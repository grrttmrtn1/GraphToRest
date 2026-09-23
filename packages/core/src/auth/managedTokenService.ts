import crypto from 'node:crypto';
import { GatewayError } from '../gateway/errors';
import type { ConnectionRecord, MappingStore } from '../storage/MappingStore';
import type { CredentialCipher } from './credentialCipher';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  parseManagedCredentials,
  requestClientCredentialsToken,
  requestRefreshedToken,
  type ManagedCredentials,
  type OAuthGrant,
  type TokenResponse,
} from './oauthClient';

export interface AccessTokenProvider {
  getAccessToken(connection: ConnectionRecord): Promise<string>;
}

export type CredentialStatus = { configured: false } | { configured: true; grant: OAuthGrant; hasRefreshToken: boolean };

interface PendingAuthorization {
  connectionId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

const REFRESH_SKEW_MS = 60_000;
const AUTHORIZATION_TTL_MS = 10 * 60_000;

function statusOf(credentials: ManagedCredentials): CredentialStatus {
  return { configured: true, grant: credentials.grant, hasRefreshToken: Boolean(credentials.refreshToken) };
}

/**
 * Owns managed vendor credentials: encrypted persistence, access-token caching with single-flight refresh,
 * and the in-memory state/PKCE bookkeeping for the authorization-code flow (single-process deployment, spec §2).
 */
export class ManagedTokenService implements AccessTokenProvider {
  private tokens = new Map<string, { accessToken: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();
  // Bumped whenever stored credentials change (invalidateInFlight). Work that started under an older generation must not persist or cache its result.
  private generations = new Map<string, number>();
  private pending = new Map<string, PendingAuthorization>();

  constructor(
    private store: MappingStore,
    private cipher: CredentialCipher,
    private now: () => number = Date.now
  ) {}

  saveCredentials(connection: ConnectionRecord, input: unknown): CredentialStatus {
    const credentials = parseManagedCredentials(connection.adapterType, input);
    this.writeCredentials(connection.id, credentials);
    this.invalidateInFlight(connection.id);
    return statusOf(credentials);
  }

  getCredentialStatus(connectionId: string): CredentialStatus {
    const credentials = this.readCredentials(connectionId);
    return credentials ? statusOf(credentials) : { configured: false };
  }

  /** Removes stored credentials; cached/in-flight tokens and pending authorizations for the connection are discarded. */
  clearCredentials(connectionId: string): void {
    this.store.setConnectionCredentials(connectionId, null);
    this.invalidateInFlight(connectionId);
    for (const [state, entry] of this.pending) {
      if (entry.connectionId === connectionId) this.pending.delete(state);
    }
  }

  /** Consumes a pending authorization the vendor rejected. Returns its connection id, or null if unknown or expired. */
  abandonAuthorization(state: string): string | null {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= this.now()) return null;
    return pending.connectionId;
  }

  getAccessToken(connection: ConnectionRecord): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > this.now()) return Promise.resolve(cached.accessToken);
    const existing = this.inflight.get(connection.id);
    if (existing) return existing;
    const request: Promise<string> = this.fetchToken(connection).finally(() => {
      if (this.inflight.get(connection.id) === request) this.inflight.delete(connection.id);
    });
    this.inflight.set(connection.id, request);
    return request;
  }

  beginAuthorization(connection: ConnectionRecord, redirectUri: string): string {
    const credentials = this.readCredentials(connection.id);
    if (!credentials) {
      throw new GatewayError('MANAGED_CREDENTIALS_MISSING', 'Store credentials for this connection before starting authorization', 400);
    }
    if (credentials.grant !== 'authorization_code') {
      throw new GatewayError('INVALID_INPUT', 'This connection uses the client_credentials grant; no authorization step is needed', 400);
    }
    this.prunePending();
    const state = crypto.randomBytes(24).toString('base64url');
    const { verifier, challenge } = generatePkcePair();
    this.pending.set(state, {
      connectionId: connection.id,
      codeVerifier: verifier,
      redirectUri,
      expiresAt: this.now() + AUTHORIZATION_TTL_MS,
    });
    return buildAuthorizationUrl(connection.adapterType, credentials, { redirectUri, state, codeChallenge: challenge });
  }

  async completeAuthorization(state: string, code: string): Promise<{ connectionId: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state); // single use, even on failure
    if (!pending || pending.expiresAt <= this.now()) {
      throw new GatewayError('INVALID_STATE', 'Unknown or expired authorization state', 400);
    }
    const connection = this.store.getConnection(pending.connectionId);
    const credentials = connection ? this.readCredentials(connection.id) : null;
    if (!connection || !credentials || credentials.grant !== 'authorization_code') {
      throw new GatewayError('INVALID_STATE', 'Unknown or expired authorization state', 400);
    }
    const generation = this.generationOf(connection.id);
    const response = await exchangeAuthorizationCode(connection.adapterType, credentials, {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
    if (!response.refreshToken) {
      throw new GatewayError(
        'VENDOR_AUTH_FAILED',
        'The vendor did not return a refresh token; make sure offline access is granted (for Microsoft, the offline_access scope)',
        502
      );
    }
    if (this.generationOf(connection.id) !== generation) {
      throw new GatewayError('INVALID_STATE', 'Credentials changed during authorization; start authorization again', 400);
    }
    this.writeCredentials(connection.id, { ...credentials, refreshToken: response.refreshToken });
    this.invalidateInFlight(connection.id); // a refresh started before this must not overwrite the new token or cache a stale access token
    this.remember(connection.id, response);
    return { connectionId: connection.id };
  }

  private async fetchToken(connection: ConnectionRecord): Promise<string> {
    const credentials = this.readCredentials(connection.id);
    if (!credentials) {
      throw new GatewayError('MANAGED_CREDENTIALS_MISSING', `Connection "${connection.name}" has no managed credentials configured`, 503);
    }
    const generation = this.generationOf(connection.id);
    let response: TokenResponse;
    if (credentials.grant === 'client_credentials') {
      response = await requestClientCredentialsToken(connection.adapterType, credentials);
    } else {
      if (!credentials.refreshToken) {
        throw new GatewayError('AUTHORIZATION_REQUIRED', `Connection "${connection.name}" has not been authorized yet`, 503);
      }
      response = await requestRefreshedToken(connection.adapterType, credentials);
      if (response.refreshToken && response.refreshToken !== credentials.refreshToken && this.generationOf(connection.id) === generation) {
        this.writeCredentials(connection.id, { ...credentials, refreshToken: response.refreshToken });
      }
    }
    // If credentials were replaced mid-flight, the caller still gets its token but it is not cached.
    if (this.generationOf(connection.id) === generation) this.remember(connection.id, response);
    return response.accessToken;
  }

  /** Called whenever stored credentials change: drops cached tokens and makes older in-flight work unable to persist or cache. */
  private invalidateInFlight(connectionId: string): void {
    this.generations.set(connectionId, this.generationOf(connectionId) + 1);
    this.tokens.delete(connectionId);
    this.inflight.delete(connectionId); // later callers must not join a request made with the old credentials
  }

  private generationOf(connectionId: string): number {
    return this.generations.get(connectionId) ?? 0;
  }

  private remember(connectionId: string, response: TokenResponse): void {
    this.tokens.set(connectionId, { accessToken: response.accessToken, expiresAt: this.now() + response.expiresInSeconds * 1000 });
  }

  private prunePending(): void {
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= this.now()) this.pending.delete(state);
    }
  }

  private readCredentials(connectionId: string): ManagedCredentials | null {
    const encrypted = this.store.getConnectionCredentials(connectionId);
    if (!encrypted) return null;
    try {
      return JSON.parse(this.cipher.decrypt(encrypted)) as ManagedCredentials;
    } catch {
      throw new GatewayError('CREDENTIAL_DECRYPTION_FAILED', 'Stored credentials could not be decrypted; check CREDENTIAL_ENCRYPTION_KEY', 500);
    }
  }

  private writeCredentials(connectionId: string, credentials: ManagedCredentials): void {
    this.store.setConnectionCredentials(connectionId, this.cipher.encrypt(JSON.stringify(credentials)));
  }
}

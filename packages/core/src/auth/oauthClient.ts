import crypto from 'node:crypto';
import { GatewayError } from '../gateway/errors';
import { assertOutboundUrlShape, outboundFetch } from '../net/outboundUrl';

export type OAuthGrant = 'client_credentials' | 'authorization_code';

export interface ManagedCredentials {
  grant: OAuthGrant;
  clientId: string;
  clientSecret: string;
  tenantId?: string;
  tokenUrl?: string;
  authorizeUrl?: string;
  scopes?: string[];
  refreshToken?: string;
}

export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
}

interface OAuthEndpoints {
  tokenUrl: string;
  authorizeUrl: string | null;
  defaultScopes: string[];
}

const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" is required`);
  return value.trim();
}

export function parseManagedCredentials(adapterType: string, input: unknown): ManagedCredentials {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('credentials must be an object');
  const raw = input as Record<string, unknown>;
  const grant = raw.grant;
  if (grant !== 'client_credentials' && grant !== 'authorization_code') {
    throw invalid('"grant" must be "client_credentials" or "authorization_code"');
  }
  const credentials: ManagedCredentials = {
    grant,
    clientId: requireString(raw.clientId, 'clientId'),
    clientSecret: requireString(raw.clientSecret, 'clientSecret'),
  };
  if (raw.scopes !== undefined) {
    const scopes = raw.scopes;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string' && s.length > 0 && !/\s/.test(s))) {
      throw invalid('"scopes" must be an array of non-empty strings without whitespace');
    }
    credentials.scopes = scopes as string[];
  }
  if (adapterType === 'microsoft-graph') {
    const tenantId = requireString(raw.tenantId, 'tenantId');
    if (!/^[A-Za-z0-9.-]+$/.test(tenantId)) throw invalid('"tenantId" may only contain letters, digits, dots and hyphens');
    credentials.tenantId = tenantId;
  } else {
    credentials.tokenUrl = assertOutboundUrlShape(raw.tokenUrl, 'tokenUrl', { httpsOnly: true });
    if (grant === 'authorization_code')
      credentials.authorizeUrl = assertOutboundUrlShape(raw.authorizeUrl, 'authorizeUrl', { httpsOnly: true });
  }
  if (raw.refreshToken !== undefined) {
    if (grant !== 'authorization_code') throw invalid('"refreshToken" is only valid with the authorization_code grant');
    credentials.refreshToken = requireString(raw.refreshToken, 'refreshToken');
  }
  return credentials;
}

function resolveEndpoints(adapterType: string, credentials: ManagedCredentials): OAuthEndpoints {
  if (adapterType === 'microsoft-graph') {
    const base = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0`;
    return {
      tokenUrl: `${base}/token`,
      authorizeUrl: `${base}/authorize`,
      defaultScopes: credentials.grant === 'authorization_code' ? ['offline_access', GRAPH_DEFAULT_SCOPE] : [GRAPH_DEFAULT_SCOPE],
    };
  }
  if (!credentials.tokenUrl) {
    throw new GatewayError('INVALID_CONFIGURATION', 'Stored credentials are missing a tokenUrl', 500);
  }
  return { tokenUrl: credentials.tokenUrl, authorizeUrl: credentials.authorizeUrl ?? null, defaultScopes: [] };
}

function scopeParam(credentials: ManagedCredentials, endpoints: OAuthEndpoints): string {
  return (credentials.scopes ?? endpoints.defaultScopes).join(' ');
}

async function postTokenRequest(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  let text: string;
  try {
    response = await outboundFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      // Never follow redirects: a 307/308 would re-POST the form (client secret, tokens) to another host or over http.
      redirect: 'manual',
    });
    text = await response.text();
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError('VENDOR_AUTH_UNREACHABLE', 'Could not reach the vendor token endpoint', 502, {
      message: (err as Error).message,
    });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GatewayError('VENDOR_AUTH_FAILED', 'The vendor token endpoint responded with a redirect, which is not followed', 502, {
      status: response.status,
    });
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body — handled below
  }
  if (!response.ok || !body || typeof body.access_token !== 'string') {
    const description = typeof body?.error_description === 'string' ? body.error_description.slice(0, 300) : undefined;
    throw new GatewayError('VENDOR_AUTH_FAILED', description ?? 'The vendor token endpoint rejected the request', 502, {
      vendorError: typeof body?.error === 'string' ? body.error : undefined,
      status: response.status,
    });
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}

export async function requestClientCredentialsToken(adapterType: string, credentials: ManagedCredentials): Promise<TokenResponse> {
  const endpoints = resolveEndpoints(adapterType, credentials);
  const form: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  };
  const scope = scopeParam(credentials, endpoints);
  if (scope) form.scope = scope;
  return postTokenRequest(endpoints.tokenUrl, form);
}

export async function requestRefreshedToken(adapterType: string, credentials: ManagedCredentials): Promise<TokenResponse> {
  if (!credentials.refreshToken) {
    throw new GatewayError('AUTHORIZATION_REQUIRED', 'No refresh token is stored; complete the OAuth authorization first', 503);
  }
  const endpoints = resolveEndpoints(adapterType, credentials);
  return postTokenRequest(endpoints.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

export async function exchangeAuthorizationCode(
  adapterType: string,
  credentials: ManagedCredentials,
  input: { code: string; redirectUri: string; codeVerifier: string }
): Promise<TokenResponse> {
  const endpoints = resolveEndpoints(adapterType, credentials);
  return postTokenRequest(endpoints.tokenUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

export function buildAuthorizationUrl(
  adapterType: string,
  credentials: ManagedCredentials,
  input: { redirectUri: string; state: string; codeChallenge: string }
): string {
  const endpoints = resolveEndpoints(adapterType, credentials);
  if (!endpoints.authorizeUrl) {
    throw new GatewayError('INVALID_CONFIGURATION', 'These credentials have no authorize endpoint configured', 400);
  }
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const scope = scopeParam(credentials, endpoints);
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

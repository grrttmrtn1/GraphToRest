import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { openDb } from '../../src/storage/db';
import { MappingStore, type ConnectionRecord } from '../../src/storage/MappingStore';
import { CredentialCipher } from '../../src/auth/credentialCipher';
import { ManagedTokenService } from '../../src/auth/managedTokenService';

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';
const KEY = '00'.repeat(32);
const CC_INPUT = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };
const AC_INPUT = { ...CC_INPUT, grant: 'authorization_code' };

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let connection: ConnectionRecord;
let clock: number;
let service: ManagedTokenService;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  connection = store.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
  clock = 1_000_000;
  service = new ManagedTokenService(store, new CredentialCipher(KEY), () => clock);
});

afterEach(() => {
  nock.cleanAll();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('credential storage', () => {
  it('encrypts credentials at rest and reports only a non-secret status', () => {
    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: false });
    const status = service.saveCredentials(connection, CC_INPUT);
    expect(status).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(service.getCredentialStatus(connection.id)).toEqual(status);
    const stored = store.getConnectionCredentials(connection.id)!;
    expect(stored).not.toContain('super-secret-value');
    expect(stored.startsWith('v1:')).toBe(true);
  });

  it('rejects invalid credentials with a 400', () => {
    expect(() => service.saveCredentials(connection, { grant: 'client_credentials' })).toThrow(/clientId/);
  });

  it('cannot read credentials encrypted under a different key', async () => {
    service.saveCredentials(connection, CC_INPUT);
    const other = new ManagedTokenService(store, new CredentialCipher('11'.repeat(32)), () => clock);
    await expect(other.getAccessToken(connection)).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED', status: 500 });
  });
});

describe('getAccessToken (client credentials)', () => {
  it('fails with a 503 when no credentials are configured', async () => {
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'MANAGED_CREDENTIALS_MISSING', status: 503 });
  });

  it('caches the token until shortly before it expires, then refetches', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-1');

    clock += 3000 * 1000; // still valid — no new HTTP call is mocked, so a refetch would fail
    expect(await service.getAccessToken(connection)).toBe('at-1');

    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-2', expires_in: 3600 });
    clock += 540 * 1000; // inside the 60s skew window before expiry
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });

  it('makes a single vendor request for concurrent callers', async () => {
    service.saveCredentials(connection, CC_INPUT);
    const scope = nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    const tokens = await Promise.all([service.getAccessToken(connection), service.getAccessToken(connection), service.getAccessToken(connection)]);
    expect(tokens).toEqual(['at-1', 'at-1', 'at-1']);
    expect(scope.isDone()).toBe(true);
  });

  it('drops the cached token when credentials are replaced', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    await service.getAccessToken(connection);
    service.saveCredentials(connection, { ...CC_INPUT, clientSecret: 'rotated-secret' });
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'rotated-secret', scope: 'https://graph.microsoft.com/.default' })
      .reply(200, { access_token: 'at-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });

  it('does not cache a failed request', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client' });
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-ok', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-ok');
  });
});

describe('authorization-code flow', () => {
  const REDIRECT = 'https://gtr.example/admin/oauth/callback';

  function stateFrom(url: string): string {
    return new URL(url).searchParams.get('state')!;
  }

  it('requires authorization before a token can be issued', async () => {
    service.saveCredentials(connection, AC_INPUT);
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED', status: 503 });
  });

  it('refuses to begin authorization for a client_credentials connection or one without credentials', () => {
    expect(() => service.beginAuthorization(connection, REDIRECT)).toThrow(/credentials/);
    service.saveCredentials(connection, CC_INPUT);
    expect(() => service.beginAuthorization(connection, REDIRECT)).toThrow(/client_credentials/);
  });

  it('completes authorization, stores the refresh token, and caches the first access token', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const url = service.beginAuthorization(connection, REDIRECT);
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.grant_type === 'authorization_code' && body.code === 'code-1' && typeof body.code_verifier === 'string')
      .reply(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });

    const result = await service.completeAuthorization(stateFrom(url), 'code-1');

    expect(result).toEqual({ connectionId: connection.id });
    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: true, grant: 'authorization_code', hasRefreshToken: true });
    expect(await service.getAccessToken(connection)).toBe('at-1'); // served from cache — no further HTTP mocked
    expect(store.getConnectionCredentials(connection.id)).not.toContain('rt-1');
  });

  it('makes state single-use and rejects unknown or expired state', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const url = service.beginAuthorization(connection, REDIRECT);
    const state = stateFrom(url);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    await service.completeAuthorization(state, 'code-1');
    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    await expect(service.completeAuthorization('made-up', 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const expiring = stateFrom(service.beginAuthorization(connection, REDIRECT));
    clock += 11 * 60 * 1000;
    await expect(service.completeAuthorization(expiring, 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('fails clearly when the vendor returns no refresh token', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = stateFrom(service.beginAuthorization(connection, REDIRECT));
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at', expires_in: 3600 });
    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('attaches the connection id to the thrown error once the state has resolved to a connection, so a web-UI redirect can target it', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = stateFrom(service.beginAuthorization(connection, REDIRECT));
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at', expires_in: 3600 }); // no refresh_token -> VENDOR_AUTH_FAILED
    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({
      code: 'VENDOR_AUTH_FAILED',
      connectionId: connection.id,
    });
  });

  it('does not attach a connection id when the state itself is unknown or expired', async () => {
    await expect(service.completeAuthorization('made-up', 'code-1')).rejects.not.toHaveProperty('connectionId');
  });

  it('refreshes with the stored token and persists a rotated refresh token', async () => {
    service.saveCredentials(connection, { ...AC_INPUT, refreshToken: 'rt-1' });
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'cid', client_secret: 'super-secret-value' })
      .reply(200, { access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-1');

    clock += 3600 * 1000;
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-2', client_id: 'cid', client_secret: 'super-secret-value' })
      .reply(200, { access_token: 'at-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });

  it('does not let a racing saveCredentials be overwritten by an in-flight refresh that rotates the token', async () => {
    service.saveCredentials(connection, { ...AC_INPUT, refreshToken: 'rt-old' });
    const replacement = { ...AC_INPUT, clientId: 'cid-new', clientSecret: 'new-secret', refreshToken: 'rt-new' };
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.refresh_token === 'rt-old')
      .reply(200, () => {
        service.saveCredentials(connection, replacement); // admin saves while the vendor call is in flight
        return { access_token: 'at-stale', refresh_token: 'rt-rotated-old', expires_in: 3600 };
      });

    expect(await service.getAccessToken(connection)).toBe('at-stale'); // the caller still gets the token it asked for

    // The new credentials were not clobbered, and the stale token was not cached: the next call refetches using them.
    nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-new', client_id: 'cid-new', client_secret: 'new-secret' })
      .reply(200, { access_token: 'at-fresh', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-fresh');
  });

  it('does not let a racing saveCredentials be overwritten by an in-flight authorization completion', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = stateFrom(service.beginAuthorization(connection, REDIRECT));
    const replacement = { ...AC_INPUT, clientId: 'cid-new', clientSecret: 'new-secret', refreshToken: 'rt-new' };
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.grant_type === 'authorization_code')
      .reply(200, () => {
        service.saveCredentials(connection, replacement);
        return { access_token: 'at-stale', refresh_token: 'rt-stale', expires_in: 3600 };
      });

    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });

    nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-new', client_id: 'cid-new', client_secret: 'new-secret' })
      .reply(200, { access_token: 'at-fresh', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-fresh');
  });
});

describe('completeAuthorization racing an in-flight refresh', () => {
  it('does not let an in-flight refresh overwrite a newly authorized refresh token or cache its stale access token', async () => {
    const REDIRECT = 'https://gtr.example/admin/oauth/callback';
    service.saveCredentials(connection, { ...AC_INPUT, refreshToken: 'rt-old' });
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    // The vendor answers the refresh slowly, so the re-authorization completes while it is still in flight.
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.grant_type === 'refresh_token' && body.refresh_token === 'rt-old')
      .delay(150)
      .reply(200, { access_token: 'at-stale', refresh_token: 'rt-rotated-old', expires_in: 3600 });
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.grant_type === 'authorization_code')
      .reply(200, { access_token: 'at-authorized', refresh_token: 'rt-authorized', expires_in: 3600 });

    const stale = service.getAccessToken(connection);
    await service.completeAuthorization(state, 'code-1');
    expect(await stale).toBe('at-stale'); // the caller still gets the token it asked for

    // The stale access token was not cached over the newly issued one...
    expect(await service.getAccessToken(connection)).toBe('at-authorized');

    // ...and the newly authorized refresh token was not clobbered by the stale refresh's rotation.
    clock += 3600 * 1000;
    nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-authorized', client_id: 'cid', client_secret: 'super-secret-value' })
      .reply(200, { access_token: 'at-fresh', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-fresh');
  });
});

describe('saveCredentials racing an in-flight fetch', () => {
  it('does not let a later caller join the stale in-flight request', async () => {
    service.saveCredentials(connection, CC_INPUT);
    let later: Promise<string> | undefined;
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.client_secret === 'super-secret-value')
      .reply(200, () => {
        service.saveCredentials(connection, { ...CC_INPUT, clientSecret: 'rotated-secret' });
        later = service.getAccessToken(connection);
        return { access_token: 'at-stale', expires_in: 3600 };
      });
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.client_secret === 'rotated-secret')
      .reply(200, { access_token: 'at-fresh', expires_in: 3600 });

    expect(await service.getAccessToken(connection)).toBe('at-stale');
    expect(await later).toBe('at-fresh');
    expect(await service.getAccessToken(connection)).toBe('at-fresh'); // cached from the fresh fetch, not the stale one
  });
});

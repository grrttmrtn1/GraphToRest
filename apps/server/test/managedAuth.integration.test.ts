import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com';
const BASE_URL = 'https://gtr.example.test';
const SECRET = 'super-secret-value';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let store: MappingStore;
let admin: AdminClient;

function buildApp(withManagedAuth: boolean, options: { publicBaseUrl?: string; webRoot?: string } = { publicBaseUrl: BASE_URL }) {
  const managedAuth = withManagedAuth ? new ManagedTokenService(store, new CredentialCipher('00'.repeat(32))) : undefined;
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store, managedAuth),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    managedAuth,
    publicBaseUrl: options.publicBaseUrl,
    webRoot: options.webRoot,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-int-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = buildApp(true);
  admin = createAdminClient(app, store);
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedManagedGraphConnection(authMode = 'managed') {
  const connectionRes = await admin.post('/admin/connections').send({ name: 'ms-managed', adapterType: 'microsoft-graph', authMode });
  const connectionId = connectionRes.body.id as string;
  await admin.post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
  });
  const apiKeyRes = await admin.post('/admin/api-keys').send({});
  return { connectionId, apiKey: apiKeyRes.body.plaintext as string };
}

const CC_BODY = { grant: 'client_credentials', clientId: 'cid', clientSecret: SECRET, tenantId: 'tenant-1' };

describe('managed auth: client credentials', () => {
  it('stores credentials encrypted, then serves API calls using only a proxy API key', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();

    const put = await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(JSON.stringify(put.body)).not.toContain(SECRET);
    expect(store.getConnectionCredentials(connectionId)).not.toContain(SECRET);

    const status = await admin.get(`/admin/connections/${connectionId}/credentials`);
    expect(status.body).toEqual(put.body);
    const listed = await admin.get('/admin/connections');
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);

    const tokenScope = nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'client_credentials', client_id: 'cid', client_secret: SECRET, scope: 'https://graph.microsoft.com/.default' })
      .reply(200, { access_token: 'managed-token', expires_in: 3600 });
    const graphScope = nock(GRAPH, { reqheaders: { authorization: 'Bearer managed-token' } })
      .get('/v1.0/users/42')
      .times(2)
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const first = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    // The developer's own X-Vendor-Token is ignored on a managed connection, and the cached token is reused.
    const second = await request(app)
      .get('/api/msgraph/users/42')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'developer-token-ignored');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: '42', displayName: 'Ada Lovelace' });
    expect(second.status).toBe(200);
    expect(tokenScope.isDone()).toBe(true);
    expect(graphScope.isDone()).toBe(true);
  });

  it('surfaces a vendor token failure as a normalized 502 without leaking the secret', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client', error_description: 'Client authentication failed' });

    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('VENDOR_AUTH_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('returns 503 when a managed connection has no credentials yet', async () => {
    const { apiKey } = await seedManagedGraphConnection();
    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_CREDENTIALS_MISSING');
  });
});

describe('managed auth: credential endpoint guards', () => {
  it('requires an admin session', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const res = await request(app).put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(401);
  });

  it('404s for an unknown connection and 400s for a non-managed one', async () => {
    expect((await admin.put('/admin/connections/nope/credentials').send(CC_BODY)).status).toBe(404);
    const { connectionId } = await seedManagedGraphConnection('passthrough');
    const res = await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('400s on invalid credential bodies', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const res = await admin.put(`/admin/connections/${connectionId}/credentials`).send({ grant: 'client_credentials', clientId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('503s with MANAGED_AUTH_DISABLED when no encryption key is configured', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const bare = buildApp(false);
    const bareAdmin = createAdminClientForExistingUser(bare);
    const res = await bareAdmin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_AUTH_DISABLED');
    const callback = await request(bare).get('/admin/oauth/callback?code=a&state=b');
    expect(callback.status).toBe(503);
  });

  function createAdminClientForExistingUser(target: ReturnType<typeof createApp>) {
    const session = store.createAdminSession(store.findAdminUserByUsername('test-admin')!.id, 60_000);
    return {
      put: (url: string) => request(target).put(url).set('Authorization', `Bearer ${session.token}`),
    };
  }
});

describe('managed auth: authorization code', () => {
  const AC_BODY = { ...CC_BODY, grant: 'authorization_code' };

  it('runs start → vendor consent → callback, then serves API calls from the stored grant', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(AC_BODY);

    const before = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(503);
    expect(before.body.error.code).toBe('AUTHORIZATION_REQUIRED');

    const start = await admin.post(`/admin/connections/${connectionId}/oauth/start`).send({});
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${LOGIN}/tenant-1/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/admin/oauth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(start.body.authorizationUrl).not.toContain(SECRET);
    const state = url.searchParams.get('state')!;

    nock(LOGIN)
      .post(
        TOKEN_PATH,
        (body: Record<string, string>) =>
          body.grant_type === 'authorization_code' &&
          body.code === 'auth-code-1' &&
          body.redirect_uri === `${BASE_URL}/admin/oauth/callback` &&
          typeof body.code_verifier === 'string' &&
          body.client_secret === SECRET
      )
      .reply(200, { access_token: 'delegated-token', refresh_token: 'rt-1', expires_in: 3600 });

    // The vendor redirects the *browser* here — no admin bearer token is present.
    const callback = await request(app).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ status: 'authorized', connectionId });

    const status = await admin.get(`/admin/connections/${connectionId}/credentials`);
    expect(status.body).toEqual({ configured: true, grant: 'authorization_code', hasRefreshToken: true });

    const graphScope = nock(GRAPH, { reqheaders: { authorization: 'Bearer delegated-token' } })
      .get('/v1.0/users/42')
      .reply(200, { id: '42' });
    const after = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(after.status).toBe(200);
    expect(graphScope.isDone()).toBe(true);

    const replay = await request(app).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_STATE');
  });

  it('rejects a callback with unknown state, missing params, or a vendor error', async () => {
    const unknown = await request(app).get('/admin/oauth/callback?code=x&state=made-up');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_STATE');

    const missing = await request(app).get('/admin/oauth/callback?code=x');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const denied = await request(app).get('/admin/oauth/callback?error=access_denied&state=s');
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('requires admin auth for oauth/start and rejects it for client_credentials connections', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    expect((await request(app).post(`/admin/connections/${connectionId}/oauth/start`).send({})).status).toBe(401);
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    const res = await admin.post(`/admin/connections/${connectionId}/oauth/start`).send({});
    expect(res.status).toBe(400);
  });

  it('fails closed with 503 when PUBLIC_BASE_URL is not configured, never deriving redirect_uri from the Host header', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(AC_BODY);
    const unconfigured = buildApp(true, {});
    const session = store.createAdminSession(store.findAdminUserByUsername('test-admin')!.id, 60_000);
    const res = await request(unconfigured)
      .post(`/admin/connections/${connectionId}/oauth/start`)
      .set('Authorization', `Bearer ${session.token}`)
      .set('Host', 'evil.example')
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('INVALID_CONFIGURATION');
    expect(res.body.error.message).toContain('PUBLIC_BASE_URL');
    expect(res.body.authorizationUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('evil.example');
  });
});

describe('OAuth callback with the web UI enabled', () => {
  const AC_BODY = { ...CC_BODY, grant: 'authorization_code' };
  let webRoot: string;
  let webApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graphtorest-webroot-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    webApp = buildApp(true, { publicBaseUrl: BASE_URL, webRoot });
  });

  afterEach(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  /**
   * Runs the whole flow on webApp: each buildApp() owns its own ManagedTokenService, so the pending state from
   * oauth/start only exists in the app that issued it. The admin session lives in the shared store, so admin.token works here.
   */
  async function startAuthorization() {
    const { connectionId } = await seedManagedGraphConnection();
    const auth = { Authorization: `Bearer ${admin.token}` };
    await request(webApp).put(`/admin/connections/${connectionId}/credentials`).set(auth).send(AC_BODY);
    const start = await request(webApp).post(`/admin/connections/${connectionId}/oauth/start`).set(auth).send({});
    return { connectionId, state: new URL(start.body.authorizationUrl).searchParams.get('state')! };
  }

  it('redirects to the connection page on success', async () => {
    const { connectionId, state } = await startAuthorization();
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'delegated-token', refresh_token: 'rt-1', expires_in: 3600 });
    const callback = await request(webApp).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`/connections/${connectionId}?oauth=success`);
  });

  it('redirects a vendor error to the connection page and consumes the state', async () => {
    const { connectionId, state } = await startAuthorization();
    const denied = await request(webApp).get(`/admin/oauth/callback?error=access_denied&state=${state}`);
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe(`/connections/${connectionId}?oauth=error&code=AUTHORIZATION_DENIED`);

    const replay = await request(webApp).get(`/admin/oauth/callback?code=x&state=${state}`);
    expect(replay.headers.location).toBe('/connections?oauth=error&code=INVALID_STATE');
  });

  it('redirects to the connections list when the state is unknown', async () => {
    const res = await request(webApp).get('/admin/oauth/callback?code=x&state=made-up');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/connections?oauth=error&code=INVALID_STATE');
  });

  it('keeps the vendor error text out of the redirect', async () => {
    const res = await request(webApp).get('/admin/oauth/callback?error=secret_vendor_text&state=nope');
    expect(res.headers.location).toBe('/connections?oauth=error&code=AUTHORIZATION_DENIED');
  });
});

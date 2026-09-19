import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import nock from 'nock';
import {
  parseManagedCredentials,
  requestClientCredentialsToken,
  requestRefreshedToken,
  exchangeAuthorizationCode,
  buildAuthorizationUrl,
  generatePkcePair,
  type ManagedCredentials,
} from '../../src/auth/oauthClient';

afterEach(() => {
  nock.cleanAll();
});

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';

const msCreds: ManagedCredentials = {
  grant: 'client_credentials',
  clientId: 'cid',
  clientSecret: 'shh-secret',
  tenantId: 'tenant-1',
};

describe('parseManagedCredentials', () => {
  it('accepts valid Microsoft client-credentials input', () => {
    expect(parseManagedCredentials('microsoft-graph', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tenantId: 't-1' })).toEqual({
      grant: 'client_credentials',
      clientId: 'a',
      clientSecret: 'b',
      tenantId: 't-1',
    });
  });

  it('requires a URL-safe tenantId for microsoft-graph', () => {
    const base = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b' };
    expect(() => parseManagedCredentials('microsoft-graph', base)).toThrow(/tenantId/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...base, tenantId: '../evil' })).toThrow(/tenantId/);
  });

  it('requires an https tokenUrl (and authorizeUrl for auth-code) for other adapters', () => {
    const base = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b' };
    expect(() => parseManagedCredentials('graphql', base)).toThrow(/tokenUrl/);
    expect(() => parseManagedCredentials('graphql', { ...base, tokenUrl: 'http://insecure.example/token' })).toThrow(/https/);
    expect(() => parseManagedCredentials('graphql', { ...base, tokenUrl: 'not a url' })).toThrow(/valid URL/);
    expect(() =>
      parseManagedCredentials('graphql', { ...base, grant: 'authorization_code', tokenUrl: 'https://v.example/token' })
    ).toThrow(/authorizeUrl/);
    expect(
      parseManagedCredentials('graphql', {
        ...base,
        grant: 'authorization_code',
        tokenUrl: 'https://v.example/token',
        authorizeUrl: 'https://v.example/authorize',
        scopes: ['read'],
      })
    ).toMatchObject({ authorizeUrl: 'https://v.example/authorize', scopes: ['read'] });
  });

  it('rejects an unknown grant, missing secrets, bad scopes, and a refreshToken with client_credentials', () => {
    const ok = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tenantId: 't' };
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, grant: 'password' })).toThrow(/grant/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, clientSecret: '' })).toThrow(/clientSecret/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, scopes: ['has space'] })).toThrow(/scopes/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, refreshToken: 'rt' })).toThrow(/refreshToken/);
    expect(() => parseManagedCredentials('microsoft-graph', 'nope')).toThrow(/object/);
  });

  it('accepts a pre-supplied refreshToken for authorization_code', () => {
    const parsed = parseManagedCredentials('microsoft-graph', {
      grant: 'authorization_code',
      clientId: 'a',
      clientSecret: 'b',
      tenantId: 't',
      refreshToken: 'rt-0',
    });
    expect(parsed.refreshToken).toBe('rt-0');
  });
});

describe('token requests', () => {
  it('requests a client-credentials token with the default Graph scope', async () => {
    const scope = nock(LOGIN)
      .post(TOKEN_PATH, {
        grant_type: 'client_credentials',
        client_id: 'cid',
        client_secret: 'shh-secret',
        scope: 'https://graph.microsoft.com/.default',
      })
      .reply(200, { access_token: 'at-1', expires_in: 3599, token_type: 'Bearer' });

    const token = await requestClientCredentialsToken('microsoft-graph', msCreds);

    expect(token).toEqual({ accessToken: 'at-1', expiresInSeconds: 3599, refreshToken: undefined });
    expect(scope.isDone()).toBe(true);
  });

  it('uses explicit scopes and the explicit tokenUrl for non-Microsoft adapters', async () => {
    nock('https://auth.vendor.example')
      .post('/oauth/token', { grant_type: 'client_credentials', client_id: 'cid', client_secret: 's', scope: 'read write' })
      .reply(200, { access_token: 'at-2', expires_in: 60 });

    const token = await requestClientCredentialsToken('graphql', {
      grant: 'client_credentials',
      clientId: 'cid',
      clientSecret: 's',
      tokenUrl: 'https://auth.vendor.example/oauth/token',
      scopes: ['read', 'write'],
    });
    expect(token.accessToken).toBe('at-2');
  });

  it('defaults expires_in to one hour when the vendor omits it', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at' });
    expect((await requestClientCredentialsToken('microsoft-graph', msCreds)).expiresInSeconds).toBe(3600);
  });

  it('exchanges an authorization code with the PKCE verifier', async () => {
    const scope = nock(LOGIN)
      .post(TOKEN_PATH, {
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://gtr.example/admin/oauth/callback',
        code_verifier: 'verifier-1',
        client_id: 'cid',
        client_secret: 'shh-secret',
      })
      .reply(200, { access_token: 'at-3', refresh_token: 'rt-3', expires_in: 3600 });

    const token = await exchangeAuthorizationCode(
      'microsoft-graph',
      { ...msCreds, grant: 'authorization_code' },
      { code: 'the-code', redirectUri: 'https://gtr.example/admin/oauth/callback', codeVerifier: 'verifier-1' }
    );

    expect(token).toMatchObject({ accessToken: 'at-3', refreshToken: 'rt-3' });
    expect(scope.isDone()).toBe(true);
  });

  it('refreshes with the stored refresh token and surfaces a rotated one', async () => {
    nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: 'cid', client_secret: 'shh-secret' })
      .reply(200, { access_token: 'at-4', refresh_token: 'rt-new', expires_in: 3600 });

    const token = await requestRefreshedToken('microsoft-graph', { ...msCreds, grant: 'authorization_code', refreshToken: 'rt-old' });
    expect(token).toMatchObject({ accessToken: 'at-4', refreshToken: 'rt-new' });
  });

  it('maps a vendor rejection to a 502 VENDOR_AUTH_FAILED without leaking secrets', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client', error_description: 'Client authentication failed' });

    const err = await requestClientCredentialsToken('microsoft-graph', msCreds).catch((e) => e);

    expect(err).toMatchObject({ code: 'VENDOR_AUTH_FAILED', status: 502, message: 'Client authentication failed' });
    expect(err.details).toEqual({ vendorError: 'invalid_client', status: 401 });
    expect(JSON.stringify(err.details) + err.message).not.toContain('shh-secret');
  });

  it('maps a 200 response with no access_token to VENDOR_AUTH_FAILED', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(200, { nope: true });
    await expect(requestClientCredentialsToken('microsoft-graph', msCreds)).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('maps a network failure to a 502 VENDOR_AUTH_UNREACHABLE', async () => {
    nock(LOGIN).post(TOKEN_PATH).replyWithError('boom');
    await expect(requestClientCredentialsToken('microsoft-graph', msCreds)).rejects.toMatchObject({
      code: 'VENDOR_AUTH_UNREACHABLE',
      status: 502,
    });
  });

  it('does not follow a redirect from the token endpoint (would re-POST the secret elsewhere)', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(307, '', { location: 'https://evil.example/steal' });
    const evil = nock('https://evil.example').post('/steal').reply(200, { access_token: 'stolen' });

    const err = await requestClientCredentialsToken('microsoft-graph', msCreds).catch((e) => e);

    expect(err).toMatchObject({ code: 'VENDOR_AUTH_FAILED', status: 502, details: { status: 307 } });
    expect(JSON.stringify(err.details) + err.message).not.toContain('shh-secret');
    expect(evil.isDone()).toBe(false);
  });

  it('sends the token request with a timeout signal and without following redirects', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at' });
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      await requestClientCredentialsToken('microsoft-graph', msCreds);
      const init = spy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe('manual');
    } finally {
      spy.mockRestore();
    }
  });

  it('maps a request timeout to a 502 VENDOR_AUTH_UNREACHABLE without leaking secrets', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    try {
      const err = await requestClientCredentialsToken('microsoft-graph', msCreds).catch((e) => e);
      expect(err).toMatchObject({ code: 'VENDOR_AUTH_UNREACHABLE', status: 502 });
      expect(JSON.stringify(err.details) + err.message).not.toContain('shh-secret');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to refresh when no refresh token is stored', async () => {
    await expect(requestRefreshedToken('microsoft-graph', { ...msCreds, grant: 'authorization_code' })).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
    });
  });
});

describe('authorization URL and PKCE', () => {
  it('builds a Microsoft authorization URL with state, PKCE challenge and offline_access', () => {
    const url = new URL(
      buildAuthorizationUrl('microsoft-graph', { ...msCreds, grant: 'authorization_code' }, {
        redirectUri: 'https://gtr.example/admin/oauth/callback',
        state: 'st-1',
        codeChallenge: 'chal-1',
      })
    );
    expect(url.origin + url.pathname).toBe(`${LOGIN}/tenant-1/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gtr.example/admin/oauth/callback');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('offline_access https://graph.microsoft.com/.default');
    expect(url.toString()).not.toContain('shh-secret');
  });

  it('refuses to build a URL when the adapter has no authorize endpoint', () => {
    expect(() =>
      buildAuthorizationUrl('graphql', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://v.example/t' }, {
        redirectUri: 'https://x/cb',
        state: 's',
        codeChallenge: 'c',
      })
    ).toThrow(/authorize/);
  });

  it('generates a PKCE pair whose challenge is the S256 hash of the verifier', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(generatePkcePair().verifier).not.toBe(verifier);
  });
});

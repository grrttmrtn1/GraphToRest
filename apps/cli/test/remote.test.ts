import { describe, it, expect } from 'vitest';
import { RemoteClient } from '../src/client/remote';
import { fakeFetch } from './helpers/fakeFetch';

function client(impl: typeof fetch, overrides: Partial<ConstructorParameters<typeof RemoteClient>[0]> = {}) {
  return new RemoteClient({ server: 'http://gtr.test', token: 'tok', source: '--server', fetchImpl: impl, ...overrides });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { code: string; message: string; exitCode: number };
  }
  throw new Error('expected failure');
}

describe('RemoteClient requests', () => {
  it('sends the bearer token and JSON body under <server>/admin, keeping a path prefix', async () => {
    const fake = fakeFetch({ 'POST /gtr/admin/connections': { status: 201, body: { id: 'c1' } } });
    const remote = client(fake.impl, { server: 'https://host.test/gtr' });
    await remote.createConnection({ name: 'n', adapterType: 'mock', authMode: 'passthrough' });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://host.test/gtr/admin/connections',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: { name: 'n', adapterType: 'mock', authMode: 'passthrough' },
    });
  });

  it('sends source=manual when creating a mapping', async () => {
    const fake = fakeFetch({ 'POST /admin/mappings': { status: 201, body: {} } });
    await client(fake.impl).createMapping({ connectionId: 'c', method: 'GET', route: '/a', operation: {} });
    expect(fake.calls[0].body).toMatchObject({ source: 'manual' });
  });

  it('sends the vendor token header and force flag for generate, and query params for export and activity', async () => {
    const fake = fakeFetch({
      'POST /admin/connections/c%201/mappings/generate': { status: 200, body: { created: [], updated: [], skipped: [], conflicts: [] } },
      'GET /admin/mappings/export': { status: 200, body: '- a: 1\n', contentType: 'text/yaml' },
      'GET /admin/activity': { status: 200, body: { items: [], nextBefore: null } },
    });
    const remote = client(fake.impl);
    await remote.generateMappings('c 1', { force: true, vendorToken: 'vt' });
    expect(await remote.exportMappings({ connectionId: 'c1' })).toBe('- a: 1\n');
    await remote.listActivity({ limit: 5 });
    expect(fake.calls[0]).toMatchObject({ headers: { 'x-vendor-token': 'vt' }, body: { force: true } });
    expect(fake.calls[1].url).toBe('http://gtr.test/admin/mappings/export?connectionId=c1');
    expect(fake.calls[2].url).toBe('http://gtr.test/admin/activity?limit=5');
  });

  it('returns undefined for 204 responses', async () => {
    const fake = fakeFetch({ 'DELETE /admin/mappings/m1': { status: 204 } });
    await expect(client(fake.impl).deleteMapping('m1')).resolves.toBeUndefined();
  });
});

describe('RemoteClient errors', () => {
  it('maps a server error body to its code and message', async () => {
    const fake = fakeFetch({ 'DELETE /admin/mappings/x': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Mapping not found', details: {} } } } });
    expect(await failure(client(fake.impl).deleteMapping('x'))).toMatchObject({ code: 'NOT_FOUND', message: 'Mapping not found', exitCode: 4 });
  });

  it('reports a non-JSON error body as SERVER_ERROR with the status', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' } });
    expect(await failure(client(fake.impl).listConnections())).toMatchObject({ code: 'SERVER_ERROR', message: 'Server returned HTTP 502' });
  });

  it('explains a 2xx non-JSON response instead of crashing on JSON.parse', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 200, body: '<html>hello</html>', contentType: 'text/html' } });
    const err = await failure(client(fake.impl).listConnections());
    expect(err.code).toBe('SERVER_ERROR');
    expect(err.message).toMatch(/expected JSON but got text\/html.*Is this a GraphToRest server URL\?/);
  });

  it('tells the user to log in again when a sent token is rejected', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } } });
    expect(await failure(client(fake.impl).listConnections())).toMatchObject({
      code: 'UNAUTHORIZED',
      exitCode: 3,
      message: 'Session expired or revoked; run "gtr login --server http://gtr.test"',
    });
  });

  it('fails before any request when there is no token', async () => {
    const fake = fakeFetch({});
    expect(await failure(client(fake.impl, { token: null }).listConnections())).toMatchObject({
      code: 'NOT_LOGGED_IN',
      exitCode: 3,
      message: 'Not logged in to http://gtr.test; run "gtr login --server http://gtr.test"',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('reports an unreachable server with where it was configured', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    }) as typeof fetch;
    expect(await failure(client(refused, { source: 'profile' }).listConnections())).toMatchObject({
      code: 'UNREACHABLE',
      exitCode: 1,
      message: 'Cannot reach server at http://gtr.test (configured via profile): connect ECONNREFUSED 127.0.0.1:9',
    });
  });

  it('reports a timeout', async () => {
    const slow = ((_input: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    expect(await failure(client(slow, { timeoutMs: 20 }).listConnections())).toMatchObject({
      code: 'TIMEOUT',
      message: 'Request to http://gtr.test timed out after 0.02s',
    });
  });

  it('refuses embedded-only operations', async () => {
    expect(await failure(client(fakeFetch({}).impl).setAdminPassword({ username: 'a', password: 'b' }))).toMatchObject({ code: 'MODE_UNSUPPORTED' });
  });
});

describe('RemoteClient sessions', () => {
  it('logs in without a token and surfaces a bad password as UNAUTHORIZED with the server message', async () => {
    const fake = fakeFetch({
      'POST /admin/login': (call) =>
        (call.body as { password: string }).password === 'right'
          ? { status: 200, body: { token: 'new', expiresAt: 'soon' } }
          : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } } },
    });
    const options = { server: 'http://gtr.test', source: '--server' as const, fetchImpl: fake.impl };
    expect(await RemoteClient.login(options, 'admin', 'right')).toEqual({ token: 'new', expiresAt: 'soon' });
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(await failure(RemoteClient.login(options, 'admin', 'wrong'))).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid username or password' });
  });

  it('describes the session as logged in, expired or not logged in', async () => {
    const ok = fakeFetch({ 'GET /admin/session': { status: 200, body: { username: 'admin', expiresAt: 'soon' } } });
    const expired = fakeFetch({ 'GET /admin/session': { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } } });
    expect(await client(ok.impl).describe()).toEqual({
      mode: 'remote',
      server: 'http://gtr.test',
      source: '--server',
      session: { username: 'admin', expiresAt: 'soon' },
    });
    expect((await client(expired.impl).describe()).session).toBe('expired');
    expect((await client(fakeFetch({}).impl, { token: null }).describe()).session).toBe('not-logged-in');
  });
});

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
  registerDefaultAdapters,
  ResponseCache,
  ManagedTokenService,
  CredentialCipher,
} from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;
let responseCache: ResponseCache;

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-cache-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const mappingStore = new MappingStore(db);
  const managedAuth = new ManagedTokenService(mappingStore, new CredentialCipher('00'.repeat(32)));
  responseCache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 300 });
  const gatewayEngine = new GatewayEngine(mappingStore, managedAuth, responseCache);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true, responseCache, managedAuth });
  admin = createAdminClient(app, mappingStore);
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedGraphQLConnection() {
  const connectionRes = await admin
    .post('/admin/connections')
    .send({ name: 'graphql-test', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: ENDPOINT } });
  const apiKeyRes = await admin.post('/admin/api-keys').send({});
  return { connectionId: connectionRes.body.id as string, apiKey: apiKeyRes.body.plaintext as string };
}

async function seedCachedMapping(connectionId: string, extra: Record<string, unknown> = {}) {
  const res = await admin
    .post('/admin/mappings')
    .send({ connectionId, route: '/me', method: 'GET', operation: { query: '{ me { id } }' }, cacheTtlSeconds: 60, ...extra });
  return res.body.id as string;
}
const me = (apiKey: string, token?: string) => {
  const r = request(app).get('/api/me').set('Authorization', `Bearer ${apiKey}`);
  return token === undefined ? r : r.set('X-Vendor-Token', token);
};
const replyFor = (token: string, id: string) =>
  nock(HOST).post('/graphql').matchHeader('authorization', `Bearer ${token}`).reply(200, { data: { me: { id } } });

describe('response caching end-to-end', () => {
  it('returns MISS then HIT without a second vendor call', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice'); // exactly one interceptor: a second vendor call would fail the test
    const first = await me(apiKey, 'tok-a');
    const second = await me(apiKey, 'tok-a');
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  it('never shares entries between passthrough tokens', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    replyFor('tok-b', 'bob');
    await me(apiKey, 'tok-a');
    const bob = await me(apiKey, 'tok-b');
    expect(bob.headers['x-cache']).toBe('MISS');
    expect(JSON.stringify(bob.body)).toContain('bob');
  });

  it("no-token requests do not hit a token-holder's entry", async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    await me(apiKey, 'tok-a');
    const anonymous = await me(apiKey);
    expect(anonymous.headers['x-cache']).toBe('MISS');
    expect(JSON.stringify(anonymous.body)).not.toContain('alice');
  });

  it('adds no X-Cache header when the mapping has no TTL', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId, { cacheTtlSeconds: null });
    replyFor('tok-a', 'alice');
    expect((await me(apiKey, 'tok-a')).headers['x-cache']).toBeUndefined();
  });

  it('never caches non-GET mappings', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/do', method: 'POST', operation: { query: 'mutation { do }' }, cacheTtlSeconds: 60 });
    const vendor = nock(HOST).post('/graphql').twice().reply(200, { data: { do: true } });
    const first = await request(app).post('/api/do').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 't');
    const second = await request(app).post('/api/do').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 't');
    expect(first.headers['x-cache']).toBeUndefined();
    expect(second.headers['x-cache']).toBeUndefined();
    expect(vendor.isDone()).toBe(true); // both POSTs reached the vendor
  });

  it('does not cache a failed vendor call', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    nock(HOST).post('/graphql').reply(500, 'upstream broke');
    const failed = await me(apiKey, 'tok-a');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const vendor = replyFor('tok-a', 'alice');
    const retry = await me(apiKey, 'tok-a');
    expect(retry.headers['x-cache']).toBe('MISS');
    expect(retry.status).toBe(200);
    expect(vendor.isDone()).toBe(true);
  });

  it('evicts on mapping update', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    const mappingId = await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    await me(apiKey, 'tok-a');
    await admin.patch(`/admin/mappings/${mappingId}`).send({ responseTemplate: { who: '$.me.id' } });
    replyFor('tok-a', 'alice-2');
    const after = await me(apiKey, 'tok-a');
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body).toEqual({ who: 'alice-2' });
  });

  it('evicts on credentials change', async () => {
    const conn = await admin
      .post('/admin/connections')
      .send({ name: 'managed-gql', adapterType: 'graphql', authMode: 'managed', config: { endpoint: ENDPOINT } });
    responseCache.set('seeded', { stale: true }, { mappingId: 'm', connectionId: conn.body.id, ttlSeconds: 60 });
    await admin
      .put(`/admin/connections/${conn.body.id}/credentials`)
      .send({ grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://login.example/token' });
    expect(responseCache.get('seeded')).toBeUndefined();
  });

  it('evicts on credentials delete', async () => {
    const conn = await admin
      .post('/admin/connections')
      .send({ name: 'managed-gql', adapterType: 'graphql', authMode: 'managed', config: { endpoint: ENDPOINT } });
    await admin
      .put(`/admin/connections/${conn.body.id}/credentials`)
      .send({ grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://login.example/token' });
    responseCache.set('seeded', { stale: true }, { mappingId: 'm', connectionId: conn.body.id, ttlSeconds: 60 });
    const res = await admin.delete(`/admin/connections/${conn.body.id}/credentials`);
    expect(res.status).toBeLessThan(300);
    expect(responseCache.get('seeded')).toBeUndefined();
  });

  it('evicts on mapping delete, import and connection delete', async () => {
    const { connectionId } = await seedGraphQLConnection();
    const mappingId = await seedCachedMapping(connectionId);
    const seed = () => responseCache.set('x', 1, { mappingId, connectionId, ttlSeconds: 60 });
    seed();
    await admin.post('/admin/mappings/import').send({ yaml: '[]' });
    expect(responseCache.size).toBe(0);
    seed();
    await admin.delete(`/admin/mappings/${mappingId}`);
    expect(responseCache.size).toBe(0);
    seed();
    await admin.delete(`/admin/connections/${connectionId}`);
    expect(responseCache.size).toBe(0);
  });
});

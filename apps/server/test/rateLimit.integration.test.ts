import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, type RateLimit } from '@graphtorest/core';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/middleware/rateLimit';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;
let store: MappingStore;

let clock = 1_000_000;
let limiter: RateLimiter;

function build(defaultLimit: RateLimit | null) {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-ratelimit-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  limiter = new RateLimiter({ defaultLimit, now: () => clock });
  app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    rateLimiter: limiter,
  });
  admin = createAdminClient(app, store);
}

afterEach(() => {
  limiter.stop();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

async function seed() {
  const conn = await admin.post('/admin/connections').send({ name: 'm', adapterType: 'mock', authMode: 'passthrough' });
  await admin.post('/admin/mappings').send({ connectionId: conn.body.id, route: '/users/{id}', method: 'GET', operation: { resource: 'user' } });
}
const call = (key: string) => request(app).get('/api/users/1').set('Authorization', `Bearer ${key}`);

describe('rate limiting', () => {
  it('is off by default', async () => {
    build(null);
    await seed();
    const key = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    for (let i = 0; i < 20; i++) expect((await call(key)).status).toBe(200);
    expect((await call(key)).headers['ratelimit-limit']).toBeUndefined();
  });

  it('enforces the server default with 429, Retry-After and RateLimit headers', async () => {
    build({ requestsPerMinute: 60, burst: 2 });
    await seed();
    const key = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    const first = await call(key);
    expect(first.headers).toMatchObject({ 'ratelimit-limit': '2', 'ratelimit-remaining': '1' });
    await call(key);
    const refused = await call(key);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 1 } });
    expect(refused.headers['retry-after']).toBe('1');
    clock += 1000;
    expect((await call(key)).status).toBe(200);
  });

  it('per-key overrides beat the default, including unlimited', async () => {
    build({ requestsPerMinute: 60, burst: 1 });
    await seed();
    const open = (await admin.post('/admin/api-keys').send({ rateLimit: 'unlimited' })).body.plaintext;
    const roomy = (await admin.post('/admin/api-keys').send({ rateLimit: { requestsPerMinute: 60, burst: 5 } })).body.plaintext;
    for (let i = 0; i < 5; i++) expect((await call(roomy)).status).toBe(200);
    expect((await call(roomy)).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await call(open)).status).toBe(200);
  });

  it('applies a changed limit on the next request', async () => {
    build(null);
    await seed();
    const created = (await admin.post('/admin/api-keys').send({ rateLimit: { requestsPerMinute: 600, burst: 100 } })).body;
    for (let i = 0; i < 3; i++) await call(created.plaintext);
    await admin.patch(`/admin/api-keys/${created.id}`).send({ rateLimit: { requestsPerMinute: 1, burst: 1 } });
    expect((await call(created.plaintext)).status).toBe(200);
    expect((await call(created.plaintext)).status).toBe(429);
  });

  it('limits keys independently and does not count rejected auth', async () => {
    build({ requestsPerMinute: 60, burst: 1 });
    await seed();
    const a = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    const b = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    await call(a);
    expect((await call(a)).status).toBe(429);
    expect((await call(b)).status).toBe(200);
    expect((await call('bogus.key')).status).toBe(401);
  });
});

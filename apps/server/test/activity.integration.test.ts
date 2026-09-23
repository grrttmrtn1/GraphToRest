import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let store: MappingStore;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;

function buildApp(activityRetention?: number) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    activityRetention,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-activity-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = buildApp();
  admin = createAdminClient(app, store);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seed() {
  const connection = store.createConnection({ name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough' });
  const mapping = store.createMapping({
    connectionId: connection.id,
    route: '/users/{id}',
    method: 'GET',
    operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
  });
  const key = store.createApiKey({ label: 'dev key' });
  return { connection, mapping, key };
}

/** supertest resolves before the response 'finish' listener has run; wait one macrotask for the log write. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('activity logging', () => {
  it('records a successful call with key, connection and mapping, but never the query string', async () => {
    const { connection, mapping, key } = seed();
    const res = await request(app).get('/api/users/42?secret=hunter2').set('Authorization', `Bearer ${key.plaintext}`);
    expect(res.status).toBe(200);
    await settle();

    const [row] = store.listRequests({ limit: 10 });
    expect(row).toMatchObject({
      method: 'GET',
      path: '/api/users/42',
      status: 200,
      errorCode: null,
      apiKeyId: key.id,
      apiKeyLabel: 'dev key',
      connectionId: connection.id,
      connectionName: 'mock-conn',
      mappingId: mapping.id,
    });
    expect(typeof row.durationMs).toBe('number');
    expect(JSON.stringify(store.listRequests({ limit: 10 }))).not.toContain('hunter2');
  });

  it('records a gateway error with its code', async () => {
    const { key } = seed();
    await request(app).get('/api/nowhere').set('Authorization', `Bearer ${key.plaintext}`);
    await settle();
    expect(store.listRequests({ limit: 1 })[0]).toMatchObject({ path: '/api/nowhere', status: 404, errorCode: 'NOT_FOUND', apiKeyId: key.id, mappingId: null });
  });

  it('records an API-key rejection without a key id', async () => {
    seed();
    await request(app).get('/api/users/1').set('Authorization', 'Bearer bogus.key');
    await settle();
    expect(store.listRequests({ limit: 1 })[0]).toMatchObject({ status: 401, errorCode: 'UNAUTHORIZED', apiKeyId: null });
  });

  it('does not log the OpenAPI document or the admin API', async () => {
    await request(app).get('/api/openapi.json');
    await admin.get('/admin/connections');
    await settle();
    expect(store.listRequests({ limit: 10 })).toEqual([]);
  });

  it('prunes to the configured retention', async () => {
    const small = buildApp(2);
    const { key } = seed();
    for (const id of ['1', '2', '3']) {
      await request(small).get(`/api/users/${id}`).set('Authorization', `Bearer ${key.plaintext}`);
      await settle();
    }
    expect(store.listRequests({ limit: 10 }).map((r) => r.path)).toEqual(['/api/users/3', '/api/users/2']);
  });

  it('never lets a failed log write affect the API response', async () => {
    const { key } = seed();
    vi.spyOn(store, 'recordRequest').mockImplementation(() => {
      throw new Error('disk full');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${key.plaintext}`);
    await settle();
    expect(res.status).toBe(200);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('activity_log_write_failed'));
  });
});

describe('GET /admin/activity', () => {
  it('pages newest first with nextBefore', async () => {
    const { key } = seed();
    for (const id of ['1', '2', '3']) {
      await request(app).get(`/api/users/${id}`).set('Authorization', `Bearer ${key.plaintext}`);
      await settle();
    }
    const first = await admin.get('/admin/activity?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((r: { path: string }) => r.path)).toEqual(['/api/users/3', '/api/users/2']);
    expect(first.body.nextBefore).toBe(first.body.items[1].id);

    const second = await admin.get(`/admin/activity?limit=2&before=${first.body.nextBefore}`);
    expect(second.body.items.map((r: { path: string }) => r.path)).toEqual(['/api/users/1']);
    expect(second.body.nextBefore).toBeNull();
  });

  it('defaults to 50 items', async () => {
    for (let i = 0; i < 55; i++) {
      store.recordRequest({ ts: new Date().toISOString(), method: 'GET', path: `/api/${i}`, status: 200, durationMs: 1 }, 1000);
    }
    const res = await admin.get('/admin/activity');
    expect(res.body.items).toHaveLength(50);
  });

  it.each(['0', '201', 'abc', '1.5'])('rejects limit=%s', async (limit) => {
    const res = await admin.get(`/admin/activity?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-integer before', async () => {
    expect((await admin.get('/admin/activity?before=x')).status).toBe(400);
  });

  it('requires an admin session', async () => {
    expect((await request(app).get('/admin/activity')).status).toBe(401);
  });
});

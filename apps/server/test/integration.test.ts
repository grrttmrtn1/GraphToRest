import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let mappingStore: MappingStore;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-server-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  mappingStore = new MappingStore(db);
  const gatewayEngine = new GatewayEngine(mappingStore);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedUserRoute() {
  const connectionRes = await request(app)
    .post('/admin/connections')
    .send({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
  const connectionId = connectionRes.body.id;
  await request(app)
    .post('/admin/mappings')
    .send({
      connectionId,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id, displayName, mail }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
    });
  const apiKeyRes = await request(app).post('/admin/api-keys').send({ label: 'test' });
  return { plaintext: apiKeyRes.body.plaintext as string, id: apiKeyRes.body.id as string };
}

describe('server integration', () => {
  it('serves the resolved mapping for an authenticated request', async () => {
    const apiKey = await seedUserRoute();
    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${apiKey.plaintext}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', name: 'Mock User', email: 'mock@example.com' });
  });

  it('rejects requests with no Authorization header', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/users/42');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with an invalid API key', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/users/42').set('Authorization', 'Bearer bogus.key');
    expect(res.status).toBe(401);
  });

  it('returns a normalized 404 for an unmapped route', async () => {
    const apiKey = await seedUserRoute();
    const res = await request(app).get('/api/nowhere').set('Authorization', `Bearer ${apiKey.plaintext}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No mapping for GET /nowhere', details: {} } });
  });

  it('serves a generated OpenAPI document including the seeded route', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/users/{id}'].get).toBeDefined();
  });

  it('mounts Swagger UI at /api/docs', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('records last-used timestamp on the API key after a successful authenticated request', async () => {
    const apiKey = await seedUserRoute();
    const before = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(apiKey.id) as {
      last_used_at: string | null;
    };
    expect(before.last_used_at).toBeNull();

    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${apiKey.plaintext}`);
    expect(res.status).toBe(200);

    const after = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(apiKey.id) as {
      last_used_at: string | null;
    };
    expect(after.last_used_at).toBeTruthy();
  });

  it('returns a normalized 400 error for malformed JSON request bodies', async () => {
    const res = await request(app)
      .post('/admin/connections')
      .set('Content-Type', 'application/json')
      .send('{"name": "c1", "adapterType":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns a 409 conflict when creating a connection with a duplicate name', async () => {
    await request(app)
      .post('/admin/connections')
      .send({ name: 'dup-conn', adapterType: 'mock', authMode: 'passthrough' });
    const res = await request(app)
      .post('/admin/connections')
      .send({ name: 'dup-conn', adapterType: 'mock', authMode: 'passthrough' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns a 409 conflict when creating a mapping with a duplicate route and method', async () => {
    const connectionRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'dup-mapping-conn', adapterType: 'mock', authMode: 'passthrough' });
    const connectionId = connectionRes.body.id;
    const mappingPayload = {
      connectionId,
      route: '/dup/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id)', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id' },
    };
    await request(app).post('/admin/mappings').send(mappingPayload);
    const res = await request(app).post('/admin/mappings').send(mappingPayload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns a 400 error when creating a mapping with a connectionId that does not exist', async () => {
    const res = await request(app)
      .post('/admin/mappings')
      .send({
        connectionId: 'nonexistent-connection-id',
        route: '/orphan/{id}',
        method: 'GET',
        operation: { query: 'user(id: $id)', variables: { id: '$params.id' } },
        responseTemplate: { id: '$.id' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

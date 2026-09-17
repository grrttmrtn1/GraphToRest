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

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-server-${Date.now()}-${Math.random()}.db`);
  mappingStore = new MappingStore(openDb(dbPath));
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
  return apiKeyRes.body.plaintext as string;
}

describe('server integration', () => {
  it('serves the resolved mapping for an authenticated request', async () => {
    const apiKey = await seedUserRoute();
    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${apiKey}`);
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
    const res = await request(app).get('/api/nowhere').set('Authorization', `Bearer ${apiKey}`);
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
});

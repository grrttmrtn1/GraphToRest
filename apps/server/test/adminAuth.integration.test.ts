import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, TEST_ADMIN_PASSWORD } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let store: MappingStore;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-adminauth-int-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
  });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('admin authentication', () => {
  it('rejects admin requests with no token, a malformed header, or a garbage token', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer garbage']) {
      const req = request(app).get('/admin/connections');
      const res = header ? await req.set('Authorization', header) : await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('logs in with valid credentials and the token then works', async () => {
    store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const login = await request(app).post('/admin/login').send({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
    expect(login.body.expiresAt).toEqual(expect.any(String));

    const res = await request(app).get('/admin/connections').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with a generic 401', async () => {
    store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const wrong = await request(app).post('/admin/login').send({ username: 'admin', password: 'not-the-password' });
    const unknown = await request(app).post('/admin/login').send({ username: 'ghost', password: TEST_ADMIN_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects a login body that is missing fields', async () => {
    const res = await request(app).post('/admin/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('logout invalidates the token', async () => {
    const admin = createAdminClient(app, store);
    expect((await admin.get('/admin/connections')).status).toBe(200);
    expect((await admin.post('/admin/logout').send({})).status).toBe(204);
    const after = await admin.get('/admin/connections');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired session', async () => {
    const user = store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const { token } = store.createAdminSession(user.id, -1000);
    const res = await request(app).get('/admin/connections').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('creates admin users through the API, with 409 for a duplicate and 400 for a weak password', async () => {
    const admin = createAdminClient(app, store);
    const created = await admin.post('/admin/admin-users').send({ username: 'second', password: 'another-long-password' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), username: 'second' });
    expect(JSON.stringify(created.body)).not.toContain('another-long-password');

    const dup = await admin.post('/admin/admin-users').send({ username: 'second', password: 'another-long-password' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const weak = await admin.post('/admin/admin-users').send({ username: 'third', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects an over-long password on POST /admin/admin-users', async () => {
    const admin = createAdminClient(app, store);
    const res = await admin.post('/admin/admin-users').send({ username: 'long', password: 'x'.repeat(1025) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('does not affect API-key auth on /api/*', async () => {
    const res = await request(app).get('/api/anything');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Missing API key');
  });
});

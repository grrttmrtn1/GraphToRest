import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { LoginThrottle } from '../src/middleware/loginThrottle';
import { createAdminClient, TEST_ADMIN_PASSWORD } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let store: MappingStore;
let throttle: LoginThrottle;
let clock = 1_000_000;

beforeEach(() => {
  registerDefaultAdapters();
  clock = 1_000_000;
  dbPath = path.join(os.tmpdir(), `graphtorest-loginthrottle-int-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  throttle = new LoginThrottle({ now: () => clock });
  app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    loginThrottle: throttle,
  });
  createAdminClient(app, store); // seeds the 'test-admin' user (and an unused session)
});

afterEach(() => {
  throttle.stop();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('admin login throttling', () => {
  it('returns 429 LOGIN_THROTTLED with Retry-After after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/admin/login').send({ username: 'test-admin', password: 'wrong-password-000' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_THROTTLED');
    expect(blocked.headers['retry-after']).toBe('60');
    clock += 60_000;
    const ok = await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('counts an over-long password as a failure', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/admin/login').send({ username: 'test-admin', password: 'x'.repeat(2000) });
    expect((await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD })).status).toBe(429);
  });
});

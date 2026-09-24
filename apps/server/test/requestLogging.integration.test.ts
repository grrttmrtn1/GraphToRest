import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, createLogger } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;
let lines: Array<Record<string, unknown>>;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-reqlog-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  const store = new MappingStore(db);
  lines = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
  app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: true, adminEnabled: true, logger });
  admin = createAdminClient(app, store);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

const completed = () => lines.filter((l) => l.msg === 'request_completed');

describe('request_completed log lines', () => {
  it('logs an /api request with gateway fields and no query string or secrets', async () => {
    const conn = await admin.post('/admin/connections').send({ name: 'm', adapterType: 'mock', authMode: 'passthrough' });
    await admin.post('/admin/mappings').send({ connectionId: conn.body.id, route: '/users/{id}', method: 'GET', operation: { resource: 'user' } });
    const key = await admin.post('/admin/api-keys').send({});
    lines.length = 0;
    await request(app).get('/api/users/7?secret=shh').set('Authorization', `Bearer ${key.body.plaintext}`).set('X-Vendor-Token', 'vendor-tok');
    const [line] = completed();
    expect(line).toMatchObject({ level: 'info', kind: 'api', method: 'GET', path: '/api/users/7', status: 200, apiKeyId: key.body.id, connectionId: conn.body.id });
    expect(typeof line.durationMs).toBe('number');
    const text = JSON.stringify(lines);
    expect(text).not.toContain('shh');
    expect(text).not.toContain('vendor-tok');
    expect(text).not.toContain(key.body.plaintext.split('.')[1]);
  });

  it('logs the error code of a failed /api request', async () => {
    await request(app).get('/api/nothing');
    expect(completed()[0]).toMatchObject({ kind: 'api', status: 401, errorCode: 'UNAUTHORIZED' });
  });

  it('logs /admin requests with the admin user id and never the password', async () => {
    await request(app).post('/admin/login').send({ username: 'test-admin', password: 'wrong-password-xyz' });
    await admin.get('/admin/connections');
    const [login, list] = completed();
    expect(login).toMatchObject({ kind: 'admin', method: 'POST', path: '/admin/login', status: 401 });
    expect(list).toMatchObject({ kind: 'admin', method: 'GET', path: '/admin/connections', status: 200 });
    expect(typeof list.adminUserId).toBe('string');
    expect(JSON.stringify(lines)).not.toContain('wrong-password-xyz');
  });

  it('logs unhandled errors through the logger', async () => {
    const store = new MappingStore(db);
    const broken = createApp({
      mappingStore: store,
      gatewayEngine: { handle: () => Promise.reject(new TypeError('kaboom')) } as unknown as GatewayEngine,
      openApiGenerator: new OpenApiGenerator(),
      apiEnabled: true,
      adminEnabled: false,
      logger: createLogger({ write: (line) => lines.push(JSON.parse(line)) }),
    });
    const key = store.createApiKey({});
    lines.length = 0;
    const res = await request(broken).get('/api/x').set('Authorization', `Bearer ${key.plaintext}`);
    expect(res.status).toBe(500);
    const err = lines.find((l) => l.msg === 'unhandled_error')!;
    expect((err.error as Record<string, unknown>).message).toBe('kaboom');
  });
});

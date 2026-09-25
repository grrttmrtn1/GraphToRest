import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-healthz-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  if (db.open) db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('GET /healthz', () => {
  it('is available with API and admin disabled and is not logged to request_log', async () => {
    const app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: false, adminEnabled: false });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(store.listRequests({ limit: 10 })).toEqual([]);
  });

  it('returns 503 when the database is unusable', async () => {
    const app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: true, adminEnabled: true });
    db.close();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error' });
  });
});

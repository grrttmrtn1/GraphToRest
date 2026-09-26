import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { ApiAuthThrottle } from '../src/middleware/apiAuthThrottle';

const dbPaths: string[] = [];
const throttles: ApiAuthThrottle[] = [];

function setup(failuresPerMinute: number) {
  registerDefaultAdapters();
  const dbPath = path.join(os.tmpdir(), `graphtorest-apiauththrottle-${Date.now()}-${Math.random()}.db`);
  dbPaths.push(dbPath);
  const store = new MappingStore(openDb(dbPath));
  const apiAuthThrottle = new ApiAuthThrottle({ failuresPerMinute });
  throttles.push(apiAuthThrottle);
  const app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: false,
    apiAuthThrottle,
  });
  const key = store.createApiKey({ label: 'good' });
  return { app, key };
}

const call = (app: ReturnType<typeof createApp>, bearer: string) => request(app).get('/api/anything').set('Authorization', `Bearer ${bearer}`);

afterEach(() => {
  for (const throttle of throttles.splice(0)) throttle.stop();
  for (const dbPath of dbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('pre-auth failure throttle on /api', () => {
  it('answers 429 without verifying once an address has spent its failure budget on unknown keys', async () => {
    const { app } = setup(3);
    for (let i = 0; i < 3; i += 1) expect((await call(app, `bad${i}.secret`)).status).toBe(401);
    const throttled = await call(app, 'bad9.secret');
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('AUTH_THROTTLED');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
    expect(throttled.body.error.details.retryAfterSeconds).toBe(Number(throttled.headers['retry-after']));
  });

  it('spends the budget before hashing, so concurrent unknown keys cannot all get through', async () => {
    const { app } = setup(3);
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => call(app, `bad${i}.secret`)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('never throttles a request carrying a real key id', async () => {
    const { app, key } = setup(3);
    for (let i = 0; i < 4; i += 1) await call(app, `bad${i}.secret`);
    const good = await call(app, key.plaintext);
    expect([401, 429]).not.toContain(good.status);
    const wrongSecret = await call(app, `${key.id}.wrong-secret`);
    expect(wrongSecret.status).toBe(401);
  });

  it('does not spend budget on valid keys', async () => {
    const { app, key } = setup(3);
    for (let i = 0; i < 10; i += 1) await call(app, key.plaintext);
    for (let i = 0; i < 3; i += 1) expect((await call(app, `bad${i}.secret`)).status).toBe(401);
  });

  it('is disabled with a budget of 0', async () => {
    const { app } = setup(0);
    for (let i = 0; i < 10; i += 1) expect((await call(app, `bad${i}.secret`)).status).toBe(401);
  });
});

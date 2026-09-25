import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { LoginThrottle } from '../src/middleware/loginThrottle';

const dbPaths: string[] = [];
const throttles: LoginThrottle[] = [];

function makeApp(trustProxy: boolean | number | string | undefined) {
  registerDefaultAdapters();
  const dbPath = path.join(os.tmpdir(), `graphtorest-trustproxy-${Date.now()}-${Math.random()}.db`);
  dbPaths.push(dbPath);
  const store = new MappingStore(openDb(dbPath));
  const throttle = new LoginThrottle();
  throttles.push(throttle);
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    loginThrottle: throttle,
    trustProxy,
  });
}

/** Five failed logins from `ip`, each for a different username, so only the IP key can reach the lockout. */
async function failFiveTimes(app: ReturnType<typeof createApp>, ip: string): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await request(app).post('/admin/login').set('X-Forwarded-For', ip).send({ username: `nobody-${ip}-${i}`, password: 'wrong-password-123' });
  }
}

afterEach(() => {
  for (const throttle of throttles.splice(0)) throttle.stop();
  for (const dbPath of dbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('TRUST_PROXY', () => {
  it('keys the login throttle by the forwarded client address when trusted', async () => {
    const app = makeApp(1);
    await failFiveTimes(app, '198.51.100.1');
    const sameIp = await request(app).post('/admin/login').set('X-Forwarded-For', '198.51.100.1').send({ username: 'fresh-a', password: 'wrong-password-123' });
    expect(sameIp.status).toBe(429);
    const otherIp = await request(app).post('/admin/login').set('X-Forwarded-For', '198.51.100.2').send({ username: 'fresh-b', password: 'wrong-password-123' });
    expect(otherIp.status).toBe(401);
  });

  it('ignores X-Forwarded-For when not trusted (the default)', async () => {
    const app = makeApp(undefined);
    await failFiveTimes(app, '198.51.100.1');
    const otherIp = await request(app).post('/admin/login').set('X-Forwarded-For', '198.51.100.2').send({ username: 'fresh-b', password: 'wrong-password-123' });
    expect(otherIp.status).toBe(429);
  });
});

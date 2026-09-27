import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

const PASSWORD = 'correct-horse-battery';
const BASE_URL = 'http://gtr.example.test';

let dbPath: string;
let store: MappingStore;

function buildApp(publicBaseUrl = BASE_URL) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    publicBaseUrl,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-cookie-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  store.createAdminUser({ username: 'admin', password: PASSWORD });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

/** Logs in with a cookie session and returns the raw Set-Cookie header and the "name=value" pair to send back. */
async function cookieLogin(app: ReturnType<typeof createApp>) {
  const res = await request(app).post('/admin/login').send({ username: 'admin', password: PASSWORD, session: 'cookie' });
  expect(res.status).toBe(200);
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
  return { res, setCookie, cookie: setCookie.split(';')[0] };
}

const CONNECTION = { name: 'c1', adapterType: 'mock', authMode: 'passthrough' };

describe('cookie login', () => {
  it('sets an HttpOnly SameSite=Strict cookie scoped to /admin and keeps the token out of the body', async () => {
    const app = buildApp();
    const { res, setCookie } = await cookieLogin(app);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'username']);
    expect(res.body.username).toBe('admin');
    expect(setCookie).toMatch(/^gtr_admin_session=[^;]+/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/admin');
    expect(setCookie).toMatch(/Max-Age=(28[0-7]\d\d|28800)\b/); // default 8h TTL, allowing for elapsed seconds
    expect(setCookie).not.toContain('Secure');
  });

  it('marks the cookie Secure when PUBLIC_BASE_URL is https', async () => {
    const { setCookie } = await cookieLogin(buildApp('https://gtr.example.test'));
    expect(setCookie).toContain('Secure');
  });

  it('keeps the bearer-token login unchanged when "session" is absent', async () => {
    const res = await request(buildApp()).post('/admin/login').send({ username: 'admin', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an unknown "session" value', async () => {
    const res = await request(buildApp()).post('/admin/login').send({ username: 'admin', password: PASSWORD, session: 'jar' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('cookie-authenticated requests', () => {
  it('authenticates reads and reports the session', async () => {
    const app = buildApp();
    const { cookie, res: login } = await cookieLogin(app);
    expect((await request(app).get('/admin/connections').set('Cookie', cookie)).status).toBe(200);
    const session = await request(app).get('/admin/session').set('Cookie', cookie);
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ username: 'admin', expiresAt: login.body.expiresAt });
  });

  it('reports 401 from /admin/session without a session', async () => {
    expect((await request(buildApp()).get('/admin/session')).status).toBe(401);
  });

  it('accepts a write whose Origin matches the Host header', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app)
      .post('/admin/connections')
      .set('Cookie', cookie)
      .set('Host', 'lan-box:3000')
      .set('Origin', 'http://lan-box:3000')
      .send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('rejects an Origin whose host matches but scheme differs', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app)
      .post('/admin/connections')
      .set('Cookie', cookie)
      .set('Host', 'lan-box:3000')
      .set('Origin', 'https://lan-box:3000')
      .send(CONNECTION);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('accepts a write whose Origin matches PUBLIC_BASE_URL', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set('Origin', BASE_URL).send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('accepts a write without Origin when Sec-Fetch-Site is same-origin', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set('Sec-Fetch-Site', 'same-origin').send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it.each([
    ['a cross-site Origin', { Origin: 'https://evil.example' }],
    ['an unparseable Origin', { Origin: 'null' }],
    ['no Origin and no Sec-Fetch-Site', {}],
    ['no Origin and a cross-site Sec-Fetch-Site', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('rejects a write with %s and changes nothing', async (_label, headers) => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set(headers as Record<string, string>).send(CONNECTION);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect(store.listConnections()).toEqual([]);
  });

  it('rejects a same-origin write whose body is not JSON', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app)
      .post('/admin/connections')
      .set('Cookie', cookie)
      .set('Origin', BASE_URL)
      .set('Content-Type', 'text/plain')
      .send('name=c1');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('does not apply CSRF checks to GET requests', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).get('/admin/connections').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it('exempts bearer-authenticated requests from CSRF checks', async () => {
    const app = buildApp();
    const login = await request(app).post('/admin/login').send({ username: 'admin', password: PASSWORD });
    const res = await request(app)
      .post('/admin/connections')
      .set('Authorization', `Bearer ${login.body.token}`)
      .set('Origin', 'https://evil.example')
      .send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('uses the Authorization header when present, even if a valid cookie is also sent', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).get('/admin/connections').set('Cookie', cookie).set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('cookie logout', () => {
  it('deletes the session and clears the cookie', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/logout').set('Cookie', cookie).set('Origin', BASE_URL);
    expect(res.status).toBe(204);
    const cleared = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cleared).toMatch(/^gtr_admin_session=;/);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/admin');
    expect((await request(app).get('/admin/session').set('Cookie', cookie)).status).toBe(401);
  });
});

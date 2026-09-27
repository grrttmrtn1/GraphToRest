import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient } from './helpers';

const INDEX_HTML = '<!doctype html><html><head><title>gtr-test-index</title></head><body></body></html>';
const CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

let dbPath: string;
let webRoot: string;
let store: MappingStore;

function buildApp(options: { webRoot?: string; apiEnabled?: boolean; adminEnabled?: boolean } = {}) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: options.apiEnabled ?? true,
    adminEnabled: options.adminEnabled ?? true,
    webRoot: options.webRoot,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-web-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graphtorest-webroot-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(webRoot, 'assets'));
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("app");');
});

afterEach(() => {
  fs.rmSync(webRoot, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('SPA serving', () => {
  it('serves index.html at / with the CSP header', async () => {
    const res = await request(buildApp({ webRoot })).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('gtr-test-index');
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves static assets with the CSP header', async () => {
    const res = await request(buildApp({ webRoot })).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log("app")');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it.each(['/connections', '/connections/abc?oauth=success', '/api-keys', '/activity', '/test'])(
    'falls back to index.html for the client route %s',
    async (url) => {
      const res = await request(buildApp({ webRoot })).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('gtr-test-index');
    }
  );

  it('never answers /api/* with index.html', async () => {
    const res = await request(buildApp({ webRoot })).get('/api/unknown');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('gtr-test-index');
  });

  it('never answers unknown /admin/* paths with index.html', async () => {
    const app = buildApp({ webRoot });
    const admin = createAdminClient(app, store);
    const res = await admin.get('/admin/no-such-route');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('gtr-test-index');
  });

  it('does not serve index.html for /api or /admin even when those surfaces are disabled', async () => {
    const app = buildApp({ webRoot, apiEnabled: false, adminEnabled: false });
    for (const url of ['/api', '/api/users/1', '/admin', '/admin/login']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('gtr-test-index');
    }
  });

  it('returns a plain 404 with the CSP header for a missing hashed asset under /assets/', async () => {
    const res = await request(buildApp({ webRoot })).get('/assets/app-stale-hash.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('gtr-test-index');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('returns a plain 404 with the CSP header for a missing top-level file with an extension', async () => {
    const res = await request(buildApp({ webRoot })).get('/favicon.ico');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('gtr-test-index');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('still falls back to index.html for a client route whose id segment contains a dot', async () => {
    const res = await request(buildApp({ webRoot })).get('/connections/abc.def');
    expect(res.status).toBe(200);
    expect(res.text).toContain('gtr-test-index');
  });

  it('serves nothing at / without a webRoot', async () => {
    const res = await request(buildApp()).get('/');
    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

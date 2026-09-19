import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { registerAdapter, clearAdapters } from '../../src/adapters/registry';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let seen: Array<{ authMode?: string; vendorToken?: string }>;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-gwmanaged-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  seen = [];
  clearAdapters();
  registerAdapter('spy-managed', () => ({
    type: 'spy-managed',
    async introspect() {
      return {};
    },
    async generateMappings() {
      return [];
    },
    async execute(_operation, _params, authContext) {
      seen.push({ authMode: authContext.authMode, vendorToken: authContext.vendorToken });
      return { ok: true };
    },
  }));
});

afterEach(() => {
  clearAdapters();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seed(authMode: string) {
  const connection = store.createConnection({ name: `c-${authMode}`, adapterType: 'spy-managed', authMode });
  store.createMapping({ connectionId: connection.id, route: '/thing', method: 'GET', operation: {} });
}

describe('GatewayEngine with managed auth', () => {
  it('gives managed connections the provider token and ignores the incoming X-Vendor-Token', async () => {
    seed('managed');
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' });
    await engine.handle('GET', '/thing', { vendorToken: 'developer-token' });
    expect(seen).toEqual([{ authMode: 'managed', vendorToken: 'managed-token' }]);
  });

  it('fails with a 503 MANAGED_AUTH_UNAVAILABLE when no provider is configured', async () => {
    seed('managed');
    const engine = new GatewayEngine(store);
    await expect(engine.handle('GET', '/thing')).rejects.toMatchObject({ code: 'MANAGED_AUTH_UNAVAILABLE', status: 503 });
    expect(seen).toEqual([]);
  });

  it('propagates provider errors unchanged', async () => {
    seed('managed');
    const engine = new GatewayEngine(store, {
      getAccessToken: async () => {
        throw Object.assign(new Error('vendor said no'), { code: 'VENDOR_AUTH_FAILED', status: 502 });
      },
    });
    await expect(engine.handle('GET', '/thing')).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('leaves passthrough connections untouched even when a provider exists', async () => {
    seed('passthrough');
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' });
    await engine.handle('GET', '/thing', { vendorToken: 'developer-token' });
    expect(seen).toEqual([{ authMode: 'passthrough', vendorToken: 'developer-token' }]);
  });
});

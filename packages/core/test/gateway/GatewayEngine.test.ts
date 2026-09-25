import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { GatewayError } from '../../src/gateway/errors';
import { ResponseCache } from '../../src/gateway/ResponseCache';
import { registerAdapter } from '../../src/adapters/registry';
import { MockAdapter } from '../../src/adapters/MockAdapter';
import type { Adapter, AuthContext } from '../../src/adapters/Adapter';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let engine: GatewayEngine;

// Test adapter that captures the operation passed to execute()
class SpyAdapter implements Adapter {
  readonly type = 'spy';
  capturedOperation: Record<string, unknown> | null = null;

  async introspect(authContext: AuthContext): Promise<unknown> {
    return null;
  }

  async generateMappings(introspection: unknown): Promise<any[]> {
    return [];
  }

  async execute(
    operation: Record<string, unknown>,
    params: Record<string, string>,
    authContext: AuthContext
  ): Promise<unknown> {
    this.capturedOperation = operation;
    return { id: params.id, displayName: 'Spy User', mail: 'spy@example.com' };
  }
}

beforeEach(() => {
  registerAdapter('mock', () => new MockAdapter());
  dbPath = path.join(os.tmpdir(), `graphtorest-gateway-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  engine = new GatewayEngine(store);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seedUserMapping() {
  const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
  return store.createMapping({
    connectionId: connection.id,
    route: '/users/{id}',
    method: 'GET',
    operation: { query: 'user(id: $id) { id, displayName, mail }', variables: { id: '$params.id' } },
    responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
  });
}

describe('GatewayEngine.resolve', () => {
  it('finds a mapping matching method and path, extracting params', () => {
    seedUserMapping();
    const resolved = engine.resolve('GET', '/users/42');
    expect(resolved?.params).toEqual({ id: '42' });
  });

  it('returns null when no mapping matches', () => {
    seedUserMapping();
    expect(engine.resolve('GET', '/groups/42')).toBeNull();
  });

  it('is case-insensitive on method', () => {
    seedUserMapping();
    expect(engine.resolve('get', '/users/42')).not.toBeNull();
  });
});

describe('GatewayEngine.handle', () => {
  it('resolves variables from params, executes the adapter, and shapes the response by template', async () => {
    seedUserMapping();
    const result = await engine.handle('GET', '/users/42');
    expect(result).toEqual({ id: '42', name: 'Mock User', email: 'mock@example.com' });
  });

  it('throws a 404 GatewayError when no mapping matches', async () => {
    seedUserMapping();
    await expect(engine.handle('GET', '/nowhere')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(engine.handle('GET', '/nowhere')).rejects.toBeInstanceOf(GatewayError);
  });

  it('substitutes $params.* variables in the operation before passing to adapter.execute', async () => {
    const spyAdapter = new SpyAdapter();
    registerAdapter('spy', () => spyAdapter);
    const connection = store.createConnection({ name: 'c2', adapterType: 'spy', authMode: 'passthrough' });
    store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id)', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
    });
    await engine.handle('GET', '/users/42');
    expect(spyAdapter.capturedOperation).not.toBeNull();
    expect(spyAdapter.capturedOperation?.variables).toEqual({ id: '42' });
  });

  it('throws a 500 GatewayError when mapping references a non-existent connection', async () => {
    // Create a real connection and mapping, then delete the connection to simulate dangling reference
    const connection = store.createConnection({ name: 'c3', adapterType: 'mock', authMode: 'passthrough' });
    store.createMapping({
      connectionId: connection.id,
      route: '/orphaned/{id}',
      method: 'GET',
      operation: { query: 'test' },
      responseTemplate: null,
    });
    // Delete the connection from the database to simulate a dangling reference
    const db = (store as any).db; // Access private db for testing
    db.prepare('PRAGMA foreign_keys = OFF').run();
    db.prepare('DELETE FROM connections WHERE id = ?').run(connection.id);
    db.prepare('PRAGMA foreign_keys = ON').run();

    await expect(engine.handle('GET', '/orphaned/42')).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      status: 500,
    });
    await expect(engine.handle('GET', '/orphaned/42')).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('GatewayEngine.handle request context', () => {
  it('passes the request context (query, body) through to the adapter', async () => {
    const received: unknown[] = [];
    registerAdapter('spy', () => ({
      type: 'spy',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, _authContext, request) {
        received.push(request);
        return {};
      },
    }));
    const connection = store.createConnection({ name: 'spy-conn', adapterType: 'spy', authMode: 'passthrough' });
    store.createMapping({ connectionId: connection.id, route: '/spy/{id}', method: 'GET', operation: {} });

    await engine.handle('GET', '/spy/1', {}, { query: { select: 'id' }, body: { x: 1 } });

    expect(received).toEqual([{ query: { select: 'id' }, body: { x: 1 } }]);
  });

  it('passes the connection authMode through the auth context', async () => {
    const received: unknown[] = [];
    registerAdapter('spy2', () => ({
      type: 'spy2',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, authContext) {
        received.push(authContext.authMode);
        return {};
      },
    }));
    const connection = store.createConnection({ name: 'spy2-conn', adapterType: 'spy2', authMode: 'managed' });
    store.createMapping({ connectionId: connection.id, route: '/spy2/{id}', method: 'GET', operation: {} });

    const managedEngine = new GatewayEngine(store, { getAccessToken: async () => 'stub-token' });
    await managedEngine.handle('GET', '/spy2/1');

    expect(received).toEqual(['managed']);
  });

  it('passes the connection config through the auth context', async () => {
    const received: unknown[] = [];
    registerAdapter('spy3', () => ({
      type: 'spy3',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, authContext) {
        received.push(authContext.config);
        return {};
      },
    }));
    const connection = store.createConnection({
      name: 'spy3-conn',
      adapterType: 'spy3',
      authMode: 'passthrough',
      config: { endpoint: 'https://example.com/graphql' },
    });
    store.createMapping({ connectionId: connection.id, route: '/spy3/{id}', method: 'GET', operation: {} });

    await engine.handle('GET', '/spy3/1');

    expect(received).toEqual([{ endpoint: 'https://example.com/graphql' }]);
  });
});

describe('GatewayEngine response caching', () => {
  it('serves a cached GET without calling the adapter again and reports HIT/MISS and latency', async () => {
    let calls = 0;
    registerAdapter('counting', () => ({
      type: 'counting',
      introspect: async () => ({}),
      generateMappings: async () => [],
      execute: async (_op, params) => ({ n: ++calls, id: params.id }),
    }));
    const conn = store.createConnection({ name: 'cc', adapterType: 'counting', authMode: 'managed' });
    store.createMapping({ connectionId: conn.id, route: '/c/{id}', method: 'GET', operation: {}, cacheTtlSeconds: 60 });
    const cache = new ResponseCache({ maxEntries: 10, maxTtlSeconds: 300 });
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' }, cache);
    const statuses: string[] = [];
    const latencies: number[] = [];
    const hooks = { onCacheStatus: (s: string) => statuses.push(s), onVendorLatency: (ms: number) => latencies.push(ms) };
    expect(await engine.handle('GET', '/c/1', {}, {}, hooks)).toEqual({ n: 1, id: '1' });
    expect(await engine.handle('GET', '/c/1', {}, {}, hooks)).toEqual({ n: 1, id: '1' });
    expect(await engine.handle('GET', '/c/2', {}, {}, hooks)).toEqual({ n: 2, id: '2' });
    expect(statuses).toEqual(['MISS', 'HIT', 'MISS']);
    expect(latencies).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    let fail = true;
    registerAdapter('flaky', () => ({
      type: 'flaky',
      introspect: async () => ({}),
      generateMappings: async () => [],
      execute: async () => {
        if (fail) throw new GatewayError('VENDOR_ERROR', 'down', 502);
        return { ok: true };
      },
    }));
    const conn = store.createConnection({ name: 'fl', adapterType: 'flaky', authMode: 'passthrough' });
    store.createMapping({ connectionId: conn.id, route: '/f', method: 'GET', operation: {}, cacheTtlSeconds: 60 });
    const engine = new GatewayEngine(store, undefined, new ResponseCache({ maxEntries: 10, maxTtlSeconds: 300 }));
    await expect(engine.handle('GET', '/f')).rejects.toThrow('down');
    fail = false;
    expect(await engine.handle('GET', '/f')).toEqual({ ok: true });
  });
});

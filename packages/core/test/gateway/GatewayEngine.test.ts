import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { GatewayError } from '../../src/gateway/errors';
import { registerAdapter } from '../../src/adapters/registry';
import { MockAdapter } from '../../src/adapters/MockAdapter';
import type { Adapter, AuthContext } from '../../src/adapters/Adapter';

let dbPath: string;
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
  store = new MappingStore(openDb(dbPath));
  engine = new GatewayEngine(store);
});

afterEach(() => {
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { registerAdapter, clearAdapters } from '../../src/adapters/registry';
import { generateAndPersistMappings } from '../../src/mappingEngine/generateMappings';
import type { Adapter, AuthContext, MappingDraft } from '../../src/adapters/Adapter';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  clearAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingengine-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function fakeAdapter(drafts: MappingDraft[]): Adapter {
  return {
    type: 'fake',
    async introspect(_authContext: AuthContext) {
      return {};
    },
    async generateMappings() {
      return drafts;
    },
    async execute() {
      return {};
    },
  };
}

describe('generateAndPersistMappings', () => {
  it('creates new mappings for drafts with no existing route/method match', async () => {
    registerAdapter('fake', () =>
      fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'user(id: $id) { id }' } }])
    );
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ route: '/users/{id}', method: 'GET', source: 'generated' });
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(store.listMappings()).toHaveLength(1);
  });

  it('overwrites an existing generated mapping at the same route/method', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const original = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old query' },
      source: 'generated',
    });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(original.id);
    expect(result.updated[0].operation).toEqual({ query: 'new query' });
    expect(result.skipped).toEqual([]);
  });

  it('skips a manual mapping at the same route/method without force', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const manual = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'hand-written' },
      source: 'manual',
    });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]);
    expect(store.getMapping(manual.id)?.operation).toEqual({ query: 'hand-written' });
  });

  it('overwrites a manual mapping when force is true', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const manual = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'hand-written' },
      source: 'manual',
    });

    const result = await generateAndPersistMappings(
      store,
      connection,
      { connectionId: connection.id, authMode: connection.authMode, config: connection.config },
      { force: true }
    );

    expect(result.created).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(manual.id);
    expect(result.updated[0].source).toBe('generated');
    expect(result.updated[0].operation).toEqual({ query: 'new query' });
  });
});

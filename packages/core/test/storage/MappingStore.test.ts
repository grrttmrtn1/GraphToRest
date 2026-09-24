import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingstore-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('MappingStore', () => {
  it('creates and retrieves a connection', () => {
    const created = store.createConnection({ name: 'ms-graph-prod', adapterType: 'mock', authMode: 'passthrough' });
    expect(created.id).toBeTruthy();
    expect(store.getConnection(created.id)).toEqual(created);
    expect(store.listConnections()).toEqual([created]);
  });

  it('returns null for an unknown connection id', () => {
    expect(store.getConnection('nope')).toBeNull();
  });

  it('defaults config to null when not provided', () => {
    const created = store.createConnection({ name: 'c-no-config', adapterType: 'mock', authMode: 'passthrough' });
    expect(created.config).toBeNull();
    expect(store.getConnection(created.id)?.config).toBeNull();
  });

  it('creates and retrieves a connection with a config object', () => {
    const created = store.createConnection({
      name: 'graphql-github',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.github.com/graphql' },
    });
    expect(created.config).toEqual({ endpoint: 'https://api.github.com/graphql' });
    expect(store.getConnection(created.id)?.config).toEqual({ endpoint: 'https://api.github.com/graphql' });
    expect(store.listConnections()).toEqual([created]);
  });

  it('creates and lists a mapping with operation and responseTemplate round-tripped as objects', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id' },
    });
    expect(mapping.source).toBe('generated');
    expect(store.listMappings()).toEqual([mapping]);
  });

  it('defaults mapping source to manual when explicitly requested', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: {},
      source: 'manual',
    });
    expect(mapping.source).toBe('manual');
    expect(mapping.responseTemplate).toBeNull();
  });

  it('gets a mapping by id', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: {} });
    expect(store.getMapping(mapping.id)).toEqual(mapping);
  });

  it('returns null from getMapping for an unknown id', () => {
    expect(store.getMapping('nope')).toBeNull();
  });

  it('finds a mapping by method and route', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: {} });
    expect(store.getMappingByRouteAndMethod('GET', '/users/{id}')).toEqual(mapping);
  });

  it('returns null from getMappingByRouteAndMethod when nothing matches', () => {
    expect(store.getMappingByRouteAndMethod('GET', '/nope')).toBeNull();
  });

  it('updates a mapping in place and sets the given source', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old' },
      source: 'generated',
    });
    const updated = store.updateMapping(mapping.id, {
      operation: { query: 'new' },
      responseTemplate: { id: '$.id' },
      source: 'manual',
    });
    expect(updated).toEqual({
      id: mapping.id,
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'new' },
      responseTemplate: { id: '$.id' },
      source: 'manual',
    });
    expect(store.getMapping(mapping.id)).toEqual(updated);
  });

  it('updateMapping leaves fields not in the patch unchanged', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old' },
      responseTemplate: { id: '$.id' },
      source: 'generated',
    });
    const updated = store.updateMapping(mapping.id, { source: 'manual' });
    expect(updated).toEqual({ ...mapping, source: 'manual' });
  });

  it('returns null from updateMapping for an unknown id', () => {
    expect(store.updateMapping('nope', { source: 'manual' })).toBeNull();
  });

  it('creates an api key whose plaintext verifies against the stored hash', async () => {
    const created = store.createApiKey({ label: 'test key' });
    const found = store.findApiKeyById(created.id);
    expect(found).not.toBeNull();
    const parsed = parsePresentedKey(created.plaintext);
    expect(await verifySecret(parsed!.secret, found!.hashedKey)).toBe(true);
  });

  it('touches last_used_at without throwing', () => {
    const created = store.createApiKey({});
    expect(() => store.touchApiKeyLastUsed(created.id)).not.toThrow();
  });

  it('rejects admin passwords longer than 1024 characters', () => {
    expect(() => store.createAdminUser({ username: 'long', password: 'x'.repeat(1025) })).toThrow('at most 1024');
    store.createAdminUser({ username: 'ok', password: 'x'.repeat(1024) });
    expect(() => store.setAdminPassword('ok', 'y'.repeat(1025))).toThrow('at most 1024');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

let dbPath: string;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingstore-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
});

afterEach(() => {
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

  it('creates an api key whose plaintext verifies against the stored hash', () => {
    const created = store.createApiKey({ label: 'test key' });
    const found = store.findApiKeyById(created.id);
    expect(found).not.toBeNull();
    const parsed = parsePresentedKey(created.plaintext);
    expect(verifySecret(parsed!.secret, found!.hashedKey)).toBe(true);
  });

  it('touches last_used_at without throwing', () => {
    const created = store.createApiKey({});
    expect(() => store.touchApiKeyLastUsed(created.id)).not.toThrow();
  });
});

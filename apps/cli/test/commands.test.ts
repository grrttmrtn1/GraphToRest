import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingCreate, parseRoute } from '../src/commands/mappingCreate';
import { apiKeyCreate } from '../src/commands/apiKeyCreate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-cli-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('parseRoute', () => {
  it('splits "METHOD /path" into method and route', () => {
    expect(parseRoute('GET /users/{id}')).toEqual({ method: 'GET', route: '/users/{id}' });
  });
});

describe('CLI embedded commands', () => {
  it('connectionCreate persists a connection queryable via the same store', () => {
    const store = freshStore();
    const created = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    expect(store.getConnection(created.id)).toEqual(created);
  });

  it('mappingCreate parses the combined route and marks the mapping manual', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = mappingCreate(store, {
      connectionId: connection.id,
      route: 'GET /users/{id}',
      operation: { query: 'user(id: $id) { id }' },
    });
    expect(mapping.method).toBe('GET');
    expect(mapping.route).toBe('/users/{id}');
    expect(mapping.source).toBe('manual');
  });

  it('apiKeyCreate returns a plaintext key that round-trips through the store', () => {
    const store = freshStore();
    const created = apiKeyCreate(store, { label: 'ci' });
    expect(store.findApiKeyById(created.id)?.id).toBe(created.id);
  });
});

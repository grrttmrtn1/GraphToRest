import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-credentials-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('MappingStore connection credentials', () => {
  it('returns null before any credentials are stored', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    expect(store.getConnectionCredentials(c.id)).toBeNull();
  });

  it('stores, replaces and clears an opaque encrypted string', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    expect(store.setConnectionCredentials(c.id, 'v1:a:b:c')).toBe(true);
    expect(store.getConnectionCredentials(c.id)).toBe('v1:a:b:c');
    store.setConnectionCredentials(c.id, 'v1:d:e:f');
    expect(store.getConnectionCredentials(c.id)).toBe('v1:d:e:f');
    store.setConnectionCredentials(c.id, null);
    expect(store.getConnectionCredentials(c.id)).toBeNull();
  });

  it('returns false when the connection does not exist', () => {
    expect(store.setConnectionCredentials('nope', 'x')).toBe(false);
    expect(store.getConnectionCredentials('nope')).toBeNull();
  });

  it('never leaks credentials through ConnectionRecord', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    store.setConnectionCredentials(c.id, 'v1:a:b:c');
    expect(JSON.stringify(store.getConnection(c.id))).not.toContain('v1:a:b:c');
    expect(JSON.stringify(store.listConnections())).not.toContain('v1:a:b:c');
  });
});

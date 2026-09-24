import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';

let dbPath: string;
let db: ReturnType<typeof openDb>;

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore(): MappingStore {
  dbPath = path.join(os.tmpdir(), `graphtorest-webui-store-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  return new MappingStore(db);
}

function seedMapping(store: MappingStore, connectionId: string, route: string) {
  return store.createMapping({ connectionId, route, method: 'GET', operation: { query: 'q' } });
}

describe('deleteConnection', () => {
  it('removes the connection, its mappings and its stored credentials, leaving other connections alone', () => {
    const store = freshStore();
    const doomed = store.createConnection({ name: 'doomed', adapterType: 'mock', authMode: 'managed' });
    const kept = store.createConnection({ name: 'kept', adapterType: 'mock', authMode: 'passthrough' });
    store.setConnectionCredentials(doomed.id, 'v1:encrypted');
    seedMapping(store, doomed.id, '/a');
    const keptMapping = seedMapping(store, kept.id, '/b');

    expect(store.deleteConnection(doomed.id)).toBe(true);

    expect(store.getConnection(doomed.id)).toBeNull();
    expect(store.getConnectionCredentials(doomed.id)).toBeNull();
    expect(store.listMappings()).toEqual([keptMapping]);
    expect(store.getConnection(kept.id)).not.toBeNull();
  });

  it('returns false for an unknown connection', () => {
    expect(freshStore().deleteConnection('nope')).toBe(false);
  });
});

describe('deleteMapping', () => {
  it('deletes one mapping and reports whether it existed', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'c', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = seedMapping(store, connection.id, '/a');
    expect(store.deleteMapping(mapping.id)).toBe(true);
    expect(store.getMapping(mapping.id)).toBeNull();
    expect(store.deleteMapping(mapping.id)).toBe(false);
  });
});

describe('API key listing and deletion', () => {
  it('lists key metadata without any hash, and deletes keys', () => {
    const store = freshStore();
    const first = store.createApiKey({ label: 'first' });
    const second = store.createApiKey({});
    store.touchApiKeyLastUsed(first.id);

    const listed = store.listApiKeys();
    expect(listed.map((k) => k.id).sort()).toEqual([first.id, second.id].sort());
    const firstRow = listed.find((k) => k.id === first.id)!;
    expect(Object.keys(firstRow).sort()).toEqual(['createdAt', 'id', 'label', 'lastUsedAt', 'rateLimit']);
    expect(firstRow.label).toBe('first');
    expect(typeof firstRow.createdAt).toBe('string');
    expect(typeof firstRow.lastUsedAt).toBe('string');
    expect(listed.find((k) => k.id === second.id)!.lastUsedAt).toBeNull();

    expect(store.deleteApiKey(first.id)).toBe(true);
    expect(store.findApiKeyById(first.id)).toBeNull();
    expect(store.deleteApiKey(first.id)).toBe(false);
  });
});

describe('request log', () => {
  const base = { method: 'GET', status: 200, durationMs: 5 };

  it('returns rows newest first with the API key label and connection name joined in', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'conn-a', adapterType: 'mock', authMode: 'passthrough' });
    const key = store.createApiKey({ label: 'dev key' });
    store.recordRequest({ ...base, ts: '2026-09-22T10:00:00.000Z', path: '/api/one' }, 1000);
    store.recordRequest(
      { ...base, ts: '2026-09-22T10:00:01.000Z', path: '/api/two', status: 502, errorCode: 'VENDOR_ERROR', apiKeyId: key.id, connectionId: connection.id, mappingId: 'm-1' },
      1000
    );

    const rows = store.listRequests({ limit: 10 });
    expect(rows.map((r) => r.path)).toEqual(['/api/two', '/api/one']);
    expect(rows[0]).toMatchObject({
      method: 'GET',
      status: 502,
      durationMs: 5,
      errorCode: 'VENDOR_ERROR',
      apiKeyId: key.id,
      apiKeyLabel: 'dev key',
      connectionId: connection.id,
      connectionName: 'conn-a',
      mappingId: 'm-1',
    });
    expect(rows[1]).toMatchObject({ errorCode: null, apiKeyId: null, apiKeyLabel: null, connectionId: null, connectionName: null, mappingId: null });
    expect(typeof rows[0].id).toBe('number');
  });

  it('pages backwards with "before"', () => {
    const store = freshStore();
    for (let i = 1; i <= 5; i++) store.recordRequest({ ...base, ts: `2026-09-22T10:00:0${i}.000Z`, path: `/api/${i}` }, 1000);
    const firstPage = store.listRequests({ limit: 2 });
    expect(firstPage.map((r) => r.path)).toEqual(['/api/5', '/api/4']);
    const secondPage = store.listRequests({ limit: 2, before: firstPage[1].id });
    expect(secondPage.map((r) => r.path)).toEqual(['/api/3', '/api/2']);
  });

  it('keeps only the newest "retention" rows', () => {
    const store = freshStore();
    for (let i = 1; i <= 5; i++) store.recordRequest({ ...base, ts: `2026-09-22T10:00:0${i}.000Z`, path: `/api/${i}` }, 3);
    expect(store.listRequests({ limit: 10 }).map((r) => r.path)).toEqual(['/api/5', '/api/4', '/api/3']);
  });

  it('rejects a retention that is not a positive integer', () => {
    const store = freshStore();
    expect(() => store.recordRequest({ ...base, ts: 't', path: '/api/x' }, 0)).toThrow(/retention/);
  });

  it('keeps log rows after their connection is deleted, with a null connection name', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'gone', adapterType: 'mock', authMode: 'passthrough' });
    store.recordRequest({ ...base, ts: 't', path: '/api/x', connectionId: connection.id }, 1000);
    store.deleteConnection(connection.id);
    expect(store.listRequests({ limit: 10 })[0]).toMatchObject({ connectionId: connection.id, connectionName: null });
  });
});

describe('findAdminSessionDetails', () => {
  it('returns the user and the session expiry, and null for an unknown token', () => {
    const store = freshStore();
    const user = store.createAdminUser({ username: 'admin', password: 'correct-horse-battery' });
    const { token, expiresAt } = store.createAdminSession(user.id, 60_000);
    expect(store.findAdminSessionDetails(token)).toEqual({ user: { id: user.id, username: 'admin' }, expiresAt });
    expect(store.findAdminSessionDetails('bogus')).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { registerAdapter } from '../../src/adapters/registry';
import { MockAdapter } from '../../src/adapters/MockAdapter';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  registerAdapter('mock', () => new MockAdapter());
  dbPath = path.join(os.tmpdir(), `graphtorest-onmatch-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('GatewayEngine onMatch hook', () => {
  it('reports the matched mapping once', async () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
    });
    const onMatch = vi.fn();
    await new GatewayEngine(store).handle('GET', '/users/42', {}, {}, { onMatch });
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenCalledWith(mapping);
  });

  it('reports the mapping even when the connection it points at is missing', async () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/x', method: 'GET', operation: { query: 'q' } });
    vi.spyOn(store, 'getConnection').mockReturnValue(null);
    const onMatch = vi.fn();
    await expect(new GatewayEngine(store).handle('GET', '/x', {}, {}, { onMatch })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    expect(onMatch).toHaveBeenCalledWith(mapping);
  });

  it('is not called when no mapping matches', async () => {
    const onMatch = vi.fn();
    await expect(new GatewayEngine(store).handle('GET', '/nowhere', {}, {}, { onMatch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(onMatch).not.toHaveBeenCalled();
  });
});

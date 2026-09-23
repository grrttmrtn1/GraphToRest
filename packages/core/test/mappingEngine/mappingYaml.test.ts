import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { exportMappingsYaml, importMappingsYaml } from '../../src/mappingEngine/mappingYaml';

let dbPath: string;
let db: ReturnType<typeof openDb>;

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore(): MappingStore {
  dbPath = path.join(os.tmpdir(), `graphtorest-mapping-yaml-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  return new MappingStore(db);
}

function seed(store: MappingStore) {
  const a = store.createConnection({ name: 'conn-a', adapterType: 'mock', authMode: 'passthrough' });
  const b = store.createConnection({ name: 'conn-b', adapterType: 'mock', authMode: 'passthrough' });
  const ma = store.createMapping({ connectionId: a.id, route: '/a', method: 'GET', operation: { query: 'a' } });
  const mb = store.createMapping({ connectionId: b.id, route: '/b', method: 'GET', operation: { query: 'b' } });
  return { a, b, ma, mb };
}

describe('exportMappingsYaml', () => {
  it('exports every mapping, naming each connection', () => {
    const store = freshStore();
    seed(store);
    const entries = YAML.parse(exportMappingsYaml(store));
    expect(entries.map((e: { route: string; connection: string }) => [e.route, e.connection])).toEqual([
      ['GET /a', 'conn-a'],
      ['GET /b', 'conn-b'],
    ]);
  });

  it('limits the export to one connection', () => {
    const store = freshStore();
    const { b } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store, { connectionId: b.id }));
    expect(entries).toHaveLength(1);
    expect(entries[0].route).toBe('GET /b');
  });

  it('throws NOT_FOUND for an unknown connection', () => {
    const store = freshStore();
    expect(() => exportMappingsYaml(store, { connectionId: 'nope' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
  });
});

describe('importMappingsYaml', () => {
  it('round-trips an export, flipping edited generated mappings to manual with a warning', () => {
    const store = freshStore();
    const { ma } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store));
    entries[0].route = 'GET /a-renamed';
    const result = importMappingsYaml(store, YAML.stringify(entries));
    expect(result.records).toHaveLength(2);
    expect(store.getMapping(ma.id)).toMatchObject({ route: '/a-renamed', source: 'manual' });
    expect(result.warnings).toEqual([
      '2 generated mapping(s) are now source=manual and will be skipped by regeneration unless forced',
    ]);
  });

  it('creates new mappings from entries without an id', () => {
    const store = freshStore();
    seed(store);
    const yamlText = YAML.stringify([
      { route: 'POST /new', connection: 'conn-a', source: 'manual', operation: { query: 'n' }, response: { shape: 'passthrough' }, auth: 'inherit' },
    ]);
    const result = importMappingsYaml(store, yamlText);
    expect(result.records[0]).toMatchObject({ route: '/new', method: 'POST', source: 'manual' });
    expect(result.warnings).toEqual([]);
  });

  it('warns that a changed "connection" on an existing mapping is ignored', () => {
    const store = freshStore();
    const { ma } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store, { connectionId: ma.connectionId }));
    entries[0].connection = 'conn-b';
    const result = importMappingsYaml(store, YAML.stringify(entries));
    expect(result.warnings).toContain(
      `Ignoring "connection" on mapping ${ma.id}: an existing mapping's connection cannot be changed by import`
    );
    expect(store.getMapping(ma.id)!.connectionId).toBe(ma.connectionId);
  });

  it('treats an empty document as nothing to import', () => {
    const store = freshStore();
    expect(importMappingsYaml(store, '# nothing here\n')).toEqual({ records: [], warnings: [] });
  });

  it.each([
    ['unparseable YAML', 'route: [unclosed', /Invalid YAML/],
    ['a non-list document', 'route: GET /x', /must be a list/],
    ['a non-object entry', '- just a string', /must be a mapping object/],
    [
      'an unknown connection',
      YAML.stringify([{ route: 'GET /x', connection: 'nope', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]),
      /No connection named "nope"/,
    ],
    [
      'an unknown mapping id',
      YAML.stringify([{ id: 'missing', route: 'GET /x', connection: 'conn-a', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]),
      /No mapping with id missing/,
    ],
    [
      'an invalid entry',
      YAML.stringify([{ route: 'GET /x', connection: 'conn-a', source: 'manual', operation: {}, response: { shape: 'template' }, auth: 'inherit' }]),
      /template/,
    ],
  ])('rejects %s with INVALID_INPUT and writes nothing', (_label, yamlText, message) => {
    const store = freshStore();
    seed(store);
    const before = store.listMappings();
    let caught: unknown;
    try {
      importMappingsYaml(store, yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect((caught as Error).message).toMatch(message);
    expect(store.listMappings()).toEqual(before);
  });

  it('rejects a method+route collision with CONFLICT and rolls back every write', () => {
    const store = freshStore();
    seed(store);
    const before = store.listMappings();
    const yamlText = YAML.stringify([
      { route: 'GET /fresh', connection: 'conn-a', source: 'manual', operation: { query: 'f' }, response: { shape: 'passthrough' }, auth: 'inherit' },
      { route: 'GET /b', connection: 'conn-a', source: 'manual', operation: { query: 'dup' }, response: { shape: 'passthrough' }, auth: 'inherit' },
    ]);
    let caught: unknown;
    try {
      importMappingsYaml(store, yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect((caught as Error).message).toMatch(/UNIQUE/);
    expect(store.listMappings()).toEqual(before);
  });
});

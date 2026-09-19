import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingCreate, parseRoute } from '../src/commands/mappingCreate';
import { apiKeyCreate } from '../src/commands/apiKeyCreate';
import { mappingGenerate } from '../src/commands/mappingGenerate';
import { mappingUpdate } from '../src/commands/mappingUpdate';
import { mappingExport } from '../src/commands/mappingExport';
import { mappingImport } from '../src/commands/mappingImport';

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

  it('rejects a route string with no method', () => {
    expect(() => parseRoute('/users/{id}')).toThrow(/Malformed route/);
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

  it('connectionCreate persists an optional config object', () => {
    const store = freshStore();
    const created = connectionCreate(store, {
      name: 'graphql-conn',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.example.com/graphql' },
    });
    expect(store.getConnection(created.id)?.config).toEqual({ endpoint: 'https://api.example.com/graphql' });
  });

  it('mappingGenerate persists drafts from the connection adapter', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });

    const result = await mappingGenerate(store, { connectionId: connection.id });

    expect(result.created).toHaveLength(1);
    expect(store.listMappings()).toHaveLength(1);
  });

  it('mappingGenerate throws for an unknown connection id', async () => {
    const store = freshStore();
    await expect(mappingGenerate(store, { connectionId: 'nope' })).rejects.toThrow('No connection with id nope');
  });

  it('mappingUpdate flips the mapping source to manual', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const generated = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: { query: 'a' } });

    const updated = mappingUpdate(store, { id: generated.id, operation: { query: 'b' } });

    expect(updated.source).toBe('manual');
    expect(updated.operation).toEqual({ query: 'b' });
  });

  it('mappingUpdate throws for an unknown mapping id', () => {
    const store = freshStore();
    expect(() => mappingUpdate(store, { id: 'nope' })).toThrow('No mapping with id nope');
  });

  it('mappingExport writes YAML that mappingImport can read back to update the same mapping', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'original' },
      source: 'generated',
    });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-export-${Date.now()}-${Math.random()}.yaml`);

    mappingExport(store, { outFile: yamlPath });
    let yamlText = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlText).toContain('route: GET /users/{id}');
    yamlText = yamlText.replace('original', 'hand-edited');
    fs.writeFileSync(yamlPath, yamlText, 'utf8');

    const imported = mappingImport(store, { file: yamlPath });

    expect(imported).toHaveLength(1);
    expect(store.getMapping(mapping.id)?.operation).toEqual({ query: 'hand-edited' });
    expect(store.getMapping(mapping.id)?.source).toBe('manual');
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport creates a new manual mapping from a hand-authored YAML entry with no id', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-new-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(
      yamlPath,
      [
        '- connection: c1',
        '  route: "GET /widgets/{id}"',
        '  source: generated',
        '  operation:',
        '    query: "widget(id: $id) { id }"',
        '  response:',
        '    shape: passthrough',
        '  auth: inherit',
        '',
      ].join('\n'),
      'utf8'
    );

    const imported = mappingImport(store, { file: yamlPath });

    expect(imported).toHaveLength(1);
    expect(imported[0].route).toBe('/widgets/{id}');
    expect(imported[0].method).toBe('GET');
    expect(imported[0].source).toBe('manual');
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport throws when the YAML entry references an unknown connection', () => {
    const store = freshStore();
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-badconn-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(
      yamlPath,
      '- connection: nope\n  route: "GET /x"\n  source: manual\n  operation: {}\n  response:\n    shape: passthrough\n  auth: inherit\n',
      'utf8'
    );

    expect(() => mappingImport(store, { file: yamlPath })).toThrow(/nope/);
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport rejects the whole file atomically when a later entry is invalid', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-atomic-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(
      yamlPath,
      [
        '- connection: c1',
        '  route: "GET /widgets/{id}"',
        '  source: generated',
        '  operation:',
        '    query: "widget(id: $id) { id }"',
        '  response:',
        '    shape: passthrough',
        '  auth: inherit',
        '- connection: nope',
        '  route: "GET /other"',
        '  source: manual',
        '  operation: {}',
        '  response:',
        '    shape: passthrough',
        '  auth: inherit',
        '',
      ].join('\n'),
      'utf8'
    );

    expect(() => mappingImport(store, { file: yamlPath })).toThrow(/nope/);
    expect(store.listMappings()).toHaveLength(0);
    fs.unlinkSync(yamlPath);
  });
  it('mappingImport rolls back earlier writes when a later entry violates UNIQUE(method, route)', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const entry = (route: string) =>
      ['- connection: c1', `  route: "${route}"`, '  source: manual', '  operation: {}', '  response:', '    shape: passthrough', '  auth: inherit'].join('\n');
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-unique-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(yamlPath, [entry('GET /a'), entry('GET /b'), entry('GET /b'), ''].join('\n'), 'utf8');

    expect(() => mappingImport(store, { file: yamlPath })).toThrow(/UNIQUE/);
    expect(store.listMappings()).toHaveLength(0);
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport warns when it flips generated mappings to manual', () => {
    const store = freshStore();
    const conn = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const created = store.createMapping({
      connectionId: conn.id,
      route: '/a',
      method: 'GET',
      operation: {},
      responseTemplate: null,
      source: 'generated',
    });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-warn-${Date.now()}-${Math.random()}.yaml`);
    mappingExport(store, { outFile: yamlPath });
    const warnings: string[] = [];

    mappingImport(store, { file: yamlPath, warn: (m) => warnings.push(m) });

    expect(store.getMapping(created.id)?.source).toBe('manual');
    expect(warnings).toEqual([expect.stringMatching(/1 generated mapping/)]);
    fs.unlinkSync(yamlPath);
  });
});

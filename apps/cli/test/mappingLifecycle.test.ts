import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingGenerate } from '../src/commands/mappingGenerate';
import { mappingUpdate } from '../src/commands/mappingUpdate';
import { mappingExport } from '../src/commands/mappingExport';
import { mappingImport } from '../src/commands/mappingImport';

let dbPath: string;
let yamlPath: string | undefined;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  if (yamlPath && fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
  yamlPath = undefined;
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-lifecycle-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('mapping lifecycle via the CLI embedded commands', () => {
  it('generates, edits, regenerates (skip then force), and round-trips a hand-edit through YAML export/import', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });

    const generated = await mappingGenerate(store, { connectionId: connection.id });
    expect(generated.created).toHaveLength(1);
    const mappingId = generated.created[0].id;

    const edited = mappingUpdate(store, { id: mappingId, operation: { query: 'hand-edited' } });
    expect(edited.source).toBe('manual');

    const skipResult = await mappingGenerate(store, { connectionId: connection.id });
    expect(skipResult.skipped).toHaveLength(1);
    expect(store.getMapping(mappingId)?.operation).toEqual({ query: 'hand-edited' });

    const forceResult = await mappingGenerate(store, { connectionId: connection.id, force: true });
    expect(forceResult.updated).toHaveLength(1);
    expect(store.getMapping(mappingId)?.source).toBe('generated');

    yamlPath = path.join(os.tmpdir(), `graphtorest-lifecycle-export-${Date.now()}-${Math.random()}.yaml`);
    mappingExport(store, { outFile: yamlPath });
    let yamlText = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlText).toContain('source: generated');
    yamlText = yamlText.replace(/query:.*$/m, 'query: edited-again');
    fs.writeFileSync(yamlPath, yamlText, 'utf8');

    const imported = mappingImport(store, { file: yamlPath });
    expect(imported).toHaveLength(1);
    expect(store.getMapping(mappingId)?.operation).toEqual({
      query: 'edited-again',
      variables: { id: '$params.id' },
    });
    expect(store.getMapping(mappingId)?.source).toBe('manual');
  });
});

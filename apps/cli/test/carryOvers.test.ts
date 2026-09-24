import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingExport } from '../src/commands/mappingExport';

let dbPath: string;
const cleanup: string[] = [];

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-carry-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('mapping-export output file', () => {
  it('creates missing parent directories and leaves no temp file behind', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const dir = path.join(os.tmpdir(), `graphtorest-export-${Date.now()}-${Math.random()}`);
    cleanup.push(dir);
    const outFile = path.join(dir, 'nested', 'deep', 'mappings.yaml');

    const text = mappingExport(store, { outFile });

    expect(fs.readFileSync(outFile, 'utf8')).toBe(text);
    expect(fs.readdirSync(path.dirname(outFile))).toEqual(['mappings.yaml']);
  });
});

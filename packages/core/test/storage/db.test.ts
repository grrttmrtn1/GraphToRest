import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';

const tmpFiles: string[] = [];

function tmpDbPath(): string {
  const file = path.join(os.tmpdir(), `graphtorest-test-${Date.now()}-${Math.random()}.db`);
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
    }
  }
});

describe('openDb', () => {
  it('creates all five tables from a fresh file', () => {
    const db = openDb(tmpDbPath());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['admin_sessions', 'admin_users', 'api_keys', 'connections', 'mappings']);
    db.close();
  });

  it('creates the parent directory if it does not exist', () => {
    const nested = path.join(os.tmpdir(), `graphtorest-nested-${Date.now()}`, 'sub', 'db.sqlite');
    tmpFiles.push(nested);
    const db = openDb(nested);
    expect(fs.existsSync(nested)).toBe(true);
    db.close();
    fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
  });

  it('is idempotent across repeated opens of the same file', () => {
    const file = tmpDbPath();
    openDb(file).close();
    const db = openDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.length).toBe(5);
    db.close();
  });

  it('adds a nullable config column to connections, idempotently across repeated opens', () => {
    const file = tmpDbPath();
    openDb(file).close();
    const db = openDb(file);
    const columns = db.prepare('PRAGMA table_info(connections)').all().map((c: any) => c.name);
    expect(columns).toContain('config');
    db.close();
  });
});

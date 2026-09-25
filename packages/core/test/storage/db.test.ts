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
  it('creates all six tables from a fresh file', () => {
    const db = openDb(tmpDbPath());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['admin_sessions', 'admin_users', 'api_keys', 'connections', 'mappings', 'request_log']);
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
    expect(tables.length).toBe(6);
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

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')('openDb file permissions', () => {
  it('creates a missing directory 0700 and the DB file 0600', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-perm-'));
    dirs.push(root);
    const file = path.join(root, 'nested', 'g.db');
    openDb(file).close();
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('tightens an existing DB file but leaves an existing directory alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-perm-'));
    dirs.push(root);
    fs.chmodSync(root, 0o755);
    const file = path.join(root, 'g.db');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
    openDb(file).close();
    expect(mode(file)).toBe(0o600);
    expect(mode(root)).toBe(0o755);
  });
});

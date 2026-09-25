import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, MappingStore, createLogger, loginAdmin } from '@graphtorest/core';
import { bootstrapAdmin } from '../src/bootstrap';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let lines: string[];
const logger = () => createLogger({ write: (line) => lines.push(line) });

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `gtr-bootstrap-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  lines = [];
});
afterEach(() => {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
});

const ADMIN = { username: 'root', password: 'correct-horse-battery' };

describe('bootstrapAdmin', () => {
  it('does nothing when not configured', () => {
    expect(bootstrapAdmin(store, null, logger())).toBe('not-configured');
    expect(store.countAdminUsers()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('creates the first admin and logs the username only', async () => {
    expect(bootstrapAdmin(store, ADMIN, logger())).toBe('created');
    expect(await loginAdmin(store, 'root', ADMIN.password)).not.toBeNull();
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'bootstrap_admin_created', username: 'root' });
    expect(lines.join('\n')).not.toContain(ADMIN.password);
  });

  it('skips when an admin already exists', () => {
    store.createAdminUser({ username: 'existing', password: 'another-long-password' });
    expect(bootstrapAdmin(store, ADMIN, logger())).toBe('skipped');
    expect(store.findAdminUserByUsername('root')).toBeNull();
    expect(JSON.parse(lines[0]).msg).toBe('bootstrap_admin_skipped');
  });

  it('throws on an invalid password and creates nothing', () => {
    expect(() => bootstrapAdmin(store, { username: 'root', password: 'short' }, logger())).toThrow('at least 12');
    expect(store.countAdminUsers()).toBe(0);
  });
});

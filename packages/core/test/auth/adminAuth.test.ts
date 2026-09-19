import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { loginAdmin } from '../../src/auth/adminAuth';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

const PASSWORD = 'correct-horse-battery';

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-adminauth-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('admin users', () => {
  it('creates a user, hashes the password, and counts users', () => {
    expect(store.countAdminUsers()).toBe(0);
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(user).toEqual({ id: expect.any(String), username: 'admin' });
    expect(store.countAdminUsers()).toBe(1);
    const found = store.findAdminUserByUsername('admin');
    expect(found?.hashedPassword).toBeTruthy();
    expect(found?.hashedPassword).not.toContain(PASSWORD);
    expect(store.findAdminUserByUsername('nobody')).toBeNull();
  });

  it('rejects a short password and an empty username with a 400 GatewayError', () => {
    expect(() => store.createAdminUser({ username: 'admin', password: 'short' })).toThrow(/at least 12/);
    expect(() => store.createAdminUser({ username: '  ', password: PASSWORD })).toThrow(/username/);
    try {
      store.createAdminUser({ username: 'admin', password: 'short' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    }
  });

  it('rejects a duplicate username with a unique-constraint error', () => {
    store.createAdminUser({ username: 'admin', password: PASSWORD });
    try {
      store.createAdminUser({ username: 'admin', password: PASSWORD });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    }
  });
});

describe('loginAdmin and sessions', () => {
  it('returns a session token for valid credentials that resolves back to the user', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const session = loginAdmin(store, 'admin', PASSWORD);
    expect(session).not.toBeNull();
    expect(store.findAdminSession(session!.token)).toEqual(user);
  });

  it('returns null for a wrong password or an unknown user', () => {
    store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(loginAdmin(store, 'admin', 'wrong-password-here')).toBeNull();
    expect(loginAdmin(store, 'nobody', PASSWORD)).toBeNull();
  });

  it('stores only a hash of the session token', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, 60_000);
    const rows = db.prepare('SELECT token_hash FROM admin_sessions').all() as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(token);
  });

  it('treats an expired session as invalid', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, -1000);
    expect(store.findAdminSession(token)).toBeNull();
  });

  it('returns null for an unknown token and supports logout', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(store.findAdminSession('garbage')).toBeNull();
    const { token } = store.createAdminSession(user.id, 60_000);
    store.deleteAdminSession(token);
    expect(store.findAdminSession(token)).toBeNull();
  });

  it('setAdminPassword changes the password and revokes existing sessions', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, 60_000);
    expect(store.setAdminPassword('admin', 'a-brand-new-password')).toBe(true);
    expect(store.findAdminSession(token)).toBeNull();
    expect(loginAdmin(store, 'admin', PASSWORD)).toBeNull();
    expect(loginAdmin(store, 'admin', 'a-brand-new-password')).not.toBeNull();
    expect(store.setAdminPassword('nobody', 'a-brand-new-password')).toBe(false);
  });
});

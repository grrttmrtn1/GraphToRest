import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginAdmin } from '@graphtorest/core';
import { openEmbeddedStore } from '../src/embeddedClient';
import { adminCreate, adminSetPassword } from '../src/commands/adminCreate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-admincli-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('admin CLI commands', () => {
  it('creates an admin user who can then log in', () => {
    const store = freshStore();
    const user = adminCreate(store, { username: 'admin', password: 'correct-horse-battery' });
    expect(user.username).toBe('admin');
    expect(loginAdmin(store, 'admin', 'correct-horse-battery')).not.toBeNull();
  });

  it('rejects a weak password', () => {
    const store = freshStore();
    expect(() => adminCreate(store, { username: 'admin', password: 'short' })).toThrow(/at least 12/);
  });

  it('resets a password and revokes old sessions', () => {
    const store = freshStore();
    const user = adminCreate(store, { username: 'admin', password: 'correct-horse-battery' });
    const { token } = store.createAdminSession(user.id, 60_000);
    adminSetPassword(store, { username: 'admin', password: 'a-brand-new-password' });
    expect(store.findAdminSession(token)).toBeNull();
    expect(loginAdmin(store, 'admin', 'a-brand-new-password')).not.toBeNull();
  });

  it('errors when resetting the password of an unknown user', () => {
    const store = freshStore();
    expect(() => adminSetPassword(store, { username: 'ghost', password: 'a-brand-new-password' })).toThrow(/No admin user named "ghost"/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { openDb } from '../../src/storage/db';
import { MappingStore, type ConnectionRecord } from '../../src/storage/MappingStore';
import { CredentialCipher } from '../../src/auth/credentialCipher';
import { ManagedTokenService } from '../../src/auth/managedTokenService';

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';
const REDIRECT = 'https://gtr.example.test/admin/oauth/callback';
const CC_INPUT = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };
const AC_INPUT = { ...CC_INPUT, grant: 'authorization_code' };

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let connection: ConnectionRecord;
let clock: number;
let service: ManagedTokenService;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-life-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  connection = store.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
  clock = 1_000_000;
  service = new ManagedTokenService(store, new CredentialCipher('00'.repeat(32)), () => clock);
});

afterEach(() => {
  nock.cleanAll();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('clearCredentials', () => {
  it('removes stored credentials and forgets a cached token', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'cached-token', expires_in: 3600 });
    await expect(service.getAccessToken(connection)).resolves.toBe('cached-token');

    service.clearCredentials(connection.id);

    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: false });
    expect(store.getConnectionCredentials(connection.id)).toBeNull();
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'MANAGED_CREDENTIALS_MISSING' });
  });

  it('invalidates pending authorizations for that connection', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    service.clearCredentials(connection.id);
    await expect(service.completeAuthorization(state, 'code')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('abandonAuthorization', () => {
  it('returns the connection id once and consumes the state', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    expect(service.abandonAuthorization(state)).toBe(connection.id);
    expect(service.abandonAuthorization(state)).toBeNull();
    await expect(service.completeAuthorization(state, 'code')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('returns null for an unknown or expired state', () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    expect(service.abandonAuthorization('made-up')).toBeNull();
    clock += 11 * 60_000;
    expect(service.abandonAuthorization(state)).toBeNull();
  });
});

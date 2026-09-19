import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore, openManagedAuth } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { connectionCredentialsSet } from '../src/commands/connectionCredentialsSet';
import { mappingGenerate } from '../src/commands/mappingGenerate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-climanaged-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

const KEY_ENV = { CREDENTIAL_ENCRYPTION_KEY: '00'.repeat(32) };
const CREDENTIALS = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };

describe('openManagedAuth', () => {
  it('is undefined without a key and defined with one', () => {
    const store = freshStore();
    expect(openManagedAuth(store, {})).toBeUndefined();
    expect(openManagedAuth(store, KEY_ENV)).toBeDefined();
  });
});

describe('connectionCredentialsSet', () => {
  it('stores encrypted credentials for a managed connection and returns a non-secret status', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
    const status = connectionCredentialsSet(store, openManagedAuth(store, KEY_ENV), { connectionId: connection.id, credentials: CREDENTIALS });
    expect(status).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(store.getConnectionCredentials(connection.id)).not.toContain('super-secret-value');
  });

  it('fails clearly when the key is missing, the connection is unknown, or it is not managed', () => {
    const store = freshStore();
    const managed = connectionCreate(store, { name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
    const passthrough = connectionCreate(store, { name: 'pt', adapterType: 'microsoft-graph', authMode: 'passthrough' });
    const service = openManagedAuth(store, KEY_ENV);
    expect(() => connectionCredentialsSet(store, undefined, { connectionId: managed.id, credentials: CREDENTIALS })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => connectionCredentialsSet(store, service, { connectionId: 'nope', credentials: CREDENTIALS })).toThrow(/No connection/);
    expect(() => connectionCredentialsSet(store, service, { connectionId: passthrough.id, credentials: CREDENTIALS })).toThrow(/managed/);
  });

  it('propagates credential validation errors', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'm', adapterType: 'microsoft-graph', authMode: 'managed' });
    expect(() =>
      connectionCredentialsSet(store, openManagedAuth(store, KEY_ENV), { connectionId: connection.id, credentials: { grant: 'client_credentials' } })
    ).toThrow(/clientId/);
  });
});

describe('mappingGenerate with managed auth', () => {
  it('fails with a clear error for a managed connection when no provider is available', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'm', adapterType: 'mock', authMode: 'managed' });
    await expect(mappingGenerate(store, { connectionId: connection.id })).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('generates when a token provider is supplied', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'm', adapterType: 'mock', authMode: 'managed' });
    const result = await mappingGenerate(store, {
      connectionId: connection.id,
      tokenProvider: { getAccessToken: async () => 'stub-token' },
    });
    expect(result.created).toHaveLength(1);
  });
});

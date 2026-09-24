import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
// Relative import on purpose: the @graphtorest/server package entry (index.ts) starts a server as a side effect.
import { createApp } from '../../../server/src/app';
import { EmbeddedClient } from '../../src/client/embedded';
import { RemoteClient } from '../../src/client/remote';
import type { GtrClient } from '../../src/client/types';

export const TEST_KEY = '00'.repeat(32);

export interface Harness {
  kind: 'embedded' | 'remote';
  client: GtrClient;
  /** Direct store access for seeding and asserting on persisted state. */
  store: MappingStore;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Defaults to true: a CREDENTIAL_ENCRYPTION_KEY is configured. */
  managedAuth?: boolean;
}

export type HarnessFactory = (options?: HarnessOptions) => Promise<Harness>;

export function tempPath(prefix: string, ext = '.db'): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
}

export function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

export const embeddedHarness: HarnessFactory = async (options = {}) => {
  const dbPath = tempPath('gtr-embedded');
  const env = options.managedAuth === false ? {} : { CREDENTIAL_ENCRYPTION_KEY: TEST_KEY };
  const client = EmbeddedClient.open(dbPath, env);
  return {
    kind: 'embedded',
    client,
    store: client.store,
    close: async () => {
      client.close();
      removeDb(dbPath);
    },
  };
};

export const remoteHarness: HarnessFactory = async (options = {}) => {
  registerDefaultAdapters();
  const dbPath = tempPath('gtr-remote');
  const db = openDb(dbPath);
  const store = new MappingStore(db);
  const managedAuth = options.managedAuth === false ? undefined : new ManagedTokenService(store, new CredentialCipher(TEST_KEY));
  const app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store, managedAuth),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: false,
    adminEnabled: true,
    managedAuth,
    publicBaseUrl: 'https://gtr.example.test',
  });
  const admin = store.createAdminUser({ username: 'harness-admin', password: 'correct-horse-battery' });
  const { token } = store.createAdminSession(admin.id, 60 * 60 * 1000);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    kind: 'remote',
    client: new RemoteClient({ server: url, token, source: '--server' }),
    store,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      removeDb(dbPath);
    },
  };
};

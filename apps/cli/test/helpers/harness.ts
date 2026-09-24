import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MappingStore } from '@graphtorest/core';
import { EmbeddedClient } from '../../src/client/embedded';
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

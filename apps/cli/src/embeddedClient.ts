import { openDb, MappingStore, ManagedTokenService, CredentialCipher, registerDefaultAdapters } from '@graphtorest/core';

export function openEmbeddedStore(dbPath: string): MappingStore {
  registerDefaultAdapters();
  return new MappingStore(openDb(dbPath));
}

export function openManagedAuth(store: MappingStore, env: NodeJS.ProcessEnv = process.env): ManagedTokenService | undefined {
  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  return key ? new ManagedTokenService(store, new CredentialCipher(key)) : undefined;
}

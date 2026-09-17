import { openDb, MappingStore, registerDefaultAdapters } from '@graphtorest/core';

export function openEmbeddedStore(dbPath: string): MappingStore {
  registerDefaultAdapters();
  return new MappingStore(openDb(dbPath));
}

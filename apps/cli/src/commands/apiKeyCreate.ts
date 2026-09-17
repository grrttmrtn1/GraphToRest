import type { MappingStore, ApiKeyRecord, GeneratedApiKey } from '@graphtorest/core';

export function apiKeyCreate(store: MappingStore, args: { label?: string }): GeneratedApiKey & ApiKeyRecord {
  return store.createApiKey(args);
}

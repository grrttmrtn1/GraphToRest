import type { MappingStore, ConnectionRecord } from '@graphtorest/core';

export function connectionCreate(
  store: MappingStore,
  args: { name: string; adapterType: string; authMode: string; config?: Record<string, unknown> | null }
): ConnectionRecord {
  return store.createConnection(args);
}

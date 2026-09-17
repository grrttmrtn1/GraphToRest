import type { MappingStore, ConnectionRecord } from '@graphtorest/core';

export function connectionCreate(
  store: MappingStore,
  args: { name: string; adapterType: string; authMode: string }
): ConnectionRecord {
  return store.createConnection(args);
}

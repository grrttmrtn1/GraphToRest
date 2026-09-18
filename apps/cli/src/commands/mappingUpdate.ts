import type { MappingStore, MappingRecord } from '@graphtorest/core';
import { parseRoute } from './mappingCreate';

export function mappingUpdate(
  store: MappingStore,
  args: { id: string; route?: string; operation?: Record<string, unknown>; responseTemplate?: Record<string, string> | null }
): MappingRecord {
  const parsed = args.route ? parseRoute(args.route) : undefined;
  const updated = store.updateMapping(args.id, {
    route: parsed?.route,
    method: parsed?.method,
    operation: args.operation,
    responseTemplate: args.responseTemplate,
    source: 'manual',
  });
  if (!updated) {
    throw new Error(`No mapping with id ${args.id}`);
  }
  return updated;
}

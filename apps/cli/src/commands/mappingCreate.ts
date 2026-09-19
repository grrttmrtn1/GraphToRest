import type { MappingStore, MappingRecord } from '@graphtorest/core';
import { parseRouteString as parseRoute } from '@graphtorest/core';

export { parseRoute };

export function mappingCreate(
  store: MappingStore,
  args: {
    connectionId: string;
    route: string;
    operation: Record<string, unknown>;
    responseTemplate?: Record<string, string>;
  }
): MappingRecord {
  const { method, route } = parseRoute(args.route);
  return store.createMapping({
    connectionId: args.connectionId,
    method,
    route,
    operation: args.operation,
    responseTemplate: args.responseTemplate ?? null,
    source: 'manual',
  });
}

import type { MappingStore, MappingRecord } from '@graphtorest/core';

export function parseRoute(combined: string): { method: string; route: string } {
  const [method, ...rest] = combined.trim().split(/\s+/);
  return { method: method.toUpperCase(), route: rest.join(' ') };
}

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

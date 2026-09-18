import type { MappingStore, MappingRecord } from '../storage/MappingStore';
import type { RequestContext } from '../adapters/Adapter';
import { createAdapter } from '../adapters/registry';
import { matchRoute } from './matchRoute';
import { GatewayError } from './errors';

export interface ResolvedRequest {
  mapping: MappingRecord;
  params: Record<string, string>;
}

export class GatewayEngine {
  constructor(private mappingStore: MappingStore) {}

  resolve(method: string, path: string): ResolvedRequest | null {
    for (const mapping of this.mappingStore.listMappings()) {
      if (mapping.method.toUpperCase() !== method.toUpperCase()) continue;
      const params = matchRoute(mapping.route, path);
      if (params) return { mapping, params };
    }
    return null;
  }

  async handle(
    method: string,
    path: string,
    incomingAuth: { vendorToken?: string } = {},
    request: RequestContext = {}
  ): Promise<unknown> {
    const resolved = this.resolve(method, path);
    if (!resolved) {
      throw new GatewayError('NOT_FOUND', `No mapping for ${method} ${path}`, 404);
    }
    const { mapping, params } = resolved;
    const connection = this.mappingStore.getConnection(mapping.connectionId);
    if (!connection) {
      throw new GatewayError('CONNECTION_NOT_FOUND', `Connection ${mapping.connectionId} not found`, 500);
    }
    const adapter = createAdapter(connection.adapterType);
    const operation = resolveVariables(mapping.operation, params);
    const raw = await adapter.execute(
      operation,
      params,
      { connectionId: connection.id, vendorToken: incomingAuth.vendorToken, authMode: connection.authMode },
      request
    );
    return shapeResponse(raw, mapping.responseTemplate);
  }
}

function resolveVariables(operation: Record<string, unknown>, params: Record<string, string>): Record<string, unknown> {
  const variables = operation.variables as Record<string, unknown> | undefined;
  if (!variables) return operation;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string' && value.startsWith('$params.')) {
      resolved[key] = params[value.slice('$params.'.length)];
    } else {
      resolved[key] = value;
    }
  }
  return { ...operation, variables: resolved };
}

function shapeResponse(raw: unknown, template: Record<string, string> | null): unknown {
  if (!template) return raw;
  const shaped: Record<string, unknown> = {};
  for (const [key, pointer] of Object.entries(template)) {
    shaped[key] = resolvePointer(raw, pointer);
  }
  return shaped;
}

function resolvePointer(raw: unknown, pointer: string): unknown {
  if (!pointer.startsWith('$.')) return undefined;
  let current: unknown = raw;
  for (const segment of pointer.slice(2).split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

import type { MappingStore, MappingRecord } from '../storage/MappingStore';
import type { RequestContext } from '../adapters/Adapter';
import { createAdapter } from '../adapters/registry';
import { matchRoute } from './matchRoute';
import { GatewayError } from './errors';
import { buildAuthContext } from '../auth/authContext';
import type { AccessTokenProvider } from '../auth/managedTokenService';
import { ResponseCache, cacheIdentity } from './ResponseCache';

export interface ResolvedRequest {
  mapping: MappingRecord;
  params: Record<string, string>;
}

export interface GatewayHooks {
  /** Called once the request has been matched to a mapping, before anything that can fail. */
  onMatch?: (mapping: MappingRecord) => void;
  /** Called for cacheable requests only: HIT when served from the cache, MISS when the vendor is called. */
  onCacheStatus?: (status: 'HIT' | 'MISS') => void;
  /** Milliseconds spent in the adapter call (reported even when it throws). */
  onVendorLatency?: (ms: number) => void;
}

export class GatewayEngine {
  constructor(
    private mappingStore: MappingStore,
    private tokenProvider?: AccessTokenProvider,
    private cache?: ResponseCache
  ) {}

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
    request: RequestContext = {},
    hooks: GatewayHooks = {}
  ): Promise<unknown> {
    const resolved = this.resolve(method, path);
    if (!resolved) {
      throw new GatewayError('NOT_FOUND', `No mapping for ${method} ${path}`, 404);
    }
    const { mapping, params } = resolved;
    hooks.onMatch?.(mapping);
    const connection = this.mappingStore.getConnection(mapping.connectionId);
    if (!connection) {
      throw new GatewayError('CONNECTION_NOT_FOUND', `Connection ${mapping.connectionId} not found`, 500);
    }

    // Only successful GETs are cached; the key always includes whose data it is (see cacheIdentity).
    const ttlSeconds = this.cache && method.toUpperCase() === 'GET' ? this.cache.ttlFor(mapping.cacheTtlSeconds) : 0;
    const cacheKey =
      ttlSeconds > 0
        ? ResponseCache.key({
            mappingId: mapping.id,
            path,
            query: request.query ?? {},
            identity: cacheIdentity(connection, incomingAuth.vendorToken),
          })
        : undefined;
    const cacheEpoch = this.cache?.epoch;
    if (cacheKey) {
      const cached = this.cache!.get(cacheKey);
      if (cached !== undefined) {
        hooks.onCacheStatus?.('HIT');
        return cached;
      }
      hooks.onCacheStatus?.('MISS');
    }

    const adapter = createAdapter(connection.adapterType);
    const operation = resolveVariables(mapping.operation, params);
    const authContext = await buildAuthContext(connection, incomingAuth.vendorToken, this.tokenProvider);
    const started = performance.now();
    let raw: unknown;
    try {
      raw = await adapter.execute(operation, params, authContext, request);
    } finally {
      hooks.onVendorLatency?.(Math.round(performance.now() - started));
    }
    const shaped = shapeResponse(raw, mapping.responseTemplate);
    if (cacheKey) this.cache!.set(cacheKey, shaped, { mappingId: mapping.id, connectionId: connection.id, ttlSeconds, epoch: cacheEpoch });
    return shaped;
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

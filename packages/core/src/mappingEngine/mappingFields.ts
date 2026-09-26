import { GatewayError } from '../gateway/errors';

export interface MappingFields {
  route?: string;
  method?: string;
  operation?: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
  source?: 'generated' | 'manual';
  cacheTtlSeconds?: number | null;
}

export const MAX_CACHE_TTL_SECONDS = 86_400;

/** A cache TTL is a whole number of seconds from 0 (off) to `MAX_CACHE_TTL_SECONDS`. */
export function isValidCacheTtl(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CACHE_TTL_SECONDS;
}

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

/** Validates the shape of mapping fields arriving over the admin API. Only keys that are present are returned. */
export function parseMappingFields(input: Record<string, unknown>): MappingFields {
  const fields: MappingFields = {};

  if (input.route !== undefined) {
    if (typeof input.route !== 'string' || !input.route.startsWith('/') || /\s/.test(input.route)) {
      throw invalid('"route" must be a path starting with "/" and containing no whitespace');
    }
    fields.route = input.route;
  }

  if (input.method !== undefined) {
    if (typeof input.method !== 'string' || !/^[A-Za-z]+$/.test(input.method)) {
      throw invalid('"method" must be an HTTP method name such as GET');
    }
    fields.method = input.method.toUpperCase();
  }

  if (input.operation !== undefined) {
    if (typeof input.operation !== 'object' || input.operation === null || Array.isArray(input.operation)) {
      throw invalid('"operation" must be an object');
    }
    fields.operation = input.operation as Record<string, unknown>;
  }

  if (input.responseTemplate !== undefined) {
    const template = input.responseTemplate;
    if (template !== null) {
      const valid =
        typeof template === 'object' && !Array.isArray(template) && Object.values(template as object).every((v) => typeof v === 'string');
      if (!valid) throw invalid('"responseTemplate" must be null or a map of strings');
    }
    fields.responseTemplate = template as Record<string, string> | null;
  }

  if (input.source !== undefined) {
    if (input.source !== 'generated' && input.source !== 'manual') throw invalid('"source" must be "generated" or "manual"');
    fields.source = input.source;
  }

  if (input.cacheTtlSeconds !== undefined) {
    const ttl = input.cacheTtlSeconds;
    if (ttl !== null && !isValidCacheTtl(ttl)) {
      throw invalid(`"cacheTtlSeconds" must be null or an integer from 0 to ${MAX_CACHE_TTL_SECONDS}`);
    }
    fields.cacheTtlSeconds = ttl === 0 ? null : ttl;
  }

  return fields;
}

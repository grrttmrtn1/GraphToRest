import { GatewayError } from '../gateway/errors';
import { assertOutboundUrlShape } from '../net/outboundUrl';
import { listAdapterTypes } from './registry';

export interface ConnectionFields {
  name: string;
  adapterType: string;
  authMode: 'passthrough' | 'managed';
  config: Record<string, unknown> | null;
}

export const MAX_CONNECTION_NAME_LENGTH = 200;

/** Validates a connection's free-form `config` at write time (admin API and embedded CLI share this). */
export function parseConnectionConfig(config: unknown): Record<string, unknown> | null {
  if (config === undefined || config === null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new GatewayError('INVALID_INPUT', '"config" must be an object', 400);
  }
  const parsed = { ...(config as Record<string, unknown>) };
  if (parsed.endpoint !== undefined) parsed.endpoint = assertOutboundUrlShape(parsed.endpoint, 'config.endpoint');
  return parsed;
}

/** Validates and normalizes a connection before it is persisted by either the server or embedded CLI. */
export function parseConnectionFields(input: unknown): ConnectionFields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GatewayError('INVALID_INPUT', 'connection must be an object', 400);
  }
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new GatewayError('INVALID_INPUT', 'name is required', 400);
  if (name.length > MAX_CONNECTION_NAME_LENGTH) {
    throw new GatewayError('INVALID_INPUT', `name must be at most ${MAX_CONNECTION_NAME_LENGTH} characters`, 400);
  }
  if (typeof raw.adapterType !== 'string' || !listAdapterTypes().includes(raw.adapterType)) {
    throw new GatewayError('INVALID_INPUT', `adapterType must be one of: ${listAdapterTypes().join(', ')}`, 400);
  }
  if (raw.authMode !== 'passthrough' && raw.authMode !== 'managed') {
    throw new GatewayError('INVALID_INPUT', 'authMode must be "passthrough" or "managed"', 400);
  }
  const config = parseConnectionConfig(raw.config);
  if (raw.adapterType === 'graphql' && typeof config?.endpoint !== 'string') {
    throw new GatewayError('INVALID_INPUT', 'GraphQL connections require config.endpoint', 400);
  }
  return { name, adapterType: raw.adapterType, authMode: raw.authMode, config };
}

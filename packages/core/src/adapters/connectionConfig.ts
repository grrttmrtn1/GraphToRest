import { GatewayError } from '../gateway/errors';
import { assertOutboundUrlShape } from '../net/outboundUrl';

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

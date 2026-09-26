import { GatewayError } from '../gateway/errors';

export interface RateLimit {
  requestsPerMinute: number;
  burst: number;
}

/** A key's stored override: a limit, "unlimited", or null to use the server default. */
export type RateLimitSetting = RateLimit | 'unlimited' | null;

export const MAX_RATE_LIMIT = 1_000_000;

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_RATE_LIMIT) {
    throw invalid(`"${field}" must be an integer from 1 to ${MAX_RATE_LIMIT}`);
  }
  return value;
}

export function parseRateLimitSetting(input: unknown): RateLimitSetting {
  if (input === null) return null;
  if (input === 'unlimited') return 'unlimited';
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('"rateLimit" must be null, "unlimited", or { requestsPerMinute, burst? }');
  }
  const raw = input as Record<string, unknown>;
  const unknownFields = Object.keys(raw).filter((key) => key !== 'requestsPerMinute' && key !== 'burst');
  if (unknownFields.length > 0) throw invalid(`Unknown rateLimit field(s): ${unknownFields.join(', ')}`);
  const requestsPerMinute = positiveInt(raw.requestsPerMinute, 'rateLimit.requestsPerMinute');
  const burst = raw.burst === undefined ? requestsPerMinute : positiveInt(raw.burst, 'rateLimit.burst');
  return { requestsPerMinute, burst };
}

export function serializeRateLimitSetting(setting: RateLimitSetting): string | null {
  return setting === null ? null : JSON.stringify(setting);
}

export function deserializeRateLimitSetting(text: string | null): RateLimitSetting {
  if (text === null) return null;
  try {
    return parseRateLimitSetting(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The limit that applies to a key, or null for unlimited. */
export function effectiveRateLimit(setting: RateLimitSetting, serverDefault: RateLimit | null): RateLimit | null {
  if (setting === 'unlimited') return null;
  return setting ?? serverDefault;
}

export function formatRateLimitSetting(setting: RateLimitSetting): string {
  if (setting === null) return 'default';
  if (setting === 'unlimited') return 'unlimited';
  return `${setting.requestsPerMinute}/min (burst ${setting.burst})`;
}

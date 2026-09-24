import { outboundPolicyFromEnv, type LogLevel } from '@graphtorest/core';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
  credentialEncryptionKey?: string;
  publicBaseUrl: string;
  activityRetention: number;
  webEnabled: boolean;
  logLevel: LogLevel;
  rateLimitDefault: { requestsPerMinute: number; burst: number } | null;
  cacheMaxTtlSeconds: number;
  cacheMaxEntries: number;
  outboundTimeoutMs: number;
  allowPrivateNetworkTargets: boolean;
  bootstrapAdmin: { username: string; password: string } | null;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Parses an optional integer env var; unset or empty yields `fallback`. Throws an Error naming the variable. */
function parseInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = env[name];
  if (!isSet(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? (min === 0 ? 'a non-negative integer' : `an integer of at least ${min}`) : `an integer from ${min} to ${max}`;
    throw new Error(`${name} must be ${range}, got "${value}"`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!isSet(value)) return 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  }
  return value as LogLevel;
}

function parseRateLimitDefault(env: NodeJS.ProcessEnv): ServerConfig['rateLimitDefault'] {
  if (!isSet(env.RATE_LIMIT_DEFAULT)) {
    if (isSet(env.RATE_LIMIT_DEFAULT_BURST)) throw new Error('RATE_LIMIT_DEFAULT_BURST requires RATE_LIMIT_DEFAULT to be set');
    return null;
  }
  const requestsPerMinute = parseInteger(env, 'RATE_LIMIT_DEFAULT', 0, 1, 1_000_000);
  const burst = parseInteger(env, 'RATE_LIMIT_DEFAULT_BURST', requestsPerMinute, 1, 1_000_000);
  return { requestsPerMinute, burst };
}

function parseBootstrapAdmin(env: NodeJS.ProcessEnv): ServerConfig['bootstrapAdmin'] {
  const username = env.GTR_BOOTSTRAP_ADMIN_USERNAME;
  const password = env.GTR_BOOTSTRAP_ADMIN_PASSWORD;
  if (!isSet(username) && !isSet(password)) return null;
  if (!isSet(username)) throw new Error('GTR_BOOTSTRAP_ADMIN_USERNAME must be set when GTR_BOOTSTRAP_ADMIN_PASSWORD is');
  if (!isSet(password)) throw new Error('GTR_BOOTSTRAP_ADMIN_PASSWORD must be set when GTR_BOOTSTRAP_ADMIN_USERNAME is');
  return { username, password };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parseInteger(env, 'PORT', 3000, 1, 65535);
  const outbound = outboundPolicyFromEnv(env);
  return {
    port,
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    activityRetention: parseInteger(env, 'ACTIVITY_RETENTION', 1000, 1),
    webEnabled: env.WEB_ENABLED !== 'false',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    rateLimitDefault: parseRateLimitDefault(env),
    cacheMaxTtlSeconds: parseInteger(env, 'CACHE_MAX_TTL_SECONDS', 300, 0),
    cacheMaxEntries: parseInteger(env, 'CACHE_MAX_ENTRIES', 1000, 0),
    outboundTimeoutMs: outbound.timeoutMs,
    allowPrivateNetworkTargets: outbound.allowPrivateNetworkTargets,
    bootstrapAdmin: parseBootstrapAdmin(env),
  };
}

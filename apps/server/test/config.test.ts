import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 3000,
      dbPath: './data/graphtorest.db',
      apiEnabled: true,
      adminEnabled: true,
      publicBaseUrl: 'http://localhost:3000',
      activityRetention: 1000,
      webEnabled: true,
      logLevel: 'info',
      rateLimitDefault: null,
      cacheMaxTtlSeconds: 300,
      cacheMaxEntries: 1000,
      cacheMaxBytes: 52428800,
      outboundTimeoutMs: 30000,
      allowPrivateNetworkTargets: false,
      bootstrapAdmin: null,
      trustProxy: false,
      apiAuthFailuresPerMinute: 60,
    });
    expect(config.credentialEncryptionKey).toBeUndefined();
  });

  it('treats empty-string bootstrap admin vars as unset (docker-compose forwards unset vars as "")', () => {
    const config = loadConfig({ GTR_BOOTSTRAP_ADMIN_USERNAME: '', GTR_BOOTSTRAP_ADMIN_PASSWORD: '' });
    expect(config.bootstrapAdmin).toBeNull();
  });

  it('reads overrides from the given env', () => {
    const config = loadConfig({
      PORT: '8080',
      DB_PATH: '/data/gtr.db',
      API_ENABLED: 'false',
      ADMIN_ENABLED: 'false',
      CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32),
      PUBLIC_BASE_URL: 'https://gtr.example.com/',
      ACTIVITY_RETENTION: '250',
      WEB_ENABLED: 'false',
      LOG_LEVEL: 'debug',
      RATE_LIMIT_DEFAULT: '60',
      RATE_LIMIT_DEFAULT_BURST: '20',
      CACHE_MAX_TTL_SECONDS: '60',
      CACHE_MAX_ENTRIES: '0',
      OUTBOUND_TIMEOUT_MS: '5000',
      ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
      GTR_BOOTSTRAP_ADMIN_USERNAME: 'root',
      GTR_BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery',
    });
    expect(config).toEqual({
      port: 8080,
      dbPath: '/data/gtr.db',
      apiEnabled: false,
      adminEnabled: false,
      credentialEncryptionKey: 'ab'.repeat(32),
      publicBaseUrl: 'https://gtr.example.com',
      activityRetention: 250,
      webEnabled: false,
      logLevel: 'debug',
      rateLimitDefault: { requestsPerMinute: 60, burst: 20 },
      cacheMaxTtlSeconds: 60,
      cacheMaxEntries: 0,
      cacheMaxBytes: 52428800,
      outboundTimeoutMs: 5000,
      allowPrivateNetworkTargets: true,
      bootstrapAdmin: { username: 'root', password: 'correct-horse-battery' },
      trustProxy: false,
      apiAuthFailuresPerMinute: 60,
    });
  });

  it('defaults the public base URL from the port', () => {
    expect(loadConfig({ PORT: '4000' }).publicBaseUrl).toBe('http://localhost:4000');
  });

  it.each(['0', '-1', '1.5', 'many'])('rejects ACTIVITY_RETENTION=%s', (value) => {
    expect(() => loadConfig({ ACTIVITY_RETENTION: value })).toThrow(/ACTIVITY_RETENTION/);
  });

  it('defaults the burst to the rate', () => {
    expect(loadConfig({ RATE_LIMIT_DEFAULT: '30' }).rateLimitDefault).toEqual({ requestsPerMinute: 30, burst: 30 });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['RATE_LIMIT_DEFAULT', '0'],
    ['RATE_LIMIT_DEFAULT', '1.5'],
    ['CACHE_MAX_TTL_SECONDS', '-1'],
    ['CACHE_MAX_ENTRIES', 'lots'],
    ['OUTBOUND_TIMEOUT_MS', '0'],
    ['ACTIVITY_RETENTION', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('rejects RATE_LIMIT_DEFAULT_BURST without RATE_LIMIT_DEFAULT', () => {
    expect(() => loadConfig({ RATE_LIMIT_DEFAULT_BURST: '5' })).toThrow('RATE_LIMIT_DEFAULT_BURST');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });

  it('rejects a non-boolean ALLOW_PRIVATE_NETWORK_TARGETS', () => {
    expect(() => loadConfig({ ALLOW_PRIVATE_NETWORK_TARGETS: 'yes' })).toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });

  it('requires both bootstrap admin variables or neither', () => {
    expect(() => loadConfig({ GTR_BOOTSTRAP_ADMIN_USERNAME: 'root' })).toThrow('GTR_BOOTSTRAP_ADMIN_PASSWORD');
    expect(() => loadConfig({ GTR_BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery' })).toThrow('GTR_BOOTSTRAP_ADMIN_USERNAME');
  });

  it('keeps the port in the default public base URL', () => {
    expect(loadConfig({ PORT: '8080' }).publicBaseUrl).toBe('http://localhost:8080');
  });

  it('parses TRUST_PROXY as a boolean, a hop count, or an address list', () => {
    expect(loadConfig({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
  });

  it('parses API_AUTH_FAILURES_PER_MINUTE (0 disables it)', () => {
    expect(loadConfig({ API_AUTH_FAILURES_PER_MINUTE: '0' }).apiAuthFailuresPerMinute).toBe(0);
    expect(loadConfig({ API_AUTH_FAILURES_PER_MINUTE: '120' }).apiAuthFailuresPerMinute).toBe(120);
    expect(() => loadConfig({ API_AUTH_FAILURES_PER_MINUTE: '-1' })).toThrow(/API_AUTH_FAILURES_PER_MINUTE/);
  });

  it('parses CACHE_MAX_BYTES (0 disables the byte bound)', () => {
    expect(loadConfig({ CACHE_MAX_BYTES: '0' }).cacheMaxBytes).toBe(0);
    expect(loadConfig({ CACHE_MAX_BYTES: '1048576' }).cacheMaxBytes).toBe(1048576);
    expect(() => loadConfig({ CACHE_MAX_BYTES: 'lots' })).toThrow(/CACHE_MAX_BYTES/);
  });
});

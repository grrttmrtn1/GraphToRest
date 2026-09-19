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
    });
    expect(config.credentialEncryptionKey).toBeUndefined();
  });

  it('reads overrides from the given env', () => {
    const config = loadConfig({
      PORT: '8080',
      DB_PATH: '/data/gtr.db',
      API_ENABLED: 'false',
      ADMIN_ENABLED: 'false',
      CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32),
      PUBLIC_BASE_URL: 'https://gtr.example.com/',
    });
    expect(config).toEqual({
      port: 8080,
      dbPath: '/data/gtr.db',
      apiEnabled: false,
      adminEnabled: false,
      credentialEncryptionKey: 'ab'.repeat(32),
      publicBaseUrl: 'https://gtr.example.com',
    });
  });

  it('defaults the public base URL from the port', () => {
    expect(loadConfig({ PORT: '4000' }).publicBaseUrl).toBe('http://localhost:4000');
  });
});

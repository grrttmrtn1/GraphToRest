import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({ port: 3000, dbPath: './data/graphtorest.db', apiEnabled: true, adminEnabled: true });
  });

  it('reads overrides from the given env', () => {
    const config = loadConfig({ PORT: '8080', DB_PATH: '/data/gtr.db', API_ENABLED: 'false', ADMIN_ENABLED: 'false' });
    expect(config).toEqual({ port: 8080, dbPath: '/data/gtr.db', apiEnabled: false, adminEnabled: false });
  });
});

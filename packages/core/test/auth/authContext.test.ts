import { describe, it, expect } from 'vitest';
import { buildAuthContext } from '../../src/auth/authContext';
import type { ConnectionRecord } from '../../src/storage/MappingStore';

const base: ConnectionRecord = { id: 'c1', name: 'c', adapterType: 'mock', authMode: 'passthrough', config: { a: 1 } };
const provider = { getAccessToken: async () => 'managed-token' };

describe('buildAuthContext', () => {
  it('forwards the incoming vendor token unchanged for passthrough connections', async () => {
    expect(await buildAuthContext(base, 'dev-token')).toEqual({
      connectionId: 'c1',
      authMode: 'passthrough',
      config: { a: 1 },
      vendorToken: 'dev-token',
    });
    expect((await buildAuthContext(base, undefined, provider)).vendorToken).toBeUndefined();
  });

  it('uses the provider token for managed connections and ignores the incoming header', async () => {
    const managed = { ...base, authMode: 'managed' };
    expect((await buildAuthContext(managed, 'dev-token', provider)).vendorToken).toBe('managed-token');
  });

  it('fails with a 503 when a managed connection has no provider configured', async () => {
    await expect(buildAuthContext({ ...base, authMode: 'managed' }, undefined)).rejects.toMatchObject({
      code: 'MANAGED_AUTH_UNAVAILABLE',
      status: 503,
    });
  });
});

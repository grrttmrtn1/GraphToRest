import { describe, it, expect, afterEach } from 'vitest';
import { getOutboundPolicy, setOutboundPolicy, resetOutboundPolicy, outboundPolicyFromEnv, DEFAULT_OUTBOUND_TIMEOUT_MS } from '../../src/net/outboundPolicy';

afterEach(() => resetOutboundPolicy());

describe('outbound policy', () => {
  it('merges patches and resets to defaults', () => {
    resetOutboundPolicy();
    expect(getOutboundPolicy()).toMatchObject({ timeoutMs: DEFAULT_OUTBOUND_TIMEOUT_MS, allowPrivateNetworkTargets: false });
    setOutboundPolicy({ allowPrivateNetworkTargets: true });
    expect(getOutboundPolicy().allowPrivateNetworkTargets).toBe(true);
    expect(getOutboundPolicy().timeoutMs).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
  });

  it('parses env', () => {
    expect(outboundPolicyFromEnv({})).toEqual({ timeoutMs: 30000, allowPrivateNetworkTargets: false });
    expect(outboundPolicyFromEnv({ OUTBOUND_TIMEOUT_MS: '500', ALLOW_PRIVATE_NETWORK_TARGETS: 'true' })).toEqual({
      timeoutMs: 500,
      allowPrivateNetworkTargets: true,
    });
    expect(() => outboundPolicyFromEnv({ OUTBOUND_TIMEOUT_MS: 'x' })).toThrow('OUTBOUND_TIMEOUT_MS');
    expect(() => outboundPolicyFromEnv({ ALLOW_PRIVATE_NETWORK_TARGETS: '1' })).toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });
});

import { beforeEach } from 'vitest';
// Two module instances exist under vitest: server/CLI tests use core's dist (via the package name), core tests use src.
import * as distPolicy from '@graphtorest/core';
import * as srcPolicy from '../../packages/core/src/net/outboundPolicy';

/** TEST-NET-3 documentation address: public for the SSRF guard, never actually contacted (nock intercepts). */
export const TEST_PUBLIC_ADDRESS = '203.0.113.10';

beforeEach(() => {
  for (const policy of [distPolicy, srcPolicy]) {
    policy.resetOutboundPolicy();
    policy.setOutboundPolicy({ lookup: async () => [TEST_PUBLIC_ADDRESS] });
  }
});

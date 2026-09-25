import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { assertOutboundUrlShape, assertOutboundTargetAllowed, outboundFetch } from '../../src/net/outboundUrl';
import type { OutboundPolicy } from '../../src/net/outboundPolicy';
import { GatewayError } from '../../src/gateway/errors';

const policy = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
  timeoutMs: 1000,
  allowPrivateNetworkTargets: false,
  lookup: async () => ['203.0.113.10'],
  ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as GatewayError).code;
  }
  return 'NO_ERROR';
}

afterEach(() => nock.cleanAll());

describe('assertOutboundUrlShape', () => {
  it('accepts http and https URLs and trims them', () => {
    expect(assertOutboundUrlShape(' https://api.example.com/graphql ', 'endpoint')).toBe('https://api.example.com/graphql');
    expect(assertOutboundUrlShape('http://graphql:4000/', 'endpoint')).toBe('http://graphql:4000/');
  });

  it.each([
    [undefined, '"endpoint" is required'],
    ['', '"endpoint" is required'],
    ['not a url', '"endpoint" must be a valid URL'],
    ['ftp://x.example/', '"endpoint" must be an http or https URL'],
    ['https://user:pw@x.example/', '"endpoint" must not contain a username or password'],
  ])('rejects %s', (value, message) => {
    expect(() => assertOutboundUrlShape(value, 'endpoint')).toThrow(message);
  });

  it('enforces https when asked', () => {
    expect(() => assertOutboundUrlShape('http://x.example/', 'tokenUrl', { httpsOnly: true })).toThrow('"tokenUrl" must be an https URL');
  });
});

describe('assertOutboundTargetAllowed', () => {
  it('allows a public https destination', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('https://api.example.com/x', policy()))).toBe('NO_ERROR');
  });

  it('blocks a private destination and names the opt-in variable', async () => {
    const p = assertOutboundTargetAllowed('https://internal.example/x', policy({ lookup: async () => ['10.0.0.5'] }));
    await expect(p).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED', status: 502 });
    await expect(p).rejects.toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });

  it('blocks when any resolved address is private', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('https://mixed.example/', policy({ lookup: async () => ['203.0.113.10', '127.0.0.1'] })))).toBe(
      'OUTBOUND_TARGET_BLOCKED'
    );
  });

  it('checks IP literals without a lookup, including bracketed IPv6', async () => {
    const lookup = async () => {
      throw new Error('lookup must not be called');
    };
    expect(await codeOf(assertOutboundTargetAllowed('https://169.254.169.254/latest', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
    expect(await codeOf(assertOutboundTargetAllowed('https://[::ffff:127.0.0.1]/', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
    expect(await codeOf(assertOutboundTargetAllowed('https://[::ffff:7f00:1]/', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
  });

  it('allows private destinations, including plain http, when opted in', async () => {
    const opted = policy({ allowPrivateNetworkTargets: true, lookup: async () => ['172.18.0.4'] });
    expect(await codeOf(assertOutboundTargetAllowed('http://graphql:4000/', opted))).toBe('NO_ERROR');
  });

  it('rejects plain http to a public destination even when opted in', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('http://api.example.com/', policy({ allowPrivateNetworkTargets: true })))).toBe(
      'OUTBOUND_TARGET_BLOCKED'
    );
  });

  it('rejects plain http when a mixed DNS answer includes a public address, even when opted in', async () => {
    // Only some of the resolved addresses are private: the http rule must require ALL of them to be private
    // (not just some), since the actual connection could land on the public address over plain http.
    const opted = policy({ allowPrivateNetworkTargets: true, lookup: async () => ['203.0.113.10', '172.18.0.4'] });
    expect(await codeOf(assertOutboundTargetAllowed('http://mixed.example/', opted))).toBe('OUTBOUND_TARGET_BLOCKED');
  });

  it('reports an unresolvable host as VENDOR_UNREACHABLE', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await codeOf(assertOutboundTargetAllowed('https://nope.example/', policy({ lookup })))).toBe('VENDOR_UNREACHABLE');
  });
});

describe('outboundFetch', () => {
  it('refuses redirects by default', async () => {
    nock('https://api.example.com').get('/r').reply(302, '', { location: 'https://169.254.169.254/' });
    await expect(outboundFetch('https://api.example.com/r', {}, policy())).rejects.toThrow();
  });

  it('aborts after the policy timeout', async () => {
    nock('https://api.example.com').get('/slow').delay(500).reply(200, 'late');
    await expect(outboundFetch('https://api.example.com/slow', {}, policy({ timeoutMs: 50 }))).rejects.toThrow();
  });

  it('does not fetch a blocked destination', async () => {
    const scope = nock('https://internal.example').get('/').reply(200, 'secret');
    await expect(outboundFetch('https://internal.example/', {}, policy({ lookup: async () => ['10.1.1.1'] }))).rejects.toMatchObject({
      code: 'OUTBOUND_TARGET_BLOCKED',
    });
    expect(scope.isDone()).toBe(false);
  });
});

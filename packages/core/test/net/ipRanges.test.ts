import { describe, it, expect } from 'vitest';
import { isPrivateAddress } from '../../src/net/ipRanges';

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.254', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('blocks IPv4 %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1', '203.0.113.10', '169.253.0.1'])(
    'allows public IPv4 %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false)
  );

  it.each(['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'feff::1', 'ff02::1'])('blocks IPv6 %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(['2001:4860:4860::8888', '2606:4700::1111'])('allows public IPv6 %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('blocks IPv4-mapped IPv6 forms', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks IPv4-compatible IPv6 forms of private ranges', () => {
    expect(isPrivateAddress('::10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::7f00:1')).toBe(true);
  });

  it('treats unparseable input as private (fail closed)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
  it('classifies NAT64 and 6to4 addresses by their embedded IPv4', () => {
    expect(isPrivateAddress('64:ff9b::a00:1')).toBe(true); // 10.0.0.1
    expect(isPrivateAddress('64:ff9b::169.254.169.254')).toBe(true);
    expect(isPrivateAddress('2002:7f00:1::')).toBe(true); // 127.0.0.1
    expect(isPrivateAddress('2002:a9fe:a9fe:1::1')).toBe(true); // 169.254.169.254
    expect(isPrivateAddress('64:ff9b::cb00:710a')).toBe(false); // 203.0.113.10
    expect(isPrivateAddress('2002:cb00:710a::1')).toBe(false);
  });
});

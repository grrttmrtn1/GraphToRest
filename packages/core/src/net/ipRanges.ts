import net from 'node:net';

/** [network, prefixLength] pairs, IPv4 as 32-bit unsigned ints. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local incl. cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xe0000000, 4], // 224/4 multicast
  [0xf0000000, 4], // 240/4 reserved and limited broadcast
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}

/** Expands an IPv6 literal (optionally ending in a dotted IPv4) into 8 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const v = v4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = halves.length === 2 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : head;
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * True for loopback, private, link-local, CGNAT, unspecified and unique-local addresses, including IPv4-mapped,
 * IPv4-compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16) IPv6 forms of blocked IPv4 ranges — a NAT64 or 6to4
 * gateway on the path would otherwise translate them into the blocked IPv4 destination. Unparseable input counts
 * as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.split('%')[0]; // drop an IPv6 zone id
  if (net.isIPv4(address)) return isBlockedV4(v4ToInt(address));
  if (!net.isIPv6(address)) return true;
  const g = expandV6(address);
  if (!g) return true;
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (mapped) or ::a.b.c.d (compatible, also covers :: and ::1)
    return isBlockedV4(((g[6] << 16) | g[7]) >>> 0);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(((g[6] << 16) | g[7]) >>> 0); // 64:ff9b::a.b.c.d NAT64 well-known prefix
  }
  if (g[0] === 0x2002) return isBlockedV4(((g[1] << 16) | g[2]) >>> 0); // 2002:AABB:CCDD::/48 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local (still routed by some networks)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/rateLimit/TokenBucket';

describe('TokenBucket', () => {
  it('allows a burst then refuses with the time until the next token', () => {
    const b = new TokenBucket({ requestsPerMinute: 60, burst: 3 }, 0); // 1 token/second
    expect([b.take(0), b.take(0), b.take(0)].every((r) => r.allowed)).toBe(true);
    const refused = b.take(0);
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    expect(refused.resetMs).toBe(3000);
  });

  it('refills at the configured rate up to the burst', () => {
    const b = new TokenBucket({ requestsPerMinute: 60, burst: 2 }, 0);
    b.take(0); b.take(0);
    expect(b.take(500).allowed).toBe(false);
    expect(b.take(1000).allowed).toBe(true);
    expect(b.tokensAt(60_000)).toBe(2);
    expect(b.isFull(60_000)).toBe(true);
  });

  it('caps initial tokens at the burst', () => {
    expect(new TokenBucket({ requestsPerMinute: 10, burst: 1 }, 0, 50).tokensAt(0)).toBe(1);
  });
});

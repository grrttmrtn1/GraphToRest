import type { RateLimit } from './rateLimitConfig';

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until one token is available (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the bucket is full again. */
  resetMs: number;
}

/** Classic token bucket: capacity `burst`, refilled at `requestsPerMinute`. Time is always passed in (testable). */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(readonly limit: RateLimit, now: number, initialTokens: number = limit.burst) {
    this.tokens = Math.min(initialTokens, limit.burst);
    this.updatedAt = now;
  }

  private get perMs(): number {
    return this.limit.requestsPerMinute / 60_000;
  }

  private refill(now: number): void {
    if (now > this.updatedAt) {
      this.tokens = Math.min(this.limit.burst, this.tokens + (now - this.updatedAt) * this.perMs);
      this.updatedAt = now;
    }
  }

  tokensAt(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  isFull(now: number): boolean {
    return this.tokensAt(now) >= this.limit.burst;
  }

  take(now: number): TakeResult {
    this.refill(now);
    const allowed = this.tokens >= 1;
    if (allowed) this.tokens -= 1;
    return {
      allowed,
      remaining: this.tokens,
      retryAfterMs: allowed ? 0 : Math.ceil((1 - this.tokens) / this.perMs),
      resetMs: Math.ceil((this.limit.burst - this.tokens) / this.perMs),
    };
  }
}

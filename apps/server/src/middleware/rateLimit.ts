import type { RequestHandler } from 'express';
import { TokenBucket, effectiveRateLimit, type RateLimit, type RateLimitSetting } from '@graphtorest/core';

export interface RateLimiterOptions {
  defaultLimit: RateLimit | null;
  now?: () => number;
  sweepIntervalMs?: number;
}

/** In-memory token buckets per API key id (single-process deployment, spec §6.3). Runs after API-key auth. */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  middleware(): RequestHandler {
    return (_req, res, next) => {
      const keyId = res.locals.apiKeyId as string | undefined;
      const setting = (res.locals.apiKeyRateLimit as RateLimitSetting | undefined) ?? null;
      const limit = effectiveRateLimit(setting, this.options.defaultLimit);
      if (!keyId || !limit) {
        next();
        return;
      }
      const now = this.now();
      let bucket = this.buckets.get(keyId);
      if (!bucket || bucket.limit.requestsPerMinute !== limit.requestsPerMinute || bucket.limit.burst !== limit.burst) {
        // A changed limit applies immediately; carry over at most the new burst so lowering a limit cannot grant a burst.
        bucket = new TokenBucket(limit, now, bucket ? bucket.tokensAt(now) : limit.burst);
        this.buckets.set(keyId, bucket);
      }
      const result = bucket.take(now);
      res.setHeader('RateLimit-Limit', String(limit.burst));
      res.setHeader('RateLimit-Remaining', String(Math.floor(result.remaining)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
      if (result.allowed) {
        next();
        return;
      }
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.locals.errorCode = 'RATE_LIMITED';
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded', details: { retryAfterSeconds } } });
    };
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [keyId, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(keyId);
  }
}

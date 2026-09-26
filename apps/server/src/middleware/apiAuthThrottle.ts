import { TokenBucket } from '@graphtorest/core';

export interface ApiAuthThrottleOptions {
  /** Failed /api authentications allowed per client address per minute; 0 disables the throttle. */
  failuresPerMinute: number;
  now?: () => number;
  sweepIntervalMs?: number;
}

/**
 * Per-address budget of failed API-key authentications (single-process deployment). Each failure costs a scrypt, so
 * once an address spends its budget, requests with a malformed or unknown key id are refused before hashing. Requests
 * carrying a real key id are never refused here, so a flood from behind a shared proxy cannot lock out real clients.
 */
export class ApiAuthThrottle {
  private buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: ApiAuthThrottleOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  /**
   * Spends one failure from `ip`'s budget and returns 0, or returns the milliseconds until it may fail again when the
   * budget is spent. Checking and spending in one synchronous step means concurrent requests cannot all see a full
   * bucket before any of them records its failure.
   */
  takeFailure(ip: string | undefined): number {
    const perMinute = this.options.failuresPerMinute;
    if (perMinute <= 0) return 0;
    const key = ip ?? 'unknown';
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ requestsPerMinute: perMinute, burst: perMinute }, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now).retryAfterMs;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(key);
  }
}

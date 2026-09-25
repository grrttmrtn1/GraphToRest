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

  /** Milliseconds until `ip` may fail again, or 0 when it still has budget. Does not spend any budget. */
  retryAfterMs(ip: string | undefined): number {
    const perMinute = this.options.failuresPerMinute;
    if (perMinute <= 0) return 0;
    const bucket = this.buckets.get(ip ?? 'unknown');
    if (!bucket) return 0;
    const tokens = bucket.tokensAt(this.now());
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / (perMinute / 60_000));
  }

  recordFailure(ip: string | undefined): void {
    const perMinute = this.options.failuresPerMinute;
    if (perMinute <= 0) return;
    const key = ip ?? 'unknown';
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ requestsPerMinute: perMinute, burst: perMinute }, now);
      this.buckets.set(key, bucket);
    }
    bucket.take(now);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(key);
  }
}

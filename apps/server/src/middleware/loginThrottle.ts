export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  now?: () => number;
  sweepIntervalMs?: number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export function loginThrottleKeys(username: string, ip: string | undefined): [string, string] {
  return [`user:${username.trim().toLowerCase()}`, `ip:${ip ?? 'unknown'}`];
}

/** In-memory failed-login counters per username and per client IP (single-process deployment). */
export class LoginThrottle {
  private entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseLockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.baseLockoutMs = options.baseLockoutMs ?? 60_000;
    this.maxLockoutMs = options.maxLockoutMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  retryAfterMs(keys: string[]): number {
    const now = this.now();
    return Math.max(0, ...keys.map((key) => (this.entries.get(key)?.lockedUntil ?? 0) - now));
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      let entry = this.entries.get(key);
      if (!entry || this.isExpired(entry, now)) {
        entry = { failures: 0, windowStart: now, lockedUntil: 0 };
        this.entries.set(key, entry);
      }
      entry.failures += 1;
      if (entry.failures >= this.maxFailures) {
        const lockout = Math.min(this.baseLockoutMs * 2 ** (entry.failures - this.maxFailures), this.maxLockoutMs);
        entry.lockedUntil = now + lockout;
      }
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * A never-locked entry expires one window after its first failure. A key that has been locked out keeps
   * escalating until it goes a full window without failing after its last lockout ended.
   */
  private isExpired(entry: Entry, now: number): boolean {
    return entry.lockedUntil === 0 ? now - entry.windowStart > this.windowMs : now - entry.lockedUntil > this.windowMs;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (this.isExpired(entry, now)) this.entries.delete(key);
  }
}

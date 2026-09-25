import { createHash } from 'node:crypto';

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
  /** Reservations made by `reserve()` for attempts that have not yet settled via `recordFailure`/`release`. */
  inFlight: number;
}

/** Usernames are attacker-controlled and the body limit is 1 MB; bound the key instead of storing one verbatim. */
const MAX_USERNAME_KEY_LENGTH = 256;

export function loginThrottleKeys(username: string, ip: string | undefined): [string, string] {
  const normalized = username.trim().toLowerCase();
  const usernameKey =
    normalized.length > MAX_USERNAME_KEY_LENGTH
      ? `user:sha256:${createHash('sha256').update(normalized).digest('hex')}`
      : `user:${normalized}`;
  return [usernameKey, `ip:${ip ?? 'unknown'}`];
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

  /**
   * Reserves an attempt against every key before the caller does anything asynchronous (such as verifying a
   * password), so that concurrent attempts cannot all slip past the check before any of them records a failure.
   * Returns 0 and reserves a slot on every key when the attempt may proceed, or a positive retry-after ms (and
   * reserves nothing) when a key is already locked or already has `maxFailures` failures-or-reservations pending.
   * Every reservation this returns 0 for must be settled exactly once, with `recordFailure` or `release`.
   */
  reserve(keys: string[]): number {
    const now = this.now();
    for (const key of keys) {
      const retry = this.effectiveRetryMs(key, now);
      if (retry > 0) return retry;
    }
    for (const key of keys) {
      this.getOrCreateEntry(key, now).inFlight += 1;
    }
    return 0;
  }

  /** Releases a reservation made by `reserve()` without counting it as a failure (e.g. on an unexpected error). */
  release(keys: string[]): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) entry.inFlight = Math.max(0, entry.inFlight - 1);
    }
  }

  /** Settles a reservation as a real failure (releasing it), or records a bare failure when there was no reservation. */
  recordFailure(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const entry = this.getOrCreateEntry(key, now);
      entry.inFlight = Math.max(0, entry.inFlight - 1);
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

  private getOrCreateEntry(key: string, now: number): Entry {
    let entry = this.entries.get(key);
    if (!entry || this.isExpired(entry, now)) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0, inFlight: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** `retryAfterMs` for a key, but also treats failures-plus-pending-reservations at the threshold as locked while
   * reservations are still outstanding (unsettled), even before any of them has produced a real `lockedUntil`. Once
   * nothing is in flight, only the real `lockedUntil` governs — a naturally-expired lockout still lets the next
   * attempt through, same as before reservations existed. */
  private effectiveRetryMs(key: string, now: number): number {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry, now)) return 0;
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.inFlight > 0 && entry.failures + entry.inFlight >= this.maxFailures) return this.baseLockoutMs;
    return 0;
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

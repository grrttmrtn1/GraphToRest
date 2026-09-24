import { describe, it, expect, afterEach } from 'vitest';
import { LoginThrottle, loginThrottleKeys } from '../src/middleware/loginThrottle';

let t = 0;
const throttles: LoginThrottle[] = [];
function make() {
  t = 1_000_000;
  const throttle = new LoginThrottle({ now: () => t });
  throttles.push(throttle);
  return throttle;
}
afterEach(() => throttles.splice(0).forEach((x) => x.stop()));

const MIN = 60_000;
const keys = loginThrottleKeys('Admin ', '1.2.3.4');

describe('LoginThrottle', () => {
  it('normalizes the username key', () => {
    expect(keys).toEqual(['user:admin', 'ip:1.2.3.4']);
    expect(loginThrottleKeys('x', undefined)[1]).toBe('ip:unknown');
  });

  it('locks out after 5 failures for 1 minute', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(0);
    th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(MIN);
    t += MIN;
    expect(th.retryAfterMs(keys)).toBe(0);
  });

  it('doubles the lockout per further failure, capped at 15 minutes', () => {
    const th = make();
    for (let i = 0; i < 5; i++) th.recordFailure(keys);
    const lockouts: number[] = [];
    for (let i = 0; i < 6; i++) {
      t += th.retryAfterMs(keys);
      th.recordFailure(keys);
      lockouts.push(th.retryAfterMs(keys));
    }
    expect(lockouts).toEqual([2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN, 15 * MIN, 15 * MIN]);
  });

  it('forgets failures older than the window', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    t += 15 * MIN + 1;
    th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(0);
  });

  it('a lockout on either key blocks', () => {
    const th = make();
    for (let i = 0; i < 5; i++) th.recordFailure(['user:a', 'ip:9.9.9.9']);
    expect(th.retryAfterMs(['user:b', 'ip:9.9.9.9'])).toBe(MIN);
    expect(th.retryAfterMs(['user:a', 'ip:8.8.8.8'])).toBe(MIN);
  });

  it('success clears the username key only', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    th.recordSuccess(keys[0]);
    th.recordFailure(keys);
    expect(th.retryAfterMs([keys[0], 'ip:other'])).toBe(0);
    expect(th.retryAfterMs(['user:other', keys[1]])).toBe(MIN);
  });
});

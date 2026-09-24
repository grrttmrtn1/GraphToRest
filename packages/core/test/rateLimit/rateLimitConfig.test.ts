import { describe, it, expect } from 'vitest';
import {
  parseRateLimitSetting, serializeRateLimitSetting, deserializeRateLimitSetting, effectiveRateLimit, formatRateLimitSetting,
} from '../../src/rateLimit/rateLimitConfig';

describe('rate-limit settings', () => {
  it('parses null, unlimited and objects (burst defaults to the rate)', () => {
    expect(parseRateLimitSetting(null)).toBeNull();
    expect(parseRateLimitSetting('unlimited')).toBe('unlimited');
    expect(parseRateLimitSetting({ requestsPerMinute: 60 })).toEqual({ requestsPerMinute: 60, burst: 60 });
    expect(parseRateLimitSetting({ requestsPerMinute: 60, burst: 5 })).toEqual({ requestsPerMinute: 60, burst: 5 });
  });

  it.each([[0], ['60'], [{}], [{ requestsPerMinute: 0 }], [{ requestsPerMinute: 1.5 }], [{ requestsPerMinute: 10, burst: 0 }],
    [{ requestsPerMinute: 2_000_000 }], [{ requestsPerMinute: 10, extra: 1 }], [[]], ['UNLIMITED']])('rejects %j', (input) => {
    expect(() => parseRateLimitSetting(input)).toThrow();
  });

  it('round-trips through storage and tolerates corrupt rows', () => {
    for (const s of [null, 'unlimited', { requestsPerMinute: 5, burst: 2 }] as const) {
      expect(deserializeRateLimitSetting(serializeRateLimitSetting(s))).toEqual(s);
    }
    expect(deserializeRateLimitSetting('{not json')).toBeNull();
  });

  it('resolves the effective limit', () => {
    const def = { requestsPerMinute: 60, burst: 60 };
    expect(effectiveRateLimit(null, def)).toEqual(def);
    expect(effectiveRateLimit(null, null)).toBeNull();
    expect(effectiveRateLimit('unlimited', def)).toBeNull();
    expect(effectiveRateLimit({ requestsPerMinute: 1, burst: 1 }, def)).toEqual({ requestsPerMinute: 1, burst: 1 });
  });

  it('formats for display', () => {
    expect(formatRateLimitSetting(null)).toBe('default');
    expect(formatRateLimitSetting('unlimited')).toBe('unlimited');
    expect(formatRateLimitSetting({ requestsPerMinute: 60, burst: 20 })).toBe('60/min (burst 20)');
  });
});

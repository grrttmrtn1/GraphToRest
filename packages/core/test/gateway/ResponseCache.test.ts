import { describe, it, expect } from 'vitest';
import { ResponseCache, cacheIdentity } from '../../src/gateway/ResponseCache';

let t = 0;
const make = (maxEntries = 10, maxTtlSeconds = 300) => {
  t = 0;
  return new ResponseCache({ maxEntries, maxTtlSeconds, now: () => t });
};
const meta = (ttlSeconds: number, mappingId = 'm1', connectionId = 'c1') => ({ mappingId, connectionId, ttlSeconds });

describe('ResponseCache', () => {
  it('returns a copy of a stored value until its TTL passes', () => {
    const cache = make();
    const value = { a: 1 };
    cache.set('k', value, meta(10));
    value.a = 2;
    expect(cache.get('k')).toEqual({ a: 1 });
    t = 9_999;
    expect(cache.get('k')).toEqual({ a: 1 });
    t = 10_000;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = make(2);
    cache.set('a', 1, meta(60));
    cache.set('b', 2, meta(60));
    cache.get('a');
    cache.set('c', 3, meta(60));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });

  it('caps TTLs at maxTtlSeconds and treats 0/absent as off', () => {
    const cache = make(10, 30);
    expect(cache.ttlFor(600)).toBe(30);
    expect(cache.ttlFor(5)).toBe(5);
    expect(cache.ttlFor(undefined)).toBe(0);
    expect(make(0).ttlFor(60)).toBe(0);
    expect(make(10, 0).ttlFor(60)).toBe(0);
  });

  it('evicts by mapping and by connection', () => {
    const cache = make();
    cache.set('a', 1, meta(60, 'm1', 'c1'));
    cache.set('b', 2, meta(60, 'm2', 'c1'));
    cache.set('c', 3, meta(60, 'm3', 'c2'));
    cache.evictMapping('m1');
    expect(cache.get('a')).toBeUndefined();
    cache.evictConnection('c1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('builds keys that differ by path, query (order-insensitive) and identity', () => {
    const base = { mappingId: 'm', path: '/api/u/1', query: { b: '2', a: '1' }, identity: 'conn:c' };
    expect(ResponseCache.key(base)).toBe(ResponseCache.key({ ...base, query: { a: '1', b: '2' } }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, path: '/api/u/2' }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, query: { a: '1' } }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, identity: 'conn:d' }));
  });

  it('derives identity from the connection for managed and from the token for passthrough', () => {
    expect(cacheIdentity({ id: 'c1', authMode: 'managed' }, 'ignored')).toBe('conn:c1');
    const a = cacheIdentity({ id: 'c1', authMode: 'passthrough' }, 'token-a');
    expect(a).not.toContain('token-a');
    expect(a).not.toBe(cacheIdentity({ id: 'c1', authMode: 'passthrough' }, 'token-b'));
    expect(a).not.toBe(cacheIdentity({ id: 'c1', authMode: 'passthrough' }, undefined));
  });

  it('never stores when TTL is 0 or the value is not JSON', () => {
    const cache = make();
    cache.set('a', 1, meta(0));
    cache.set('b', undefined, meta(60));
    expect(cache.size).toBe(0);
  });

  it('evicts least recently used entries to stay within maxBytes', () => {
    const cache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 60, maxBytes: 25 });
    const meta = { mappingId: 'm', connectionId: 'c', ttlSeconds: 60 };
    cache.set('a', 'x'.repeat(8), meta); // '"xxxxxxxx"' = 10 bytes
    cache.set('b', 'y'.repeat(8), meta);
    cache.get('a'); // a is now most recently used
    cache.set('c', 'z'.repeat(8), meta); // 30 bytes > 25: evict b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('xxxxxxxx');
    expect(cache.get('c')).toBe('zzzzzzzz');
    expect(cache.bytes).toBe(20);
  });

  it('skips an entry larger than maxBytes without flushing the others', () => {
    const cache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 60, maxBytes: 25 });
    const meta = { mappingId: 'm', connectionId: 'c', ttlSeconds: 60 };
    cache.set('a', 'x'.repeat(8), meta);
    cache.set('huge', 'h'.repeat(100), meta);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('a')).toBe('xxxxxxxx');
    expect(cache.bytes).toBe(10);
  });

  it('keeps the byte total in step with evictions and replacements', () => {
    const cache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 60, maxBytes: 1000 });
    cache.set('a', 'x'.repeat(8), { mappingId: 'm1', connectionId: 'c', ttlSeconds: 60 });
    cache.set('a', 'x'.repeat(18), { mappingId: 'm1', connectionId: 'c', ttlSeconds: 60 });
    expect(cache.bytes).toBe(20);
    cache.set('b', 'y', { mappingId: 'm2', connectionId: 'c', ttlSeconds: 60 });
    cache.evictMapping('m1');
    expect(cache.bytes).toBe(3);
    cache.clear();
    expect(cache.bytes).toBe(0);
  });

  it('ignores a write that started before an eviction (stale epoch)', () => {
    const cache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 60 });
    const epoch = cache.epoch;
    cache.evictMapping('m');
    cache.set('k', 'stale', { mappingId: 'm', connectionId: 'c', ttlSeconds: 60, epoch });
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', 'fresh', { mappingId: 'm', connectionId: 'c', ttlSeconds: 60, epoch: cache.epoch });
    expect(cache.get('k')).toBe('fresh');
  });
});

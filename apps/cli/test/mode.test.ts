import { describe, it, expect } from 'vitest';
import { resolveMode, normalizeServerUrl, DEFAULT_DB_PATH } from '../src/mode';
import type { Profile } from '../src/profile';

const profile: Profile = { server: 'http://saved:3000', username: 'admin', token: 'saved-token', expiresAt: '2026-09-24T00:00:00Z' };
const none = () => null;
const saved = () => profile;

describe('normalizeServerUrl', () => {
  it('strips trailing slashes and keeps a path prefix', () => {
    expect(normalizeServerUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeServerUrl('https://host.example/gtr/')).toBe('https://host.example/gtr');
    expect(normalizeServerUrl('https://host.example/gtr')).toBe('https://host.example/gtr');
  });

  it('rejects non-URLs and non-http schemes as usage errors', () => {
    expect(() => normalizeServerUrl('localhost:3000')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => normalizeServerUrl('not a url')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => normalizeServerUrl('ftp://host')).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('resolveMode', () => {
  it('uses embedded mode with --db, then DB_PATH, then the default when nothing is configured', () => {
    expect(resolveMode({ db: '/tmp/a.db' }, { DB_PATH: '/tmp/b.db' }, none)).toEqual({ kind: 'embedded', dbPath: '/tmp/a.db' });
    expect(resolveMode({}, { DB_PATH: '/tmp/b.db' }, none)).toEqual({ kind: 'embedded', dbPath: '/tmp/b.db' });
    expect(resolveMode({}, {}, none)).toEqual({ kind: 'embedded', dbPath: DEFAULT_DB_PATH });
  });

  it('--server wins over GTR_SERVER and the profile', () => {
    expect(resolveMode({ server: 'http://flag:1/' }, { GTR_SERVER: 'http://env:2', GTR_TOKEN: 't' }, saved)).toEqual({
      kind: 'remote',
      server: 'http://flag:1',
      token: 't',
      source: '--server',
    });
  });

  it('GTR_SERVER wins over the profile', () => {
    expect(resolveMode({}, { GTR_SERVER: 'http://env:2' }, saved)).toEqual({
      kind: 'remote',
      server: 'http://env:2',
      token: null,
      source: 'GTR_SERVER',
    });
  });

  it('reuses the profile token only for the same server', () => {
    expect(resolveMode({ server: 'http://saved:3000/' }, {}, saved)).toMatchObject({ token: 'saved-token' });
    expect(resolveMode({ server: 'http://other:3000' }, {}, saved)).toMatchObject({ token: null });
    expect(resolveMode({}, { GTR_SERVER: 'http://saved:3000' }, saved)).toMatchObject({ token: 'saved-token' });
  });

  it('GTR_TOKEN overrides the profile token for an explicit server', () => {
    expect(resolveMode({ server: 'http://saved:3000' }, { GTR_TOKEN: 'env-token' }, saved)).toMatchObject({ token: 'env-token' });
  });

  it('uses the profile when nothing else is configured', () => {
    expect(resolveMode({}, {}, saved)).toEqual({ kind: 'remote', server: 'http://saved:3000', token: 'saved-token', source: 'profile' });
  });

  it('rejects an explicit --db in remote mode but ignores DB_PATH', () => {
    expect(() => resolveMode({ db: '/tmp/a.db' }, {}, saved)).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => resolveMode({ db: '/tmp/a.db', server: 'http://x' }, {}, none)).toThrow(/--db cannot be combined with remote mode \(server configured via --server\)/);
    expect(resolveMode({}, { DB_PATH: '/data/g.db', GTR_SERVER: 'http://x' }, none)).toMatchObject({ kind: 'remote' });
  });

  it('does not read the profile when --server and GTR_TOKEN are both given', () => {
    const exploding = () => {
      throw new Error('profile should not be read');
    };
    expect(resolveMode({ server: 'http://x' }, { GTR_TOKEN: 't' }, exploding)).toMatchObject({ token: 't' });
  });
});

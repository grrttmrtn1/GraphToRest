import { describe, it, expect } from 'vitest';
import { matchRoute } from '../../src/gateway/matchRoute';

describe('matchRoute', () => {
  it('matches a single path parameter and extracts it', () => {
    expect(matchRoute('/users/{id}', '/users/42')).toEqual({ id: '42' });
  });

  it('matches multiple path parameters', () => {
    expect(matchRoute('/orgs/{org}/repos/{repo}', '/orgs/acme/repos/widgets')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
  });

  it('returns null when segment counts differ', () => {
    expect(matchRoute('/users/{id}', '/users/42/extra')).toBeNull();
  });

  it('returns null when a literal segment does not match', () => {
    expect(matchRoute('/users/{id}', '/groups/42')).toBeNull();
  });

  it('matches a route with no parameters', () => {
    expect(matchRoute('/health', '/health')).toEqual({});
  });

  it('decodes URI-encoded parameter values', () => {
    expect(matchRoute('/users/{id}', '/users/a%20b')).toEqual({ id: 'a b' });
  });

  it('treats special object property names as ordinary parameters', () => {
    const params = matchRoute('/users/{__proto__}', '/users/safe')!;
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(params, '__proto__')).toBe(true);
    expect(params.__proto__).toBe('safe');
  });
});

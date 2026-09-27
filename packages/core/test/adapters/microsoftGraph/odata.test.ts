import { describe, it, expect } from 'vitest';
import { normalizeRequestQuery, encodeCursor, decodeCursor, interpolatePath, assertValidGraphCursorUrl } from '../../../src/adapters/microsoftGraph/odata';
import { GatewayError } from '../../../src/gateway/errors';

describe('normalizeRequestQuery', () => {
  it('picks known REST query params through unchanged', () => {
    expect(normalizeRequestQuery({ select: 'id,displayName', filter: "startswith(displayName,'A')", expand: 'manager' })).toEqual({
      select: 'id,displayName',
      filter: "startswith(displayName,'A')",
      expand: 'manager',
    });
  });

  it('parses a positive limit to a number', () => {
    expect(normalizeRequestQuery({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('rejects a non-integer or non-positive limit', () => {
    for (const limit of ['abc', '-5', '0', '1.5']) {
      expect(() => normalizeRequestQuery({ limit })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('rejects duplicate or structured known query parameters', () => {
    expect(() => normalizeRequestQuery({ select: ['id', 'mail'] })).toThrow('single string');
    expect(() => normalizeRequestQuery({ cursor: { token: 'x' } })).toThrow('single string');
    expect(() => normalizeRequestQuery({ limit: ['10', '20'] })).toThrow('positive integer');
  });

  it('passes cursor through unchanged', () => {
    expect(normalizeRequestQuery({ cursor: 'opaque-token' })).toEqual({ cursor: 'opaque-token' });
  });

  it('ignores unrecognized query params', () => {
    expect(normalizeRequestQuery({ unrelated: 'x' })).toEqual({});
  });

  it('returns an empty object for undefined query', () => {
    expect(normalizeRequestQuery(undefined)).toEqual({});
  });
});

describe('cursor encode/decode', () => {
  it('round-trips a Graph nextLink URL', () => {
    const url = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    expect(decodeCursor(encodeCursor(url))).toBe(url);
  });
});

describe('assertValidGraphCursorUrl', () => {
  it('returns the normalized URL rather than the raw decoded text', () => {
    expect(assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users?$skiptoken=a b', '/users')).toBe(
      'https://graph.microsoft.com/v1.0/users?$skiptoken=a%20b'
    );
  });

  it('matches the host and resource path case-insensitively', () => {
    expect(() => assertValidGraphCursorUrl('https://GRAPH.microsoft.com/v1.0/Users?$skiptoken=x', '/users')).not.toThrow();
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users/abc/messages', '/users/ABC/messages')).not.toThrow();
  });

  it('still rejects a different resource path', () => {
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/groups', '/users')).toThrow(GatewayError);
  });

  it('accepts a valid same-path v1.0 next-link', () => {
    expect(assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users?$skiptoken=abc123', '/users')).toBe(
      'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123'
    );
  });

  it('accepts a valid same-path beta delta-link', () => {
    expect(assertValidGraphCursorUrl('https://graph.microsoft.com/beta/users/delta?$deltatoken=xyz', '/users/delta')).toBe(
      'https://graph.microsoft.com/beta/users/delta?$deltatoken=xyz'
    );
  });

  it('rejects a foreign host', () => {
    expect(() => assertValidGraphCursorUrl('https://10.0.0.5/v1.0/users?$skiptoken=x', '/users')).toThrow(GatewayError);
    try {
      assertValidGraphCursorUrl('https://attacker.example/v1.0/users', '/users');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    }
  });

  it('rejects plain http even to the real Graph host', () => {
    expect(() => assertValidGraphCursorUrl('http://graph.microsoft.com/v1.0/users', '/users')).toThrow(GatewayError);
  });

  it('rejects an IPv4-literal host', () => {
    expect(() => assertValidGraphCursorUrl('https://127.0.0.1/v1.0/users', '/users')).toThrow(GatewayError);
  });

  it('rejects a path outside /v1.0/ or /beta/', () => {
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v2.0/users', '/users')).toThrow(GatewayError);
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/users', '/users')).toThrow(GatewayError);
  });

  it('rejects a cursor pointing at a different Graph resource than the mapping requested', () => {
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/secrets', '/users')).toThrow(GatewayError);
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/me/messages', '/users')).toThrow(GatewayError);
  });

  it('matches a next-link whose path spells a parameter unencoded where the request encoded it', () => {
    const requestPath = interpolatePath('/users/{id}/messages', { id: 'alice@contoso.com' });
    const link = 'https://graph.microsoft.com/v1.0/users/alice@contoso.com/messages?$skiptoken=x';
    expect(assertValidGraphCursorUrl(link, requestPath)).toBe(link);
  });

  it('accepts a next-link whose version segment differs only in case', () => {
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/V1.0/users?$skiptoken=x', '/users')).not.toThrow();
  });

  it('does not let a decoded slash split one parameter into extra path segments', () => {
    const requestPath = interpolatePath('/users/{id}', { id: 'a/b' });
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users/a/b', requestPath)).toThrow(GatewayError);
    expect(() => assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users/a%2Fb', requestPath)).not.toThrow();
  });

  it('rejects an unparseable cursor', () => {
    expect(() => assertValidGraphCursorUrl('not a url', '/users')).toThrow(GatewayError);
  });
});

describe('interpolatePath', () => {
  it('substitutes a single path parameter', () => {
    expect(interpolatePath('/users/{id}', { id: '42' })).toBe('/users/42');
  });

  it('substitutes multiple path parameters', () => {
    expect(interpolatePath('/users/{id}/messages/{messageId}', { id: '42', messageId: '7' })).toBe(
      '/users/42/messages/7'
    );
  });

  it('URL-encodes the substituted value', () => {
    expect(interpolatePath('/users/{id}', { id: 'a b' })).toBe('/users/a%20b');
  });

  it('throws when a required parameter is missing', () => {
    expect(() => interpolatePath('/users/{id}', {})).toThrow('Missing path parameter "id"');
  });
});

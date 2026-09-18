import { describe, it, expect } from 'vitest';
import { normalizeRequestQuery, encodeCursor, decodeCursor, interpolatePath } from '../../../src/adapters/microsoftGraph/odata';

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

  it('ignores a non-numeric or non-positive limit', () => {
    expect(normalizeRequestQuery({ limit: 'abc' })).toEqual({});
    expect(normalizeRequestQuery({ limit: '-5' })).toEqual({});
    expect(normalizeRequestQuery({ limit: '0' })).toEqual({});
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

import { describe, it, expect } from 'vitest';
import { parseConnectionConfig } from '../../src/adapters/connectionConfig';

describe('parseConnectionConfig', () => {
  it('passes through null/undefined as null', () => {
    expect(parseConnectionConfig(undefined)).toBeNull();
    expect(parseConnectionConfig(null)).toBeNull();
  });
  it('rejects non-objects', () => {
    for (const bad of [123, 'x', [1]]) expect(() => parseConnectionConfig(bad)).toThrow('"config" must be an object');
  });
  it('validates and trims config.endpoint', () => {
    expect(parseConnectionConfig({ endpoint: ' https://api.example.com/graphql ', extra: 1 })).toEqual({
      endpoint: 'https://api.example.com/graphql',
      extra: 1,
    });
    expect(() => parseConnectionConfig({ endpoint: 'https://u:p@x.example/' })).toThrow('must not contain a username or password');
    expect(() => parseConnectionConfig({ endpoint: 'file:///etc/passwd' })).toThrow('http or https');
  });
});

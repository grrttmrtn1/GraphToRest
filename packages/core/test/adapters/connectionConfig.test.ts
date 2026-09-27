import { describe, it, expect } from 'vitest';
import { parseConnectionConfig, parseConnectionFields } from '../../src/adapters/connectionConfig';
import { registerDefaultAdapters } from '../../src/adapters/defaults';

describe('parseConnectionConfig', () => {
  it('passes through null/undefined as null', () => {
    expect(parseConnectionConfig(undefined)).toBeNull();
    expect(parseConnectionConfig(null)).toBeNull();
  });
  it('rejects non-objects', () => {
    for (const bad of [123, 'x', [1]]) {
      expect(() => parseConnectionConfig(bad)).toThrow('"config" must be an object');
      expect(() => parseConnectionConfig(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
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

describe('parseConnectionFields', () => {
  it('normalizes valid fields', () => {
    registerDefaultAdapters();
    expect(
      parseConnectionFields({
        name: '  example  ',
        adapterType: 'graphql',
        authMode: 'passthrough',
        config: { endpoint: ' https://api.example.com/graphql ' },
      })
    ).toEqual({
      name: 'example',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.example.com/graphql' },
    });
  });

  it('rejects unsupported adapters, auth modes, and incomplete GraphQL connections', () => {
    registerDefaultAdapters();
    expect(() => parseConnectionFields({ name: 'x', adapterType: 'unknown', authMode: 'passthrough' })).toThrow('adapterType');
    expect(() => parseConnectionFields({ name: 'x', adapterType: 'mock', authMode: 'other' })).toThrow('authMode');
    expect(() => parseConnectionFields({ name: 'x', adapterType: 'graphql', authMode: 'passthrough' })).toThrow('config.endpoint');
  });
});

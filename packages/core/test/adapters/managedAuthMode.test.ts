import { describe, it, expect } from 'vitest';
import { GraphHttpClient } from '../../src/adapters/microsoftGraph/GraphHttpClient';
import { GraphQLHttpClient } from '../../src/adapters/graphql/GraphQLHttpClient';

describe('vendor clients accept authMode "managed"', () => {
  it('GraphHttpClient constructs for managed with a token, and still rejects a missing token', () => {
    expect(() => new GraphHttpClient('managed', 'tok')).not.toThrow();
    expect(() => new GraphHttpClient('managed', undefined)).toThrow(/vendor access token/);
  });

  it('GraphQLHttpClient constructs for managed with a token, and still rejects a missing token', () => {
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'managed', 'tok')).not.toThrow();
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'managed', undefined)).toThrow(/vendor access token/);
  });

  it('both still reject unknown modes with 501', () => {
    expect(() => new GraphHttpClient('basic', 'tok')).toThrow(/passthrough.*managed/);
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'basic', 'tok')).toThrow(/passthrough.*managed/);
  });
});

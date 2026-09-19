import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphQLHttpClient } from '../../../src/adapters/graphql/GraphQLHttpClient';
import { GatewayError } from '../../../src/gateway/errors';

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

afterEach(() => {
  nock.cleanAll();
});

describe('GraphQLHttpClient construction', () => {
  it('throws a 501 GatewayError for an unsupported authMode', () => {
    expect(() => new GraphQLHttpClient(ENDPOINT, 'basic', 'token')).toThrow(GatewayError);
    try {
      new GraphQLHttpClient(ENDPOINT, 'basic', 'token');
    } catch (err) {
      expect((err as GatewayError).status).toBe(501);
    }
  });

  it('throws a 401 GatewayError when passthrough has no vendor token', () => {
    expect(() => new GraphQLHttpClient(ENDPOINT, 'passthrough', undefined)).toThrow(GatewayError);
    try {
      new GraphQLHttpClient(ENDPOINT, 'passthrough', undefined);
    } catch (err) {
      expect((err as GatewayError).status).toBe(401);
    }
  });
});

describe('GraphQLHttpClient.execute', () => {
  it('posts {query, variables} with a bearer token and returns data on success', async () => {
    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } })
      .matchHeader('authorization', 'Bearer vendor-token-1')
      .reply(200, { data: { user: { id: '42' } } });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    const result = await client.execute({ query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } });

    expect(result).toEqual({ user: { id: '42' } });
  });

  it('defaults variables to {} when omitted', async () => {
    nock(HOST).post('/graphql', { query: 'query { viewer { id } }', variables: {} }).reply(200, { data: { viewer: { id: '1' } } });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    const result = await client.execute({ query: 'query { viewer { id } }' });

    expect(result).toEqual({ viewer: { id: '1' } });
  });

  it('normalizes a 200-status response with errors[] into a 400 GatewayError', async () => {
    nock(HOST)
      .post('/graphql')
      .reply(200, { errors: [{ message: 'Cannot query field "nope"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({
      status: 400,
      code: 'GRAPHQL_VALIDATION_FAILED',
      message: 'Cannot query field "nope"',
    });
  });

  it('preserves a non-2xx HTTP status from the endpoint', async () => {
    nock(HOST).post('/graphql').reply(503, { errors: [{ message: 'Service unavailable' }] });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 503 });
  });

  it('normalizes an unreachable endpoint into a 502 GatewayError', async () => {
    nock(HOST).post('/graphql').replyWithError('connection reset');

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 502, code: 'VENDOR_UNREACHABLE' });
  });

  it('preserves the non-2xx status when the response body is not JSON', async () => {
    nock(HOST).post('/graphql').reply(504, '<html><body>Gateway Timeout</body></html>');

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 504 });
  });

  it('normalizes a 200-status non-JSON response to a 502 GatewayError', async () => {
    nock(HOST).post('/graphql').reply(200, 'not json');

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 502, code: 'VENDOR_ERROR' });
  });
});

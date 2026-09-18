import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphQLAdapter } from '../../../src/adapters/graphql/GraphQLAdapter';
import { GatewayError } from '../../../src/gateway/errors';
import type { AuthContext } from '../../../src/adapters/Adapter';

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

afterEach(() => {
  nock.cleanAll();
});

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { connectionId: 'c1', authMode: 'passthrough', vendorToken: 'vendor-token-1', config: { endpoint: ENDPOINT }, ...overrides };
}

describe('GraphQLAdapter.introspect', () => {
  it('sends the standard introspection query and returns the parsed schema', async () => {
    nock(HOST)
      .post('/graphql')
      .reply(200, {
        data: { __schema: { queryType: { name: 'Query' }, mutationType: null, types: [{ name: 'Query', kind: 'OBJECT', fields: [] }] } },
      });

    const adapter = new GraphQLAdapter();
    const result = await adapter.introspect(authContext());

    expect(result).toEqual({ queryTypeName: 'Query', mutationTypeName: null, types: [{ name: 'Query', kind: 'OBJECT', fields: [] }] });
  });
});

describe('GraphQLAdapter.generateMappings', () => {
  it('delegates to generateMappingsFromIntrospection', async () => {
    const adapter = new GraphQLAdapter();
    const introspection = {
      queryTypeName: 'Query',
      mutationTypeName: null,
      types: [
        { name: 'Query', kind: 'OBJECT', fields: [{ name: 'count', args: [], type: { kind: 'SCALAR', name: 'Int', ofType: null } }] },
        { name: 'Int', kind: 'SCALAR', fields: null },
      ],
    };
    const drafts = await adapter.generateMappings(introspection);
    expect(drafts).toEqual([{ route: '/graphql/count', method: 'GET', operation: { query: 'query { count }' } }]);
  });
});

describe('GraphQLAdapter.execute', () => {
  it('posts the operation query/variables and returns the client data', async () => {
    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } })
      .reply(200, { data: { user: { id: '42' } } });

    const adapter = new GraphQLAdapter();
    const result = await adapter.execute(
      { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } },
      { id: '42' },
      authContext()
    );

    expect(result).toEqual({ user: { id: '42' } });
  });

  it('throws a 500 GatewayError when the connection has no config.endpoint', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({ query: 'query { x }' }, {}, authContext({ config: null }))).rejects.toMatchObject({
      status: 500,
      code: 'INVALID_CONFIGURATION',
    });
  });

  it('throws a 500 GatewayError when the operation has no query string', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({}, {}, authContext())).rejects.toMatchObject({ status: 500, code: 'UNSUPPORTED_OPERATION' });
  });

  it('is an instance of GatewayError for the missing-query case', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({}, {}, authContext())).rejects.toBeInstanceOf(GatewayError);
  });
});

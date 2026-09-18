import { describe, it, expect } from 'vitest';
import { generateMappingsFromIntrospection } from '../../../src/adapters/graphql/mappingGeneration';
import type { GraphQLSchemaIntrospection } from '../../../src/adapters/graphql/introspection';

const SCHEMA: GraphQLSchemaIntrospection = {
  queryTypeName: 'Query',
  mutationTypeName: null,
  types: [
    {
      name: 'Query',
      kind: 'OBJECT',
      fields: [
        {
          name: 'user',
          args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
          type: { kind: 'OBJECT', name: 'User', ofType: null },
        },
        {
          name: 'count',
          args: [],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
        {
          name: 'viewer',
          args: [],
          type: { kind: 'OBJECT', name: 'OnlyNested', ofType: null },
        },
        {
          name: 'search',
          args: [
            { name: 'query', type: { kind: 'SCALAR', name: 'String', ofType: null } },
            { name: 'limit', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
          ],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
        {
          name: 'usersByTeam',
          args: [{ name: 'teamIds', type: { kind: 'LIST', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
        {
          name: 'users',
          args: [],
          type: { kind: 'NON_NULL', name: null, ofType: { kind: 'LIST', name: null, ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'User', ofType: null } } } },
        },
      ],
    },
    {
      name: 'User',
      kind: 'OBJECT',
      fields: [
        { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID', ofType: null } },
        { name: 'displayName', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
        { name: 'address', args: [], type: { kind: 'OBJECT', name: 'Address', ofType: null } },
      ],
    },
    { name: 'Address', kind: 'OBJECT', fields: [{ name: 'city', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] },
    { name: 'OnlyNested', kind: 'OBJECT', fields: [{ name: 'address', args: [], type: { kind: 'OBJECT', name: 'Address', ofType: null } }] },
    { name: 'ID', kind: 'SCALAR', fields: null },
    { name: 'String', kind: 'SCALAR', fields: null },
    { name: 'Int', kind: 'SCALAR', fields: null },
  ],
};

describe('generateMappingsFromIntrospection', () => {
  it('generates a GET mapping with a path param for a single scalar-arg field, selecting only scalar sub-fields', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/user/{id}',
      method: 'GET',
      operation: {
        query: 'query($id: ID!) { user(id: $id) { id displayName } }',
        variables: { id: '$params.id' },
      },
      responseTemplate: { id: '$.user.id', displayName: '$.user.displayName' },
    });
  });

  it('generates a GET mapping with no args and no response template for a scalar-returning field', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/count',
      method: 'GET',
      operation: { query: 'query { count }' },
    });
  });

  it('skips the bare route for a field whose return type has no scalar sub-fields of its own', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route === '/graphql/viewer')).toBe(false);
  });

  it('generates a nested-resource route for a field whose only content is a nested object', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/viewer/address',
      method: 'GET',
      operation: { query: 'query { viewer { address { city } } }' },
      responseTemplate: { city: '$.viewer.address.city' },
    });
  });

  it('generates a nested-resource route alongside a field that also has its own scalar leaves', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/user/{id}/address',
      method: 'GET',
      operation: {
        query: 'query($id: ID!) { user(id: $id) { address { city } } }',
        variables: { id: '$params.id' },
      },
      responseTemplate: { city: '$.user.address.city' },
    });
  });

  it('skips a field with more than one argument', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('search'))).toBe(false);
  });

  it('skips a field whose single argument is list-typed', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('usersByTeam'))).toBe(false);
  });

  it('skips a field whose return type is a list', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('users'))).toBe(false);
  });

  it('returns an empty array when the schema has no query type', () => {
    expect(generateMappingsFromIntrospection({ queryTypeName: null, mutationTypeName: null, types: [] })).toEqual([]);
  });
});

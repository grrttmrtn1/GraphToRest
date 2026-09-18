import { describe, it, expect } from 'vitest';
import { parseIntrospection, unwrapType, findType, SCALAR_KINDS, type GraphQLNamedType } from '../../../src/adapters/graphql/introspection';

describe('parseIntrospection', () => {
  it('extracts queryTypeName, mutationTypeName, and types from a raw __schema response', () => {
    const raw = {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: [{ name: 'Query', kind: 'OBJECT', fields: [] }],
      },
    };
    expect(parseIntrospection(raw)).toEqual({
      queryTypeName: 'Query',
      mutationTypeName: 'Mutation',
      types: [{ name: 'Query', kind: 'OBJECT', fields: [] }],
    });
  });

  it('defaults mutationTypeName to null when the schema has no mutations', () => {
    const raw = { __schema: { queryType: { name: 'Query' }, mutationType: null, types: [] } };
    expect(parseIntrospection(raw).mutationTypeName).toBeNull();
  });
});

describe('unwrapType', () => {
  it('unwraps a NON_NULL-wrapped scalar to its named type', () => {
    const ref = { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } };
    expect(unwrapType(ref)).toEqual({ namedType: 'ID', isList: false, isNonNull: true });
  });

  it('unwraps a plain scalar with no wrapping', () => {
    const ref = { kind: 'SCALAR', name: 'String', ofType: null };
    expect(unwrapType(ref)).toEqual({ namedType: 'String', isList: false, isNonNull: false });
  });

  it('detects LIST wrapping', () => {
    const ref = { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'User', ofType: null } };
    expect(unwrapType(ref)).toEqual({ namedType: 'User', isList: true, isNonNull: false });
  });
});

describe('findType', () => {
  it('finds a named type by name', () => {
    const types: GraphQLNamedType[] = [{ name: 'User', kind: 'OBJECT', fields: [] }];
    expect(findType(types, 'User')).toEqual({ name: 'User', kind: 'OBJECT', fields: [] });
  });

  it('returns undefined for an unknown name', () => {
    expect(findType([], 'Nope')).toBeUndefined();
  });
});

describe('SCALAR_KINDS', () => {
  it('contains SCALAR and ENUM', () => {
    expect(SCALAR_KINDS.has('SCALAR')).toBe(true);
    expect(SCALAR_KINDS.has('ENUM')).toBe(true);
    expect(SCALAR_KINDS.has('OBJECT')).toBe(false);
  });
});

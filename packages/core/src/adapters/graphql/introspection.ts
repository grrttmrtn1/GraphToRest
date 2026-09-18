export const INTROSPECTION_QUERY = `
  query GraphToRestIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        name
        kind
        fields {
          name
          args { name type { ...TypeRef } }
          type { ...TypeRef }
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

export interface GraphQLTypeRef {
  kind: string;
  name: string | null;
  ofType: GraphQLTypeRef | null;
}

export interface GraphQLFieldArg {
  name: string;
  type: GraphQLTypeRef;
}

export interface GraphQLField {
  name: string;
  args: GraphQLFieldArg[];
  type: GraphQLTypeRef;
}

export interface GraphQLNamedType {
  name: string;
  kind: string;
  fields: GraphQLField[] | null;
}

export interface GraphQLSchemaIntrospection {
  queryTypeName: string | null;
  mutationTypeName: string | null;
  types: GraphQLNamedType[];
}

interface RawIntrospectionResponse {
  __schema: {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    types: GraphQLNamedType[];
  };
}

export function parseIntrospection(raw: unknown): GraphQLSchemaIntrospection {
  const schema = (raw as RawIntrospectionResponse).__schema;
  return {
    queryTypeName: schema.queryType?.name ?? null,
    mutationTypeName: schema.mutationType?.name ?? null,
    types: schema.types ?? [],
  };
}

export interface UnwrappedType {
  namedType: string | null;
  isList: boolean;
  isNonNull: boolean;
}

// Coarse nullability check: true if NON_NULL appears anywhere in the wrapper chain
// (not just outermost). Sufficient for the single scalar-arg case generateMappings uses.
export function unwrapType(ref: GraphQLTypeRef): UnwrappedType {
  let current: GraphQLTypeRef | null = ref;
  let isList = false;
  let isNonNull = false;
  let namedType: string | null = null;
  while (current) {
    if (current.kind === 'LIST') isList = true;
    if (current.kind === 'NON_NULL') isNonNull = true;
    if (current.name) {
      namedType = current.name;
      break;
    }
    current = current.ofType;
  }
  return { namedType, isList, isNonNull };
}

export function findType(types: GraphQLNamedType[], name: string): GraphQLNamedType | undefined {
  return types.find((t) => t.name === name);
}

export const SCALAR_KINDS = new Set(['SCALAR', 'ENUM']);

import type { MappingDraft } from '../Adapter';
import {
  type GraphQLSchemaIntrospection,
  type GraphQLField,
  type GraphQLNamedType,
  unwrapType,
  findType,
  SCALAR_KINDS,
} from './introspection';

interface ScalarSelection {
  text: string;
  fieldNames: string[];
}

export function generateMappingsFromIntrospection(introspection: GraphQLSchemaIntrospection): MappingDraft[] {
  if (!introspection.queryTypeName) return [];
  const queryType = findType(introspection.types, introspection.queryTypeName);
  if (!queryType?.fields) return [];

  const drafts: MappingDraft[] = [];
  for (const field of queryType.fields) {
    const draft = buildMappingDraft(field, introspection.types);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function buildMappingDraft(field: GraphQLField, types: GraphQLNamedType[]): MappingDraft | null {
  if (field.args.length > 1) return null;

  const selection = buildScalarSelection(field, types);
  if (!selection) return null;

  const responseTemplate =
    selection.fieldNames.length > 0
      ? Object.fromEntries(selection.fieldNames.map((name) => [name, `$.${field.name}.${name}`]))
      : undefined;

  if (field.args.length === 0) {
    return {
      route: `/graphql/${field.name}`,
      method: 'GET',
      operation: { query: `query { ${field.name}${selection.text} }` },
      responseTemplate,
    };
  }

  const arg = field.args[0];
  const argType = unwrapType(arg.type);
  if (!argType.namedType || argType.isList) return null;

  const gqlType = `${argType.namedType}${argType.isNonNull ? '!' : ''}`;
  return {
    route: `/graphql/${field.name}/{${arg.name}}`,
    method: 'GET',
    operation: {
      query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name})${selection.text} }`,
      variables: { [arg.name]: `$params.${arg.name}` },
    },
    responseTemplate,
  };
}

function buildScalarSelection(field: GraphQLField, types: GraphQLNamedType[]): ScalarSelection | null {
  const returnType = unwrapType(field.type);
  if (returnType.isList) return null;
  if (!returnType.namedType) return null;
  if (SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types))) {
    return { text: '', fieldNames: [] };
  }

  const named = findType(types, returnType.namedType);
  const scalarFields = (named?.fields ?? []).filter((f) => {
    const fieldReturn = unwrapType(f.type);
    return fieldReturn.namedType !== null && SCALAR_KINDS.has(scalarKindOf(fieldReturn.namedType, types));
  });
  if (scalarFields.length === 0) return null;

  const fieldNames = scalarFields.map((f) => f.name);
  return { text: ` { ${fieldNames.join(' ')} }`, fieldNames };
}

function scalarKindOf(typeName: string, types: GraphQLNamedType[]): string {
  return findType(types, typeName)?.kind ?? '';
}

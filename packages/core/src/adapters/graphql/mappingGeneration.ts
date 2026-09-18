import type { MappingDraft } from '../Adapter';
import {
  type GraphQLSchemaIntrospection,
  type GraphQLField,
  type GraphQLFieldArg,
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
    drafts.push(...buildMappingDrafts(field, introspection.types));
  }
  return drafts;
}

function buildMappingDrafts(field: GraphQLField, types: GraphQLNamedType[]): MappingDraft[] {
  if (field.args.length > 1) return [];

  const returnType = unwrapType(field.type);
  if (returnType.isList) return [];

  let arg: GraphQLFieldArg | null = null;
  if (field.args.length === 1) {
    arg = field.args[0];
    const argType = unwrapType(arg.type);
    if (!argType.namedType || argType.isList) return [];
  }

  const baseRoute = arg ? `/graphql/${field.name}/{${arg.name}}` : `/graphql/${field.name}`;
  const drafts: MappingDraft[] = [];

  const selection = buildScalarSelection(field, types);
  if (selection) {
    drafts.push(buildDraft(field, arg, baseRoute, selection.text, selection.fieldNames));
  }

  drafts.push(...buildNestedResourceDrafts(field, arg, baseRoute, types));

  return drafts;
}

function buildDraft(
  field: GraphQLField,
  arg: GraphQLFieldArg | null,
  route: string,
  selectionText: string,
  fieldNames: string[]
): MappingDraft {
  const responseTemplate =
    fieldNames.length > 0 ? Object.fromEntries(fieldNames.map((name) => [name, `$.${field.name}.${name}`])) : undefined;

  if (!arg) {
    return { route, method: 'GET', operation: { query: `query { ${field.name}${selectionText} }` }, responseTemplate };
  }

  const gqlType = formatArgType(arg);
  return {
    route,
    method: 'GET',
    operation: {
      query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name})${selectionText} }`,
      variables: { [arg.name]: `$params.${arg.name}` },
    },
    responseTemplate,
  };
}

// One level of object-typed sub-fields becomes a nested resource route, e.g.
// /graphql/user/{id}/address. Deeper nesting, and sub-fields that take their
// own arguments, are out of scope — see Plan 4's Task 3 note for why.
function buildNestedResourceDrafts(
  field: GraphQLField,
  arg: GraphQLFieldArg | null,
  baseRoute: string,
  types: GraphQLNamedType[]
): MappingDraft[] {
  const returnType = unwrapType(field.type);
  if (!returnType.namedType) return [];
  const parentType = findType(types, returnType.namedType);
  if (!parentType?.fields) return [];

  const drafts: MappingDraft[] = [];
  for (const subField of parentType.fields) {
    if (subField.args.length > 0) continue;
    const subReturn = unwrapType(subField.type);
    if (!subReturn.namedType || subReturn.isList) continue;
    if (SCALAR_KINDS.has(scalarKindOf(subReturn.namedType, types))) continue;

    const nestedType = findType(types, subReturn.namedType);
    const nestedScalarFields = (nestedType?.fields ?? []).filter((f) => isScalarLeaf(f, types));
    if (nestedScalarFields.length === 0) continue;

    const nestedFieldNames = nestedScalarFields.map((f) => f.name);
    const nestedSelection = `${subField.name} { ${nestedFieldNames.join(' ')} }`;
    const responseTemplate = Object.fromEntries(
      nestedFieldNames.map((name) => [name, `$.${field.name}.${subField.name}.${name}`])
    );
    const route = `${baseRoute}/${subField.name}`;

    if (!arg) {
      drafts.push({
        route,
        method: 'GET',
        operation: { query: `query { ${field.name} { ${nestedSelection} } }` },
        responseTemplate,
      });
      continue;
    }

    const gqlType = formatArgType(arg);
    drafts.push({
      route,
      method: 'GET',
      operation: {
        query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name}) { ${nestedSelection} } }`,
        variables: { [arg.name]: `$params.${arg.name}` },
      },
      responseTemplate,
    });
  }
  return drafts;
}

function formatArgType(arg: GraphQLFieldArg): string {
  const argType = unwrapType(arg.type);
  return `${argType.namedType}${argType.isNonNull ? '!' : ''}`;
}

function isScalarLeaf(field: GraphQLField, types: GraphQLNamedType[]): boolean {
  const returnType = unwrapType(field.type);
  return returnType.namedType !== null && SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types));
}

function buildScalarSelection(field: GraphQLField, types: GraphQLNamedType[]): ScalarSelection | null {
  const returnType = unwrapType(field.type);
  if (!returnType.namedType) return null;
  if (SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types))) {
    return { text: '', fieldNames: [] };
  }

  const named = findType(types, returnType.namedType);
  const scalarFields = (named?.fields ?? []).filter((f) => isScalarLeaf(f, types));
  if (scalarFields.length === 0) return null;

  const fieldNames = scalarFields.map((f) => f.name);
  return { text: ` { ${fieldNames.join(' ')} }`, fieldNames };
}

function scalarKindOf(typeName: string, types: GraphQLNamedType[]): string {
  return findType(types, typeName)?.kind ?? '';
}

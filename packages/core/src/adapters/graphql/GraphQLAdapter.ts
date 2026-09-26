import type { Adapter, AuthContext, MappingDraft, RequestContext } from '../Adapter';
import { GatewayError } from '../../gateway/errors';
import { GraphQLHttpClient } from './GraphQLHttpClient';
import { INTROSPECTION_QUERY, parseIntrospection, type GraphQLSchemaIntrospection } from './introspection';
import { generateMappingsFromIntrospection } from './mappingGeneration';

export class GraphQLAdapter implements Adapter {
  readonly type = 'graphql';

  async introspect(authContext: AuthContext): Promise<GraphQLSchemaIntrospection> {
    const client = this.clientFor(authContext);
    const raw = await client.execute({ query: INTROSPECTION_QUERY });
    return parseIntrospection(raw);
  }

  async generateMappings(introspection: unknown): Promise<MappingDraft[]> {
    return generateMappingsFromIntrospection(introspection as GraphQLSchemaIntrospection);
  }

  async execute(
    operation: Record<string, unknown>,
    _params: Record<string, string>,
    authContext: AuthContext,
    _request: RequestContext = {}
  ): Promise<unknown> {
    const client = this.clientFor(authContext);
    const query = operation.query as string | undefined;
    if (!query) {
      throw new GatewayError('UNSUPPORTED_OPERATION', 'GraphQL operation is missing a "query" string', 500);
    }
    const variables = operation.variables as Record<string, unknown> | undefined;
    return client.execute({ query, variables: variables && coerceScalarVariables(query, variables) });
  }

  private clientFor(authContext: AuthContext): GraphQLHttpClient {
    const endpoint = authContext.config?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new GatewayError('INVALID_CONFIGURATION', 'GraphQL connections require a config.endpoint URL', 500);
    }
    return new GraphQLHttpClient(endpoint, authContext.authMode ?? 'passthrough', authContext.vendorToken);
  }
}

const VARIABLE_DEFINITION = /\$(\w+)\s*:\s*(\w+)/g;

/**
 * Route parameters always arrive as strings, but a GraphQL server rejects "42" for an `Int` variable. Converts string
 * values of variables the query declares as non-list `Int`, `Float` or `Boolean`; other values pass through unchanged.
 */
export function coerceScalarVariables(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const declared = new Map<string, string>();
  for (const [, name, type] of query.matchAll(VARIABLE_DEFINITION)) declared.set(name, type);
  const coerced: Record<string, unknown> = { ...variables };
  for (const [name, value] of Object.entries(variables)) {
    const type = declared.get(name);
    if (typeof value !== 'string' || !type) continue;
    if (type === 'Int') {
      const n = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n > 2_147_483_647 || n < -2_147_483_648) throw invalidVariable(name, type);
      coerced[name] = n;
    } else if (type === 'Float') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) throw invalidVariable(name, type);
      coerced[name] = n;
    } else if (type === 'Boolean') {
      if (value !== 'true' && value !== 'false') throw invalidVariable(name, type);
      coerced[name] = value === 'true';
    }
  }
  return coerced;
}

function invalidVariable(name: string, type: string): GatewayError {
  return new GatewayError('INVALID_INPUT', `Path parameter "${name}" must be a valid ${type}`, 400);
}

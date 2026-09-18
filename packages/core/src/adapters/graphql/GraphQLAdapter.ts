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
    return client.execute({ query, variables: operation.variables as Record<string, unknown> | undefined });
  }

  private clientFor(authContext: AuthContext): GraphQLHttpClient {
    const endpoint = authContext.config?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new GatewayError('INVALID_CONFIGURATION', 'GraphQL connections require a config.endpoint URL', 500);
    }
    return new GraphQLHttpClient(endpoint, authContext.authMode ?? 'passthrough', authContext.vendorToken);
  }
}

import type { Adapter, AuthContext, MappingDraft, RequestContext } from '../Adapter';
import { GatewayError } from '../../gateway/errors';
import { GraphHttpClient } from './GraphHttpClient';
import { normalizeRequestQuery, interpolatePath } from './odata';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from './defaultMappings';

export class MicrosoftGraphAdapter implements Adapter {
  readonly type = 'microsoft-graph';

  async introspect(_authContext: AuthContext): Promise<unknown> {
    return { curatedRoutes: DEFAULT_MICROSOFT_GRAPH_MAPPINGS.map((mapping) => mapping.route) };
  }

  async generateMappings(_introspection: unknown): Promise<MappingDraft[]> {
    return DEFAULT_MICROSOFT_GRAPH_MAPPINGS;
  }

  async execute(
    operation: Record<string, unknown>,
    params: Record<string, string>,
    authContext: AuthContext,
    request: RequestContext = {}
  ): Promise<unknown> {
    const client = new GraphHttpClient(authContext.authMode ?? 'passthrough', authContext.vendorToken);
    const query = normalizeRequestQuery(request.query);
    const kind = operation.kind as string;

    if (kind === 'get') {
      return client.get(interpolatePath(operation.path as string, params), query);
    }

    if (kind === 'list') {
      return client.list(interpolatePath(operation.path as string, params), query);
    }

    if (kind === 'batch') {
      const requests = (operation.requests as Array<{ id: string; method: string; path: string }>).map((r) => ({
        id: r.id,
        method: r.method,
        path: interpolatePath(r.path, params),
      }));
      return client.batch(requests);
    }

    throw new GatewayError('UNSUPPORTED_OPERATION', `Unsupported Microsoft Graph operation kind: ${kind}`, 500);
  }
}

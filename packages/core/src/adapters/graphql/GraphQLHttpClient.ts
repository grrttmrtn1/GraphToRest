import { GatewayError } from '../../gateway/errors';

export interface GraphQLExecuteInput {
  query: string;
  variables?: Record<string, unknown>;
}

interface GraphQLErrorEntry {
  message: string;
  extensions?: { code?: string };
}

interface GraphQLHttpResponse {
  data?: unknown;
  errors?: GraphQLErrorEntry[];
}

export class GraphQLHttpClient {
  constructor(
    private endpoint: string,
    authMode: string,
    private vendorToken: string | undefined
  ) {
    if (authMode !== 'passthrough') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'GraphQL connections only support authMode "passthrough" until Plan 5 adds managed OAuth',
        501
      );
    }
    if (!vendorToken) {
      throw new GatewayError('MISSING_VENDOR_TOKEN', 'This request requires a vendor access token', 401);
    }
  }

  async execute(input: GraphQLExecuteInput): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.vendorToken}`,
        },
        body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      });
    } catch (err) {
      throw new GatewayError('VENDOR_UNREACHABLE', 'Could not reach the GraphQL endpoint', 502, {
        vendor: 'graphql',
        message: (err as Error).message,
      });
    }

    let body: GraphQLHttpResponse;
    try {
      body = (await response.json()) as GraphQLHttpResponse;
    } catch {
      throw new GatewayError('VENDOR_ERROR', 'GraphQL endpoint returned a non-JSON response', 502, { vendor: 'graphql' });
    }

    if (!response.ok) {
      const firstError = body.errors?.[0];
      throw new GatewayError(
        firstError?.extensions?.code ?? 'VENDOR_ERROR',
        firstError?.message ?? `GraphQL endpoint responded with status ${response.status}`,
        response.status,
        { vendor: 'graphql', body }
      );
    }

    if (body.errors && body.errors.length > 0) {
      const firstError = body.errors[0];
      throw new GatewayError(firstError.extensions?.code ?? 'GRAPHQL_ERROR', firstError.message, 400, {
        vendor: 'graphql',
        errors: body.errors,
      });
    }

    return body.data;
  }
}

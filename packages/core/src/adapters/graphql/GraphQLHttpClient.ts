import { GatewayError } from '../../gateway/errors';
import { redactVendorText } from '../../gateway/redact';
import { outboundFetch } from '../../net/outboundUrl';

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
    if (authMode !== 'passthrough' && authMode !== 'managed') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'GraphQL connections only support authMode "passthrough" or "managed"',
        501
      );
    }
    if (!vendorToken) {
      throw new GatewayError('MISSING_VENDOR_TOKEN', 'This request requires a vendor access token', 401);
    }
  }

  async execute(input: GraphQLExecuteInput): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      response = await outboundFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.vendorToken}`,
        },
        body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      });
      text = await response.text();
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError('VENDOR_UNREACHABLE', 'Could not reach the GraphQL endpoint', 502, {
        vendor: 'graphql',
        message: (err as Error).message,
      });
    }

    let body: GraphQLHttpResponse | null = null;
    try {
      body = JSON.parse(text) as GraphQLHttpResponse;
    } catch {
      // non-JSON body — body stays null, handled below
    }

    if (!response.ok) {
      const firstError = body?.errors?.[0];
      throw new GatewayError(
        firstError?.extensions?.code ?? 'VENDOR_ERROR',
        firstError?.message ? redactVendorText(firstError.message) : `GraphQL endpoint responded with status ${response.status}`,
        response.status,
        { vendor: 'graphql', body: redactVendorText(body ? JSON.stringify(body) : text, 500) }
      );
    }

    if (!body) {
      throw new GatewayError('VENDOR_ERROR', 'GraphQL endpoint returned a non-JSON response', 502, { vendor: 'graphql' });
    }

    if (body.errors && body.errors.length > 0) {
      const firstError = body.errors[0];
      throw new GatewayError(firstError.extensions?.code ?? 'GRAPHQL_ERROR', redactVendorText(String(firstError.message)), 400, {
        vendor: 'graphql',
        errors: body.errors.map((e) => ({ message: redactVendorText(String(e.message)), code: e.extensions?.code })),
      });
    }

    return body.data;
  }
}

import { Client } from '@microsoft/microsoft-graph-client';
import { GatewayError } from '../../gateway/errors';
import { encodeCursor, decodeCursor, type NormalizedRequestQuery } from './odata';

export interface GraphListResult {
  data: unknown[];
  nextCursor: string | null;
}

export interface GraphBatchRequest {
  id: string;
  method: string;
  path: string;
}

export class GraphHttpClient {
  private client: Client;

  constructor(authMode: string, vendorToken: string | undefined) {
    if (authMode !== 'passthrough') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'Microsoft Graph connections only support authMode "passthrough" until Plan 5 adds managed OAuth',
        501
      );
    }
    if (!vendorToken) {
      throw new GatewayError('MISSING_VENDOR_TOKEN', 'This request requires a vendor access token', 401);
    }
    this.client = Client.init({
      authProvider: (done) => done(null, vendorToken),
    });
  }

  async get(path: string, query: NormalizedRequestQuery): Promise<unknown> {
    try {
      let req = this.client.api(path);
      if (query.select) req = req.select(query.select);
      if (query.expand) req = req.expand(query.expand);
      return await req.get();
    } catch (err) {
      throw toGatewayError(err);
    }
  }

  async list(path: string, query: NormalizedRequestQuery): Promise<GraphListResult> {
    try {
      let req = query.cursor ? this.client.api(decodeCursor(query.cursor)) : this.client.api(path);
      if (!query.cursor) {
        if (query.select) req = req.select(query.select);
        if (query.filter) req = req.filter(query.filter);
        if (query.expand) req = req.expand(query.expand);
        if (query.limit) req = req.top(query.limit);
      }
      const raw = (await req.get()) as Record<string, unknown>;
      const next = (raw['@odata.nextLink'] as string | undefined) ?? (raw['@odata.deltaLink'] as string | undefined);
      return {
        data: Array.isArray(raw.value) ? (raw.value as unknown[]) : [],
        nextCursor: next ? encodeCursor(next) : null,
      };
    } catch (err) {
      throw toGatewayError(err);
    }
  }

  async batch(requests: GraphBatchRequest[]): Promise<Record<string, unknown>> {
    try {
      const raw = (await this.client.api('/$batch').post({
        requests: requests.map((r) => ({ id: r.id, method: r.method, url: r.path })),
      })) as { responses: Array<{ id: string; status: number; body: unknown }> };
      const byId: Record<string, unknown> = {};
      for (const response of raw.responses) {
        if (response.status >= 400) {
          throw new GatewayError(
            'VENDOR_ERROR',
            `Batch sub-request "${response.id}" failed with status ${response.status}`,
            502,
            { vendor: 'microsoft-graph', body: response.body }
          );
        }
        byId[response.id] = response.body;
      }
      return byId;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw toGatewayError(err);
    }
  }
}

function toGatewayError(err: unknown): GatewayError {
  const graphErr = err as { statusCode?: number; code?: string | null; message?: string; body?: unknown };
  if (typeof graphErr?.statusCode === 'number') {
    return new GatewayError(
      graphErr.code ?? 'VENDOR_ERROR',
      graphErr.message ?? 'Microsoft Graph request failed',
      graphErr.statusCode > 0 ? graphErr.statusCode : 502,
      { vendor: 'microsoft-graph', body: graphErr.body }
    );
  }
  return new GatewayError('VENDOR_ERROR', 'Microsoft Graph request failed', 502, { vendor: 'microsoft-graph' });
}

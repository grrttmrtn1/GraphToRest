import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { MicrosoftGraphAdapter } from '../../../src/adapters/microsoftGraph/MicrosoftGraphAdapter';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from '../../../src/adapters/microsoftGraph/defaultMappings';
import { GatewayError } from '../../../src/gateway/errors';

afterEach(() => {
  nock.cleanAll();
});

describe('MicrosoftGraphAdapter', () => {
  const adapter = new MicrosoftGraphAdapter();

  it('has type "microsoft-graph"', () => {
    expect(adapter.type).toBe('microsoft-graph');
  });

  it('serves the curated mapping table regardless of introspection input', async () => {
    const drafts = await adapter.generateMappings(await adapter.introspect({ connectionId: 'c1' }));
    expect(drafts).toEqual(DEFAULT_MICROSOFT_GRAPH_MAPPINGS);
  });

  it('dispatches a "get" operation to a single Graph resource, applying $expand from the request', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $expand: 'manager' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const result = await adapter.execute(
      { kind: 'get', path: '/users/{id}' },
      { id: '42' },
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' },
      { query: { expand: 'manager' } }
    );

    expect(result).toEqual({ id: '42', displayName: 'Ada Lovelace' });
  });

  it('dispatches a "list" operation and returns the normalized pagination envelope', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/groups').reply(200, { value: [{ id: 'g1' }] });

    const result = await adapter.execute(
      { kind: 'list', path: '/groups' },
      {},
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' }
    );

    expect(result).toEqual({ data: [{ id: 'g1' }], nextCursor: null });
  });

  it('dispatches a "batch" operation, interpolating path params into each sub-request', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch', {
        requests: [
          { id: 'user', method: 'GET', url: '/users/42' },
          { id: 'manager', method: 'GET', url: '/users/42/manager' },
        ],
      })
      .reply(200, {
        responses: [
          { id: 'user', status: 200, body: { id: '42' } },
          { id: 'manager', status: 200, body: { id: '99' } },
        ],
      });

    const result = await adapter.execute(
      {
        kind: 'batch',
        requests: [
          { id: 'user', method: 'GET', path: '/users/{id}' },
          { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
        ],
      },
      { id: '42' },
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' }
    );

    expect(result).toEqual({ user: { id: '42' }, manager: { id: '99' } });
  });

  it('rejects an unsupported operation kind', async () => {
    await expect(
      adapter.execute({ kind: 'delete-everything' }, {}, { connectionId: 'c1', authMode: 'passthrough', vendorToken: 't' })
    ).rejects.toBeInstanceOf(GatewayError);
  });
});

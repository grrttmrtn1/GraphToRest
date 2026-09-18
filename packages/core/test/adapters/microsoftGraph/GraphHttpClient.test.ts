import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphHttpClient } from '../../../src/adapters/microsoftGraph/GraphHttpClient';
import { encodeCursor } from '../../../src/adapters/microsoftGraph/odata';
import { GatewayError } from '../../../src/gateway/errors';

afterEach(() => {
  nock.cleanAll();
});

describe('GraphHttpClient construction', () => {
  it('throws a 501 GatewayError for an unsupported authMode', () => {
    expect(() => new GraphHttpClient('managed', 'token')).toThrow(GatewayError);
    try {
      new GraphHttpClient('managed', 'token');
    } catch (err) {
      expect((err as GatewayError).status).toBe(501);
    }
  });

  it('throws a 401 GatewayError when passthrough has no vendor token', () => {
    expect(() => new GraphHttpClient('passthrough', undefined)).toThrow(GatewayError);
    try {
      new GraphHttpClient('passthrough', undefined);
    } catch (err) {
      expect((err as GatewayError).status).toBe(401);
    }
  });
});

describe('GraphHttpClient.get', () => {
  it('fetches a single resource and applies $select', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $select: 'id,displayName' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.get('/users/42', { select: 'id,displayName' });

    expect(result).toEqual({ id: '42', displayName: 'Ada Lovelace' });
  });

  it('normalizes a vendor error response into a GatewayError', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/999')
      .reply(404, { error: { code: 'Request_ResourceNotFound', message: 'User not found' } });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    await expect(client.get('/users/999', {})).rejects.toMatchObject({ status: 404, code: 'Request_ResourceNotFound' });
  });
});

describe('GraphHttpClient.list', () => {
  it('returns data and an encoded nextCursor when @odata.nextLink is present', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users')
      .reply(200, { value: [{ id: '1' }], '@odata.nextLink': nextLink });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users', {});

    expect(result.data).toEqual([{ id: '1' }]);
    expect(result.nextCursor).toBe(encodeCursor(nextLink));
  });

  it('returns a null nextCursor when there is no further page', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/users').reply(200, { value: [{ id: '1' }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users', {});

    expect(result.nextCursor).toBeNull();
  });

  it('falls back to @odata.deltaLink for the nextCursor on a delta query final page', async () => {
    const deltaLink = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=xyz789';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/delta')
      .reply(200, { value: [{ id: '1', displayName: 'Ada Lovelace' }], '@odata.deltaLink': deltaLink });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users/delta', {});

    expect(result.data).toEqual([{ id: '1', displayName: 'Ada Lovelace' }]);
    expect(result.nextCursor).toBe(encodeCursor(deltaLink));
  });

  it('follows a decoded cursor directly instead of rebuilding the query', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/users').query({ $skiptoken: 'abc123' }).reply(200, { value: [{ id: '2' }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const cursor = encodeCursor('https://graph.microsoft.com/v1.0/users?$skiptoken=abc123');
    const result = await client.list('/users', { cursor });

    expect(result.data).toEqual([{ id: '2' }]);
  });
});

describe('GraphHttpClient.batch', () => {
  it('combines multiple sub-requests into one call, keyed by id', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch', {
        requests: [
          { id: 'user', method: 'GET', url: '/users/42' },
          { id: 'manager', method: 'GET', url: '/users/42/manager' },
        ],
      })
      .reply(200, {
        responses: [
          { id: 'user', status: 200, body: { id: '42', displayName: 'Ada Lovelace' } },
          { id: 'manager', status: 200, body: { id: '99', displayName: 'Grace Hopper' } },
        ],
      });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.batch([
      { id: 'user', method: 'GET', path: '/users/42' },
      { id: 'manager', method: 'GET', path: '/users/42/manager' },
    ]);

    expect(result).toEqual({
      user: { id: '42', displayName: 'Ada Lovelace' },
      manager: { id: '99', displayName: 'Grace Hopper' },
    });
  });

  it('throws a GatewayError if any sub-response failed', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch')
      .reply(200, { responses: [{ id: 'user', status: 404, body: { error: { message: 'not found' } } }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    await expect(client.batch([{ id: 'user', method: 'GET', path: '/users/999' }])).rejects.toBeInstanceOf(GatewayError);
  });
});

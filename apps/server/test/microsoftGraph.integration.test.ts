import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-msgraph-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const mappingStore = new MappingStore(db);
  const gatewayEngine = new GatewayEngine(mappingStore);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true });
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedMicrosoftGraphConnection() {
  const connectionRes = await request(app)
    .post('/admin/connections')
    .send({ name: 'ms-graph-test', adapterType: 'microsoft-graph', authMode: 'passthrough' });
  const connectionId = connectionRes.body.id;

  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName', mail: '$.mail' },
  });
  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users',
    method: 'GET',
    operation: { kind: 'list', path: '/users' },
  });
  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}/overview',
    method: 'GET',
    operation: {
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    },
    responseTemplate: {
      id: '$.user.id',
      displayName: '$.user.displayName',
      managerDisplayName: '$.manager.displayName',
    },
  });

  const apiKeyRes = await request(app).post('/admin/api-keys').send({});
  return apiKeyRes.body.plaintext as string;
}

describe('Microsoft Graph adapter end-to-end', () => {
  it('proxies a single-resource get, applying $select from the query string', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $select: 'id,displayName,mail' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace', mail: 'ada@example.com' });

    const res = await request(app)
      .get('/api/msgraph/users/42?select=id,displayName,mail')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', displayName: 'Ada Lovelace', mail: 'ada@example.com' });
  });

  it('normalizes @odata.nextLink into a cursor and honors it on the next request', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    const nextLink = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users')
      .reply(200, { value: [{ id: '1' }], '@odata.nextLink': nextLink });

    const firstPage = await request(app)
      .get('/api/msgraph/users')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toEqual([{ id: '1' }]);
    expect(typeof firstPage.body.nextCursor).toBe('string');

    nock('https://graph.microsoft.com').get('/v1.0/users').query({ $skiptoken: 'abc123' }).reply(200, { value: [{ id: '2' }] });

    const secondPage = await request(app)
      .get(`/api/msgraph/users?cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(secondPage.status).toBe(200);
    expect(secondPage.body).toEqual({ data: [{ id: '2' }], nextCursor: null });
  });

  it('combines two Graph calls into one response via internal batching', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
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

    const res = await request(app)
      .get('/api/msgraph/users/42/overview')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', displayName: 'Ada Lovelace', managerDisplayName: 'Grace Hopper' });
  });

  it('returns a normalized 401 when no vendor token is supplied for a passthrough connection', async () => {
    const apiKey = await seedMicrosoftGraphConnection();

    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_VENDOR_TOKEN');
  });

  it('normalizes a Graph error response to the standard error envelope', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/999')
      .query(true)
      .reply(404, { error: { code: 'Request_ResourceNotFound', message: 'User not found' } });

    const res = await request(app)
      .get('/api/msgraph/users/999')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Request_ResourceNotFound');
  });
});

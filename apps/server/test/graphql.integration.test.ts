import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, createAdapter } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-graphql-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const mappingStore = new MappingStore(db);
  const gatewayEngine = new GatewayEngine(mappingStore);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true });
  admin = createAdminClient(app, mappingStore);
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedGraphQLConnection() {
  const connectionRes = await admin
    .post('/admin/connections')
    .send({ name: 'graphql-test', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: ENDPOINT } });
  const apiKeyRes = await admin.post('/admin/api-keys').send({});
  return { connectionId: connectionRes.body.id as string, apiKey: apiKeyRes.body.plaintext as string };
}

describe('GraphQL adapter end-to-end', () => {
  it('executes a hand-written query mapping and shapes the response by template', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({
      connectionId,
      route: '/gh/users/{id}',
      method: 'GET',
      operation: { query: 'query($id: ID!) { user(id: $id) { id name } }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.user.id', name: '$.user.name' },
    });

    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id name } }', variables: { id: '42' } })
      .reply(200, { data: { user: { id: '42', name: 'Ada Lovelace' } } });

    const res = await request(app)
      .get('/api/gh/users/42')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', name: 'Ada Lovelace' });
  });

  it('normalizes a 200-status errors[] response to a 400 GatewayError', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/gh/broken', method: 'GET', operation: { query: 'query { broken }' } });

    nock(HOST)
      .post('/graphql')
      .reply(200, { errors: [{ message: 'Cannot query field "broken"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });

    const res = await request(app).get('/api/gh/broken').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('preserves a non-2xx HTTP status from the GraphQL endpoint', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/gh/down', method: 'GET', operation: { query: 'query { down }' } });

    nock(HOST).post('/graphql').reply(503, { errors: [{ message: 'Service unavailable' }] });

    const res = await request(app).get('/api/gh/down').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(503);
  });

  it('returns a normalized 401 when no vendor token is supplied', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/gh/needs-token', method: 'GET', operation: { query: 'query { viewer }' } });

    const res = await request(app).get('/api/gh/needs-token').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_VENDOR_TOKEN');
  });

  it('generates a working mapping from live schema introspection and serves it end-to-end', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();

    nock(HOST)
      .post('/graphql')
      .reply(200, {
        data: {
          __schema: {
            queryType: { name: 'Query' },
            mutationType: null,
            types: [
              {
                name: 'Query',
                kind: 'OBJECT',
                fields: [
                  {
                    name: 'user',
                    args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
                    type: { kind: 'OBJECT', name: 'User', ofType: null },
                  },
                ],
              },
              {
                name: 'User',
                kind: 'OBJECT',
                fields: [
                  { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID', ofType: null } },
                  { name: 'displayName', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
                ],
              },
              { name: 'ID', kind: 'SCALAR', fields: null },
              { name: 'String', kind: 'SCALAR', fields: null },
            ],
          },
        },
      });

    const adapter = createAdapter('graphql');
    const introspection = await adapter.introspect({ connectionId, authMode: 'passthrough', vendorToken: 'vendor-token-1', config: { endpoint: ENDPOINT } });
    const drafts = await adapter.generateMappings(introspection);

    expect(drafts).toEqual([
      {
        route: '/graphql/user/{id}',
        method: 'GET',
        operation: { query: 'query($id: ID!) { user(id: $id) { id displayName } }', variables: { id: '$params.id' } },
        responseTemplate: { id: '$.user.id', displayName: '$.user.displayName' },
      },
    ]);

    for (const draft of drafts) {
      const created = await admin.post('/admin/mappings').send({ connectionId, ...draft });
      expect(created.status).toBe(201);
    }

    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id displayName } }', variables: { id: '99' } })
      .reply(200, { data: { user: { id: '99', displayName: 'Grace Hopper' } } });

    const res = await request(app)
      .get('/api/graphql/user/99')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '99', displayName: 'Grace Hopper' });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, setOutboundPolicy } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-outbound-guard-${Date.now()}-${Math.random()}.db`);
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

describe('outbound guard end-to-end', () => {
  it('rejects a connection whose endpoint embeds credentials', async () => {
    const res = await admin
      .post('/admin/connections')
      .send({ name: 'bad', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: 'https://u:p@x.example/graphql' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-object config', async () => {
    const res = await admin.post('/admin/connections').send({ name: 'bad', adapterType: 'graphql', authMode: 'passthrough', config: 'nope' });
    expect(res.status).toBe(400);
  });

  it('returns 502 OUTBOUND_TARGET_BLOCKED for a private endpoint and succeeds once opted in', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/q', method: 'GET', operation: { query: '{ viewer { id } }' } });
    setOutboundPolicy({ lookup: async () => ['10.0.0.2'] });
    const blocked = await request(app).get('/api/q').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 't');
    expect(blocked.status).toBe(502);
    expect(blocked.body.error.code).toBe('OUTBOUND_TARGET_BLOCKED');
    expect(blocked.body.error.message).toContain('ALLOW_PRIVATE_NETWORK_TARGETS');

    setOutboundPolicy({ allowPrivateNetworkTargets: true });
    nock(HOST).post('/graphql').reply(200, { data: { viewer: { id: 'v1' } } });
    const allowed = await request(app).get('/api/q').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 't');
    expect(allowed.status).toBe(200);
  });
});

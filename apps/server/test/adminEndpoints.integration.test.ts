import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import YAML from 'yaml';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
  listAdapterTypes,
} from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let store: MappingStore;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;

function buildApp(withManagedAuth: boolean) {
  const managedAuth = withManagedAuth ? new ManagedTokenService(store, new CredentialCipher('00'.repeat(32))) : undefined;
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store, managedAuth),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    managedAuth,
    publicBaseUrl: 'https://gtr.example.test',
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-admin-endpoints-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = buildApp(true);
  admin = createAdminClient(app, store);
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seedConnectionWithMapping(name = 'c1', route = '/users/{id}') {
  const connection = store.createConnection({ name, adapterType: 'mock', authMode: 'passthrough' });
  const mapping = store.createMapping({
    connectionId: connection.id,
    route,
    method: 'GET',
    operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
  });
  return { connection, mapping };
}

describe('authentication', () => {
  it.each([
    ['get', '/admin/adapters'],
    ['get', '/admin/api-keys'],
    ['delete', '/admin/api-keys/x'],
    ['delete', '/admin/connections/x'],
    ['delete', '/admin/connections/x/credentials'],
    ['delete', '/admin/mappings/x'],
    ['get', '/admin/mappings/export'],
    ['post', '/admin/mappings/import'],
  ] as const)('%s %s requires an admin session', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/adapters', () => {
  it('lists the registered adapter types', async () => {
    const res = await admin.get('/admin/adapters');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listAdapterTypes());
    expect(res.body).toEqual(expect.arrayContaining(['mock', 'microsoft-graph', 'graphql']));
  });
});

describe('API keys', () => {
  it('lists keys without secrets and revokes them', async () => {
    const created = await admin.post('/admin/api-keys').send({ label: 'dev' });
    const listed = await admin.get('/admin/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: created.body.id, label: 'dev', lastUsedAt: null });
    expect(JSON.stringify(listed.body)).not.toContain(created.body.plaintext.split('.').pop());
    expect(listed.body[0]).not.toHaveProperty('hashedKey');

    expect((await admin.delete(`/admin/api-keys/${created.body.id}`)).status).toBe(204);
    expect((await admin.get('/admin/api-keys')).body).toEqual([]);
    const reused = await request(app).get('/api/anything').set('Authorization', `Bearer ${created.body.plaintext}`);
    expect(reused.status).toBe(401);

    const again = await admin.delete(`/admin/api-keys/${created.body.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('NOT_FOUND');
  });
});

describe('API key rate limits', () => {
  it('creates a key with a limit and changes it with PATCH', async () => {
    const created = await admin.post('/admin/api-keys').send({ label: 'ci', rateLimit: { requestsPerMinute: 30 } });
    expect(created.status).toBe(201);
    expect(created.body.rateLimit).toEqual({ requestsPerMinute: 30, burst: 30 });
    const patched = await admin.patch(`/admin/api-keys/${created.body.id}`).send({ rateLimit: 'unlimited' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: created.body.id, label: 'ci', rateLimit: 'unlimited' });
    expect((await admin.get('/admin/api-keys')).body[0].rateLimit).toBe('unlimited');
    const cleared = await admin.patch(`/admin/api-keys/${created.body.id}`).send({ rateLimit: null });
    expect(cleared.body.rateLimit).toBeNull();
  });

  it('validates rateLimit and reports unknown keys', async () => {
    const key = await admin.post('/admin/api-keys').send({});
    expect((await admin.patch(`/admin/api-keys/${key.body.id}`).send({ rateLimit: { requestsPerMinute: -1 } })).status).toBe(400);
    expect((await admin.patch(`/admin/api-keys/${key.body.id}`).send({})).status).toBe(400);
    expect((await admin.post('/admin/api-keys').send({ rateLimit: 'lots' })).status).toBe(400);
    expect((await admin.patch('/admin/api-keys/nope').send({ rateLimit: null })).status).toBe(404);
  });
});

describe('DELETE /admin/connections/:id', () => {
  it('deletes the connection and its mappings', async () => {
    const { connection } = seedConnectionWithMapping();
    const other = seedConnectionWithMapping('c2', '/other');
    expect((await admin.delete(`/admin/connections/${connection.id}`)).status).toBe(204);
    expect(store.getConnection(connection.id)).toBeNull();
    expect(store.listMappings()).toEqual([other.mapping]);
    expect((await admin.delete(`/admin/connections/${connection.id}`)).status).toBe(404);
  });

  it('also deletes stored managed credentials', async () => {
    const connection = store.createConnection({ name: 'm', adapterType: 'microsoft-graph', authMode: 'managed' });
    await admin
      .put(`/admin/connections/${connection.id}/credentials`)
      .send({ grant: 'client_credentials', clientId: 'cid', clientSecret: 'secret-value', tenantId: 't1' });
    expect(store.getConnectionCredentials(connection.id)).not.toBeNull();
    expect((await admin.delete(`/admin/connections/${connection.id}`)).status).toBe(204);
    expect(store.getConnectionCredentials(connection.id)).toBeNull();
  });
});

describe('DELETE /admin/connections/:id/credentials', () => {
  it('clears stored credentials', async () => {
    const connection = store.createConnection({ name: 'm', adapterType: 'microsoft-graph', authMode: 'managed' });
    await admin
      .put(`/admin/connections/${connection.id}/credentials`)
      .send({ grant: 'client_credentials', clientId: 'cid', clientSecret: 'secret-value', tenantId: 't1' });
    expect((await admin.delete(`/admin/connections/${connection.id}/credentials`)).status).toBe(204);
    expect((await admin.get(`/admin/connections/${connection.id}/credentials`)).body).toEqual({ configured: false });
  });

  it('returns 404 for an unknown connection and 400 for a passthrough one', async () => {
    expect((await admin.delete('/admin/connections/nope/credentials')).status).toBe(404);
    const { connection } = seedConnectionWithMapping();
    const res = await admin.delete(`/admin/connections/${connection.id}/credentials`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('returns 503 MANAGED_AUTH_DISABLED when managed auth is not configured', async () => {
    const bare = buildApp(false); // same store, so the admin session created in beforeEach is valid here too
    const connection = store.createConnection({ name: 'm', adapterType: 'microsoft-graph', authMode: 'managed' });
    const res = await request(bare).delete(`/admin/connections/${connection.id}/credentials`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_AUTH_DISABLED');
  });
});

describe('DELETE /admin/mappings/:id', () => {
  it('deletes a mapping and 404s afterwards', async () => {
    const { mapping } = seedConnectionWithMapping();
    expect((await admin.delete(`/admin/mappings/${mapping.id}`)).status).toBe(204);
    expect(store.getMapping(mapping.id)).toBeNull();
    expect((await admin.delete(`/admin/mappings/${mapping.id}`)).status).toBe(404);
  });
});

describe('mapping cacheTtlSeconds', () => {
  it('accepts it on create, updates it without flipping source, and validates it', async () => {
    const conn = await admin.post('/admin/connections').send({ name: 'ttl-conn', adapterType: 'mock', authMode: 'passthrough' });
    const created = await admin
      .post('/admin/mappings')
      .send({ connectionId: conn.body.id, route: '/ttl', method: 'GET', operation: {}, source: 'generated', cacheTtlSeconds: 60 });
    expect(created.body).toMatchObject({ cacheTtlSeconds: 60, source: 'generated' });
    const patched = await admin.patch(`/admin/mappings/${created.body.id}`).send({ cacheTtlSeconds: 5 });
    expect(patched.body).toMatchObject({ cacheTtlSeconds: 5, source: 'generated' });
    const edited = await admin.patch(`/admin/mappings/${created.body.id}`).send({ route: '/ttl2' });
    expect(edited.body).toMatchObject({ cacheTtlSeconds: 5, source: 'manual' });
    expect((await admin.patch(`/admin/mappings/${created.body.id}`).send({ cacheTtlSeconds: 'soon' })).status).toBe(400);
  });
});

describe('YAML export and import', () => {
  it('exports YAML, optionally for one connection', async () => {
    seedConnectionWithMapping('c1', '/one');
    const { connection } = seedConnectionWithMapping('c2', '/two');
    const all = await admin.get('/admin/mappings/export');
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toMatch(/^text\/yaml/);
    expect(YAML.parse(all.text)).toHaveLength(2);
    const one = await admin.get(`/admin/mappings/export?connectionId=${connection.id}`);
    expect(YAML.parse(one.text).map((e: { route: string }) => e.route)).toEqual(['GET /two']);
    expect((await admin.get('/admin/mappings/export?connectionId=nope')).status).toBe(404);
  });

  it('imports an edited export', async () => {
    const { mapping } = seedConnectionWithMapping();
    const entries = YAML.parse((await admin.get('/admin/mappings/export')).text);
    entries[0].route = 'GET /people/{id}';
    const res = await admin.post('/admin/mappings/import').send({ yaml: YAML.stringify(entries) });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.warnings).toEqual(['1 generated mapping(s) are now source=manual and will be skipped by regeneration unless forced']);
    expect(store.getMapping(mapping.id)).toMatchObject({ route: '/people/{id}', source: 'manual' });
  });

  it('rejects invalid YAML with 400 and writes nothing', async () => {
    seedConnectionWithMapping();
    const before = store.listMappings();
    const res = await admin
      .post('/admin/mappings/import')
      .send({ yaml: YAML.stringify([{ route: 'GET /x', connection: 'nope', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(store.listMappings()).toEqual(before);
  });

  it('rejects a route collision with 409', async () => {
    seedConnectionWithMapping('c1', '/taken');
    const res = await admin
      .post('/admin/mappings/import')
      .send({ yaml: YAML.stringify([{ route: 'GET /taken', connection: 'c1', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('requires a string "yaml" field', async () => {
    const res = await admin.post('/admin/mappings/import').send({ yaml: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('accepts request bodies larger than the old 100 kB default', async () => {
    const yaml = `# ${'x'.repeat(300_000)}\n`;
    const res = await admin.post('/admin/mappings/import').send({ yaml });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 0, warnings: [] });
  });
});

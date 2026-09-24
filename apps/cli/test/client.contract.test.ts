import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loginAdmin } from '@graphtorest/core';
import { toCliError } from '../src/errors';
import { embeddedHarness, type Harness, type HarnessFactory } from './helpers/harness';

const HARNESSES: Array<[Harness['kind'], HarnessFactory]> = [['embedded', embeddedHarness]];

/** Resolves to the CLI error code a failing call produces (after the same normalization the CLI applies). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return toCliError(err).code;
  }
  throw new Error('expected the call to fail');
}

const CREDENTIALS = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };

function yamlEntry(connection: string, route: string, auth = 'inherit'): string {
  return [
    `- connection: ${connection}`,
    `  route: "${route}"`,
    '  source: manual',
    '  operation: { query: q }',
    '  response: { shape: passthrough }',
    `  auth: ${auth}`,
  ].join('\n');
}

describe.each(HARNESSES)('GtrClient contract (%s)', (kind, makeHarness) => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  describe('connections', () => {
    it('creates, lists and deletes a connection', async () => {
      const created = await h.client.createConnection({
        name: 'c1',
        adapterType: 'graphql',
        authMode: 'passthrough',
        config: { endpoint: 'https://api.example.test/graphql' },
      });
      expect(created).toMatchObject({ name: 'c1', config: { endpoint: 'https://api.example.test/graphql' } });
      expect(await h.client.listConnections()).toEqual([created]);
      await h.client.deleteConnection(created.id);
      expect(await h.client.listConnections()).toEqual([]);
    });

    it('reports CONFLICT for a duplicate name and NOT_FOUND deleting an unknown id', async () => {
      await h.client.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
      expect(await codeOf(h.client.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' }))).toBe('CONFLICT');
      expect(await codeOf(h.client.deleteConnection('nope'))).toBe('NOT_FOUND');
    });
  });

  describe('managed credentials', () => {
    it('stores, reports and clears credentials without exposing the secret', async () => {
      const connection = await h.client.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
      const status = await h.client.setCredentials(connection.id, CREDENTIALS);
      expect(status).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
      expect(h.store.getConnectionCredentials(connection.id)).not.toContain('super-secret-value');
      expect(await h.client.getCredentialStatus(connection.id)).toEqual(status);
      await h.client.clearCredentials(connection.id);
      expect(await h.client.getCredentialStatus(connection.id)).toEqual({ configured: false });
    });

    it('rejects a passthrough connection, an unknown connection and an invalid payload', async () => {
      const passthrough = await h.client.createConnection({ name: 'pt', adapterType: 'microsoft-graph', authMode: 'passthrough' });
      const managed = await h.client.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
      expect(await codeOf(h.client.setCredentials(passthrough.id, CREDENTIALS))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.setCredentials('nope', CREDENTIALS))).toBe('NOT_FOUND');
      expect(await codeOf(h.client.setCredentials(managed.id, { grant: 'client_credentials' }))).toBe('INVALID_INPUT');
    });

    it('reports managed auth as disabled/unavailable when no encryption key is configured', async () => {
      const bare = await makeHarness({ managedAuth: false });
      try {
        const managed = await bare.client.createConnection({ name: 'm', adapterType: 'mock', authMode: 'managed' });
        expect(await codeOf(bare.client.setCredentials(managed.id, CREDENTIALS))).toBe('MANAGED_AUTH_DISABLED');
        expect(await codeOf(bare.client.getCredentialStatus(managed.id))).toBe('MANAGED_AUTH_DISABLED');
        expect(await codeOf(bare.client.clearCredentials(managed.id))).toBe('MANAGED_AUTH_DISABLED');
        expect(await codeOf(bare.client.generateMappings(managed.id, {}))).toBe('MANAGED_AUTH_UNAVAILABLE');
      } finally {
        await bare.close();
      }
    });
  });

  describe('mappings', () => {
    let connectionId: string;
    beforeEach(async () => {
      connectionId = (await h.client.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' })).id;
    });

    it('creates a manual mapping and lists it', async () => {
      const mapping = await h.client.createMapping({
        connectionId,
        method: 'get',
        route: '/users/{id}',
        operation: { query: 'user(id: $id) { id }' },
      });
      expect(mapping).toMatchObject({ connectionId, method: 'GET', route: '/users/{id}', source: 'manual' });
      expect(await h.client.listMappings()).toEqual([mapping]);
    });

    it('rejects a duplicate route, an unknown connection and a malformed route', async () => {
      await h.client.createMapping({ connectionId, method: 'GET', route: '/a', operation: {} });
      expect(await codeOf(h.client.createMapping({ connectionId, method: 'GET', route: '/a', operation: {} }))).toBe('CONFLICT');
      expect(await codeOf(h.client.createMapping({ connectionId: 'nope', method: 'GET', route: '/b', operation: {} }))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.createMapping({ connectionId, method: 'GET', route: 'no-slash', operation: {} }))).toBe('INVALID_INPUT');
    });

    it('updates a mapping, flips it to manual, and validates the patch', async () => {
      const generated = h.store.createMapping({ connectionId, method: 'GET', route: '/a', operation: { query: 'a' }, source: 'generated' });
      const updated = await h.client.updateMapping(generated.id, { operation: { query: 'b' } });
      expect(updated).toMatchObject({ id: generated.id, source: 'manual', operation: { query: 'b' } });
      expect(await codeOf(h.client.updateMapping(generated.id, {}))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.updateMapping(generated.id, { route: 'bad route' }))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.updateMapping('nope', { operation: {} }))).toBe('NOT_FOUND');
    });

    it('reports CONFLICT when an update collides with another mapping', async () => {
      h.store.createMapping({ connectionId, method: 'GET', route: '/a', operation: {} });
      const second = h.store.createMapping({ connectionId, method: 'GET', route: '/b', operation: {} });
      expect(await codeOf(h.client.updateMapping(second.id, { route: '/a' }))).toBe('CONFLICT');
    });

    it('deletes a mapping and reports NOT_FOUND for an unknown one', async () => {
      const mapping = h.store.createMapping({ connectionId, method: 'GET', route: '/a', operation: {} });
      await h.client.deleteMapping(mapping.id);
      expect(await h.client.listMappings()).toEqual([]);
      expect(await codeOf(h.client.deleteMapping(mapping.id))).toBe('NOT_FOUND');
    });

    it('generates, keeps a manual edit on regenerate, and overwrites it with force', async () => {
      const first = await h.client.generateMappings(connectionId, {});
      expect(first.created).toHaveLength(1);
      const id = first.created[0].id;
      await h.client.updateMapping(id, { operation: { query: 'hand-edited' } });

      const skipped = await h.client.generateMappings(connectionId, {});
      expect(skipped.skipped).toHaveLength(1);
      expect(h.store.getMapping(id)?.operation).toEqual({ query: 'hand-edited' });

      const forced = await h.client.generateMappings(connectionId, { force: true });
      expect(forced.updated).toHaveLength(1);
      expect(h.store.getMapping(id)?.source).toBe('generated');
    });

    it('reports NOT_FOUND generating for an unknown connection', async () => {
      expect(await codeOf(h.client.generateMappings('nope', {}))).toBe('NOT_FOUND');
    });

    it('exports YAML and imports a hand edit back onto the same mapping', async () => {
      const mapping = h.store.createMapping({ connectionId, method: 'GET', route: '/users/{id}', operation: { query: 'original' }, source: 'generated' });
      const yaml = await h.client.exportMappings({});
      expect(yaml).toContain('route: GET /users/{id}');

      const result = await h.client.importMappings(yaml.replace('original', 'hand-edited'));

      expect(result.imported).toBe(1);
      expect(result.warnings).toEqual([expect.stringMatching(/1 generated mapping/)]);
      expect(h.store.getMapping(mapping.id)).toMatchObject({ operation: { query: 'hand-edited' }, source: 'manual' });
    });

    it('exports one connection only and reports NOT_FOUND for an unknown one', async () => {
      const other = await h.client.createConnection({ name: 'c2', adapterType: 'mock', authMode: 'passthrough' });
      h.store.createMapping({ connectionId, method: 'GET', route: '/mine', operation: {} });
      h.store.createMapping({ connectionId: other.id, method: 'GET', route: '/theirs', operation: {} });
      const yaml = await h.client.exportMappings({ connectionId });
      expect(yaml).toContain('/mine');
      expect(yaml).not.toContain('/theirs');
      expect(await codeOf(h.client.exportMappings({ connectionId: 'nope' }))).toBe('NOT_FOUND');
    });

    it('creates new manual mappings from hand-authored entries', async () => {
      const result = await h.client.importMappings(`${yamlEntry('c1', 'GET /widgets/{id}')}\n`);
      expect(result).toEqual({ imported: 1, warnings: [] });
      expect(await h.client.listMappings()).toEqual([
        expect.objectContaining({ route: '/widgets/{id}', method: 'GET', source: 'manual' }),
      ]);
    });

    it('imports atomically: bad YAML, an unknown connection, an auth override or a duplicate route writes nothing', async () => {
      expect(await codeOf(h.client.importMappings('- [unclosed'))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.importMappings([yamlEntry('c1', 'GET /a'), yamlEntry('nope', 'GET /b')].join('\n')))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.importMappings([yamlEntry('c1', 'GET /a'), yamlEntry('c1', 'GET /c', 'override')].join('\n')))).toBe('INVALID_INPUT');
      expect(
        await codeOf(h.client.importMappings([yamlEntry('c1', 'GET /a'), yamlEntry('c1', 'GET /b'), yamlEntry('c1', 'GET /b')].join('\n')))
      ).toBe('CONFLICT');
      expect(await h.client.listMappings()).toEqual([]);
    });
  });

  describe('api keys', () => {
    it('creates a key exposing only id, plaintext and label, lists it and revokes it', async () => {
      const created = await h.client.createApiKey({ label: 'ci' });
      expect(Object.keys(created).sort()).toEqual(['id', 'label', 'plaintext']);
      expect(created.label).toBe('ci');
      expect((await h.client.listApiKeys()).map((k) => k.id)).toEqual([created.id]);
      await h.client.revokeApiKey(created.id);
      expect(await h.client.listApiKeys()).toEqual([]);
      expect(await codeOf(h.client.revokeApiKey(created.id))).toBe('NOT_FOUND');
    });
  });

  describe('admin users', () => {
    it('creates an admin user who can log in, and rejects duplicates and weak passwords', async () => {
      const user = await h.client.createAdminUser({ username: 'ops', password: 'correct-horse-battery' });
      expect(user).toEqual({ id: expect.any(String), username: 'ops' });
      expect(loginAdmin(h.store, 'ops', 'correct-horse-battery')).not.toBeNull();
      expect(await codeOf(h.client.createAdminUser({ username: 'ops', password: 'correct-horse-battery' }))).toBe('CONFLICT');
      expect(await codeOf(h.client.createAdminUser({ username: 'ops2', password: 'short' }))).toBe('INVALID_INPUT');
    });

    it.runIf(kind === 'embedded')('resets a password, revoking old sessions; unknown users are NOT_FOUND', async () => {
      const user = await h.client.createAdminUser({ username: 'ops', password: 'correct-horse-battery' });
      const { token } = h.store.createAdminSession(user.id, 60_000);
      await h.client.setAdminPassword({ username: 'ops', password: 'a-brand-new-password' });
      expect(h.store.findAdminSession(token)).toBeNull();
      expect(loginAdmin(h.store, 'ops', 'a-brand-new-password')).not.toBeNull();
      expect(await codeOf(h.client.setAdminPassword({ username: 'ghost', password: 'a-brand-new-password' }))).toBe('NOT_FOUND');
    });

    it.runIf(kind === 'remote')('refuses to reset a password remotely', async () => {
      expect(await codeOf(h.client.setAdminPassword({ username: 'ops', password: 'a-brand-new-password' }))).toBe('MODE_UNSUPPORTED');
    });
  });

  describe('authorization', () => {
    it.runIf(kind === 'embedded')('refuses to start an OAuth authorization in embedded mode', async () => {
      expect(await codeOf(h.client.startAuthorization('any'))).toBe('MODE_UNSUPPORTED');
    });

    it.runIf(kind === 'remote')('rejects authorization for a passthrough connection', async () => {
      const passthrough = await h.client.createConnection({ name: 'pt', adapterType: 'mock', authMode: 'passthrough' });
      expect(await codeOf(h.client.startAuthorization(passthrough.id))).toBe('INVALID_INPUT');
    });
  });

  describe('adapters and activity', () => {
    it('lists registered adapter types', async () => {
      expect(await h.client.listAdapters()).toEqual(expect.arrayContaining(['mock', 'microsoft-graph', 'graphql']));
    });

    it('pages activity newest first and validates the query', async () => {
      for (let i = 0; i < 3; i += 1) {
        h.store.recordRequest({ ts: new Date().toISOString(), method: 'GET', path: `/api/x${i}`, status: 200, durationMs: 5 }, 1000);
      }
      const page = await h.client.listActivity({ limit: 2 });
      expect(page.items.map((r) => r.path)).toEqual(['/api/x2', '/api/x1']);
      expect(page.nextBefore).toBe(page.items[1].id);
      const rest = await h.client.listActivity({ limit: 2, before: page.nextBefore! });
      expect(rest).toEqual({ items: [expect.objectContaining({ path: '/api/x0' })], nextBefore: null });
      expect((await h.client.listActivity({})).items).toHaveLength(3);
      expect(await codeOf(h.client.listActivity({ limit: 0 }))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.listActivity({ limit: 201 }))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.listActivity({ before: 0 }))).toBe('INVALID_INPUT');
    });
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { makeCli } from './helpers/cli';
import { tempPath, TEST_KEY } from './helpers/harness';
import { fakeFetch } from './helpers/fakeFetch';
import { EmbeddedClient } from '../src/client/embedded';
import { resolveConnection } from '../src/client/resolve';

const clis: Array<ReturnType<typeof makeCli>> = [];
const files: string[] = [];
function cli(options: Parameters<typeof makeCli>[0] = {}) {
  const created = makeCli({ ...options, env: { CREDENTIAL_ENCRYPTION_KEY: TEST_KEY, ...options.env } });
  clis.push(created);
  return created;
}
afterEach(() => {
  for (const c of clis.splice(0)) c.cleanup();
  for (const f of files.splice(0)) fs.rmSync(f, { force: true });
});

async function createConnection(c: ReturnType<typeof makeCli>, name: string, authMode = 'passthrough') {
  expect(await c.run(['connection', 'create', '--db', c.dbPath, '--json', '--name', name, '--adapter-type', 'mock', '--auth-mode', authMode])).toBe(0);
  const created = JSON.parse(c.stdout());
  c.reset();
  return created as { id: string; name: string };
}

describe('resolveConnection', () => {
  it('matches an id before a name, then a name, else NOT_FOUND', async () => {
    const dbPath = tempPath('gtr-resolve');
    const client = EmbeddedClient.open(dbPath, {});
    try {
      const first = await client.createConnection({ name: 'first', adapterType: 'mock', authMode: 'passthrough' });
      // A connection deliberately named after the other connection's id.
      const tricky = await client.createConnection({ name: first.id, adapterType: 'mock', authMode: 'passthrough' });
      expect((await resolveConnection(client, first.id)).id).toBe(first.id);
      expect((await resolveConnection(client, 'first')).id).toBe(first.id);
      expect((await resolveConnection(client, tricky.id)).id).toBe(tricky.id);
      await expect(resolveConnection(client, 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No connection with id or name "ghost"' });
    } finally {
      client.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    }
  });
});

describe('gtr connection', () => {
  it('creates with --config and lists as a table', async () => {
    const c = cli();
    expect(
      await c.run(['connection', 'create', '--db', c.dbPath, '--name', 'gql', '--adapter-type', 'graphql', '--auth-mode', 'passthrough', '--config', '{"endpoint":"https://x.test/graphql"}'])
    ).toBe(0);
    expect(c.stdout()).toMatch(/^Created connection gql \(.+\)\.\n$/);
    c.reset();
    expect(await c.run(['connection', 'list', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toMatch(/^ID\s+NAME\s+ADAPTER\s+AUTH MODE\n\S+\s+gql\s+graphql\s+passthrough\n$/);
  });

  it('prints "No connections." for an empty list and [] with --json', async () => {
    const c = cli();
    expect(await c.run(['connection', 'list', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toBe('No connections.\n');
    c.reset();
    await c.run(['connection', 'list', '--db', c.dbPath, '--json']);
    expect(JSON.parse(c.stdout())).toEqual([]);
  });

  it('rejects invalid --config JSON with exit 2', async () => {
    const c = cli();
    expect(await c.run(['connection', 'create', '--db', c.dbPath, '--name', 'x', '--adapter-type', 'mock', '--auth-mode', 'passthrough', '--config', '[1]'])).toBe(2);
    expect(c.stderr()).toBe('error: --config must be a JSON object\n');
  });

  it('exits 5 on a duplicate name', async () => {
    const c = cli();
    await createConnection(c, 'dup');
    expect(await c.run(['connection', 'create', '--db', c.dbPath, '--name', 'dup', '--adapter-type', 'mock', '--auth-mode', 'passthrough'])).toBe(5);
  });

  it('shows a connection by name, with credential status for managed connections', async () => {
    const c = cli();
    await createConnection(c, 'm', 'managed');
    expect(await c.run(['connection', 'show', 'm', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toContain('name: m');
    expect(c.stdout()).toContain('credentials: not configured');
  });

  it('shows credentials as unavailable when no encryption key is set locally', async () => {
    const c = cli({ env: { CREDENTIAL_ENCRYPTION_KEY: '' } });
    await createConnection(c, 'm', 'managed');
    expect(await c.run(['connection', 'show', 'm', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toMatch(/credentials: unavailable \(Managed auth is disabled/);
  });

  it('exits 4 for an unknown connection', async () => {
    const c = cli();
    expect(await c.run(['connection', 'show', 'ghost', '--db', c.dbPath])).toBe(4);
  });

  it('deletes with --yes, refuses without a terminal, and cancels when declined', async () => {
    const c = cli();
    const created = await createConnection(c, 'gone');
    expect(await c.run(['connection', 'delete', 'gone', '--db', c.dbPath])).toBe(2);
    expect(c.stderr()).toMatch(/pass --yes/);

    const declining = cli({ interactive: true, confirm: false });
    fs.copyFileSync(c.dbPath, declining.dbPath);
    expect(await declining.run(['connection', 'delete', 'gone', '--db', declining.dbPath])).toBe(0);
    expect(declining.prompter.asked).toEqual([`Delete connection "gone" (${created.id}) and all of its mappings?`]);
    expect(declining.stderr()).toBe('Cancelled.\n');

    c.reset();
    expect(await c.run(['connection', 'delete', 'gone', '--yes', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toBe(`Deleted connection gone (${created.id}).\n`);
  });

  it('refuses delete and credentials clear in a non-TTY without --yes before sending any request', async () => {
    const fake = fakeFetch({});
    const remote = cli({ env: { GTR_SERVER: 'http://gtr.test', GTR_TOKEN: 'tok' }, fetchImpl: fake.impl });
    expect(await remote.run(['connection', 'delete', 'some-conn'])).toBe(2);
    expect(remote.stderr()).toMatch(/pass --yes/);
    expect(fake.calls).toHaveLength(0);

    remote.reset();
    expect(await remote.run(['connection', 'credentials', 'clear', 'some-conn'])).toBe(2);
    expect(remote.stderr()).toMatch(/pass --yes/);
    expect(fake.calls).toHaveLength(0);
  });

  it('sets credentials from a file, reports status and clears them', async () => {
    const c = cli();
    await createConnection(c, 'm', 'managed');
    const file = tempPath('gtr-creds', '.json');
    files.push(file);
    // adapterType 'mock' is not 'microsoft-graph', so tokenUrl (not just tenantId) is required by
    // packages/core's parseManagedCredentials; see the deviation note in task-6-report.md.
    fs.writeFileSync(
      file,
      JSON.stringify({
        grant: 'client_credentials',
        clientId: 'cid',
        clientSecret: 'super-secret-value',
        tenantId: 't',
        tokenUrl: 'https://vendor.test/token',
      })
    );

    expect(await c.run(['connection', 'credentials', 'set', 'm', '--credentials-file', file, '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toBe('Stored credentials for m: configured (grant: client_credentials, refresh token: no).\n');
    expect(c.stdout()).not.toContain('super-secret-value');
    c.reset();
    expect(await c.run(['connection', 'credentials', 'status', 'm', '--db', c.dbPath, '--json'])).toBe(0);
    expect(JSON.parse(c.stdout())).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    c.reset();
    expect(await c.run(['connection', 'credentials', 'clear', 'm', '--yes', '--db', c.dbPath])).toBe(0);
    expect(c.stdout()).toBe('Cleared credentials for m.\n');
  });

  it('requires exactly one credentials source and hides JSON parse details', async () => {
    const c = cli();
    await createConnection(c, 'm', 'managed');
    expect(await c.run(['connection', 'credentials', 'set', 'm', '--db', c.dbPath])).toBe(2);
    expect(await c.run(['connection', 'credentials', 'set', 'm', '--credentials', '{"clientSecret": "leak', '--db', c.dbPath])).toBe(2);
    expect(c.stderr()).toContain('error: Credentials are not valid JSON');
    expect(c.stderr()).not.toContain('leak');
  });

  it('authorize is remote-only and prints the authorization URL', async () => {
    const embedded = cli();
    await createConnection(embedded, 'm', 'managed');
    expect(await embedded.run(['connection', 'authorize', 'm', '--db', embedded.dbPath])).toBe(2);
    expect(embedded.stderr()).toMatch(/needs remote mode/);

    const fake = fakeFetch({
      'GET /admin/connections': { status: 200, body: [{ id: 'c1', name: 'm', adapterType: 'mock', authMode: 'managed', config: null }] },
      'POST /admin/connections/c1/oauth/start': { status: 200, body: { authorizationUrl: 'https://login.example/authorize?x=1' } },
    });
    const remote = cli({ env: { GTR_SERVER: 'http://gtr.test', GTR_TOKEN: 'tok' }, fetchImpl: fake.impl });
    expect(await remote.run(['connection', 'authorize', 'm'])).toBe(0);
    expect(remote.stdout()).toBe('Open this URL in a browser to authorize "m":\nhttps://login.example/authorize?x=1\n');
  });
});

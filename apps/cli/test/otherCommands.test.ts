import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { loginAdmin, openDb, MappingStore } from '@graphtorest/core';
import { makeCli } from './helpers/cli';
import { fakeFetch } from './helpers/fakeFetch';

const clis: Array<ReturnType<typeof makeCli>> = [];
function cli(options: Parameters<typeof makeCli>[0] = {}) {
  const created = makeCli(options);
  clis.push(created);
  return created;
}
afterEach(() => {
  for (const c of clis.splice(0)) c.cleanup();
});

async function run(c: ReturnType<typeof makeCli>, args: string[]) {
  c.reset();
  const code = await c.run([...args, '--db', c.dbPath]);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

function withStore<T>(dbPath: string, fn: (store: MappingStore) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(new MappingStore(db));
  } finally {
    db.close();
  }
}

describe('gtr apikey', () => {
  it('creates a key, printing the plaintext once and the warning on stderr', async () => {
    const c = cli();
    const created = await run(c, ['apikey', 'create', '--label', 'ci']);
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/^Created API key \S+ \(ci\):\n\S+\n$/);
    expect(created.stderr).toBe('Store this key now; it cannot be shown again.\n');
    const unlabelled = await run(c, ['apikey', 'create']);
    expect(unlabelled.code).toBe(0);
    expect(unlabelled.stdout).toMatch(/^Created API key \S+:\n\S+\n$/);
    const json = await run(c, ['apikey', 'create', '--json']);
    expect(JSON.parse(json.stdout).label).toBeNull();
    expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(['id', 'label', 'plaintext', 'rateLimit']);
  });

  it('lists keys and revokes one', async () => {
    const c = cli();
    const key = JSON.parse((await run(c, ['apikey', 'create', '--label', 'ci', '--json'])).stdout);
    const listed = await run(c, ['apikey', 'list']);
    expect(listed.stdout).toMatch(new RegExp(`^ID\\s+LABEL\\s+RATE LIMIT\\s+CREATED\\s+LAST USED\\n${key.id}\\s+ci\\s+default\\s+\\S.*\\s+never\\n$`));
    expect((await run(c, ['apikey', 'revoke', key.id, '--yes'])).stdout).toBe(`Revoked API key ${key.id}.\n`);
    expect((await run(c, ['apikey', 'list'])).stdout).toBe('No API keys.\n');
    expect((await run(c, ['apikey', 'revoke', key.id, '--yes'])).code).toBe(4);
  });

  it('sets rate limits on create and update', async () => {
    const c = cli();
    const key = JSON.parse((await run(c, ['apikey', 'create', '--rate-limit', '60', '--burst', '10', '--json'])).stdout);
    expect(key.rateLimit).toEqual({ requestsPerMinute: 60, burst: 10 });
    expect((await run(c, ['apikey', 'list'])).stdout).toContain('60/min (burst 10)');
    expect((await run(c, ['apikey', 'update', key.id, '--unlimited'])).stdout).toBe(`API key ${key.id} rate limit: unlimited.\n`);
    expect((await run(c, ['apikey', 'update', key.id, '--default'])).stdout).toBe(`API key ${key.id} rate limit: default.\n`);
  });

  it.each([
    [['apikey', 'create', '--burst', '5']],
    [['apikey', 'create', '--rate-limit', '5', '--unlimited']],
    [['apikey', 'create', '--rate-limit', 'abc']],
    [['apikey', 'update', 'k1']],
    [['apikey', 'update', 'k1', '--default', '--unlimited']],
  ])('rejects bad rate-limit flags %j with a usage error', async (args) => {
    expect((await run(cli(), args)).code).toBe(2);
  });
});

describe('gtr admin', () => {
  it('creates an admin from GTR_ADMIN_PASSWORD, and fails with exit 2 without any password source', async () => {
    const c = cli({ env: { GTR_ADMIN_PASSWORD: 'correct-horse-battery' } });
    expect(await run(c, ['admin', 'create', '--username', 'ops'])).toMatchObject({ code: 0, stdout: 'Created admin user ops.\n' });
    const db = openDb(c.dbPath);
    try {
      expect(await loginAdmin(new MappingStore(db), 'ops', 'correct-horse-battery')).not.toBeNull();
    } finally {
      db.close();
    }

    const bare = cli();
    const failed = await run(bare, ['admin', 'create', '--username', 'ops']);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toMatch(/--password, GTR_ADMIN_PASSWORD/);
    // The password must be resolved before the client opens (and so creates) the embedded DB file.
    expect(fs.existsSync(bare.dbPath)).toBe(false);
  });

  it('prompts for the password on a terminal', async () => {
    const c = cli({ interactive: true, answers: ['correct-horse-battery'] });
    expect((await run(c, ['admin', 'create', '--username', 'ops'])).code).toBe(0);
    expect(c.prompter.asked).toEqual(['Password for ops: ']);
  });

  it('resets a password in embedded mode and refuses in remote mode', async () => {
    const c = cli();
    await run(c, ['admin', 'create', '--username', 'ops', '--password', 'correct-horse-battery']);
    expect(await run(c, ['admin', 'set-password', '--username', 'ops', '--password', 'a-brand-new-password'])).toMatchObject({
      code: 0,
      stdout: 'Password updated for ops.\n',
    });
    expect((await run(c, ['admin', 'set-password', '--username', 'ghost', '--password', 'a-brand-new-password'])).code).toBe(4);

    const remote = cli({ env: { GTR_SERVER: 'http://gtr.test', GTR_TOKEN: 't' }, fetchImpl: fakeFetch({}).impl });
    expect(await remote.run(['admin', 'set-password', '--username', 'ops', '--password', 'a-brand-new-password'])).toBe(2);
    expect(remote.stderr()).toMatch(/embedded-only/);
  });

  it('resolves the password before opening (and so creating) the embedded DB for set-password too', async () => {
    const bare = cli();
    const failed = await run(bare, ['admin', 'set-password', '--username', 'ghost']);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toMatch(/--password, GTR_ADMIN_PASSWORD/);
    expect(fs.existsSync(bare.dbPath)).toBe(false);
  });
});

describe('gtr adapters and activity', () => {
  it('lists adapter types one per line', async () => {
    const c = cli();
    const listed = await run(c, ['adapters']);
    expect(listed.stdout.split('\n')).toEqual(expect.arrayContaining(['mock', 'microsoft-graph', 'graphql']));
  });

  it('shows activity newest first with a paging hint, and validates --limit', async () => {
    const c = cli();
    withStore(c.dbPath, (store) => {
      for (let i = 0; i < 3; i += 1) {
        store.recordRequest({ ts: `2026-09-23T10:00:0${i}.000Z`, method: 'GET', path: `/api/x${i}`, status: 200, durationMs: 7 }, 1000);
      }
    });
    const page = await run(c, ['activity', '--limit', '2']);
    expect(page.stdout).toMatch(/^TIME\s+STATUS\s+METHOD\s+PATH\s+LATENCY\n2026-09-23T10:00:02.000Z\s+200\s+GET\s+\/api\/x2\s+7ms\n.*\/api\/x1.*\nMore: gtr activity --limit 2 --before \d+\n$/);
    expect((await run(c, ['activity', '--limit', 'abc'])).code).toBe(2);
    expect((await run(c, ['activity', '--limit', '500'])).code).toBe(2);
  });

  it('prints "No activity." when empty', async () => {
    const c = cli();
    expect((await run(c, ['activity'])).stdout).toBe('No activity.\n');
  });
});

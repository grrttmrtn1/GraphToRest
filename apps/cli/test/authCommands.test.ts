import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { fakeFetch } from './helpers/fakeFetch';
import { makeCli } from './helpers/cli';
import { writeProfile, readProfile } from '../src/profile';
import { EmbeddedClient } from '../src/client/embedded';

const clis: Array<ReturnType<typeof makeCli>> = [];
function cli(options: Parameters<typeof makeCli>[0] = {}) {
  const created = makeCli(options);
  clis.push(created);
  return created;
}
afterEach(() => {
  for (const c of clis.splice(0)) c.cleanup();
});

const loginRoute = {
  'POST /admin/login': (call: { body: unknown }) =>
    (call.body as { password: string }).password === 'correct-horse-battery'
      ? { status: 200, body: { token: 'session-token', expiresAt: '2026-09-24T08:00:00.000Z' } }
      : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } } },
};

describe('gtr login', () => {
  it('logs in with --username and GTR_ADMIN_PASSWORD, saves the profile, and never prints the token', async () => {
    const fake = fakeFetch(loginRoute);
    const c = cli({ fetchImpl: fake.impl, env: { GTR_ADMIN_PASSWORD: 'correct-horse-battery' } });
    expect(await c.run(['login', '--server', 'http://gtr.test/', '--username', 'admin'])).toBe(0);
    expect(fake.calls[0]).toMatchObject({ url: 'http://gtr.test/admin/login', body: { username: 'admin', password: 'correct-horse-battery' } });
    expect(readProfile(c.profileFile)).toEqual({
      server: 'http://gtr.test',
      username: 'admin',
      token: 'session-token',
      expiresAt: '2026-09-24T08:00:00.000Z',
    });
    expect(c.stdout()).toBe('Logged in to http://gtr.test as admin (session expires 2026-09-24T08:00:00.000Z).\n');
    expect(c.stdout() + c.stderr()).not.toContain('session-token');
  });

  it('prompts for username and a hidden password on a terminal', async () => {
    const fake = fakeFetch(loginRoute);
    const c = cli({ fetchImpl: fake.impl, interactive: true, answers: ['admin', 'correct-horse-battery'] });
    expect(await c.run(['login', '--server', 'http://gtr.test'])).toBe(0);
    expect(c.prompter.asked).toEqual(['Username: ', 'Password: ']);
  });

  it('fails fast with exit 2 and sends nothing when there is no terminal and no password', async () => {
    const fake = fakeFetch(loginRoute);
    const c = cli({ fetchImpl: fake.impl });
    expect(await c.run(['login', '--server', 'http://gtr.test', '--username', 'admin'])).toBe(2);
    expect(c.stderr()).toMatch(/GTR_ADMIN_PASSWORD/);
    expect(fake.calls).toHaveLength(0);
    expect(fs.existsSync(c.profileFile)).toBe(false);
  });

  it('exits 3 on bad credentials and writes no profile', async () => {
    const c = cli({ fetchImpl: fakeFetch(loginRoute).impl, env: { GTR_ADMIN_PASSWORD: 'wrong-password-xx' } });
    expect(await c.run(['login', '--server', 'http://gtr.test', '--username', 'admin'])).toBe(3);
    expect(c.stderr()).toBe('error: Invalid username or password\n');
    expect(fs.existsSync(c.profileFile)).toBe(false);
  });

  it('re-uses the saved server when none is given, and is a usage error with no server at all', async () => {
    const fake = fakeFetch(loginRoute);
    const c = cli({ fetchImpl: fake.impl, env: { GTR_ADMIN_PASSWORD: 'correct-horse-battery' } });
    expect(await c.run(['login', '--username', 'admin'])).toBe(2);
    expect(c.stderr()).toMatch(/gtr login --server/);
    writeProfile(c.profileFile, { server: 'http://saved.test', username: 'admin', token: 'old', expiresAt: 'x' });
    expect(await c.run(['login', '--username', 'admin'])).toBe(0);
    expect(fake.calls[0].url).toBe('http://saved.test/admin/login');
  });
});

describe('gtr logout', () => {
  it('revokes the session on the server and deletes the profile', async () => {
    const fake = fakeFetch({ 'POST /admin/logout': { status: 204 } });
    const c = cli({ fetchImpl: fake.impl });
    writeProfile(c.profileFile, { server: 'http://gtr.test', username: 'admin', token: 'tok', expiresAt: 'x' });
    expect(await c.run(['logout'])).toBe(0);
    expect(fake.calls[0].headers.authorization).toBe('Bearer tok');
    expect(fs.existsSync(c.profileFile)).toBe(false);
    expect(c.stdout()).toBe('Logged out of http://gtr.test.\n');
  });

  it('still deletes the profile when the server is unreachable or the file is malformed', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const c = cli({ fetchImpl: down });
    writeProfile(c.profileFile, { server: 'http://gtr.test', username: 'admin', token: 'tok', expiresAt: 'x' });
    expect(await c.run(['logout'])).toBe(0);
    expect(fs.existsSync(c.profileFile)).toBe(false);
    fs.writeFileSync(c.profileFile, '{broken');
    expect(await c.run(['logout'])).toBe(0);
    expect(fs.existsSync(c.profileFile)).toBe(false);
  });

  it('says so when not logged in', async () => {
    const c = cli();
    expect(await c.run(['logout'])).toBe(0);
    expect(c.stdout()).toBe('Not logged in.\n');
  });
});

describe('gtr status', () => {
  it('reports embedded mode without creating a missing database file', async () => {
    const c = cli();
    expect(await c.run(['status', '--db', c.dbPath])).toBe(0);
    expect(fs.existsSync(c.dbPath)).toBe(false);
    expect(c.stdout()).toContain('mode: embedded');
    expect(c.stdout()).toContain(`database: ${c.dbPath} (not created yet)`);
  });

  it('reports an existing embedded database with its admin user count, as JSON too', async () => {
    const c = cli();
    // `admin create` arrives in Task 8; until then seed through the embedded client directly.
    const seeded = EmbeddedClient.open(c.dbPath, {});
    seeded.store.createAdminUser({ username: 'seeded', password: 'correct-horse-battery' });
    seeded.close();
    expect(await c.run(['status', '--db', c.dbPath, '--json'])).toBe(0);
    expect(JSON.parse(c.stdout())).toEqual({ mode: 'embedded', dbPath: c.dbPath, exists: true, adminUsers: 1 });
  });

  it('reports remote mode as not logged in (exit 0) or logged in', async () => {
    const fake = fakeFetch({ 'GET /admin/session': { status: 200, body: { username: 'admin', expiresAt: 'soon' } } });
    const anonymous = cli({ env: { GTR_SERVER: 'http://gtr.test' }, fetchImpl: fake.impl });
    expect(await anonymous.run(['status'])).toBe(0);
    expect(anonymous.stdout()).toContain('session: not logged in');
    expect(anonymous.stdout()).toContain('server: http://gtr.test (via GTR_SERVER)');
    const authed = cli({ env: { GTR_SERVER: 'http://gtr.test', GTR_TOKEN: 'tok' }, fetchImpl: fake.impl });
    expect(await authed.run(['status'])).toBe(0);
    expect(authed.stdout()).toContain('session: logged in as admin until soon');
  });
});

describe('runCli error handling', () => {
  it('keeps stdout empty on a --json failure and reports on stderr with the exit code', async () => {
    const c = cli({ env: { GTR_SERVER: 'http://gtr.test' } });
    expect(await c.run(['status', '--db', '/tmp/x.db', '--json'])).toBe(2);
    expect(c.stdout()).toBe('');
    expect(c.stderr()).toMatch(/^error: --db cannot be combined with remote mode/);
  });

  it('maps commander usage errors to exit 2', async () => {
    const c = cli();
    expect(await c.run(['no-such-command'])).toBe(2);
    expect(c.stderr()).toMatch(/unknown command/);
  });

  it('prints the stack trace only with GTR_DEBUG=1', async () => {
    const quiet = cli({ env: { GTR_SERVER: 'not a url' } });
    await quiet.run(['status']);
    expect(quiet.stderr().split('\n').filter(Boolean)).toHaveLength(1);
    const debug = cli({ env: { GTR_SERVER: 'not a url', GTR_DEBUG: '1' } });
    await debug.run(['status']);
    expect(debug.stderr()).toMatch(/\n\s+at /);
  });
});

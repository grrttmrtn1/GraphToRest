import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCli } from './helpers/cli';
import { tempPath } from './helpers/harness';

const clis: Array<ReturnType<typeof makeCli>> = [];
const paths: string[] = [];
function cli(options: Parameters<typeof makeCli>[0] = {}) {
  const created = makeCli(options);
  clis.push(created);
  return created;
}
afterEach(() => {
  for (const c of clis.splice(0)) c.cleanup();
  for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function run(c: ReturnType<typeof makeCli>, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  c.reset();
  const code = await c.run([...args, '--db', c.dbPath]);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

async function withConnection() {
  const c = cli();
  expect((await run(c, ['connection', 'create', '--name', 'c1', '--adapter-type', 'mock', '--auth-mode', 'passthrough'])).code).toBe(0);
  return c;
}

describe('gtr mapping', () => {
  it('creates from a combined route and lists with the connection name', async () => {
    const c = await withConnection();
    const created = await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'get /users/{id}', '--operation', '{"query":"user"}', '--json']);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ method: 'GET', route: '/users/{id}', source: 'manual' });
    const listed = await run(c, ['mapping', 'list']);
    expect(listed.stdout).toMatch(/^ID\s+METHOD\s+ROUTE\s+CONNECTION\s+SOURCE\s+CACHE\n\S+\s+GET\s+\/users\/\{id\}\s+c1\s+manual\s+-\n$/);
  });

  it('rejects a malformed --route with exit 2', async () => {
    const c = await withConnection();
    const result = await run(c, ['mapping', 'create', '--connection', 'c1', '--route', '/no-method', '--operation', '{}']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Malformed route/);
  });

  it('filters the list by connection', async () => {
    const c = await withConnection();
    await run(c, ['connection', 'create', '--name', 'c2', '--adapter-type', 'mock', '--auth-mode', 'passthrough']);
    await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'GET /one', '--operation', '{}']);
    await run(c, ['mapping', 'create', '--connection', 'c2', '--route', 'GET /two', '--operation', '{}']);
    const listed = JSON.parse((await run(c, ['mapping', 'list', '--connection', 'c2', '--json'])).stdout);
    expect(listed.map((m: { route: string }) => m.route)).toEqual(['/two']);
    expect((await run(c, ['mapping', 'list', '--connection', 'ghost'])).code).toBe(4);
  });

  it('updates, clears the response template with null, and exits 2 on an empty patch', async () => {
    const c = await withConnection();
    const created = JSON.parse(
      (await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'GET /a', '--operation', '{}', '--response-template', '{"id":"$.id"}', '--json'])).stdout
    );
    const updated = await run(c, ['mapping', 'update', created.id, '--route', 'POST /b', '--response-template', 'null', '--json']);
    expect(JSON.parse(updated.stdout)).toMatchObject({ method: 'POST', route: '/b', responseTemplate: null });
    expect((await run(c, ['mapping', 'update', created.id])).code).toBe(2);
    expect((await run(c, ['mapping', 'update', 'nope', '--operation', '{}'])).code).toBe(4);
  });

  it('sets the cache TTL on create and update and shows it in the list', async () => {
    const c = await withConnection();
    const created = JSON.parse(
      (await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'GET /ttl', '--operation', '{}', '--cache-ttl', '60', '--json'])).stdout
    );
    expect(created.cacheTtlSeconds).toBe(60);
    expect((await run(c, ['mapping', 'list'])).stdout).toMatch(/CACHE[\s\S]*\b60s\b/);
    const updated = await run(c, ['mapping', 'update', created.id, '--cache-ttl', '0']);
    expect(updated.stdout).toBe(`Updated mapping GET /ttl (${created.id}); source is manual.\n`);
    expect((await run(c, ['mapping', 'update', created.id, '--cache-ttl', 'soon'])).code).toBe(2);
  });

  it('keeps a generated mapping generated when only its cache TTL changes', async () => {
    const c = await withConnection();
    await run(c, ['mapping', 'generate', '--connection', 'c1']);
    const [generated] = JSON.parse((await run(c, ['mapping', 'list', '--json'])).stdout);
    expect(generated.source).toBe('generated');
    const updated = await run(c, ['mapping', 'update', generated.id, '--cache-ttl', '30', '--json']);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({ cacheTtlSeconds: 30, source: 'generated' });
  });

  it('deletes with --yes', async () => {
    const c = await withConnection();
    const created = JSON.parse((await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'GET /a', '--operation', '{}', '--json'])).stdout);
    const deleted = await run(c, ['mapping', 'delete', created.id, '--yes']);
    expect(deleted).toMatchObject({ code: 0, stdout: `Deleted mapping ${created.id}.\n` });
  });

  it('generates and summarizes the result', async () => {
    const c = await withConnection();
    const first = await run(c, ['mapping', 'generate', '--connection', 'c1']);
    expect(first).toMatchObject({ code: 0, stdout: 'Generated mappings for c1: 1 created, 0 updated, 0 skipped, 0 conflicts.\n' });
    const again = await run(c, ['mapping', 'generate', '--connection', 'c1', '--json']);
    expect(JSON.parse(again.stdout)).toMatchObject({ created: [], updated: [expect.any(Object)] });
  });

  it('exports to stdout verbatim even with --json, and to a nested --out path atomically', async () => {
    const c = await withConnection();
    await run(c, ['mapping', 'create', '--connection', 'c1', '--route', 'GET /a', '--operation', '{}']);
    const stdoutExport = await run(c, ['mapping', 'export', '--json']);
    expect(stdoutExport.stdout).toContain('route: GET /a');
    expect(() => JSON.parse(stdoutExport.stdout)).toThrow();

    const dir = path.join(os.tmpdir(), `gtr-export-${Date.now()}-${Math.random()}`);
    paths.push(dir);
    const outFile = path.join(dir, 'nested', 'deep', 'mappings.yaml');
    const written = await run(c, ['mapping', 'export', '--out', outFile]);
    expect(written.stdout).toBe(`Wrote mappings to ${outFile}.\n`);
    expect(fs.readFileSync(outFile, 'utf8')).toBe(stdoutExport.stdout);
    expect(fs.readdirSync(path.dirname(outFile))).toEqual(['mappings.yaml']);
  });

  it('imports a file, printing warnings to stderr, and reports a missing file clearly', async () => {
    const c = await withConnection();
    await run(c, ['mapping', 'generate', '--connection', 'c1']);
    const file = tempPath('gtr-import', '.yaml');
    paths.push(file);
    await run(c, ['mapping', 'export', '--out', file]);
    const imported = await run(c, ['mapping', 'import', file]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toBe('Imported 1 mapping(s).\n');
    expect(imported.stderr).toMatch(/warning: 1 generated mapping/);

    const missing = await run(c, ['mapping', 'import', '/definitely/not/here.yaml']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('error: Cannot read /definitely/not/here.yaml: ENOENT\n');
  });

  it('includes warnings in the JSON result instead of stderr with --json', async () => {
    const c = await withConnection();
    await run(c, ['mapping', 'generate', '--connection', 'c1']);
    const file = tempPath('gtr-import', '.yaml');
    paths.push(file);
    await run(c, ['mapping', 'export', '--out', file]);
    const imported = await run(c, ['mapping', 'import', file, '--json']);
    expect(JSON.parse(imported.stdout)).toEqual({ imported: 1, warnings: [expect.stringMatching(/1 generated mapping/)] });
    expect(imported.stderr).toBe('');
  });
});

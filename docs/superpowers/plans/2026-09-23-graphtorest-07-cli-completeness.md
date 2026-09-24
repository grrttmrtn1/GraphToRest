# GraphToRest Plan 7 — CLI Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat, embedded-only `gtr` commands with a nested `gtr <noun> <verb>` CLI that works either against the SQLite file directly (embedded mode) or against a running server's `/admin/*` API (remote mode, after `gtr login`).

**Architecture:** Every command talks to one `GtrClient` interface with two implementations: `EmbeddedClient` (wraps `MappingStore` and core functions) and `RemoteClient` (Node `fetch` against `/admin/*` with a bearer token). `resolveMode()` picks the implementation from `--server` / `GTR_SERVER` / a saved profile file. A shared contract test suite runs every client method against both implementations (remote against a real `createApp()` on an ephemeral port), which is how parity is enforced.

**Tech Stack:** TypeScript (CommonJS, ES2022), commander 12, Node 20 built-in `fetch` and `readline/promises`, vitest 2, better-sqlite3 via `@graphtorest/core`.

**Spec:** `docs/superpowers/specs/2026-09-23-graphtorest-07-cli-design.md`

## Global Constraints

- Mode precedence: `--server` > `GTR_SERVER` > profile file > embedded. No network probing. A configured server that is unreachable is an error, never a fallback to embedded.
- Only an **explicit `--db` flag** conflicts with remote mode (usage error). The `DB_PATH` env var never conflicts; the Docker image sets it.
- Embedded DB path: `--db ?? DB_PATH ?? ./data/graphtorest.db`.
- Profile path: `GTR_PROFILE_PATH`, else `$XDG_CONFIG_HOME/graphtorest/cli.json`, else `~/.config/graphtorest/cli.json`. Directory `0700`, file `0600`, written atomically.
- A saved profile token is reused for `--server`/`GTR_SERVER` only when the profile's server equals that URL after normalization.
- Exit codes: 0 success, 1 general, 2 usage, 3 auth, 4 not found, 5 conflict.
- Errors print `error: <message>` to stderr; stack only when `GTR_DEBUG=1`. With `--json`, stdout carries only JSON results, never errors, warnings or prompts.
- Remote request timeout 30 s; `mapping generate` 120 s.
- The flat command names (`connection-create`, `mapping-generate`, `apikey-create`, `admin-create`, …) are removed with no aliases.
- No new runtime dependencies in `apps/cli`.
- Tests must never read or write the real `~/.config`: every test context sets `GTR_PROFILE_PATH` to a temp file.
- Commit trailer, verbatim, on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not pass `--author`.

## Review Focus

1. **Server URL with a path prefix or trailing slash** (`https://host/gtr/`, reverse proxy): requests must go to `https://host/gtr/admin/...`, not drop the prefix or double the slash. Pinned in Task 2 (`normalizeServerUrl`) and Task 4 (`remote.test.ts` prefix test).
2. **`--server` pointed at something that isn't GraphToRest** (it returns a 200 HTML page): the user should get "expected JSON … Is this a GraphToRest server URL?", not a `SyntaxError` from `res.json()`. Pinned in Task 4.
3. **A connection whose name equals another connection's id**: `<conn>` must resolve the id match first, deterministically. Pinned in Task 6.
4. **`gtr login` or a destructive command in a non-TTY (CI, pipe) with no password env / no `--yes`**: must fail fast with exit 2, never hang on a prompt, and never send a request. Pinned in Task 5 (login) and Task 6 (delete).
5. **`--json` combined with a failure**: stdout must stay empty (so `gtr ... --json | jq` fails cleanly) and the error goes to stderr with the right exit code. Pinned in Task 5.

---

## File Structure

```
apps/cli/src/
  index.ts              (rewritten, Task 9) process entry: runCli(process.argv.slice(2), realContext)
  program.ts            (Task 5) buildProgram(ctx), runCli(argv, ctx) → exit code
  runtime.ts            (Task 5) CliContext, Runtime, action(), requireMode(), secrets/confirm/JSON helpers
  prompt.ts             (Task 5) Prompter interface + createTtyPrompter()
  errors.ts             (Task 1) CliError, exitCodeFor(), toCliError(), usageError()
  output.ts             (Task 1) Io, Output, table()
  profile.ts            (Task 2) Profile, profilePath(), readProfile(), writeProfile(), deleteProfile()
  mode.ts               (Task 2) GlobalOptions, Mode, normalizeServerUrl(), resolveMode()
  client/types.ts       (Task 3) GtrClient + input/result types
  client/embedded.ts    (Task 3) EmbeddedClient
  client/remote.ts      (Task 4) RemoteClient
  client/resolve.ts     (Task 6) resolveConnection()
  commands/auth.ts      (Task 5) login, logout, status
  commands/connection.ts(Task 6)
  commands/mapping.ts   (Task 7)
  commands/apikey.ts    (Task 8)
  commands/admin.ts     (Task 8)
  commands/misc.ts      (Task 8) adapters, activity
  (deleted in Task 9) embeddedClient.ts, commands/adminCreate.ts, apiKeyCreate.ts, connectionCreate.ts,
                      connectionCredentialsSet.ts, mappingCreate.ts, mappingExport.ts, mappingGenerate.ts,
                      mappingImport.ts, mappingUpdate.ts
apps/cli/test/
  errors.test.ts, output.test.ts                     (Task 1)
  profile.test.ts, mode.test.ts                      (Task 2)
  helpers/harness.ts, client.contract.test.ts        (Task 3; remote half Task 4)
  helpers/fakeFetch.ts, remote.test.ts               (Task 4)
  helpers/cli.ts, prompt.test.ts, authCommands.test.ts (Task 5)
  connectionCommands.test.ts                         (Task 6)
  mappingCommands.test.ts                            (Task 7)
  otherCommands.test.ts                              (Task 8)
  bin.smoke.test.ts                                  (Task 9)
  (deleted) commands.test.ts, adminCommands.test.ts, managedAuth.test.ts, mappingLifecycle.test.ts (Task 3),
            carryOvers.test.ts (Task 7)
apps/cli/README.md                                   (Task 9)
```

Run tests from the repo root. `npm test` builds core first; for a single file use `npx vitest run apps/cli/test/<file>` after core is built once (`npm run build -w @graphtorest/core`).

---

### Task 1: Errors and output

**Files:**
- Create: `apps/cli/src/errors.ts`, `apps/cli/src/output.ts`
- Test: `apps/cli/test/errors.test.ts`, `apps/cli/test/output.test.ts`

**Interfaces:**
- Produces:
  - `class CliError extends Error { readonly code: string; readonly exitCode: number; constructor(code: string, message: string, exitCode?: number) }`
  - `const EXIT_CODES: { general: 1; usage: 2; auth: 3; notFound: 4; conflict: 5 }`
  - `exitCodeFor(code: string): number`
  - `usageError(message: string): CliError` (code `USAGE`)
  - `toCliError(err: unknown): CliError`
  - `interface Io { out(text: string): void; err(text: string): void }`
  - `class Output { constructor(io: Io, json: boolean); readonly json: boolean; result<T>(value: T, render: (value: T) => string): void; done(message: string): void; raw(text: string): void; warn(message: string): void }`
  - `table(headers: string[], rows: string[][]): string`

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GatewayError } from '@graphtorest/core';
import { CliError, EXIT_CODES, exitCodeFor, toCliError, usageError } from '../src/errors';

describe('exitCodeFor', () => {
  it('maps error codes to the documented exit codes', () => {
    expect(exitCodeFor('USAGE')).toBe(EXIT_CODES.usage);
    expect(exitCodeFor('INVALID_INPUT')).toBe(2);
    expect(exitCodeFor('INVALID_REQUEST')).toBe(2);
    expect(exitCodeFor('MODE_UNSUPPORTED')).toBe(2);
    expect(exitCodeFor('UNAUTHORIZED')).toBe(3);
    expect(exitCodeFor('NOT_LOGGED_IN')).toBe(3);
    expect(exitCodeFor('NOT_FOUND')).toBe(4);
    expect(exitCodeFor('CONFLICT')).toBe(5);
    expect(exitCodeFor('INTERNAL_ERROR')).toBe(1);
    expect(exitCodeFor('SOMETHING_NEW')).toBe(1);
  });
});

describe('toCliError', () => {
  it('passes a CliError through unchanged', () => {
    const err = usageError('bad flag');
    expect(toCliError(err)).toBe(err);
    expect(err).toMatchObject({ code: 'USAGE', exitCode: 2, message: 'bad flag' });
  });

  it('keeps a GatewayError code and message', () => {
    const converted = toCliError(new GatewayError('NOT_FOUND', 'Connection not found', 404));
    expect(converted).toBeInstanceOf(CliError);
    expect(converted).toMatchObject({ code: 'NOT_FOUND', message: 'Connection not found', exitCode: 4 });
  });

  it('maps SQLite constraint failures', () => {
    const unique = Object.assign(new Error('UNIQUE constraint failed: connections.name'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const foreignKey = Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(toCliError(unique)).toMatchObject({ code: 'CONFLICT', exitCode: 5 });
    expect(toCliError(foreignKey)).toMatchObject({ code: 'INVALID_INPUT', exitCode: 2 });
  });

  it('wraps anything else as a general error', () => {
    expect(toCliError(new Error('boom'))).toMatchObject({ code: 'ERROR', message: 'boom', exitCode: 1 });
    expect(toCliError('text')).toMatchObject({ code: 'ERROR', message: 'text', exitCode: 1 });
  });
});
```

`apps/cli/test/output.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Output, table, type Io } from '../src/output';

function capture(): Io & { stdout: string; stderr: string } {
  const io = { stdout: '', stderr: '', out: (t: string) => { io.stdout += t; }, err: (t: string) => { io.stderr += t; } };
  return io;
}

describe('table', () => {
  it('aligns columns with two spaces and no trailing whitespace', () => {
    expect(table(['ID', 'NAME'], [['1', 'alpha'], ['22', 'b']])).toBe('ID  NAME\n1   alpha\n22  b');
  });

  it('renders only the header for no rows', () => {
    expect(table(['ID', 'NAME'], [])).toBe('ID  NAME');
  });
});

describe('Output', () => {
  it('renders with the renderer in table mode', () => {
    const io = capture();
    new Output(io, false).result({ n: 1 }, (v) => `n is ${v.n}`);
    expect(io.stdout).toBe('n is 1\n');
  });

  it('prints pretty JSON in json mode and ignores the renderer', () => {
    const io = capture();
    new Output(io, true).result({ n: 1 }, () => 'unused');
    expect(JSON.parse(io.stdout)).toEqual({ n: 1 });
  });

  it('done prints the message, or {"ok":true} in json mode', () => {
    const plain = capture();
    new Output(plain, false).done('Deleted mapping m1.');
    expect(plain.stdout).toBe('Deleted mapping m1.\n');
    const json = capture();
    new Output(json, true).done('Deleted mapping m1.');
    expect(JSON.parse(json.stdout)).toEqual({ ok: true });
  });

  it('raw prints text as-is with exactly one trailing newline in both modes', () => {
    const io = capture();
    new Output(io, true).raw('- a: 1\n');
    new Output(io, true).raw('- b: 2');
    expect(io.stdout).toBe('- a: 1\n- b: 2\n');
  });

  it('warn always goes to stderr', () => {
    const io = capture();
    new Output(io, true).warn('careful');
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('careful\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/cli/test/errors.test.ts apps/cli/test/output.test.ts`
Expected: FAIL, cannot resolve `../src/errors` / `../src/output`.

- [ ] **Step 3: Implement**

`apps/cli/src/errors.ts`:

```ts
import { GatewayError } from '@graphtorest/core';

export const EXIT_CODES = { general: 1, usage: 2, auth: 3, notFound: 4, conflict: 5 } as const;

const EXIT_BY_CODE: Record<string, number> = {
  USAGE: EXIT_CODES.usage,
  INVALID_INPUT: EXIT_CODES.usage,
  INVALID_REQUEST: EXIT_CODES.usage,
  MODE_UNSUPPORTED: EXIT_CODES.usage,
  UNAUTHORIZED: EXIT_CODES.auth,
  NOT_LOGGED_IN: EXIT_CODES.auth,
  NOT_FOUND: EXIT_CODES.notFound,
  CONFLICT: EXIT_CODES.conflict,
};

export function exitCodeFor(code: string): number {
  return EXIT_BY_CODE[code] ?? EXIT_CODES.general;
}

/** Every failure the CLI reports ends up as one of these: a stable code, a user-facing message, an exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number = exitCodeFor(code)) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError('USAGE', message);
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof GatewayError) return new CliError(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return new CliError('CONFLICT', `Already exists: ${message}`);
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return new CliError('INVALID_INPUT', `References a record that does not exist: ${message}`);
  return new CliError('ERROR', message);
}
```

`apps/cli/src/output.ts`:

```ts
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Table/summary text by default; raw JSON with --json. Warnings and prompts never go to stdout. */
export class Output {
  constructor(
    private readonly io: Io,
    readonly json: boolean
  ) {}

  result<T>(value: T, render: (value: T) => string): void {
    this.io.out(`${this.json ? JSON.stringify(value, null, 2) : render(value)}\n`);
  }

  /** For commands with no result body (delete, revoke, logout). */
  done(message: string): void {
    this.io.out(this.json ? `${JSON.stringify({ ok: true })}\n` : `${message}\n`);
  }

  /** Content printed verbatim in both modes (YAML export). */
  raw(text: string): void {
    this.io.out(text.endsWith('\n') ? text : `${text}\n`);
  }

  warn(message: string): void {
    this.io.err(`${message}\n`);
  }
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/errors.test.ts apps/cli/test/output.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/errors.ts apps/cli/src/output.ts apps/cli/test/errors.test.ts apps/cli/test/output.test.ts
git commit -m "feat(cli): add CliError exit-code mapping and table/JSON output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Profile file and mode resolution

**Files:**
- Create: `apps/cli/src/profile.ts`, `apps/cli/src/mode.ts`
- Test: `apps/cli/test/profile.test.ts`, `apps/cli/test/mode.test.ts`

**Interfaces:**
- Consumes: `CliError`, `usageError` (Task 1).
- Produces:
  - `interface Profile { server: string; username: string; token: string; expiresAt: string }`
  - `profilePath(env: NodeJS.ProcessEnv): string`
  - `readProfile(file: string): Profile | null` (missing → `null`; malformed → `CliError('PROFILE_INVALID', …)`)
  - `writeProfile(file: string, profile: Profile): void`
  - `deleteProfile(file: string): boolean`
  - `interface GlobalOptions { server?: string; db?: string; json?: boolean }`
  - `type ModeSource = '--server' | 'GTR_SERVER' | 'profile'`
  - `type Mode = { kind: 'embedded'; dbPath: string } | { kind: 'remote'; server: string; token: string | null; source: ModeSource }`
  - `DEFAULT_DB_PATH = './data/graphtorest.db'`
  - `normalizeServerUrl(raw: string): string`
  - `resolveMode(globals: GlobalOptions, env: NodeJS.ProcessEnv, loadProfile: () => Profile | null): Mode`

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/profile.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profilePath, readProfile, writeProfile, deleteProfile, type Profile } from '../src/profile';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-profile-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PROFILE: Profile = { server: 'http://localhost:3000', username: 'admin', token: 'tok', expiresAt: '2026-09-24T00:00:00.000Z' };

describe('profilePath', () => {
  it('prefers GTR_PROFILE_PATH, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(profilePath({ GTR_PROFILE_PATH: '/x/p.json', XDG_CONFIG_HOME: '/xdg' })).toBe('/x/p.json');
    expect(profilePath({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'graphtorest', 'cli.json'));
    expect(profilePath({})).toBe(path.join(os.homedir(), '.config', 'graphtorest', 'cli.json'));
  });
});

describe('profile file', () => {
  it('round-trips with 0700 directory and 0600 file permissions and no temp file left behind', () => {
    const file = path.join(tempDir(), 'nested', 'cli.json');
    writeProfile(file, PROFILE);
    expect(readProfile(file)).toEqual(PROFILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['cli.json']);
  });

  it('returns null when there is no file', () => {
    expect(readProfile(path.join(tempDir(), 'missing.json'))).toBeNull();
  });

  it('rejects a malformed file with a message naming the path and "gtr logout"', () => {
    const file = path.join(tempDir(), 'cli.json');
    fs.writeFileSync(file, '{not json');
    expect(() => readProfile(file)).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }));
    expect(() => readProfile(file)).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*gtr logout`));
    fs.writeFileSync(file, JSON.stringify({ server: 'http://x' }));
    expect(() => readProfile(file)).toThrow(/gtr logout/);
  });

  it('deletes a profile, including a malformed one, and reports whether it existed', () => {
    const file = path.join(tempDir(), 'cli.json');
    fs.writeFileSync(file, 'garbage');
    expect(deleteProfile(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteProfile(file)).toBe(false);
  });
});
```

`apps/cli/test/mode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveMode, normalizeServerUrl, DEFAULT_DB_PATH } from '../src/mode';
import type { Profile } from '../src/profile';

const profile: Profile = { server: 'http://saved:3000', username: 'admin', token: 'saved-token', expiresAt: '2026-09-24T00:00:00Z' };
const none = () => null;
const saved = () => profile;

describe('normalizeServerUrl', () => {
  it('strips trailing slashes and keeps a path prefix', () => {
    expect(normalizeServerUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeServerUrl('https://host.example/gtr/')).toBe('https://host.example/gtr');
    expect(normalizeServerUrl('https://host.example/gtr')).toBe('https://host.example/gtr');
  });

  it('rejects non-URLs and non-http schemes as usage errors', () => {
    expect(() => normalizeServerUrl('localhost:3000')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => normalizeServerUrl('not a url')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => normalizeServerUrl('ftp://host')).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('resolveMode', () => {
  it('uses embedded mode with --db, then DB_PATH, then the default when nothing is configured', () => {
    expect(resolveMode({ db: '/tmp/a.db' }, { DB_PATH: '/tmp/b.db' }, none)).toEqual({ kind: 'embedded', dbPath: '/tmp/a.db' });
    expect(resolveMode({}, { DB_PATH: '/tmp/b.db' }, none)).toEqual({ kind: 'embedded', dbPath: '/tmp/b.db' });
    expect(resolveMode({}, {}, none)).toEqual({ kind: 'embedded', dbPath: DEFAULT_DB_PATH });
  });

  it('--server wins over GTR_SERVER and the profile', () => {
    expect(resolveMode({ server: 'http://flag:1/' }, { GTR_SERVER: 'http://env:2', GTR_TOKEN: 't' }, saved)).toEqual({
      kind: 'remote',
      server: 'http://flag:1',
      token: 't',
      source: '--server',
    });
  });

  it('GTR_SERVER wins over the profile', () => {
    expect(resolveMode({}, { GTR_SERVER: 'http://env:2' }, saved)).toEqual({
      kind: 'remote',
      server: 'http://env:2',
      token: null,
      source: 'GTR_SERVER',
    });
  });

  it('reuses the profile token only for the same server', () => {
    expect(resolveMode({ server: 'http://saved:3000/' }, {}, saved)).toMatchObject({ token: 'saved-token' });
    expect(resolveMode({ server: 'http://other:3000' }, {}, saved)).toMatchObject({ token: null });
    expect(resolveMode({}, { GTR_SERVER: 'http://saved:3000' }, saved)).toMatchObject({ token: 'saved-token' });
  });

  it('GTR_TOKEN overrides the profile token for an explicit server', () => {
    expect(resolveMode({ server: 'http://saved:3000' }, { GTR_TOKEN: 'env-token' }, saved)).toMatchObject({ token: 'env-token' });
  });

  it('uses the profile when nothing else is configured', () => {
    expect(resolveMode({}, {}, saved)).toEqual({ kind: 'remote', server: 'http://saved:3000', token: 'saved-token', source: 'profile' });
  });

  it('rejects an explicit --db in remote mode but ignores DB_PATH', () => {
    expect(() => resolveMode({ db: '/tmp/a.db' }, {}, saved)).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => resolveMode({ db: '/tmp/a.db', server: 'http://x' }, {}, none)).toThrow(/--db cannot be combined with remote mode \(server configured via --server\)/);
    expect(resolveMode({}, { DB_PATH: '/data/g.db', GTR_SERVER: 'http://x' }, none)).toMatchObject({ kind: 'remote' });
  });

  it('does not read the profile when --server and GTR_TOKEN are both given', () => {
    const exploding = () => {
      throw new Error('profile should not be read');
    };
    expect(resolveMode({ server: 'http://x' }, { GTR_TOKEN: 't' }, exploding)).toMatchObject({ token: 't' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/profile.test.ts apps/cli/test/mode.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/cli/src/profile.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors';

export interface Profile {
  server: string;
  username: string;
  token: string;
  expiresAt: string;
}

export function profilePath(env: NodeJS.ProcessEnv): string {
  if (env.GTR_PROFILE_PATH) return env.GTR_PROFILE_PATH;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'graphtorest', 'cli.json');
}

function invalidProfile(file: string, reason: string): CliError {
  return new CliError('PROFILE_INVALID', `Cannot read the CLI profile ${file} (${reason}); run "gtr logout" to remove it`);
}

export function readProfile(file: string): Profile | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalidProfile(file, (err as NodeJS.ErrnoException).code ?? 'unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidProfile(file, 'not valid JSON');
  }
  const p = parsed as Partial<Profile> | null;
  const valid =
    typeof p === 'object' && p !== null &&
    typeof p.server === 'string' && typeof p.username === 'string' &&
    typeof p.token === 'string' && typeof p.expiresAt === 'string';
  if (!valid) throw invalidProfile(file, 'missing fields');
  return { server: p.server!, username: p.username!, token: p.token!, expiresAt: p.expiresAt! };
}

/** Atomic write; the file holds a bearer token, so it is created 0600 inside a 0700 directory. */
export function writeProfile(file: string, profile: Profile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function deleteProfile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
```

Note: `fs.chmodSync(dir, 0o700)` runs on an existing directory too. That is intentional for the dedicated `graphtorest` directory; `GTR_PROFILE_PATH` users choose their own directory, and tests only use temp directories.

`apps/cli/src/mode.ts`:

```ts
import type { Profile } from './profile';
import { usageError } from './errors';

export interface GlobalOptions {
  server?: string;
  db?: string;
  json?: boolean;
}

export type ModeSource = '--server' | 'GTR_SERVER' | 'profile';

export type Mode =
  | { kind: 'embedded'; dbPath: string }
  | { kind: 'remote'; server: string; token: string | null; source: ModeSource };

export const DEFAULT_DB_PATH = './data/graphtorest.db';

export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid server URL "${raw}" (expected e.g. http://localhost:3000)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError(`Server URL must start with http:// or https://, got "${raw}"`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Remote only when configured (spec §3): --server > GTR_SERVER > saved profile > embedded. Never probes the network. */
export function resolveMode(globals: GlobalOptions, env: NodeJS.ProcessEnv, loadProfile: () => Profile | null): Mode {
  let remote: Extract<Mode, { kind: 'remote' }> | null = null;
  const explicit =
    globals.server !== undefined
      ? { raw: globals.server, source: '--server' as const }
      : env.GTR_SERVER
        ? { raw: env.GTR_SERVER, source: 'GTR_SERVER' as const }
        : null;

  if (explicit) {
    const server = normalizeServerUrl(explicit.raw);
    let token = env.GTR_TOKEN || null;
    if (!token) {
      const profile = loadProfile();
      if (profile && normalizeServerUrl(profile.server) === server) token = profile.token;
    }
    remote = { kind: 'remote', server, token, source: explicit.source };
  } else {
    const profile = loadProfile();
    if (profile) remote = { kind: 'remote', server: normalizeServerUrl(profile.server), token: profile.token, source: 'profile' };
  }

  if (remote) {
    if (globals.db !== undefined) {
      throw usageError(
        `--db cannot be combined with remote mode (server configured via ${remote.source}); run "gtr logout" or drop --db`
      );
    }
    return remote;
  }
  return { kind: 'embedded', dbPath: globals.db ?? (env.DB_PATH || DEFAULT_DB_PATH) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/profile.test.ts apps/cli/test/mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/profile.ts apps/cli/src/mode.ts apps/cli/test/profile.test.ts apps/cli/test/mode.test.ts
git commit -m "feat(cli): add login profile storage and remote/embedded mode resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: GtrClient interface, EmbeddedClient, and the contract suite

The old `commands/*.ts` functions stay in place (the current `index.ts` still imports them) until Task 9. Their tests move into the contract suite here, and the old test files are deleted, except `carryOvers.test.ts` whose export half moves in Task 7.

**Files:**
- Create: `apps/cli/src/client/types.ts`, `apps/cli/src/client/embedded.ts`, `apps/cli/test/helpers/harness.ts`, `apps/cli/test/client.contract.test.ts`
- Delete: `apps/cli/test/commands.test.ts`, `apps/cli/test/adminCommands.test.ts`, `apps/cli/test/managedAuth.test.ts`, `apps/cli/test/mappingLifecycle.test.ts`
- Modify: `apps/cli/test/carryOvers.test.ts`, removing the `mapping-import auth override` describe block, now covered by the contract suite.

**Interfaces:**
- Consumes: `CliError` (Task 1), `ModeSource` (Task 2).
- Produces (`client/types.ts`):

```ts
export interface CreateConnectionInput { name: string; adapterType: string; authMode: string; config?: Record<string, unknown> | null }
export interface CreateMappingInput { connectionId: string; method: string; route: string; operation: Record<string, unknown>; responseTemplate?: Record<string, string> | null }
export interface MappingPatch { method?: string; route?: string; operation?: Record<string, unknown>; responseTemplate?: Record<string, string> | null }
export interface GenerateOptions { force?: boolean; vendorToken?: string }
export interface CreatedApiKey { id: string; plaintext: string; label: string | null }
export interface ImportResult { imported: number; warnings: string[] }
export interface ActivityQuery { limit?: number; before?: number }
export interface ActivityPage { items: RequestLogRecord[]; nextBefore: number | null }
export type SessionState = { username: string; expiresAt: string } | 'not-logged-in' | 'expired';
export type ClientStatus =
  | { mode: 'embedded'; dbPath: string; adminUsers: number }
  | { mode: 'remote'; server: string; source: ModeSource; session: SessionState };
export interface GtrClient { /* see code below */ }
```

- `class EmbeddedClient implements GtrClient { static open(dbPath: string, env?: NodeJS.ProcessEnv): EmbeddedClient; readonly store: MappingStore; readonly dbPath: string }`
- Test helper: `type HarnessFactory = (options?: { managedAuth?: boolean }) => Promise<Harness>`, `interface Harness { kind: 'embedded' | 'remote'; client: GtrClient; store: MappingStore; close(): Promise<void> }`, `embeddedHarness`, `tempPath(prefix, ext?)`, `removeDb(path)`.

- [ ] **Step 1: Write the client types** (no behavior, needed by the tests)

`apps/cli/src/client/types.ts`:

```ts
import type {
  ConnectionRecord,
  MappingRecord,
  ApiKeySummary,
  AdminUserRecord,
  RequestLogRecord,
  GenerationResult,
  CredentialStatus,
} from '@graphtorest/core';
import type { ModeSource } from '../mode';

export type { ConnectionRecord, MappingRecord, ApiKeySummary, AdminUserRecord, RequestLogRecord, GenerationResult, CredentialStatus };

export interface CreateConnectionInput {
  name: string;
  adapterType: string;
  authMode: string;
  config?: Record<string, unknown> | null;
}

export interface CreateMappingInput {
  connectionId: string;
  method: string;
  route: string;
  operation: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
}

export interface MappingPatch {
  method?: string;
  route?: string;
  operation?: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
}

export interface GenerateOptions {
  force?: boolean;
  vendorToken?: string;
}

export interface CreatedApiKey {
  id: string;
  plaintext: string;
  label: string | null;
}

export interface ImportResult {
  imported: number;
  warnings: string[];
}

export interface ActivityQuery {
  limit?: number;
  before?: number;
}

export interface ActivityPage {
  items: RequestLogRecord[];
  nextBefore: number | null;
}

export type SessionState = { username: string; expiresAt: string } | 'not-logged-in' | 'expired';

export type ClientStatus =
  | { mode: 'embedded'; dbPath: string; adminUsers: number }
  | { mode: 'remote'; server: string; source: ModeSource; session: SessionState };

/**
 * Everything a command can do, in either mode. Both implementations must behave identically, including error
 * codes; client.contract.test.ts is the proof.
 */
export interface GtrClient {
  readonly mode: 'embedded' | 'remote';
  describe(): Promise<ClientStatus>;
  close(): void;

  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord>;
  listConnections(): Promise<ConnectionRecord[]>;
  deleteConnection(id: string): Promise<void>;
  setCredentials(id: string, credentials: unknown): Promise<CredentialStatus>;
  getCredentialStatus(id: string): Promise<CredentialStatus>;
  clearCredentials(id: string): Promise<void>;
  /** Remote only: the vendor redirects back to the server's /admin/oauth/callback. */
  startAuthorization(id: string): Promise<{ authorizationUrl: string }>;

  createMapping(input: CreateMappingInput): Promise<MappingRecord>;
  listMappings(): Promise<MappingRecord[]>;
  updateMapping(id: string, patch: MappingPatch): Promise<MappingRecord>;
  deleteMapping(id: string): Promise<void>;
  generateMappings(connectionId: string, options: GenerateOptions): Promise<GenerationResult>;
  exportMappings(options: { connectionId?: string }): Promise<string>;
  importMappings(yaml: string): Promise<ImportResult>;

  createApiKey(input: { label?: string }): Promise<CreatedApiKey>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id: string): Promise<void>;

  createAdminUser(input: { username: string; password: string }): Promise<AdminUserRecord>;
  /** Embedded only: lockout recovery, no remote endpoint exists. */
  setAdminPassword(input: { username: string; password: string }): Promise<void>;

  listAdapters(): Promise<string[]>;
  listActivity(query: ActivityQuery): Promise<ActivityPage>;
}
```

- [ ] **Step 2: Write the harness and the failing contract suite**

`apps/cli/test/helpers/harness.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MappingStore } from '@graphtorest/core';
import { EmbeddedClient } from '../../src/client/embedded';
import type { GtrClient } from '../../src/client/types';

export const TEST_KEY = '00'.repeat(32);

export interface Harness {
  kind: 'embedded' | 'remote';
  client: GtrClient;
  /** Direct store access for seeding and asserting on persisted state. */
  store: MappingStore;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Defaults to true: a CREDENTIAL_ENCRYPTION_KEY is configured. */
  managedAuth?: boolean;
}

export type HarnessFactory = (options?: HarnessOptions) => Promise<Harness>;

export function tempPath(prefix: string, ext = '.db'): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
}

export function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

export const embeddedHarness: HarnessFactory = async (options = {}) => {
  const dbPath = tempPath('gtr-embedded');
  const env = options.managedAuth === false ? {} : { CREDENTIAL_ENCRYPTION_KEY: TEST_KEY };
  const client = EmbeddedClient.open(dbPath, env);
  return {
    kind: 'embedded',
    client,
    store: client.store,
    close: async () => {
      client.close();
      removeDb(dbPath);
    },
  };
};
```

`apps/cli/test/client.contract.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the suite to verify it fails**

Run: `npx vitest run apps/cli/test/client.contract.test.ts`
Expected: FAIL, cannot resolve `../../src/client/embedded`.

- [ ] **Step 4: Implement EmbeddedClient**

`apps/cli/src/client/embedded.ts`:

```ts
import {
  openDb,
  MappingStore,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
  listAdapterTypes,
  buildAuthContext,
  generateAndPersistMappings,
  exportMappingsYaml,
  importMappingsYaml,
  parseMappingFields,
  type ConnectionRecord,
} from '@graphtorest/core';
import { CliError } from '../errors';
import type {
  GtrClient,
  ClientStatus,
  CreateConnectionInput,
  CreateMappingInput,
  MappingPatch,
  GenerateOptions,
  CreatedApiKey,
  ImportResult,
  ActivityQuery,
  ActivityPage,
} from './types';

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;

function sqliteCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function notFound(message: string): CliError {
  return new CliError('NOT_FOUND', message);
}

function invalid(message: string): CliError {
  return new CliError('INVALID_INPUT', message);
}

/**
 * Direct SQLite access through @graphtorest/core. Validation and error codes deliberately mirror
 * apps/server/src/routers/adminRouter.ts so both modes behave the same (see client.contract.test.ts).
 */
export class EmbeddedClient implements GtrClient {
  readonly mode = 'embedded' as const;

  static open(dbPath: string, env: NodeJS.ProcessEnv = process.env): EmbeddedClient {
    registerDefaultAdapters();
    const db = openDb(dbPath);
    const store = new MappingStore(db);
    const key = env.CREDENTIAL_ENCRYPTION_KEY;
    return new EmbeddedClient(dbPath, db, store, key ? new ManagedTokenService(store, new CredentialCipher(key)) : undefined);
  }

  private constructor(
    readonly dbPath: string,
    private readonly db: ReturnType<typeof openDb>,
    readonly store: MappingStore,
    private readonly managedAuth: ManagedTokenService | undefined
  ) {}

  close(): void {
    this.db.close();
  }

  async describe(): Promise<ClientStatus> {
    return { mode: 'embedded', dbPath: this.dbPath, adminUsers: this.store.countAdminUsers() };
  }

  async createConnection(input: CreateConnectionInput) {
    try {
      return this.store.createConnection(input);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A connection with this name already exists');
      throw err;
    }
  }

  async listConnections() {
    return this.store.listConnections();
  }

  async deleteConnection(id: string) {
    if (!this.store.getConnection(id)) throw notFound('Connection not found');
    this.managedAuth?.clearCredentials(id); // drop cached tokens and pending authorizations first, as the server does
    this.store.deleteConnection(id);
  }

  async setCredentials(id: string, credentials: unknown) {
    const [managedAuth, connection] = this.managedConnection(id);
    return managedAuth.saveCredentials(connection, credentials);
  }

  async getCredentialStatus(id: string) {
    const [managedAuth, connection] = this.managedConnection(id);
    return managedAuth.getCredentialStatus(connection.id);
  }

  async clearCredentials(id: string) {
    const [managedAuth, connection] = this.managedConnection(id);
    managedAuth.clearCredentials(connection.id);
  }

  async startAuthorization(_id: string): Promise<never> {
    throw new CliError(
      'MODE_UNSUPPORTED',
      '"connection authorize" needs remote mode: the vendor redirects to a running server\'s /admin/oauth/callback. Run "gtr login --server <url>" first.'
    );
  }

  async createMapping(input: CreateMappingInput) {
    const fields = parseMappingFields({
      route: input.route,
      method: input.method,
      operation: input.operation,
      responseTemplate: input.responseTemplate,
    });
    try {
      return this.store.createMapping({
        connectionId: input.connectionId,
        route: fields.route!,
        method: fields.method!,
        operation: fields.operation!,
        responseTemplate: fields.responseTemplate ?? null,
        source: 'manual',
      });
    } catch (err) {
      const code = sqliteCode(err);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A mapping with this route and method already exists');
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw invalid('connectionId does not reference an existing connection');
      throw err;
    }
  }

  async listMappings() {
    return this.store.listMappings();
  }

  async updateMapping(id: string, patch: MappingPatch) {
    const fields = parseMappingFields({ ...patch });
    if (
      fields.route === undefined &&
      fields.method === undefined &&
      fields.operation === undefined &&
      fields.responseTemplate === undefined
    ) {
      throw invalid('At least one of route, method, operation, responseTemplate is required');
    }
    let updated;
    try {
      updated = this.store.updateMapping(id, {
        route: fields.route,
        method: fields.method,
        operation: fields.operation,
        responseTemplate: fields.responseTemplate,
        source: 'manual', // any admin edit flips a mapping to manual (spec §5.2)
      });
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A mapping with this route and method already exists');
      throw err;
    }
    if (!updated) throw notFound('Mapping not found');
    return updated;
  }

  async deleteMapping(id: string) {
    if (!this.store.deleteMapping(id)) throw notFound('Mapping not found');
  }

  async generateMappings(connectionId: string, options: GenerateOptions) {
    const connection = this.store.getConnection(connectionId);
    if (!connection) throw notFound('Connection not found');
    if (connection.authMode === 'managed' && !this.managedAuth) {
      throw new CliError(
        'MANAGED_AUTH_UNAVAILABLE',
        'Managed auth requires CREDENTIAL_ENCRYPTION_KEY to be set in this environment (embedded mode)'
      );
    }
    const authContext = await buildAuthContext(connection, options.vendorToken, this.managedAuth);
    return generateAndPersistMappings(this.store, connection, authContext, { force: options.force === true });
  }

  async exportMappings(options: { connectionId?: string }) {
    return exportMappingsYaml(this.store, { connectionId: options.connectionId });
  }

  async importMappings(yaml: string): Promise<ImportResult> {
    const { records, warnings } = importMappingsYaml(this.store, yaml);
    return { imported: records.length, warnings };
  }

  async createApiKey(input: { label?: string }): Promise<CreatedApiKey> {
    const created = this.store.createApiKey({ label: input.label });
    return { id: created.id, plaintext: created.plaintext, label: created.label };
  }

  async listApiKeys() {
    return this.store.listApiKeys();
  }

  async revokeApiKey(id: string) {
    if (!this.store.deleteApiKey(id)) throw notFound('API key not found');
  }

  async createAdminUser(input: { username: string; password: string }) {
    try {
      return this.store.createAdminUser(input);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'An admin user with this username already exists');
      throw err;
    }
  }

  async setAdminPassword(input: { username: string; password: string }) {
    if (!this.store.setAdminPassword(input.username, input.password)) throw notFound(`No admin user named "${input.username}"`);
  }

  async listAdapters() {
    return listAdapterTypes();
  }

  async listActivity(query: ActivityQuery): Promise<ActivityPage> {
    const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
      throw invalid(`"limit" must be an integer from 1 to ${ACTIVITY_MAX_LIMIT}`);
    }
    if (query.before !== undefined && (!Number.isInteger(query.before) || query.before < 1)) {
      throw invalid('"before" must be a positive integer');
    }
    const items = this.store.listRequests({ limit, before: query.before });
    return { items, nextBefore: items.length === limit ? items[items.length - 1].id : null };
  }

  /** Same order as the server: managed auth configured → connection exists → connection is managed. */
  private managedConnection(id: string): [ManagedTokenService, ConnectionRecord] {
    if (!this.managedAuth) {
      throw new CliError(
        'MANAGED_AUTH_DISABLED',
        'Managed auth is disabled: set CREDENTIAL_ENCRYPTION_KEY in this environment to manage stored credentials in embedded mode'
      );
    }
    const connection = this.store.getConnection(id);
    if (!connection) throw notFound('Connection not found');
    if (connection.authMode !== 'managed') throw invalid('The connection authMode must be "managed" to use stored credentials');
    return [this.managedAuth, connection];
  }
}
```

- [ ] **Step 5: Run the contract suite to verify it passes**

Run: `npx vitest run apps/cli/test/client.contract.test.ts`
Expected: PASS. The `runIf(kind === 'remote')` tests are skipped.

- [ ] **Step 6: Delete the ported test files and the ported carry-over block**

```bash
git rm apps/cli/test/commands.test.ts apps/cli/test/adminCommands.test.ts apps/cli/test/managedAuth.test.ts apps/cli/test/mappingLifecycle.test.ts
```

In `apps/cli/test/carryOvers.test.ts`, delete the whole `describe('mapping-import auth override', …)` block and the now-unused `mappingImport` import. Keep the `mapping-export output file` block; Task 7 ports it.

Run: `npx vitest run apps/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/client apps/cli/test
git commit -m "feat(cli): add the GtrClient interface, EmbeddedClient and a shared client contract suite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: RemoteClient

**Files:**
- Create: `apps/cli/src/client/remote.ts`, `apps/cli/test/helpers/fakeFetch.ts`, `apps/cli/test/remote.test.ts`
- Modify: `apps/cli/test/helpers/harness.ts` (add `remoteHarness`), `apps/cli/test/client.contract.test.ts` (add remote to `HARNESSES`)

**Interfaces:**
- Consumes: `GtrClient` and types (Task 3), `CliError` (Task 1), `ModeSource` (Task 2).
- Produces:
  - `DEFAULT_TIMEOUT_MS = 30_000`, `GENERATE_TIMEOUT_MS = 120_000`
  - `interface RemoteClientOptions { server: string; token: string | null; source: ModeSource; fetchImpl?: typeof fetch; timeoutMs?: number }`
  - `class RemoteClient implements GtrClient { constructor(options: RemoteClientOptions); static login(options: Omit<RemoteClientOptions, 'token'>, username: string, password: string): Promise<{ token: string; expiresAt: string }>; session(): Promise<{ username: string; expiresAt: string }>; logout(): Promise<void> }`
  - Test helper `fakeFetch(routes)`: returns `{ impl: typeof fetch; calls: FakeCall[] }`, where `routes` maps `"METHOD /pathname"` to a responder.

- [ ] **Step 1: Write the fake fetch helper and the failing unit tests**

`apps/cli/test/helpers/fakeFetch.ts`:

```ts
export interface FakeCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Defaults to application/json when body is set. */
  contentType?: string;
}

type Responder = FakeResponse | ((call: FakeCall) => FakeResponse);

/** Routes are keyed "METHOD /pathname" (no query string). Unrouted calls fail the test loudly. */
export function fakeFetch(routes: Record<string, Responder>) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      path: url.pathname,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const responder = routes[`${call.method} ${call.path}`];
    if (!responder) throw new Error(`fakeFetch: no route for ${call.method} ${call.path}`);
    const response = typeof responder === 'function' ? responder(call) : responder;
    if (response.status === 204) return new Response(null, { status: 204 });
    const isText = typeof response.body === 'string';
    const contentType = response.contentType ?? (isText ? 'text/plain' : 'application/json; charset=utf-8');
    const payload = response.body === undefined ? '' : isText ? (response.body as string) : JSON.stringify(response.body);
    return new Response(payload, { status: response.status, headers: { 'content-type': contentType } });
  }) as typeof fetch;
  return { impl, calls };
}
```

`apps/cli/test/remote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RemoteClient } from '../src/client/remote';
import { fakeFetch } from './helpers/fakeFetch';

function client(impl: typeof fetch, overrides: Partial<ConstructorParameters<typeof RemoteClient>[0]> = {}) {
  return new RemoteClient({ server: 'http://gtr.test', token: 'tok', source: '--server', fetchImpl: impl, ...overrides });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { code: string; message: string; exitCode: number };
  }
  throw new Error('expected failure');
}

describe('RemoteClient requests', () => {
  it('sends the bearer token and JSON body under <server>/admin, keeping a path prefix', async () => {
    const fake = fakeFetch({ 'POST /gtr/admin/connections': { status: 201, body: { id: 'c1' } } });
    const remote = client(fake.impl, { server: 'https://host.test/gtr' });
    await remote.createConnection({ name: 'n', adapterType: 'mock', authMode: 'passthrough' });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://host.test/gtr/admin/connections',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: { name: 'n', adapterType: 'mock', authMode: 'passthrough' },
    });
  });

  it('sends source=manual when creating a mapping', async () => {
    const fake = fakeFetch({ 'POST /admin/mappings': { status: 201, body: {} } });
    await client(fake.impl).createMapping({ connectionId: 'c', method: 'GET', route: '/a', operation: {} });
    expect(fake.calls[0].body).toMatchObject({ source: 'manual' });
  });

  it('sends the vendor token header and force flag for generate, and query params for export and activity', async () => {
    const fake = fakeFetch({
      'POST /admin/connections/c%201/mappings/generate': { status: 200, body: { created: [], updated: [], skipped: [], conflicts: [] } },
      'GET /admin/mappings/export': { status: 200, body: '- a: 1\n', contentType: 'text/yaml' },
      'GET /admin/activity': { status: 200, body: { items: [], nextBefore: null } },
    });
    const remote = client(fake.impl);
    await remote.generateMappings('c 1', { force: true, vendorToken: 'vt' });
    expect(await remote.exportMappings({ connectionId: 'c1' })).toBe('- a: 1\n');
    await remote.listActivity({ limit: 5 });
    expect(fake.calls[0]).toMatchObject({ headers: { 'x-vendor-token': 'vt' }, body: { force: true } });
    expect(fake.calls[1].url).toBe('http://gtr.test/admin/mappings/export?connectionId=c1');
    expect(fake.calls[2].url).toBe('http://gtr.test/admin/activity?limit=5');
  });

  it('returns undefined for 204 responses', async () => {
    const fake = fakeFetch({ 'DELETE /admin/mappings/m1': { status: 204 } });
    await expect(client(fake.impl).deleteMapping('m1')).resolves.toBeUndefined();
  });
});

describe('RemoteClient errors', () => {
  it('maps a server error body to its code and message', async () => {
    const fake = fakeFetch({ 'DELETE /admin/mappings/x': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Mapping not found', details: {} } } } });
    expect(await failure(client(fake.impl).deleteMapping('x'))).toMatchObject({ code: 'NOT_FOUND', message: 'Mapping not found', exitCode: 4 });
  });

  it('reports a non-JSON error body as SERVER_ERROR with the status', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' } });
    expect(await failure(client(fake.impl).listConnections())).toMatchObject({ code: 'SERVER_ERROR', message: 'Server returned HTTP 502' });
  });

  it('explains a 2xx non-JSON response instead of crashing on JSON.parse', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 200, body: '<html>hello</html>', contentType: 'text/html' } });
    const err = await failure(client(fake.impl).listConnections());
    expect(err.code).toBe('SERVER_ERROR');
    expect(err.message).toMatch(/expected JSON but got text\/html.*Is this a GraphToRest server URL\?/);
  });

  it('tells the user to log in again when a sent token is rejected', async () => {
    const fake = fakeFetch({ 'GET /admin/connections': { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } } });
    expect(await failure(client(fake.impl).listConnections())).toMatchObject({
      code: 'UNAUTHORIZED',
      exitCode: 3,
      message: 'Session expired or revoked; run "gtr login --server http://gtr.test"',
    });
  });

  it('fails before any request when there is no token', async () => {
    const fake = fakeFetch({});
    expect(await failure(client(fake.impl, { token: null }).listConnections())).toMatchObject({
      code: 'NOT_LOGGED_IN',
      exitCode: 3,
      message: 'Not logged in to http://gtr.test; run "gtr login --server http://gtr.test"',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('reports an unreachable server with where it was configured', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    }) as typeof fetch;
    expect(await failure(client(refused, { source: 'profile' }).listConnections())).toMatchObject({
      code: 'UNREACHABLE',
      exitCode: 1,
      message: 'Cannot reach server at http://gtr.test (configured via profile): connect ECONNREFUSED 127.0.0.1:9',
    });
  });

  it('reports a timeout', async () => {
    const slow = ((_input: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    expect(await failure(client(slow, { timeoutMs: 20 }).listConnections())).toMatchObject({
      code: 'TIMEOUT',
      message: 'Request to http://gtr.test timed out after 0.02s',
    });
  });

  it('refuses embedded-only operations', async () => {
    expect(await failure(client(fakeFetch({}).impl).setAdminPassword({ username: 'a', password: 'b' }))).toMatchObject({ code: 'MODE_UNSUPPORTED' });
  });
});

describe('RemoteClient sessions', () => {
  it('logs in without a token and surfaces a bad password as UNAUTHORIZED with the server message', async () => {
    const fake = fakeFetch({
      'POST /admin/login': (call) =>
        (call.body as { password: string }).password === 'right'
          ? { status: 200, body: { token: 'new', expiresAt: 'soon' } }
          : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } } },
    });
    const options = { server: 'http://gtr.test', source: '--server' as const, fetchImpl: fake.impl };
    expect(await RemoteClient.login(options, 'admin', 'right')).toEqual({ token: 'new', expiresAt: 'soon' });
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(await failure(RemoteClient.login(options, 'admin', 'wrong'))).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid username or password' });
  });

  it('describes the session as logged in, expired or not logged in', async () => {
    const ok = fakeFetch({ 'GET /admin/session': { status: 200, body: { username: 'admin', expiresAt: 'soon' } } });
    const expired = fakeFetch({ 'GET /admin/session': { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } } });
    expect(await client(ok.impl).describe()).toEqual({
      mode: 'remote',
      server: 'http://gtr.test',
      source: '--server',
      session: { username: 'admin', expiresAt: 'soon' },
    });
    expect((await client(expired.impl).describe()).session).toBe('expired');
    expect((await client(fakeFetch({}).impl, { token: null }).describe()).session).toBe('not-logged-in');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/remote.test.ts`
Expected: FAIL, cannot resolve `../src/client/remote`.

- [ ] **Step 3: Implement RemoteClient**

`apps/cli/src/client/remote.ts`:

```ts
import { CliError } from '../errors';
import type { ModeSource } from '../mode';
import type {
  GtrClient,
  ClientStatus,
  CreateConnectionInput,
  CreateMappingInput,
  MappingPatch,
  GenerateOptions,
  CreatedApiKey,
  ImportResult,
  ActivityQuery,
  ActivityPage,
  ConnectionRecord,
  MappingRecord,
  CredentialStatus,
  GenerationResult,
  ApiKeySummary,
  AdminUserRecord,
} from './types';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const GENERATE_TIMEOUT_MS = 120_000;

export interface RemoteClientOptions {
  server: string;
  token: string | null;
  source: ModeSource;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** false for /login, the only call made without a session. */
  auth?: boolean;
  expect?: 'json' | 'text' | 'none';
}

const enc = encodeURIComponent;

/** Calls a running server's /admin/* API with a bearer session token. */
export class RemoteClient implements GtrClient {
  readonly mode = 'remote' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static login(options: Omit<RemoteClientOptions, 'token'>, username: string, password: string): Promise<{ token: string; expiresAt: string }> {
    return new RemoteClient({ ...options, token: null }).request('POST', '/login', { body: { username, password }, auth: false });
  }

  session(): Promise<{ username: string; expiresAt: string }> {
    return this.request('GET', '/session');
  }

  async logout(): Promise<void> {
    await this.request('POST', '/logout', { expect: 'none' });
  }

  close(): void {}

  async describe(): Promise<ClientStatus> {
    const base = { mode: 'remote' as const, server: this.options.server, source: this.options.source };
    if (!this.options.token) return { ...base, session: 'not-logged-in' };
    try {
      return { ...base, session: await this.session() };
    } catch (err) {
      if (err instanceof CliError && err.code === 'UNAUTHORIZED') return { ...base, session: 'expired' };
      throw err;
    }
  }

  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord> {
    return this.request('POST', '/connections', { body: input });
  }

  listConnections(): Promise<ConnectionRecord[]> {
    return this.request('GET', '/connections');
  }

  async deleteConnection(id: string): Promise<void> {
    await this.request('DELETE', `/connections/${enc(id)}`, { expect: 'none' });
  }

  setCredentials(id: string, credentials: unknown): Promise<CredentialStatus> {
    return this.request('PUT', `/connections/${enc(id)}/credentials`, { body: credentials });
  }

  getCredentialStatus(id: string): Promise<CredentialStatus> {
    return this.request('GET', `/connections/${enc(id)}/credentials`);
  }

  async clearCredentials(id: string): Promise<void> {
    await this.request('DELETE', `/connections/${enc(id)}/credentials`, { expect: 'none' });
  }

  startAuthorization(id: string): Promise<{ authorizationUrl: string }> {
    return this.request('POST', `/connections/${enc(id)}/oauth/start`);
  }

  createMapping(input: CreateMappingInput): Promise<MappingRecord> {
    return this.request('POST', '/mappings', { body: { ...input, source: 'manual' } });
  }

  listMappings(): Promise<MappingRecord[]> {
    return this.request('GET', '/mappings');
  }

  updateMapping(id: string, patch: MappingPatch): Promise<MappingRecord> {
    return this.request('PATCH', `/mappings/${enc(id)}`, { body: patch });
  }

  async deleteMapping(id: string): Promise<void> {
    await this.request('DELETE', `/mappings/${enc(id)}`, { expect: 'none' });
  }

  generateMappings(connectionId: string, options: GenerateOptions): Promise<GenerationResult> {
    return this.request('POST', `/connections/${enc(connectionId)}/mappings/generate`, {
      body: { force: options.force === true },
      headers: options.vendorToken ? { 'X-Vendor-Token': options.vendorToken } : {},
      timeoutMs: GENERATE_TIMEOUT_MS,
    });
  }

  exportMappings(options: { connectionId?: string }): Promise<string> {
    return this.request('GET', '/mappings/export', { query: { connectionId: options.connectionId }, expect: 'text' });
  }

  importMappings(yaml: string): Promise<ImportResult> {
    return this.request('POST', '/mappings/import', { body: { yaml } });
  }

  createApiKey(input: { label?: string }): Promise<CreatedApiKey> {
    return this.request('POST', '/api-keys', { body: input });
  }

  listApiKeys(): Promise<ApiKeySummary[]> {
    return this.request('GET', '/api-keys');
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/api-keys/${enc(id)}`, { expect: 'none' });
  }

  createAdminUser(input: { username: string; password: string }): Promise<AdminUserRecord> {
    return this.request('POST', '/admin-users', { body: input });
  }

  async setAdminPassword(_input: { username: string; password: string }): Promise<never> {
    throw new CliError(
      'MODE_UNSUPPORTED',
      '"admin set-password" is embedded-only (lockout recovery): run it where the SQLite file is, without --server/GTR_SERVER and after "gtr logout"'
    );
  }

  listAdapters(): Promise<string[]> {
    return this.request('GET', '/adapters');
  }

  listActivity(query: ActivityQuery): Promise<ActivityPage> {
    return this.request('GET', '/activity', { query: { limit: query.limit, before: query.before } });
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { server, token, source } = this.options;
    const authenticated = opts.auth !== false;
    if (authenticated && !token) {
      throw new CliError('NOT_LOGGED_IN', `Not logged in to ${server}; run "gtr login --server ${server}"`);
    }

    const url = new URL(`${server}/admin${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'TimeoutError') {
        throw new CliError('TIMEOUT', `Request to ${server} timed out after ${timeoutMs / 1000}s`);
      }
      const cause = (err as { cause?: { message?: string } } | null)?.cause?.message ?? (err as Error)?.message ?? String(err);
      throw new CliError('UNREACHABLE', `Cannot reach server at ${server} (configured via ${source}): ${cause}`);
    }

    if (!res.ok) throw await this.errorFrom(res);
    const expect = opts.expect ?? 'json';
    if (expect === 'none' || res.status === 204) return undefined as T;
    if (expect === 'text') return (await res.text()) as T;
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^application\/json/i.test(contentType)) {
      throw new CliError(
        'SERVER_ERROR',
        `Unexpected response from ${server}: expected JSON but got ${contentType || 'no content type'}. Is this a GraphToRest server URL?`
      );
    }
    return (await res.json()) as T;
  }

  private async errorFrom(res: Response): Promise<CliError> {
    const { server, token } = this.options;
    if (res.status === 401 && token) {
      return new CliError('UNAUTHORIZED', `Session expired or revoked; run "gtr login --server ${server}"`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return new CliError(error.code, error.message);
    }
    return new CliError('SERVER_ERROR', `Server returned HTTP ${res.status}`);
  }
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run apps/cli/test/remote.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the remote harness and enable remote in the contract suite**

Append to `apps/cli/test/helpers/harness.ts` (and add the new imports at the top):

```ts
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
// Relative import on purpose: the @graphtorest/server package entry (index.ts) starts a server as a side effect.
import { createApp } from '../../../server/src/app';
import { RemoteClient } from '../../src/client/remote';

export const remoteHarness: HarnessFactory = async (options = {}) => {
  registerDefaultAdapters();
  const dbPath = tempPath('gtr-remote');
  const db = openDb(dbPath);
  const store = new MappingStore(db);
  const managedAuth = options.managedAuth === false ? undefined : new ManagedTokenService(store, new CredentialCipher(TEST_KEY));
  const app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store, managedAuth),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: false,
    adminEnabled: true,
    managedAuth,
    publicBaseUrl: 'https://gtr.example.test',
  });
  const admin = store.createAdminUser({ username: 'harness-admin', password: 'correct-horse-battery' });
  const { token } = store.createAdminSession(admin.id, 60 * 60 * 1000);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    kind: 'remote',
    client: new RemoteClient({ server: url, token, source: '--server' }),
    store,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      removeDb(dbPath);
    },
  };
};
```

The existing `import type { MappingStore } from '@graphtorest/core';` line merges into the value import above, since `MappingStore` is now also used as a value.

In `apps/cli/test/client.contract.test.ts` change the import and `HARNESSES`:

```ts
import { embeddedHarness, remoteHarness, type Harness, type HarnessFactory } from './helpers/harness';

const HARNESSES: Array<[Harness['kind'], HarnessFactory]> = [
  ['embedded', embeddedHarness],
  ['remote', remoteHarness],
];
```

- [ ] **Step 6: Run the contract suite in both modes**

Run: `npx vitest run apps/cli/test/client.contract.test.ts`
Expected: PASS for both `(embedded)` and `(remote)`. If a remote case fails with a code the embedded side doesn't produce, fix `EmbeddedClient` or `RemoteClient`. **Do not** change `adminRouter.ts`: the server is the reference behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/client/remote.ts apps/cli/test
git commit -m "feat(cli): add RemoteClient over /admin/* and run the client contract suite against a live server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Program skeleton, prompts, and login / logout / status

**Files:**
- Create: `apps/cli/src/prompt.ts`, `apps/cli/src/runtime.ts`, `apps/cli/src/program.ts`, `apps/cli/src/commands/auth.ts`, `apps/cli/test/helpers/cli.ts`, `apps/cli/test/prompt.test.ts`, `apps/cli/test/authCommands.test.ts`

`index.ts` is **not** switched yet (Task 9). All tests drive `runCli` directly.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `interface Prompter { isInteractive(): boolean; ask(q: string): Promise<string>; askHidden(q: string): Promise<string>; confirm(q: string): Promise<boolean> }`, `createTtyPrompter(input?, output?): Prompter`
  - `interface CliContext { env: NodeJS.ProcessEnv; io: Io; prompter: Prompter; fetchImpl?: typeof fetch; openClient?: (mode: Mode) => GtrClient }`
  - `interface Runtime { ctx: CliContext; globals: GlobalOptions; out: Output; profileFile: string; mode(): Mode; client(): GtrClient }`
  - `action<A extends unknown[]>(ctx: CliContext, fn: (rt: Runtime, ...args: A) => Promise<void>): (...args: unknown[]) => Promise<void>`
  - `requireMode(rt: Runtime, kind: Mode['kind'], message: string): void`
  - `resolveSecret(rt: Runtime, opts: { value?: string; envVar: string; prompt: string; missing: string }): Promise<string>`
  - `resolveText(rt: Runtime, value: string | undefined, prompt: string, missing: string): Promise<string>`
  - `confirmOrRefuse(rt: Runtime, yes: boolean | undefined, question: string): Promise<boolean>`
  - `parseJsonObject(text: string, flag: string): Record<string, unknown>`
  - `buildProgram(ctx: CliContext): Command`, `runCli(argv: string[], ctx: CliContext): Promise<number>`
  - `registerAuthCommands(program: Command, ctx: CliContext): void`
  - Test helper `makeCli(options?)`: returns `{ ctx, run(argv: string[]): Promise<number>, stdout(): string, stderr(): string, profileFile: string, dbPath: string, cleanup(): void }`

- [ ] **Step 1: Write the prompt, runtime and program modules** (the test harness needs these types; behavior is tested next)

`apps/cli/src/prompt.ts`:

```ts
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { CliError } from './errors';

export interface Prompter {
  isInteractive(): boolean;
  ask(question: string): Promise<string>;
  /** Input is not echoed. */
  askHidden(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

/** Prompts go to stderr so stdout stays clean for --json and pipes. */
export function createTtyPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): Prompter {
  const question = async (text: string, hidden: boolean): Promise<string> => {
    let muted = false;
    const sink = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) output.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input, output: sink, terminal: true });
    const abort = new AbortController();
    rl.on('SIGINT', () => abort.abort());
    try {
      const answer = rl.question(text, { signal: abort.signal });
      muted = hidden;
      return await answer;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw new CliError('ABORTED', 'Aborted', 130);
      throw err;
    } finally {
      muted = false;
      if (hidden) output.write('\n');
      rl.close();
    }
  };

  return {
    isInteractive: () => Boolean(input.isTTY),
    ask: async (text) => (await question(text, false)).trim(),
    askHidden: (text) => question(text, true),
    confirm: async (text) => /^y(es)?$/i.test((await question(`${text} [y/N] `, false)).trim()),
  };
}
```

`apps/cli/src/runtime.ts`:

```ts
import type { Command } from 'commander';
import { CliError, usageError } from './errors';
import { Output, type Io } from './output';
import { resolveMode, type GlobalOptions, type Mode } from './mode';
import { profilePath, readProfile } from './profile';
import type { Prompter } from './prompt';
import type { GtrClient } from './client/types';
import { EmbeddedClient } from './client/embedded';
import { RemoteClient } from './client/remote';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  io: Io;
  prompter: Prompter;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to EmbeddedClient / RemoteClient. */
  openClient?: (mode: Mode) => GtrClient;
}

export interface Runtime {
  ctx: CliContext;
  globals: GlobalOptions;
  out: Output;
  profileFile: string;
  /** Resolved lazily so login/logout never trip over mode resolution. */
  mode(): Mode;
  /** Opened lazily on first use and closed after the action. */
  client(): GtrClient;
}

function defaultOpenClient(ctx: CliContext, mode: Mode): GtrClient {
  return mode.kind === 'embedded'
    ? EmbeddedClient.open(mode.dbPath, ctx.env)
    : new RemoteClient({ server: mode.server, token: mode.token, source: mode.source, fetchImpl: ctx.fetchImpl });
}

/** Wraps a commander action: commander passes (...positionals, options, command). */
export function action<A extends unknown[]>(ctx: CliContext, fn: (rt: Runtime, ...args: A) => Promise<void>) {
  return async (...args: unknown[]): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const globals = command.optsWithGlobals() as GlobalOptions;
    const profileFile = profilePath(ctx.env);
    let mode: Mode | undefined;
    let client: GtrClient | undefined;
    const rt: Runtime = {
      ctx,
      globals,
      profileFile,
      out: new Output(ctx.io, globals.json === true),
      mode: () => (mode ??= resolveMode(globals, ctx.env, () => readProfile(profileFile))),
      client: () => (client ??= (ctx.openClient ?? ((m: Mode) => defaultOpenClient(ctx, m)))(rt.mode())),
    };
    try {
      await fn(rt, ...(args.slice(0, -1) as A));
    } finally {
      client?.close();
    }
  };
}

export function requireMode(rt: Runtime, kind: Mode['kind'], message: string): void {
  if (rt.mode().kind !== kind) throw new CliError('MODE_UNSUPPORTED', message);
}

/** Flag, then env var, then a hidden prompt on a terminal; otherwise a usage error (never hangs in CI). */
export async function resolveSecret(
  rt: Runtime,
  opts: { value?: string; envVar: string; prompt: string; missing: string }
): Promise<string> {
  const provided = opts.value ?? rt.ctx.env[opts.envVar];
  if (provided) return provided;
  if (rt.ctx.prompter.isInteractive()) {
    const answer = await rt.ctx.prompter.askHidden(opts.prompt);
    if (answer) return answer;
  }
  throw usageError(opts.missing);
}

export async function resolveText(rt: Runtime, value: string | undefined, prompt: string, missing: string): Promise<string> {
  if (value) return value;
  if (rt.ctx.prompter.isInteractive()) {
    const answer = await rt.ctx.prompter.ask(prompt);
    if (answer) return answer;
  }
  throw usageError(missing);
}

/** true = go ahead. Without a terminal, --yes is mandatory. */
export async function confirmOrRefuse(rt: Runtime, yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  if (!rt.ctx.prompter.isInteractive()) {
    throw usageError('Refusing to delete without confirmation: pass --yes when not running in a terminal');
  }
  const confirmed = await rt.ctx.prompter.confirm(question);
  if (!confirmed) rt.out.warn('Cancelled.');
  return confirmed;
}

export function parseJsonObject(text: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(`${flag} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usageError(`${flag} must be a JSON object`);
  return parsed as Record<string, unknown>;
}
```

`apps/cli/src/program.ts`:

```ts
import { Command, CommanderError } from 'commander';
import { EXIT_CODES, toCliError } from './errors';
import type { CliContext } from './runtime';
import { registerAuthCommands } from './commands/auth';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name('gtr')
    .description('GraphToRest CLI: embedded (SQLite file) or remote (running server) mode')
    .option('--server <url>', 'remote mode against this server (or set GTR_SERVER / run "gtr login")')
    .option('--db <path>', 'SQLite file for embedded mode (default: $DB_PATH or ./data/graphtorest.db)')
    .option('--json', 'print raw JSON instead of tables')
    // Both settings are inherited by every subcommand created after this point.
    .exitOverride()
    .configureOutput({ writeOut: (text) => ctx.io.out(text), writeErr: (text) => ctx.io.err(text) });

  registerAuthCommands(program, ctx);
  return program;
}

/** Runs one CLI invocation and returns the process exit code. Never calls process.exit. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    // Commander already printed its own message (usage errors) or the help text.
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : EXIT_CODES.usage;
    const cliError = toCliError(err);
    ctx.io.err(`error: ${cliError.message}\n`);
    if (ctx.env.GTR_DEBUG === '1' && err instanceof Error && err.stack) ctx.io.err(`${err.stack}\n`);
    return cliError.exitCode;
  }
}
```

- [ ] **Step 2: Write the CLI test helper and the failing tests**

`apps/cli/test/helpers/cli.ts`:

```ts
import fs from 'node:fs';
import { runCli } from '../../src/program';
import type { CliContext } from '../../src/runtime';
import type { Prompter } from '../../src/prompt';
import { tempPath, removeDb } from './harness';

export interface FakePrompterOptions {
  interactive?: boolean;
  /** Answers for ask()/askHidden(), consumed in order. */
  answers?: string[];
  confirm?: boolean;
}

export function fakePrompter(options: FakePrompterOptions = {}): Prompter & { asked: string[] } {
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);
    return answers.shift() ?? '';
  };
  return {
    asked,
    isInteractive: () => options.interactive ?? false,
    ask: next,
    askHidden: next,
    confirm: async (question) => {
      asked.push(question);
      return options.confirm ?? false;
    },
  };
}

export interface MakeCliOptions extends FakePrompterOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * A CLI context that never touches the real home directory: the profile lives in a temp file, and `dbPath` is a
 * fresh temp SQLite path for embedded-mode tests (pass it with --db).
 */
export function makeCli(options: MakeCliOptions = {}) {
  const profileFile = tempPath('gtr-cli-profile', '.json');
  const dbPath = tempPath('gtr-cli');
  let stdout = '';
  let stderr = '';
  const prompter = fakePrompter(options);
  const ctx: CliContext = {
    env: { GTR_PROFILE_PATH: profileFile, ...options.env },
    io: { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } },
    prompter,
    fetchImpl: options.fetchImpl,
  };
  return {
    ctx,
    prompter,
    profileFile,
    dbPath,
    run: (argv: string[]) => runCli(argv, ctx),
    stdout: () => stdout,
    stderr: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
    cleanup: () => {
      fs.rmSync(profileFile, { force: true });
      removeDb(dbPath);
    },
  };
}
```

`apps/cli/test/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createTtyPrompter } from '../src/prompt';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe('createTtyPrompter', () => {
  it('reports interactivity from input.isTTY', () => {
    const { input, output } = streams();
    expect(createTtyPrompter(input, output).isInteractive()).toBe(false);
    expect(createTtyPrompter(Object.assign(input, { isTTY: true }), output).isInteractive()).toBe(true);
  });

  it('asks a question and trims the answer', async () => {
    const { input, output, written } = streams();
    const answer = createTtyPrompter(input, output).ask('Username: ');
    input.write('  admin  \n');
    expect(await answer).toBe('admin');
    expect(written()).toContain('Username: ');
  });

  it('does not echo a hidden answer', async () => {
    const { input, output, written } = streams();
    const answer = createTtyPrompter(input, output).askHidden('Password: ');
    input.write('s3cret-value\n');
    expect(await answer).toBe('s3cret-value');
    expect(written()).toContain('Password: ');
    expect(written()).not.toContain('s3cret-value');
  });

  it('confirms only on y or yes', async () => {
    for (const [typed, expected] of [['y', true], ['YES', true], ['', false], ['n', false]] as const) {
      const { input, output } = streams();
      const answer = createTtyPrompter(input, output).confirm('Delete?');
      input.write(`${typed}\n`);
      expect(await answer).toBe(expected);
    }
  });
});
```

`apps/cli/test/authCommands.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/prompt.test.ts apps/cli/test/authCommands.test.ts`
Expected: `prompt.test.ts` PASS (the module exists); `authCommands.test.ts` FAIL, since `../src/commands/auth` doesn't exist.

- [ ] **Step 4: Implement the auth commands**

`apps/cli/src/commands/auth.ts`:

```ts
import fs from 'node:fs';
import type { Command } from 'commander';
import { action, resolveSecret, resolveText, type CliContext, type Runtime } from '../runtime';
import { usageError } from '../errors';
import { normalizeServerUrl, type ModeSource } from '../mode';
import { readProfile, writeProfile, deleteProfile, type Profile } from '../profile';
import { RemoteClient } from '../client/remote';
import type { ClientStatus } from '../client/types';

type StatusView =
  | { mode: 'embedded'; dbPath: string; exists: boolean; adminUsers?: number }
  | Extract<ClientStatus, { mode: 'remote' }>;

function loginTarget(rt: Runtime): { server: string; source: ModeSource } {
  if (rt.globals.server !== undefined) return { server: normalizeServerUrl(rt.globals.server), source: '--server' };
  if (rt.ctx.env.GTR_SERVER) return { server: normalizeServerUrl(rt.ctx.env.GTR_SERVER), source: 'GTR_SERVER' };
  const profile = readProfile(rt.profileFile);
  if (profile) return { server: normalizeServerUrl(profile.server), source: 'profile' };
  throw usageError('No server to log in to: run "gtr login --server <url>"');
}

function renderStatus(view: StatusView): string {
  if (view.mode === 'embedded') {
    const lines = ['mode: embedded', `database: ${view.dbPath} (${view.exists ? 'exists' : 'not created yet'})`];
    if (view.adminUsers !== undefined) lines.push(`admin users: ${view.adminUsers}`);
    return lines.join('\n');
  }
  const session =
    view.session === 'not-logged-in'
      ? `not logged in (run "gtr login --server ${view.server}")`
      : view.session === 'expired'
        ? `expired or revoked (run "gtr login --server ${view.server}")`
        : `logged in as ${view.session.username} until ${view.session.expiresAt}`;
  return ['mode: remote', `server: ${view.server} (via ${view.source})`, `session: ${session}`].join('\n');
}

export function registerAuthCommands(program: Command, ctx: CliContext): void {
  program
    .command('login')
    .description('log in to a GraphToRest server and save the session for later commands')
    .option('--username <name>', 'admin username (prompted on a terminal when omitted)')
    .action(
      action(ctx, async (rt, opts: { username?: string }) => {
        const { server, source } = loginTarget(rt);
        const username = await resolveText(rt, opts.username, 'Username: ', 'Provide --username');
        const password = await resolveSecret(rt, {
          envVar: 'GTR_ADMIN_PASSWORD',
          prompt: 'Password: ',
          missing: 'Provide the password with the GTR_ADMIN_PASSWORD environment variable, or run in a terminal to be prompted',
        });
        const session = await RemoteClient.login({ server, source, fetchImpl: ctx.fetchImpl }, username, password);
        writeProfile(rt.profileFile, { server, username, token: session.token, expiresAt: session.expiresAt });
        rt.out.result(
          { server, username, expiresAt: session.expiresAt },
          (r) => `Logged in to ${r.server} as ${r.username} (session expires ${r.expiresAt}).`
        );
      })
    );

  program
    .command('logout')
    .description('end the saved session and delete the local profile')
    .action(
      action(ctx, async (rt) => {
        let profile: Profile | null = null;
        try {
          profile = readProfile(rt.profileFile);
        } catch {
          // A malformed profile is still deleted below.
        }
        if (profile) {
          try {
            await new RemoteClient({ server: profile.server, token: profile.token, source: 'profile', fetchImpl: ctx.fetchImpl }).logout();
          } catch {
            // Best effort: an expired session or an unreachable server must not keep the local token around.
          }
        }
        const removed = deleteProfile(rt.profileFile);
        rt.out.done(removed ? (profile ? `Logged out of ${profile.server}.` : 'Removed the local CLI profile.') : 'Not logged in.');
      })
    );

  program
    .command('status')
    .description('show which mode gtr uses, and the database or session it would use')
    .action(
      action(ctx, async (rt) => {
        const mode = rt.mode();
        if (mode.kind === 'embedded' && !fs.existsSync(mode.dbPath)) {
          rt.out.result<StatusView>({ mode: 'embedded', dbPath: mode.dbPath, exists: false }, renderStatus);
          return;
        }
        const status = await rt.client().describe();
        const view: StatusView = status.mode === 'embedded' ? { ...status, exists: true } : status;
        rt.out.result(view, renderStatus);
      })
    );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/prompt.test.ts apps/cli/test/authCommands.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/prompt.ts apps/cli/src/runtime.ts apps/cli/src/program.ts apps/cli/src/commands/auth.ts apps/cli/test
git commit -m "feat(cli): add the nested command program with login, logout and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Connection commands

**Files:**
- Create: `apps/cli/src/client/resolve.ts`, `apps/cli/src/commands/connection.ts`, `apps/cli/test/connectionCommands.test.ts`
- Modify: `apps/cli/src/program.ts` (register the commands)

**Interfaces:**
- Consumes: `action`, `requireMode`, `confirmOrRefuse`, `parseJsonObject`, `Runtime` (Task 5); `GtrClient` (Task 3); `CliError`, `toCliError`, `usageError` (Task 1); `table` (Task 1).
- Produces:
  - `resolveConnection(client: GtrClient, ref: string): Promise<ConnectionRecord>` (id match first, then name; otherwise `NOT_FOUND`)
  - `registerConnectionCommands(program: Command, ctx: CliContext): void`

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/connectionCommands.test.ts`:

```ts
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

  it('sets credentials from a file, reports status and clears them', async () => {
    const c = cli();
    await createConnection(c, 'm', 'managed');
    const file = tempPath('gtr-creds', '.json');
    files.push(file);
    fs.writeFileSync(file, JSON.stringify({ grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 't' }));

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/connectionCommands.test.ts`
Expected: FAIL, `../src/client/resolve` not found.

- [ ] **Step 3: Implement**

`apps/cli/src/client/resolve.ts`:

```ts
import { CliError } from '../errors';
import type { GtrClient, ConnectionRecord } from './types';

/** Accepts an id or a unique name. An exact id match always wins over a name match. */
export async function resolveConnection(client: GtrClient, ref: string): Promise<ConnectionRecord> {
  const connections = await client.listConnections();
  const match = connections.find((c) => c.id === ref) ?? connections.find((c) => c.name === ref);
  if (!match) throw new CliError('NOT_FOUND', `No connection with id or name "${ref}"`);
  return match;
}
```

`apps/cli/src/commands/connection.ts`:

```ts
import fs from 'node:fs';
import type { Command } from 'commander';
import { action, requireMode, confirmOrRefuse, parseJsonObject, type CliContext } from '../runtime';
import { CliError, toCliError, usageError } from '../errors';
import { table } from '../output';
import { resolveConnection } from '../client/resolve';
import type { ConnectionRecord, CredentialStatus } from '../client/types';

type CredentialView = CredentialStatus | { unavailable: string };

export function describeCredentials(status: CredentialView): string {
  if ('unavailable' in status) return `unavailable (${status.unavailable})`;
  if (!status.configured) return 'not configured';
  return `configured (grant: ${status.grant}, refresh token: ${status.hasRefreshToken ? 'yes' : 'no'})`;
}

function readCredentials(opts: { credentials?: string; credentialsFile?: string }): unknown {
  if (Boolean(opts.credentials) === Boolean(opts.credentialsFile)) {
    throw usageError('Provide exactly one of --credentials or --credentials-file');
  }
  let raw: string;
  try {
    raw = opts.credentials ?? fs.readFileSync(opts.credentialsFile!, 'utf8');
  } catch (err) {
    throw new CliError('FILE_ERROR', `Cannot read ${opts.credentialsFile}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Deliberately generic: a JSON.parse message can quote a fragment of the secret-bearing input.
    throw usageError('Credentials are not valid JSON');
  }
}

export function registerConnectionCommands(program: Command, ctx: CliContext): void {
  const connection = program.command('connection').description('manage vendor connections');

  connection
    .command('create')
    .description('create a connection')
    .requiredOption('--name <name>')
    .requiredOption('--adapter-type <type>', 'see "gtr adapters"')
    .requiredOption('--auth-mode <mode>', 'passthrough or managed')
    .option('--config <json>', 'JSON adapter config, e.g. {"endpoint":"https://api.example.com/graphql"}')
    .action(
      action(ctx, async (rt, opts: { name: string; adapterType: string; authMode: string; config?: string }) => {
        const created = await rt.client().createConnection({
          name: opts.name,
          adapterType: opts.adapterType,
          authMode: opts.authMode,
          config: opts.config === undefined ? undefined : parseJsonObject(opts.config, '--config'),
        });
        rt.out.result(created, (c) => `Created connection ${c.name} (${c.id}).`);
      })
    );

  connection
    .command('list')
    .description('list connections')
    .action(
      action(ctx, async (rt) => {
        const connections = await rt.client().listConnections();
        rt.out.result(connections, (list) =>
          list.length === 0
            ? 'No connections.'
            : table(['ID', 'NAME', 'ADAPTER', 'AUTH MODE'], list.map((c) => [c.id, c.name, c.adapterType, c.authMode]))
        );
      })
    );

  connection
    .command('show <conn>')
    .description('show one connection (id or name), including credential status for managed connections')
    .action(
      action(ctx, async (rt, ref: string) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        let credentials: CredentialView | undefined;
        if (found.authMode === 'managed') {
          try {
            credentials = await client.getCredentialStatus(found.id);
          } catch (err) {
            const cliError = toCliError(err);
            if (cliError.code !== 'MANAGED_AUTH_DISABLED') throw cliError;
            credentials = { unavailable: cliError.message };
          }
        }
        rt.out.result({ ...found, ...(credentials ? { credentials } : {}) }, (c: ConnectionRecord & { credentials?: CredentialView }) =>
          [
            `id: ${c.id}`,
            `name: ${c.name}`,
            `adapter: ${c.adapterType}`,
            `auth mode: ${c.authMode}`,
            `config: ${c.config ? JSON.stringify(c.config) : '-'}`,
            ...(c.credentials ? [`credentials: ${describeCredentials(c.credentials)}`] : []),
          ].join('\n')
        );
      })
    );

  connection
    .command('delete <conn>')
    .description('delete a connection and all of its mappings')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, ref: string, opts: { yes?: boolean }) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        if (!(await confirmOrRefuse(rt, opts.yes, `Delete connection "${found.name}" (${found.id}) and all of its mappings?`))) return;
        await client.deleteConnection(found.id);
        rt.out.done(`Deleted connection ${found.name} (${found.id}).`);
      })
    );

  const credentials = connection.command('credentials').description('manage stored credentials of a managed connection');

  credentials
    .command('set <conn>')
    .description('store vendor app credentials (encrypted at rest)')
    .option('--credentials-file <path>', 'JSON file holding the credentials object (recommended)')
    .option('--credentials <json>', 'credentials JSON (visible in shell history; prefer --credentials-file)')
    .action(
      action(ctx, async (rt, ref: string, opts: { credentials?: string; credentialsFile?: string }) => {
        const payload = readCredentials(opts);
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const status = await client.setCredentials(found.id, payload);
        rt.out.result(status, (s) => `Stored credentials for ${found.name}: ${describeCredentials(s)}.`);
      })
    );

  credentials
    .command('status <conn>')
    .description('show whether credentials are stored (never the secrets)')
    .action(
      action(ctx, async (rt, ref: string) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const status = await client.getCredentialStatus(found.id);
        rt.out.result(status, (s) => `${found.name}: ${describeCredentials(s)}`);
      })
    );

  credentials
    .command('clear <conn>')
    .description('delete stored credentials and cached tokens')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, ref: string, opts: { yes?: boolean }) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        if (!(await confirmOrRefuse(rt, opts.yes, `Clear stored credentials for "${found.name}"?`))) return;
        await client.clearCredentials(found.id);
        rt.out.done(`Cleared credentials for ${found.name}.`);
      })
    );

  connection
    .command('authorize <conn>')
    .description('start the OAuth authorization-code flow (remote mode only)')
    .action(
      action(ctx, async (rt, ref: string) => {
        requireMode(
          rt,
          'remote',
          '"connection authorize" needs remote mode: the vendor redirects to a running server\'s /admin/oauth/callback. Run "gtr login --server <url>" first.'
        );
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const { authorizationUrl } = await client.startAuthorization(found.id);
        rt.out.result({ authorizationUrl }, (r) => `Open this URL in a browser to authorize "${found.name}":\n${r.authorizationUrl}`);
      })
    );
}
```

In `apps/cli/src/program.ts` add `import { registerConnectionCommands } from './commands/connection';` and call `registerConnectionCommands(program, ctx);` after `registerAuthCommands`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/connectionCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/client/resolve.ts apps/cli/src/commands/connection.ts apps/cli/src/program.ts apps/cli/test/connectionCommands.test.ts
git commit -m "feat(cli): add gtr connection create/list/show/delete/credentials/authorize

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mapping commands

**Files:**
- Create: `apps/cli/src/commands/mapping.ts`, `apps/cli/test/mappingCommands.test.ts`
- Modify: `apps/cli/src/program.ts` (register the commands)
- Delete: `apps/cli/test/carryOvers.test.ts` (its export-file test is ported below)

**Interfaces:**
- Consumes: Task 5 runtime helpers, `resolveConnection` (Task 6), `parseRouteString` from `@graphtorest/core`.
- Produces: `registerMappingCommands(program: Command, ctx: CliContext): void`, `writeFileAtomic(file: string, text: string): void`

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/mappingCommands.test.ts`:

```ts
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
    expect(listed.stdout).toMatch(/^ID\s+METHOD\s+ROUTE\s+CONNECTION\s+SOURCE\n\S+\s+GET\s+\/users\/\{id\}\s+c1\s+manual\n$/);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/mappingCommands.test.ts`
Expected: FAIL with exit 2 "unknown command 'mapping'".

- [ ] **Step 3: Implement**

`apps/cli/src/commands/mapping.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parseRouteString } from '@graphtorest/core';
import { action, confirmOrRefuse, parseJsonObject, type CliContext } from '../runtime';
import { CliError, usageError } from '../errors';
import { table } from '../output';
import { resolveConnection } from '../client/resolve';
import type { MappingPatch } from '../client/types';

function parseRoute(text: string): { method: string; route: string } {
  try {
    return parseRouteString(text);
  } catch (err) {
    throw usageError((err as Error).message);
  }
}

/** A JSON object of strings, or the literal null (clears the template). */
function parseTemplate(text: string): Record<string, string> | null {
  if (text.trim() === 'null') return null;
  return parseJsonObject(text, '--response-template') as Record<string, string>;
}

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('FILE_ERROR', `Cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
}

export function registerMappingCommands(program: Command, ctx: CliContext): void {
  const mapping = program.command('mapping').description('manage REST route mappings');

  mapping
    .command('create')
    .description('create a manual mapping')
    .requiredOption('--connection <conn>', 'connection id or name')
    .requiredOption('--route <route>', 'e.g. "GET /users/{id}"')
    .requiredOption('--operation <json>', 'JSON operation object')
    .option('--response-template <json>', 'JSON map of output field to JSONPath')
    .action(
      action(ctx, async (rt, opts: { connection: string; route: string; operation: string; responseTemplate?: string }) => {
        const { method, route } = parseRoute(opts.route);
        const operation = parseJsonObject(opts.operation, '--operation');
        const responseTemplate = opts.responseTemplate === undefined ? undefined : parseTemplate(opts.responseTemplate);
        const client = rt.client();
        const connection = await resolveConnection(client, opts.connection);
        const created = await client.createMapping({ connectionId: connection.id, method, route, operation, responseTemplate });
        rt.out.result(created, (m) => `Created mapping ${m.method} ${m.route} (${m.id}).`);
      })
    );

  mapping
    .command('list')
    .description('list mappings')
    .option('--connection <conn>', 'only this connection (id or name)')
    .action(
      action(ctx, async (rt, opts: { connection?: string }) => {
        const client = rt.client();
        const connections = await client.listConnections();
        const only = opts.connection === undefined ? undefined : await resolveConnection(client, opts.connection);
        const mappings = (await client.listMappings()).filter((m) => !only || m.connectionId === only.id);
        const names = new Map(connections.map((c) => [c.id, c.name]));
        rt.out.result(mappings, (list) =>
          list.length === 0
            ? 'No mappings.'
            : table(
                ['ID', 'METHOD', 'ROUTE', 'CONNECTION', 'SOURCE'],
                list.map((m) => [m.id, m.method, m.route, names.get(m.connectionId) ?? m.connectionId, m.source])
              )
        );
      })
    );

  mapping
    .command('update <id>')
    .description('edit a mapping (it becomes source=manual)')
    .option('--route <route>', 'e.g. "GET /users/{id}"')
    .option('--operation <json>', 'JSON operation object')
    .option('--response-template <json>', 'JSON map of output field to JSONPath, or null to clear')
    .action(
      action(ctx, async (rt, id: string, opts: { route?: string; operation?: string; responseTemplate?: string }) => {
        const patch: MappingPatch = {};
        if (opts.route !== undefined) Object.assign(patch, parseRoute(opts.route));
        if (opts.operation !== undefined) patch.operation = parseJsonObject(opts.operation, '--operation');
        if (opts.responseTemplate !== undefined) patch.responseTemplate = parseTemplate(opts.responseTemplate);
        const updated = await rt.client().updateMapping(id, patch);
        rt.out.result(updated, (m) => `Updated mapping ${m.method} ${m.route} (${m.id}); source is now manual.`);
      })
    );

  mapping
    .command('delete <id>')
    .description('delete a mapping')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, id: string, opts: { yes?: boolean }) => {
        if (!(await confirmOrRefuse(rt, opts.yes, `Delete mapping ${id}?`))) return;
        await rt.client().deleteMapping(id);
        rt.out.done(`Deleted mapping ${id}.`);
      })
    );

  mapping
    .command('generate')
    .description("generate mappings from the connection's schema")
    .requiredOption('--connection <conn>', 'connection id or name')
    .option('--force', 'also overwrite manual mappings')
    .option('--vendor-token <token>', 'vendor access token for passthrough connections')
    .action(
      action(ctx, async (rt, opts: { connection: string; force?: boolean; vendorToken?: string }) => {
        const client = rt.client();
        const connection = await resolveConnection(client, opts.connection);
        const result = await client.generateMappings(connection.id, { force: opts.force === true, vendorToken: opts.vendorToken });
        rt.out.result(result, (r) =>
          [
            `Generated mappings for ${connection.name}: ${r.created.length} created, ${r.updated.length} updated, ${r.skipped.length} skipped, ${r.conflicts.length} conflicts.`,
            ...r.conflicts.map((d) => `  conflict: ${d.method} ${d.route}`),
            ...(r.skipped.length > 0 && !opts.force ? ['  (skipped mappings are manual; use --force to overwrite them)'] : []),
          ].join('\n')
        );
      })
    );

  mapping
    .command('export')
    .description('export mappings as YAML (stdout, or --out FILE)')
    .option('--connection <conn>', 'only this connection (id or name)')
    .option('--out <file>', 'write to this file instead of stdout')
    .action(
      action(ctx, async (rt, opts: { connection?: string; out?: string }) => {
        const client = rt.client();
        const connectionId = opts.connection === undefined ? undefined : (await resolveConnection(client, opts.connection)).id;
        const yaml = await client.exportMappings({ connectionId });
        if (opts.out === undefined) {
          rt.out.raw(yaml);
          return;
        }
        writeFileAtomic(opts.out, yaml);
        rt.out.result({ file: opts.out }, (r) => `Wrote mappings to ${r.file}.`);
      })
    );

  mapping
    .command('import <file>')
    .description('import mappings from a YAML file (all-or-nothing)')
    .action(
      action(ctx, async (rt, file: string) => {
        const result = await rt.client().importMappings(readTextFile(file));
        if (!rt.out.json) for (const warning of result.warnings) rt.out.warn(`warning: ${warning}`);
        rt.out.result(result, (r) => `Imported ${r.imported} mapping(s).`);
      })
    );
}
```

In `apps/cli/src/program.ts` add `import { registerMappingCommands } from './commands/mapping';` and call `registerMappingCommands(program, ctx);`.

Then delete the old carry-over test, which is now fully ported:

```bash
git rm apps/cli/test/carryOvers.test.ts
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/mappingCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/mapping.ts apps/cli/src/program.ts apps/cli/test
git commit -m "feat(cli): add gtr mapping create/list/update/delete/generate/export/import

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API key, admin, adapters and activity commands

**Files:**
- Create: `apps/cli/src/commands/apikey.ts`, `apps/cli/src/commands/admin.ts`, `apps/cli/src/commands/misc.ts`, `apps/cli/test/otherCommands.test.ts`
- Modify: `apps/cli/src/program.ts` (register all three)

**Interfaces:**
- Consumes: Task 5 runtime helpers, `table`.
- Produces: `registerApiKeyCommands`, `registerAdminCommands`, `registerMiscCommands`, each `(program: Command, ctx: CliContext) => void`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/otherCommands.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
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
    const json = await run(c, ['apikey', 'create', '--json']);
    expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(['id', 'label', 'plaintext']);
  });

  it('lists keys and revokes one', async () => {
    const c = cli();
    const key = JSON.parse((await run(c, ['apikey', 'create', '--label', 'ci', '--json'])).stdout);
    const listed = await run(c, ['apikey', 'list']);
    expect(listed.stdout).toMatch(new RegExp(`^ID\\s+LABEL\\s+CREATED\\s+LAST USED\\n${key.id}\\s+ci\\s+\\S.*\\s+never\\n$`));
    expect((await run(c, ['apikey', 'revoke', key.id, '--yes'])).stdout).toBe(`Revoked API key ${key.id}.\n`);
    expect((await run(c, ['apikey', 'list'])).stdout).toBe('No API keys.\n');
    expect((await run(c, ['apikey', 'revoke', key.id, '--yes'])).code).toBe(4);
  });
});

describe('gtr admin', () => {
  it('creates an admin from GTR_ADMIN_PASSWORD, and fails with exit 2 without any password source', async () => {
    const c = cli({ env: { GTR_ADMIN_PASSWORD: 'correct-horse-battery' } });
    expect(await run(c, ['admin', 'create', '--username', 'ops'])).toMatchObject({ code: 0, stdout: 'Created admin user ops.\n' });
    expect(withStore(c.dbPath, (store) => loginAdmin(store, 'ops', 'correct-horse-battery'))).not.toBeNull();

    const bare = cli();
    const failed = await run(bare, ['admin', 'create', '--username', 'ops']);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toMatch(/--password, GTR_ADMIN_PASSWORD/);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/test/otherCommands.test.ts`
Expected: FAIL with unknown commands (exit 2).

- [ ] **Step 3: Implement**

`apps/cli/src/commands/apikey.ts`:

```ts
import type { Command } from 'commander';
import { action, confirmOrRefuse, type CliContext } from '../runtime';
import { table } from '../output';

export function registerApiKeyCommands(program: Command, ctx: CliContext): void {
  const apikey = program.command('apikey').description('manage developer API keys for /api/*');

  apikey
    .command('create')
    .description('create an API key (the plaintext is shown only once)')
    .option('--label <label>')
    .action(
      action(ctx, async (rt, opts: { label?: string }) => {
        const created = await rt.client().createApiKey({ label: opts.label });
        rt.out.result(created, (k) => `Created API key ${k.id}${k.label ? ` (${k.label})` : ''}:\n${k.plaintext}`);
        rt.out.warn('Store this key now; it cannot be shown again.');
      })
    );

  apikey
    .command('list')
    .description('list API keys (never the secrets)')
    .action(
      action(ctx, async (rt) => {
        const keys = await rt.client().listApiKeys();
        rt.out.result(keys, (list) =>
          list.length === 0
            ? 'No API keys.'
            : table(['ID', 'LABEL', 'CREATED', 'LAST USED'], list.map((k) => [k.id, k.label ?? '-', k.createdAt, k.lastUsedAt ?? 'never']))
        );
      })
    );

  apikey
    .command('revoke <id>')
    .description('revoke an API key')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, id: string, opts: { yes?: boolean }) => {
        if (!(await confirmOrRefuse(rt, opts.yes, `Revoke API key ${id}?`))) return;
        await rt.client().revokeApiKey(id);
        rt.out.done(`Revoked API key ${id}.`);
      })
    );
}
```

`apps/cli/src/commands/admin.ts`:

```ts
import type { Command } from 'commander';
import { action, requireMode, resolveSecret, type CliContext, type Runtime } from '../runtime';

function password(rt: Runtime, value: string | undefined, username: string): Promise<string> {
  return resolveSecret(rt, {
    value,
    envVar: 'GTR_ADMIN_PASSWORD',
    prompt: `Password for ${username}: `,
    missing: 'Provide a password with --password, GTR_ADMIN_PASSWORD, or run in a terminal to be prompted (12+ characters)',
  });
}

export function registerAdminCommands(program: Command, ctx: CliContext): void {
  const admin = program.command('admin').description('manage admin users (web UI and remote CLI logins)');

  admin
    .command('create')
    .description('create an admin user (in embedded mode this is the first-run bootstrap)')
    .requiredOption('--username <name>')
    .option('--password <password>', 'visible in shell history; prefer GTR_ADMIN_PASSWORD or the prompt')
    .action(
      action(ctx, async (rt, opts: { username: string; password?: string }) => {
        const user = await rt.client().createAdminUser({ username: opts.username, password: await password(rt, opts.password, opts.username) });
        rt.out.result(user, (u) => `Created admin user ${u.username}.`);
      })
    );

  admin
    .command('set-password')
    .description('reset an admin password and revoke their sessions (embedded mode only)')
    .requiredOption('--username <name>')
    .option('--password <password>', 'visible in shell history; prefer GTR_ADMIN_PASSWORD or the prompt')
    .action(
      action(ctx, async (rt, opts: { username: string; password?: string }) => {
        requireMode(
          rt,
          'embedded',
          '"admin set-password" is embedded-only (lockout recovery): run it where the SQLite file is, without --server/GTR_SERVER and after "gtr logout"'
        );
        await rt.client().setAdminPassword({ username: opts.username, password: await password(rt, opts.password, opts.username) });
        rt.out.result({ username: opts.username, passwordUpdated: true }, (r) => `Password updated for ${r.username}.`);
      })
    );
}
```

`apps/cli/src/commands/misc.ts`:

```ts
import type { Command } from 'commander';
import { action, type CliContext } from '../runtime';
import { usageError } from '../errors';
import { table } from '../output';

function positiveInt(flag: string) {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) throw usageError(`${flag} must be a positive integer`);
    return Number(value);
  };
}

export function registerMiscCommands(program: Command, ctx: CliContext): void {
  program
    .command('adapters')
    .description('list the adapter types connections can use')
    .action(
      action(ctx, async (rt) => {
        const adapters = await rt.client().listAdapters();
        rt.out.result(adapters, (list) => list.join('\n'));
      })
    );

  program
    .command('activity')
    .description('show recent /api/* requests, newest first')
    .option('--limit <n>', 'rows per page (1-200, default 50)', positiveInt('--limit'))
    .option('--before <id>', 'show rows older than this row id', positiveInt('--before'))
    .action(
      action(ctx, async (rt, opts: { limit?: number; before?: number }) => {
        const page = await rt.client().listActivity({ limit: opts.limit, before: opts.before });
        rt.out.result(page, (p) => {
          if (p.items.length === 0) return 'No activity.';
          const rows = p.items.map((r) => [r.ts, String(r.status), r.method, r.path, `${r.durationMs}ms`]);
          const lines = [table(['TIME', 'STATUS', 'METHOD', 'PATH', 'LATENCY'], rows)];
          if (p.nextBefore !== null) lines.push(`More: gtr activity${opts.limit ? ` --limit ${opts.limit}` : ''} --before ${p.nextBefore}`);
          return lines.join('\n');
        });
      })
    );
}
```

A usage error thrown from a commander option parser propagates out of `parseAsync` as that `CliError` (exit 2), not as a `CommanderError`, so `runCli` reports it as `error: --limit must be a positive integer`.

In `apps/cli/src/program.ts` add the three imports and calls:

```ts
import { registerApiKeyCommands } from './commands/apikey';
import { registerAdminCommands } from './commands/admin';
import { registerMiscCommands } from './commands/misc';
// …inside buildProgram, after registerMappingCommands:
registerApiKeyCommands(program, ctx);
registerAdminCommands(program, ctx);
registerMiscCommands(program, ctx);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/test/otherCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands apps/cli/src/program.ts apps/cli/test
git commit -m "feat(cli): add gtr apikey, admin, adapters and activity commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Switch the entry point, remove the flat commands, and update the docs

**Files:**
- Rewrite: `apps/cli/src/index.ts`
- Delete: `apps/cli/src/embeddedClient.ts`, `apps/cli/src/commands/adminCreate.ts`, `apiKeyCreate.ts`, `connectionCreate.ts`, `connectionCredentialsSet.ts`, `mappingCreate.ts`, `mappingExport.ts`, `mappingGenerate.ts`, `mappingImport.ts`, `mappingUpdate.ts`
- Create: `apps/cli/test/bin.smoke.test.ts`, `apps/cli/README.md`
- Modify: `docker-compose.yml:5`, `apps/server/src/index.ts:55`, `apps/web/src/pages/LoginPage.tsx:45`, `apps/web/test/login.test.tsx:26`, `apps/web/src/pages/ConnectionsPage.tsx:125`, `packages/core/src/mappingEngine/mappingYaml.ts:17`

**Interfaces:**
- Consumes: `runCli`, `createTtyPrompter`.

- [ ] **Step 1: Write the failing smoke test**

`apps/cli/test/bin.smoke.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempPath, removeDb } from './helpers/harness';

const cliDir = path.resolve(__dirname, '..');
const bin = path.join(cliDir, 'bin', 'gtr.js');
const dbPath = tempPath('gtr-smoke');
const profile = tempPath('gtr-smoke-profile', '.json');

function gtr(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GTR_PROFILE_PATH: profile, DB_PATH: dbPath },
  });
}

beforeAll(() => {
  execFileSync('npx', ['tsc', '-p', cliDir], { stdio: 'inherit' });
}, 120_000);

afterAll(() => {
  removeDb(dbPath);
  fs.rmSync(profile, { force: true });
});

describe('gtr binary', () => {
  it('runs status in embedded mode and exits 0', () => {
    const result = gtr(['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mode: embedded');
  });

  it('exits 2 for an unknown command', () => {
    expect(gtr(['connection-create']).status).toBe(2);
  });

  it('round-trips a connection through the real binary', () => {
    expect(gtr(['connection', 'create', '--name', 'smoke', '--adapter-type', 'mock', '--auth-mode', 'passthrough']).status).toBe(0);
    const listed = gtr(['connection', 'list', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: 'smoke' })]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/cli/test/bin.smoke.test.ts`
Expected: FAIL. `connection-create` still exists (exit ≠ 2) and `status` is unknown.

- [ ] **Step 3: Rewrite the entry point and delete the old modules**

`apps/cli/src/index.ts`:

```ts
#!/usr/bin/env node
import { runCli } from './program';
import { createTtyPrompter } from './prompt';

runCli(process.argv.slice(2), {
  env: process.env,
  io: { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  prompter: createTtyPrompter(),
}).then((code) => {
  process.exitCode = code;
});
```

```bash
git rm apps/cli/src/embeddedClient.ts apps/cli/src/commands/adminCreate.ts apps/cli/src/commands/apiKeyCreate.ts \
  apps/cli/src/commands/connectionCreate.ts apps/cli/src/commands/connectionCredentialsSet.ts apps/cli/src/commands/mappingCreate.ts \
  apps/cli/src/commands/mappingExport.ts apps/cli/src/commands/mappingGenerate.ts apps/cli/src/commands/mappingImport.ts \
  apps/cli/src/commands/mappingUpdate.ts
rm -rf apps/cli/dist
```

Run: `grep -rn "embeddedClient\|commands/\(adminCreate\|apiKeyCreate\|connectionCreate\|connectionCredentialsSet\|mapping\(Create\|Export\|Generate\|Import\|Update\)\)" apps/cli/src apps/cli/test`
Expected: no output.

- [ ] **Step 4: Run the smoke test and the whole CLI suite**

Run: `npx vitest run apps/cli`
Expected: PASS (all CLI test files).

- [ ] **Step 5: Update flat-name references elsewhere**

- `docker-compose.yml` line 5: `…--entrypoint gtr graphtorest admin-create --username admin` becomes `…--entrypoint gtr graphtorest admin create --username admin`.
- `apps/server/src/index.ts` line 55: `Create one with: gtr admin-create --username <name>` becomes `Create one with: gtr admin create --username <name>`.
- `apps/web/src/pages/LoginPage.tsx` line 45: `<code>gtr admin-create --username &lt;name&gt;</code>` becomes `<code>gtr admin create --username &lt;name&gt;</code>`.
- `apps/web/test/login.test.tsx` line 26: `/gtr admin-create/` becomes `/gtr admin create/`.
- `apps/web/src/pages/ConnectionsPage.tsx` line 125: `<code>gtr mapping-export</code>` becomes `<code>gtr mapping export</code>`.
- `packages/core/src/mappingEngine/mappingYaml.ts` line 17: `` `gtr mapping-export` `` becomes `` `gtr mapping export` ``.

Run: `grep -rnE "gtr [a-z]+-[a-z]+|admin-create|mapping-export|connection-create|apikey-create" --include=*.ts --include=*.tsx --include=*.yml --include=Dockerfile . | grep -v node_modules | grep -v /dist/ | grep -v docs/superpowers`
Expected: only `gtr admin set-password` style hits (a space before the hyphenated verb); no flat command names.

- [ ] **Step 6: Write the CLI README**

`apps/cli/README.md`:

````markdown
# gtr — GraphToRest CLI

`gtr` manages connections, mappings, API keys and admin users. It runs in one of two modes.

## Modes

| Mode | When | Talks to |
|---|---|---|
| **remote** | `--server URL`, `GTR_SERVER`, or a saved `gtr login` profile | a running server's `/admin/*` API |
| **embedded** | none of the above | the SQLite file directly (`--db`, else `$DB_PATH`, else `./data/graphtorest.db`) |

`gtr status` shows which mode applies and why. A configured server that can't be reached is an error; `gtr` never silently falls back to a local file. `--db` together with remote mode is rejected.

## Remote mode

```sh
gtr login --server https://gtr.example.com --username admin   # prompts for the password
gtr connection list
gtr logout
```

The session is saved to `~/.config/graphtorest/cli.json` (mode 0600; `$XDG_CONFIG_HOME` and `GTR_PROFILE_PATH` are honored). For CI, set `GTR_SERVER` and `GTR_TOKEN` instead of logging in. `GTR_ADMIN_PASSWORD` supplies the login password without a prompt.

## Embedded mode (no server needed)

```sh
docker compose run --rm -e GTR_ADMIN_PASSWORD --entrypoint gtr graphtorest admin create --username admin
gtr --db ./data/graphtorest.db mapping export --out mappings.yaml
```

Managed-connection commands need `CREDENTIAL_ENCRYPTION_KEY` in the environment, the same key the server uses.

## Commands

```
gtr login | logout | status
gtr connection create | list | show <conn> | delete <conn>
gtr connection credentials set | status | clear <conn>
gtr connection authorize <conn>                (remote only)
gtr mapping create | list | update <id> | delete <id> | generate | export | import <file>
gtr apikey create | list | revoke <id>
gtr admin create | set-password                (set-password: embedded only)
gtr adapters
gtr activity [--limit N] [--before ID]
```

`<conn>` is a connection id or name. Add `--json` to any command for machine-readable output. Destructive commands ask for confirmation on a terminal; pass `--yes` in scripts.

Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 not found, 5 conflict. Set `GTR_DEBUG=1` for stack traces.
````

- [ ] **Step 7: Full verification**

Run: `npm run build && npm test`
Expected: the workspace build succeeds and every test passes (server, web, core, cli). Report the final test count.

Run: `node apps/cli/bin/gtr.js --help`
Expected: lists `login`, `logout`, `status`, `connection`, `mapping`, `apikey`, `admin`, `adapters`, `activity` and no flat names.

- [ ] **Step 8: Commit**

```bash
git add -A apps/cli docker-compose.yml apps/server/src/index.ts apps/web/src/pages/LoginPage.tsx apps/web/test/login.test.tsx \
  apps/web/src/pages/ConnectionsPage.tsx packages/core/src/mappingEngine/mappingYaml.ts
git commit -m "feat(cli)!: switch gtr to nested commands with remote mode and remove the flat command names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

# GraphToRest Plan 8 — Rate Limiting, Caching, Observability, Deployment & Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GraphToRest deployable as a v1: per-key rate limiting, optional per-mapping response caching, structured stdout logs, security hardening (login throttling, async scrypt, timeouts, redaction, SSRF guard, graceful shutdown), a slim non-root Docker image with `/healthz`, env-var admin bootstrap, and a clean `npm audit`.

**Architecture:** New pure units live in `packages/core` (`logging/`, `net/`, `rateLimit/`, `gateway/ResponseCache.ts`, `gateway/redact.ts`) and are wired into `apps/server` through `createApp`'s `AppDeps` and small new middleware files; `apps/server/src/index.ts` owns process lifecycle (config, bootstrap, shutdown). The outbound network policy is a module-level singleton in core (same pattern as the adapter registry) configured once at startup by the server and by the CLI's embedded client. The CLI and web UI gain the new per-key rate-limit and per-mapping cache-TTL fields.

**Tech Stack:** Node 20, TypeScript 5, Express 4, better-sqlite3, vitest (upgraded in Task 16), supertest, nock 14, React 18 + TanStack Query, commander 12, Docker.

**Spec:** `docs/superpowers/specs/2026-09-24-graphtorest-08-hardening-design.md`

## Global Constraints

- Work on branch `worktree-graphtorest-08-hardening` in `/home/gmartin/dev/GraphToRest/.claude/worktrees/graphtorest-07-cli`. Never `cd` to the primary checkout.
- The base branch is `master` (not `main`).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — copy it literally; do not substitute your own model name.
- Run tests with `npm test` from the worktree root (it builds `@graphtorest/core` first; server/CLI tests import core's **dist** via `@graphtorest/core`, core tests import core's **src**). After changing core, the server/CLI tests only see it after `npm run build -w @graphtorest/core` (which `npm test` does).
- Baseline before Task 1: 576 tests passing. No task may leave the suite red.
- From Task 3 on, the shared vitest setup file imports core's **dist**, so before any targeted `npx vitest run <file>` run `npm run build -w @graphtorest/core` (a stale dist makes every test fail in `beforeEach`).
- If nock's fetch interception turns out not to honour `redirect: 'error'`, `AbortSignal` timeouts or `delayBody`, report it as a harness limitation. Do not weaken production code to make a test pass.
- Defaults must not change behaviour, except outbound private-network destinations are blocked unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`.
- Error envelope is always `{ "error": { "code", "message", "details" } }`.
- New error codes: `RATE_LIMITED` (429), `LOGIN_THROTTLED` (429), `OUTBOUND_TARGET_BLOCKED` (502).
- New env vars and defaults: `LOG_LEVEL=info`, `RATE_LIMIT_DEFAULT` unset (unlimited), `RATE_LIMIT_DEFAULT_BURST` = `RATE_LIMIT_DEFAULT`, `CACHE_MAX_TTL_SECONDS=300`, `CACHE_MAX_ENTRIES=1000` (`0` disables caching), `OUTBOUND_TIMEOUT_MS=30000`, `ALLOW_PRIVATE_NETWORK_TARGETS=false`, `GTR_BOOTSTRAP_ADMIN_USERNAME`/`GTR_BOOTSTRAP_ADMIN_PASSWORD` unset.
- Passwords: 12–1024 characters.
- Logs never contain headers, bodies, query strings, tokens, API-key secrets or passwords.
- No new runtime npm dependencies.

## Review Focus

1. **Passthrough cache isolation** — two developers with different `X-Vendor-Token`s hitting the same cached GET must never see each other's data, including when one sends no token at all. (Task 12 tests: "never shares entries between passthrough tokens" and "no-token requests do not hit a token-holder's entry".)
2. **Config edits while cached** — after an admin edits, deletes, or re-imports a mapping, or changes a connection's credentials, the next request must reflect the change, not a stale cached body. (Task 12 tests: "evicts on mapping update", "evicts on credentials change".)
3. **Rate-limit changes take effect immediately** — lowering a key's limit through `PATCH /admin/api-keys/:id` must apply on the next request, not after the bucket refills or the server restarts. (Task 9 test: "applies a changed limit on the next request".)
4. **An IPv4-mapped IPv6 literal or a hostname resolving to both public and private addresses must not slip past the SSRF guard** (`http://[::ffff:127.0.0.1]/`, `http://[::ffff:7f00:1]/`, mixed DNS answers). (Task 3 tests: "blocks IPv4-mapped IPv6 forms" and "blocks when any resolved address is private".)
5. **Existing volumes after the non-root switch** — a user upgrading an existing `/data` volume created by the old root image must get a clear, documented fix rather than a silent crash. (Task 14: startup `hint` naming the `chown` fix; Task 16: README/compose upgrade note; Task 18 Step 3: smoke-tested against a root-owned volume.)

---

## File Structure

**Create (core)**
- `packages/core/src/logging/logger.ts` — `createLogger`, `silentLogger`, `LogLevel`, `Logger`.
- `packages/core/src/net/ipRanges.ts` — `isPrivateAddress(ip)`.
- `packages/core/src/net/outboundPolicy.ts` — policy singleton + `outboundPolicyFromEnv`.
- `packages/core/src/net/outboundUrl.ts` — `assertOutboundUrlShape`, `assertOutboundTargetAllowed`, `outboundFetch`.
- `packages/core/src/adapters/connectionConfig.ts` — `parseConnectionConfig`.
- `packages/core/src/gateway/redact.ts` — `redactVendorText`.
- `packages/core/src/rateLimit/rateLimitConfig.ts` — setting parse/serialize/format/effective.
- `packages/core/src/rateLimit/TokenBucket.ts`.
- `packages/core/src/gateway/ResponseCache.ts` — LRU+TTL cache and `cacheIdentity`.

**Create (server)**
- `apps/server/src/middleware/requestLogger.ts`, `apps/server/src/middleware/loginThrottle.ts`, `apps/server/src/middleware/rateLimit.ts`
- `apps/server/src/shutdown.ts`, `apps/server/src/bootstrap.ts`

**Create (other)**
- `test/setup/outboundPolicy.ts` (vitest setup file), `.dockerignore`, `README.md`

**Modify** — listed per task.

---

### Task 1: Server configuration — validation and new settings

**Files:**
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 8, 11, 13, 14):
  ```ts
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error'; // re-declared here; Task 2 moves it to core
  export interface ServerConfig {
    port: number; dbPath: string; apiEnabled: boolean; adminEnabled: boolean; credentialEncryptionKey?: string;
    publicBaseUrl: string; activityRetention: number; webEnabled: boolean;
    logLevel: LogLevel;
    rateLimitDefault: { requestsPerMinute: number; burst: number } | null;
    cacheMaxTtlSeconds: number;
    cacheMaxEntries: number;
    outboundTimeoutMs: number;
    allowPrivateNetworkTargets: boolean;
    bootstrapAdmin: { username: string; password: string } | null;
  }
  export function loadConfig(env?: NodeJS.ProcessEnv): ServerConfig; // throws Error naming the variable on bad input
  ```

- [ ] **Step 1: Update the failing tests**

Replace the two `toEqual` expectations in `apps/server/test/config.test.ts` so they include the new fields, and add validation tests:

```ts
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 3000,
      dbPath: './data/graphtorest.db',
      apiEnabled: true,
      adminEnabled: true,
      publicBaseUrl: 'http://localhost:3000',
      activityRetention: 1000,
      webEnabled: true,
      logLevel: 'info',
      rateLimitDefault: null,
      cacheMaxTtlSeconds: 300,
      cacheMaxEntries: 1000,
      outboundTimeoutMs: 30000,
      allowPrivateNetworkTargets: false,
      bootstrapAdmin: null,
    });
    expect(config.credentialEncryptionKey).toBeUndefined();
  });
```

In the existing "reads overrides" test add these env entries and expected fields:

```ts
      LOG_LEVEL: 'debug',
      RATE_LIMIT_DEFAULT: '60',
      RATE_LIMIT_DEFAULT_BURST: '20',
      CACHE_MAX_TTL_SECONDS: '60',
      CACHE_MAX_ENTRIES: '0',
      OUTBOUND_TIMEOUT_MS: '5000',
      ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
      GTR_BOOTSTRAP_ADMIN_USERNAME: 'root',
      GTR_BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery',
      // expected:
      logLevel: 'debug',
      rateLimitDefault: { requestsPerMinute: 60, burst: 20 },
      cacheMaxTtlSeconds: 60,
      cacheMaxEntries: 0,
      outboundTimeoutMs: 5000,
      allowPrivateNetworkTargets: true,
      bootstrapAdmin: { username: 'root', password: 'correct-horse-battery' },
```

New tests:

```ts
  it('defaults the burst to the rate', () => {
    expect(loadConfig({ RATE_LIMIT_DEFAULT: '30' }).rateLimitDefault).toEqual({ requestsPerMinute: 30, burst: 30 });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['RATE_LIMIT_DEFAULT', '0'],
    ['RATE_LIMIT_DEFAULT', '1.5'],
    ['CACHE_MAX_TTL_SECONDS', '-1'],
    ['CACHE_MAX_ENTRIES', 'lots'],
    ['OUTBOUND_TIMEOUT_MS', '0'],
    ['ACTIVITY_RETENTION', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('rejects RATE_LIMIT_DEFAULT_BURST without RATE_LIMIT_DEFAULT', () => {
    expect(() => loadConfig({ RATE_LIMIT_DEFAULT_BURST: '5' })).toThrow('RATE_LIMIT_DEFAULT_BURST');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });

  it('rejects a non-boolean ALLOW_PRIVATE_NETWORK_TARGETS', () => {
    expect(() => loadConfig({ ALLOW_PRIVATE_NETWORK_TARGETS: 'yes' })).toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });

  it('requires both bootstrap admin variables or neither', () => {
    expect(() => loadConfig({ GTR_BOOTSTRAP_ADMIN_USERNAME: 'root' })).toThrow('GTR_BOOTSTRAP_ADMIN_PASSWORD');
    expect(() => loadConfig({ GTR_BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery' })).toThrow('GTR_BOOTSTRAP_ADMIN_USERNAME');
  });

  it('keeps the port in the default public base URL', () => {
    expect(loadConfig({ PORT: '8080' }).publicBaseUrl).toBe('http://localhost:8080');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/test/config.test.ts`
Expected: FAIL (new fields missing, `PORT=abc` not rejected).

- [ ] **Step 3: Implement**

Rewrite `apps/server/src/config.ts`:

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
  credentialEncryptionKey?: string;
  publicBaseUrl: string;
  activityRetention: number;
  webEnabled: boolean;
  logLevel: LogLevel;
  rateLimitDefault: { requestsPerMinute: number; burst: number } | null;
  cacheMaxTtlSeconds: number;
  cacheMaxEntries: number;
  outboundTimeoutMs: number;
  allowPrivateNetworkTargets: boolean;
  bootstrapAdmin: { username: string; password: string } | null;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Parses an optional integer env var; unset or empty yields `fallback`. Throws an Error naming the variable. */
function parseInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = env[name];
  if (!isSet(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? (min === 0 ? 'a non-negative integer' : `an integer of at least ${min}`) : `an integer from ${min} to ${max}`;
    throw new Error(`${name} must be ${range}, got "${value}"`);
  }
  return parsed;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (!isSet(value)) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!isSet(value)) return 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  }
  return value as LogLevel;
}

function parseRateLimitDefault(env: NodeJS.ProcessEnv): ServerConfig['rateLimitDefault'] {
  if (!isSet(env.RATE_LIMIT_DEFAULT)) {
    if (isSet(env.RATE_LIMIT_DEFAULT_BURST)) throw new Error('RATE_LIMIT_DEFAULT_BURST requires RATE_LIMIT_DEFAULT to be set');
    return null;
  }
  const requestsPerMinute = parseInteger(env, 'RATE_LIMIT_DEFAULT', 0, 1, 1_000_000);
  const burst = parseInteger(env, 'RATE_LIMIT_DEFAULT_BURST', requestsPerMinute, 1, 1_000_000);
  return { requestsPerMinute, burst };
}

function parseBootstrapAdmin(env: NodeJS.ProcessEnv): ServerConfig['bootstrapAdmin'] {
  const username = env.GTR_BOOTSTRAP_ADMIN_USERNAME;
  const password = env.GTR_BOOTSTRAP_ADMIN_PASSWORD;
  if (!isSet(username) && !isSet(password)) return null;
  if (!isSet(username)) throw new Error('GTR_BOOTSTRAP_ADMIN_USERNAME must be set when GTR_BOOTSTRAP_ADMIN_PASSWORD is');
  if (!isSet(password)) throw new Error('GTR_BOOTSTRAP_ADMIN_PASSWORD must be set when GTR_BOOTSTRAP_ADMIN_USERNAME is');
  return { username, password };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parseInteger(env, 'PORT', 3000, 1, 65535);
  return {
    port,
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    activityRetention: parseInteger(env, 'ACTIVITY_RETENTION', 1000, 1),
    webEnabled: env.WEB_ENABLED !== 'false',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    rateLimitDefault: parseRateLimitDefault(env),
    cacheMaxTtlSeconds: parseInteger(env, 'CACHE_MAX_TTL_SECONDS', 300, 0),
    cacheMaxEntries: parseInteger(env, 'CACHE_MAX_ENTRIES', 1000, 0),
    outboundTimeoutMs: parseInteger(env, 'OUTBOUND_TIMEOUT_MS', 30_000, 1),
    allowPrivateNetworkTargets: parseBoolean(env, 'ALLOW_PRIVATE_NETWORK_TARGETS', false),
    bootstrapAdmin: parseBootstrapAdmin(env),
  };
}
```

If an existing test asserts the old exact `ACTIVITY_RETENTION must be a positive integer` message, update that expectation to match the new message (`ACTIVITY_RETENTION must be an integer of at least 1, got "0"`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/server/test/config.test.ts` → PASS. Then `npm test` → all green (index.ts ignores the new fields for now).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/test/config.test.ts
git commit -m "feat(server): validate numeric env vars and add Plan 8 settings to loadConfig

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Structured logger and per-request log lines

**Files:**
- Create: `packages/core/src/logging/logger.ts`, `apps/server/src/middleware/requestLogger.ts`
- Modify: `packages/core/src/index.ts`, `apps/server/src/config.ts` (import `LogLevel` from core instead of declaring it), `apps/server/src/app.ts`, `apps/server/src/routers/apiRouter.ts`, `apps/server/src/routers/adminRouter.ts`, `apps/server/src/middleware/activityLog.ts`, `apps/server/src/index.ts`
- Test: `packages/core/test/logging/logger.test.ts`, `apps/server/test/requestLogging.integration.test.ts`

**Interfaces:**
- Consumes: `ServerConfig.logLevel` (Task 1).
- Produces:
  ```ts
  // core
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
  export type LogFields = Record<string, unknown>;
  export interface Logger { debug(msg: string, fields?: LogFields): void; info(...): void; warn(...): void; error(...): void }
  export interface LoggerOptions { level?: LogLevel; write?: (line: string, level: LogLevel) => void; now?: () => Date }
  export function createLogger(options?: LoggerOptions): Logger;
  export const silentLogger: Logger;
  // server
  export function createRequestLogger(logger: Logger, kind: 'api' | 'admin'): RequestHandler;
  AppDeps.logger?: Logger              // default silentLogger
  AdminRouterOptions.logger?: Logger   // default silentLogger
  createApiRouter(gatewayEngine: GatewayEngine, logger?: Logger): Router
  createActivityLogger(store, retention, logger?: Logger)
  ```
- `res.locals` keys read by the request logger (set by later tasks where noted): `apiKeyId`, `connectionId`, `mappingId`, `errorCode`, `cache` (Task 11), `vendorLatencyMs` (Task 11), `adminUser`.

- [ ] **Step 1: Write the failing core test** — `packages/core/test/logging/logger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createLogger, silentLogger } from '../../src/logging/logger';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const logger = createLogger({
    level,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    write: (line, lvl) => lines.push({ level: lvl, entry: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per call with ts, level and msg first', () => {
    const { logger, lines } = capture();
    logger.info('server_started', { port: 3000 });
    expect(lines).toEqual([{ level: 'info', entry: { ts: '2026-09-24T12:00:00.000Z', level: 'info', msg: 'server_started', port: 3000 } }]);
  });

  it('filters below the configured level (default info)', () => {
    const { logger, lines } = capture();
    logger.debug('noise');
    logger.warn('kept');
    expect(lines.map((l) => l.entry.msg)).toEqual(['kept']);
    const verbose = capture('debug');
    verbose.logger.debug('shown');
    expect(verbose.lines).toHaveLength(1);
  });

  it('serializes Error values with name, message and stack', () => {
    const { logger, lines } = capture();
    logger.error('unhandled_error', { error: new TypeError('boom') });
    const error = lines[0].entry.error as Record<string, unknown>;
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe('boom');
    expect(typeof error.stack).toBe('string');
  });

  it('cannot be overridden by fields named ts/level/msg', () => {
    const { logger, lines } = capture();
    logger.info('real', { msg: 'fake', level: 'error', ts: 'x' });
    expect(lines[0].entry).toMatchObject({ msg: 'real', level: 'info', ts: '2026-09-24T12:00:00.000Z' });
  });

  it('silentLogger discards everything', () => {
    expect(() => silentLogger.error('x', { a: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/core/test/logging/logger.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/core/src/logging/logger.ts`:

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives one serialized JSON line (no trailing newline). Defaults to stdout, or stderr for warn/error. */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function defaultWrite(line: string, level: LogLevel): void {
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

/** One JSON line per event: { ts, level, msg, ...fields }. Fields can never overwrite ts/level/msg. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (RANK[level] < threshold) return;
    write(JSON.stringify({ ts: now().toISOString(), level, msg, ...fields }, replacer), level);
  };
  // Strip same-named fields so ts/level/msg always come first and can never be overwritten.
  const ordered = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    const { ts: _ts, level: _level, msg: _msg, ...rest } = fields ?? {};
    emit(level, msg, rest);
  };
  return { debug: ordered('debug'), info: ordered('info'), warn: ordered('warn'), error: ordered('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
```

Export from `packages/core/src/index.ts`:

```ts
export { createLogger, silentLogger } from './logging/logger';
export type { Logger, LogLevel, LogFields, LoggerOptions } from './logging/logger';
```

In `apps/server/src/config.ts` delete the local `LogLevel` type and `import type { LogLevel } from '@graphtorest/core';` (keep the local `LOG_LEVELS` array).

- [ ] **Step 4: Run** `npx vitest run packages/core/test/logging/logger.test.ts` → PASS.

- [ ] **Step 5: Write the failing server test** — `apps/server/test/requestLogging.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, createLogger } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;
let lines: Array<Record<string, unknown>>;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-reqlog-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  const store = new MappingStore(db);
  lines = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
  app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: true, adminEnabled: true, logger });
  admin = createAdminClient(app, store);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

const completed = () => lines.filter((l) => l.msg === 'request_completed');

describe('request_completed log lines', () => {
  it('logs an /api request with gateway fields and no query string or secrets', async () => {
    const conn = await admin.post('/admin/connections').send({ name: 'm', adapterType: 'mock', authMode: 'passthrough' });
    await admin.post('/admin/mappings').send({ connectionId: conn.body.id, route: '/users/{id}', method: 'GET', operation: { resource: 'user' } });
    const key = await admin.post('/admin/api-keys').send({});
    lines.length = 0;
    await request(app).get('/api/users/7?secret=shh').set('Authorization', `Bearer ${key.body.plaintext}`).set('X-Vendor-Token', 'vendor-tok');
    const [line] = completed();
    expect(line).toMatchObject({ level: 'info', kind: 'api', method: 'GET', path: '/api/users/7', status: 200, apiKeyId: key.body.id, connectionId: conn.body.id });
    expect(typeof line.durationMs).toBe('number');
    const text = JSON.stringify(lines);
    expect(text).not.toContain('shh');
    expect(text).not.toContain('vendor-tok');
    expect(text).not.toContain(key.body.plaintext.split('.')[1]);
  });

  it('logs the error code of a failed /api request', async () => {
    await request(app).get('/api/nothing');
    expect(completed()[0]).toMatchObject({ kind: 'api', status: 401, errorCode: 'UNAUTHORIZED' });
  });

  it('logs /admin requests with the admin user id and never the password', async () => {
    await request(app).post('/admin/login').send({ username: 'test-admin', password: 'wrong-password-xyz' });
    await admin.get('/admin/connections');
    const [login, list] = completed();
    expect(login).toMatchObject({ kind: 'admin', method: 'POST', path: '/admin/login', status: 401 });
    expect(list).toMatchObject({ kind: 'admin', method: 'GET', path: '/admin/connections', status: 200 });
    expect(typeof list.adminUserId).toBe('string');
    expect(JSON.stringify(lines)).not.toContain('wrong-password-xyz');
  });

  it('logs unhandled errors through the logger', async () => {
    const store = new MappingStore(db);
    const broken = createApp({
      mappingStore: store,
      gatewayEngine: { handle: () => Promise.reject(new TypeError('kaboom')) } as unknown as GatewayEngine,
      openApiGenerator: new OpenApiGenerator(),
      apiEnabled: true,
      adminEnabled: false,
      logger: createLogger({ write: (line) => lines.push(JSON.parse(line)) }),
    });
    const key = store.createApiKey({});
    lines.length = 0;
    const res = await request(broken).get('/api/x').set('Authorization', `Bearer ${key.plaintext}`);
    expect(res.status).toBe(500);
    const err = lines.find((l) => l.msg === 'unhandled_error')!;
    expect((err.error as Record<string, unknown>).message).toBe('kaboom');
  });
});
```

- [ ] **Step 6: Run** `npx vitest run apps/server/test/requestLogging.integration.test.ts` → FAIL (`logger` not accepted / no lines).

- [ ] **Step 7: Implement the middleware** — `apps/server/src/middleware/requestLogger.ts`:

```ts
import type { RequestHandler } from 'express';
import type { Logger } from '@graphtorest/core';

/**
 * Emits one `request_completed` line when the response finishes. Only the path is logged — never the query string,
 * headers or body. /api lines carry gateway fields; /admin lines carry the admin user id.
 */
export function createRequestLogger(logger: Logger, kind: 'api' | 'admin'): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const locals = res.locals;
      const base = {
        kind,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        errorCode: (locals.errorCode as string | undefined) ?? null,
      };
      const fields =
        kind === 'api'
          ? {
              ...base,
              apiKeyId: locals.apiKeyId ?? null,
              connectionId: locals.connectionId ?? null,
              mappingId: locals.mappingId ?? null,
              cache: locals.cache ?? null,
              vendorLatencyMs: locals.vendorLatencyMs ?? null,
            }
          : { ...base, adminUserId: (locals.adminUser as { id?: string } | undefined)?.id ?? null };
      logger.info('request_completed', fields);
    });
    next();
  };
}
```

- [ ] **Step 8: Wire it in.**

`apps/server/src/app.ts`:
- `import { silentLogger, type Logger } from '@graphtorest/core';` and `import { createRequestLogger } from './middleware/requestLogger';`
- Add `logger?: Logger;` to `AppDeps`; at top of `createApp`: `const logger = deps.logger ?? silentLogger;`
- `/api` mount becomes:
  ```ts
  app.use(
    '/api',
    createRequestLogger(logger, 'api'),
    createActivityLogger(deps.mappingStore, deps.activityRetention ?? DEFAULT_ACTIVITY_RETENTION, logger),
    createApiKeyAuth(deps.mappingStore),
    createApiRouter(deps.gatewayEngine, logger)
  );
  ```
- `/admin` mount becomes `app.use('/admin', createRequestLogger(logger, 'admin'), createAdminRouter(deps.mappingStore, { ...existing options, logger }))`.
- In the error handler replace `console.error(err);` with `logger.error('unhandled_error', { error: err });` and, in all three branches, set `res.locals.errorCode = <the code being sent>` before responding.

`apps/server/src/routers/apiRouter.ts`: signature `createApiRouter(gatewayEngine: GatewayEngine, logger: Logger = silentLogger)`; replace `console.error(err)` with `logger.error('unhandled_error', { error: err })`.

`apps/server/src/routers/adminRouter.ts`: add `logger?: Logger` to `AdminRouterOptions`; `const logger = options.logger ?? silentLogger;`; replace both `console.error(err)` with `logger.error('unhandled_error', { error: err })`. In the four places that respond with an error envelope directly (`res.status(4xx).json({ error: { code: X ...` ) set `res.locals.errorCode = X` first — simplest: add a local helper

```ts
  const sendError = (res: Response, status: number, code: string, message: string) => {
    res.locals.errorCode = code;
    res.status(status).json({ error: { code, message, details: {} } });
  };
```

and use it for every inline error response in the router (import `type Response` from express). In the two `toErrorResponse` catch blocks also set `res.locals.errorCode = body.error.code`.

`apps/server/src/middleware/activityLog.ts`: add a third parameter `logger: Logger = silentLogger` and replace the `console.error(JSON.stringify(...))` with `logger.error('activity_log_write_failed', { error: err })`.

`apps/server/src/index.ts`: create `const logger = createLogger({ level: config.logLevel });` right after `loadConfig()`, pass `logger` into `createApp`, and convert every `console.warn(JSON.stringify({ msg, warning }))` / `console.log(JSON.stringify({ msg, ... }))` into `logger.warn(msg, { warning })` / `logger.info('server_started', { port, dbPath })`.

Confirm no `console.` remains: `grep -rn "console\." apps/server/src packages/core/src` → no output.

- [ ] **Step 9: Run** `npm test` → all green.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/logging packages/core/src/index.ts packages/core/test/logging apps/server/src apps/server/test/requestLogging.integration.test.ts
git commit -m "feat: add structured JSON logger and request_completed log lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Outbound network policy and SSRF guard (core units)

**Files:**
- Create: `packages/core/src/net/ipRanges.ts`, `packages/core/src/net/outboundPolicy.ts`, `packages/core/src/net/outboundUrl.ts`, `test/setup/outboundPolicy.ts`
- Modify: `packages/core/src/index.ts`, `vitest.config.ts`
- Test: `packages/core/test/net/ipRanges.test.ts`, `packages/core/test/net/outboundUrl.test.ts`, `packages/core/test/net/outboundPolicy.test.ts`

**Interfaces:**
- Produces (consumed by Task 4, which wires the guard into its callers, and by Task 1's config via `outboundPolicyFromEnv`):
  ```ts
  export function isPrivateAddress(ip: string): boolean;
  export type LookupFn = (hostname: string) => Promise<string[]>;
  export interface OutboundPolicy { timeoutMs: number; allowPrivateNetworkTargets: boolean; lookup: LookupFn }
  export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
  export const systemLookup: LookupFn;
  export function getOutboundPolicy(): OutboundPolicy;
  export function setOutboundPolicy(patch: Partial<OutboundPolicy>): void;
  export function resetOutboundPolicy(): void;
  export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv): Pick<OutboundPolicy, 'timeoutMs' | 'allowPrivateNetworkTargets'>; // throws Error naming the variable
  export function assertOutboundUrlShape(value: unknown, field: string, options?: { httpsOnly?: boolean }): string; // throws GatewayError INVALID_INPUT 400
  export async function assertOutboundTargetAllowed(url: string, policy?: OutboundPolicy): Promise<void>; // throws GatewayError OUTBOUND_TARGET_BLOCKED 502 / VENDOR_UNREACHABLE 502
  export async function outboundFetch(url: string, init?: RequestInit, policy?: OutboundPolicy): Promise<Response>;
  ```

- [ ] **Step 1: Failing tests.**

`packages/core/test/net/ipRanges.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isPrivateAddress } from '../../src/net/ipRanges';

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  ])('blocks IPv4 %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1', '203.0.113.10', '169.253.0.1'])(
    'allows public IPv4 %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false)
  );

  it.each(['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1'])('blocks IPv6 %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(['2001:4860:4860::8888', '2606:4700::1111', 'fec0::1'])('allows public IPv6 %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('blocks IPv4-mapped IPv6 forms', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks IPv4-compatible IPv6 forms of private ranges', () => {
    expect(isPrivateAddress('::10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::7f00:1')).toBe(true);
  });

  it('treats unparseable input as private (fail closed)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});
```

`packages/core/test/net/outboundUrl.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { assertOutboundUrlShape, assertOutboundTargetAllowed, outboundFetch } from '../../src/net/outboundUrl';
import type { OutboundPolicy } from '../../src/net/outboundPolicy';
import { GatewayError } from '../../src/gateway/errors';

const policy = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
  timeoutMs: 1000,
  allowPrivateNetworkTargets: false,
  lookup: async () => ['203.0.113.10'],
  ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as GatewayError).code;
  }
  return 'NO_ERROR';
}

afterEach(() => nock.cleanAll());

describe('assertOutboundUrlShape', () => {
  it('accepts http and https URLs and trims them', () => {
    expect(assertOutboundUrlShape(' https://api.example.com/graphql ', 'endpoint')).toBe('https://api.example.com/graphql');
    expect(assertOutboundUrlShape('http://graphql:4000/', 'endpoint')).toBe('http://graphql:4000/');
  });

  it.each([
    [undefined, '"endpoint" is required'],
    ['', '"endpoint" is required'],
    ['not a url', '"endpoint" must be a valid URL'],
    ['ftp://x.example/', '"endpoint" must be an http or https URL'],
    ['https://user:pw@x.example/', '"endpoint" must not contain a username or password'],
  ])('rejects %s', (value, message) => {
    expect(() => assertOutboundUrlShape(value, 'endpoint')).toThrow(message);
  });

  it('enforces https when asked', () => {
    expect(() => assertOutboundUrlShape('http://x.example/', 'tokenUrl', { httpsOnly: true })).toThrow('"tokenUrl" must be an https URL');
  });
});

describe('assertOutboundTargetAllowed', () => {
  it('allows a public https destination', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('https://api.example.com/x', policy()))).toBe('NO_ERROR');
  });

  it('blocks a private destination and names the opt-in variable', async () => {
    const p = assertOutboundTargetAllowed('https://internal.example/x', policy({ lookup: async () => ['10.0.0.5'] }));
    await expect(p).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED', status: 502 });
    await expect(p).rejects.toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });

  it('blocks when any resolved address is private', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('https://mixed.example/', policy({ lookup: async () => ['203.0.113.10', '127.0.0.1'] })))).toBe(
      'OUTBOUND_TARGET_BLOCKED'
    );
  });

  it('checks IP literals without a lookup, including bracketed IPv6', async () => {
    const lookup = async () => {
      throw new Error('lookup must not be called');
    };
    expect(await codeOf(assertOutboundTargetAllowed('https://169.254.169.254/latest', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
    expect(await codeOf(assertOutboundTargetAllowed('https://[::ffff:127.0.0.1]/', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
    expect(await codeOf(assertOutboundTargetAllowed('https://[::ffff:7f00:1]/', policy({ lookup })))).toBe('OUTBOUND_TARGET_BLOCKED');
  });

  it('allows private destinations, including plain http, when opted in', async () => {
    const opted = policy({ allowPrivateNetworkTargets: true, lookup: async () => ['172.18.0.4'] });
    expect(await codeOf(assertOutboundTargetAllowed('http://graphql:4000/', opted))).toBe('NO_ERROR');
  });

  it('rejects plain http to a public destination even when opted in', async () => {
    expect(await codeOf(assertOutboundTargetAllowed('http://api.example.com/', policy({ allowPrivateNetworkTargets: true })))).toBe(
      'OUTBOUND_TARGET_BLOCKED'
    );
  });

  it('reports an unresolvable host as VENDOR_UNREACHABLE', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await codeOf(assertOutboundTargetAllowed('https://nope.example/', policy({ lookup })))).toBe('VENDOR_UNREACHABLE');
  });
});

describe('outboundFetch', () => {
  it('refuses redirects by default', async () => {
    nock('https://api.example.com').get('/r').reply(302, '', { location: 'https://169.254.169.254/' });
    await expect(outboundFetch('https://api.example.com/r', {}, policy())).rejects.toThrow();
  });

  it('aborts after the policy timeout', async () => {
    nock('https://api.example.com').get('/slow').delay(500).reply(200, 'late');
    await expect(outboundFetch('https://api.example.com/slow', {}, policy({ timeoutMs: 50 }))).rejects.toThrow();
  });

  it('does not fetch a blocked destination', async () => {
    const scope = nock('https://internal.example').get('/').reply(200, 'secret');
    await expect(outboundFetch('https://internal.example/', {}, policy({ lookup: async () => ['10.1.1.1'] }))).rejects.toMatchObject({
      code: 'OUTBOUND_TARGET_BLOCKED',
    });
    expect(scope.isDone()).toBe(false);
  });
});
```

`packages/core/test/net/outboundPolicy.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { getOutboundPolicy, setOutboundPolicy, resetOutboundPolicy, outboundPolicyFromEnv, DEFAULT_OUTBOUND_TIMEOUT_MS } from '../../src/net/outboundPolicy';

afterEach(() => resetOutboundPolicy());

describe('outbound policy', () => {
  it('merges patches and resets to defaults', () => {
    resetOutboundPolicy();
    expect(getOutboundPolicy()).toMatchObject({ timeoutMs: DEFAULT_OUTBOUND_TIMEOUT_MS, allowPrivateNetworkTargets: false });
    setOutboundPolicy({ allowPrivateNetworkTargets: true });
    expect(getOutboundPolicy().allowPrivateNetworkTargets).toBe(true);
    expect(getOutboundPolicy().timeoutMs).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
  });

  it('parses env', () => {
    expect(outboundPolicyFromEnv({})).toEqual({ timeoutMs: 30000, allowPrivateNetworkTargets: false });
    expect(outboundPolicyFromEnv({ OUTBOUND_TIMEOUT_MS: '500', ALLOW_PRIVATE_NETWORK_TARGETS: 'true' })).toEqual({
      timeoutMs: 500,
      allowPrivateNetworkTargets: true,
    });
    expect(() => outboundPolicyFromEnv({ OUTBOUND_TIMEOUT_MS: 'x' })).toThrow('OUTBOUND_TIMEOUT_MS');
    expect(() => outboundPolicyFromEnv({ ALLOW_PRIVATE_NETWORK_TARGETS: '1' })).toThrow('ALLOW_PRIVATE_NETWORK_TARGETS');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/core/test/net` → FAIL (modules missing).

- [ ] **Step 3: Implement `packages/core/src/net/ipRanges.ts`:**

```ts
import net from 'node:net';

/** [network, prefixLength] pairs, IPv4 as 32-bit unsigned ints. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local incl. cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}

/** Expands an IPv6 literal (optionally ending in a dotted IPv4) into 8 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const v = v4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = halves.length === 2 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : head;
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * True for loopback, private, link-local, CGNAT, unspecified and unique-local addresses, including IPv4-mapped and
 * IPv4-compatible IPv6 forms of blocked IPv4 ranges. Unparseable input counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.split('%')[0]; // drop an IPv6 zone id
  if (net.isIPv4(address)) return isBlockedV4(v4ToInt(address));
  if (!net.isIPv6(address)) return true;
  const g = expandV6(address);
  if (!g) return true;
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (mapped) or ::a.b.c.d (compatible, also covers :: and ::1)
    return isBlockedV4(((g[6] << 16) | g[7]) >>> 0);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}
```

`expandV6` rewrites a dotted IPv4 tail into two hex groups before the plain hex expansion, so `::ffff:127.0.0.1` and `::ffff:7f00:1` expand identically.

- [ ] **Step 4: Implement `packages/core/src/net/outboundPolicy.ts`:**

```ts
import dns from 'node:dns';

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface OutboundPolicy {
  timeoutMs: number;
  allowPrivateNetworkTargets: boolean;
  lookup: LookupFn;
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export const systemLookup: LookupFn = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const DEFAULTS: OutboundPolicy = { timeoutMs: DEFAULT_OUTBOUND_TIMEOUT_MS, allowPrivateNetworkTargets: false, lookup: systemLookup };
let current: OutboundPolicy = { ...DEFAULTS };

/** Process-wide outbound policy (single-process deployment). Configured once at startup by the server and the CLI. */
export function getOutboundPolicy(): OutboundPolicy {
  return current;
}

export function setOutboundPolicy(patch: Partial<OutboundPolicy>): void {
  current = { ...current, ...patch };
}

export function resetOutboundPolicy(): void {
  current = { ...DEFAULTS };
}

export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv): Pick<OutboundPolicy, 'timeoutMs' | 'allowPrivateNetworkTargets'> {
  let timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS;
  const rawTimeout = env.OUTBOUND_TIMEOUT_MS;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`OUTBOUND_TIMEOUT_MS must be an integer of at least 1, got "${rawTimeout}"`);
    }
  }
  const rawAllow = env.ALLOW_PRIVATE_NETWORK_TARGETS;
  let allowPrivateNetworkTargets = false;
  if (rawAllow !== undefined && rawAllow !== '') {
    if (rawAllow !== 'true' && rawAllow !== 'false') {
      throw new Error(`ALLOW_PRIVATE_NETWORK_TARGETS must be "true" or "false", got "${rawAllow}"`);
    }
    allowPrivateNetworkTargets = rawAllow === 'true';
  }
  return { timeoutMs, allowPrivateNetworkTargets };
}
```

Then make `apps/server/src/config.ts` reuse it (DRY): replace the `outboundTimeoutMs` and `allowPrivateNetworkTargets` lines in `loadConfig` with `...outboundPolicyFromEnv(env)` renamed:

```ts
  const outbound = outboundPolicyFromEnv(env);
  // ...
    outboundTimeoutMs: outbound.timeoutMs,
    allowPrivateNetworkTargets: outbound.allowPrivateNetworkTargets,
```

(import `outboundPolicyFromEnv` from `@graphtorest/core`; the Task 1 tests keep passing because the messages name the variable).

- [ ] **Step 5: Implement `packages/core/src/net/outboundUrl.ts`:**

```ts
import net from 'node:net';
import { GatewayError } from '../gateway/errors';
import { isPrivateAddress } from './ipRanges';
import { getOutboundPolicy, type OutboundPolicy } from './outboundPolicy';

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function blocked(message: string): GatewayError {
  return new GatewayError('OUTBOUND_TARGET_BLOCKED', message, 502);
}

/** Write-time URL validation for admin-supplied outbound URLs. Returns the trimmed URL. */
export function assertOutboundUrlShape(value: unknown, field: string, options: { httpsOnly?: boolean } = {}): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" is required`);
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`"${field}" must be a valid URL`);
  }
  if (options.httpsOnly && url.protocol !== 'https:') throw invalid(`"${field}" must be an https URL`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid(`"${field}" must be an http or https URL`);
  if (url.username || url.password) throw invalid(`"${field}" must not contain a username or password`);
  return text;
}

/**
 * Request-time destination check. Resolves the host and refuses private-network destinations unless the policy opts
 * in; plain http is allowed only for opted-in private destinations. Known gap: DNS may change between this check and
 * the connection (rebinding) — see the Plan 8 spec §5.5.
 */
export async function assertOutboundTargetAllowed(url: string, policy: OutboundPolicy = getOutboundPolicy()): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await policy.lookup(host);
    } catch (err) {
      throw new GatewayError('VENDOR_UNREACHABLE', `Could not resolve ${host}`, 502, { message: (err as Error).message });
    }
    if (addresses.length === 0) throw new GatewayError('VENDOR_UNREACHABLE', `Could not resolve ${host}`, 502);
  }
  const privateTarget = addresses.some(isPrivateAddress);
  if (privateTarget && !policy.allowPrivateNetworkTargets) {
    throw blocked(`${host} resolves to a private-network address; set ALLOW_PRIVATE_NETWORK_TARGETS=true to allow it`);
  }
  if (parsed.protocol === 'http:' && !privateTarget) {
    throw blocked(`Plain http is only allowed for private-network destinations (with ALLOW_PRIVATE_NETWORK_TARGETS=true); use https for ${host}`);
  }
}

/** fetch() for admin-configured destinations: destination check, policy timeout, and no redirects unless `init` says otherwise. */
export async function outboundFetch(url: string, init: RequestInit = {}, policy: OutboundPolicy = getOutboundPolicy()): Promise<Response> {
  await assertOutboundTargetAllowed(url, policy);
  return fetch(url, { redirect: 'error', ...init, signal: init.signal ?? AbortSignal.timeout(policy.timeoutMs) });
}
```

Export from `packages/core/src/index.ts`:

```ts
export { isPrivateAddress } from './net/ipRanges';
export {
  getOutboundPolicy,
  setOutboundPolicy,
  resetOutboundPolicy,
  outboundPolicyFromEnv,
  systemLookup,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
} from './net/outboundPolicy';
export type { OutboundPolicy, LookupFn } from './net/outboundPolicy';
export { assertOutboundUrlShape, assertOutboundTargetAllowed, outboundFetch } from './net/outboundUrl';
```

- [ ] **Step 6: Test setup file so no test does real DNS.** Create `test/setup/outboundPolicy.ts`:

```ts
import { beforeEach } from 'vitest';
// Two module instances exist under vitest: server/CLI tests use core's dist (via the package name), core tests use src.
import * as distPolicy from '@graphtorest/core';
import * as srcPolicy from '../../packages/core/src/net/outboundPolicy';

/** TEST-NET-3 documentation address: public for the SSRF guard, never actually contacted (nock intercepts). */
export const TEST_PUBLIC_ADDRESS = '203.0.113.10';

beforeEach(() => {
  for (const policy of [distPolicy, srcPolicy]) {
    policy.resetOutboundPolicy();
    policy.setOutboundPolicy({ lookup: async () => [TEST_PUBLIC_ADDRESS] });
  }
});
```

In `vitest.config.ts` add `setupFiles: ['test/setup/outboundPolicy.ts'],` inside `test`. Tests that need a different policy call `setOutboundPolicy` themselves in their own `beforeEach` (which runs after the setup file's).

- [ ] **Step 7: Run** `npx vitest run packages/core/test/net` → PASS, then `npm test` → all green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/net packages/core/src/index.ts packages/core/test/net test/setup vitest.config.ts apps/server/src/config.ts
git commit -m "feat(core): add outbound network policy and SSRF guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the outbound guard, timeouts and write-time URL checks into callers

**Files:**
- Create: `packages/core/src/adapters/connectionConfig.ts`
- Modify: `packages/core/src/adapters/graphql/GraphQLHttpClient.ts`, `packages/core/src/auth/oauthClient.ts`, `packages/core/src/index.ts`, `apps/server/src/routers/adminRouter.ts` (POST /connections), `apps/cli/src/client/embedded.ts` (`open`, `createConnection`), `apps/server/src/index.ts`
- Test: `packages/core/test/adapters/connectionConfig.test.ts`, `packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts` (extend), `packages/core/test/auth/oauthClient.test.ts` (extend), `apps/server/test/outboundGuard.integration.test.ts`, `apps/cli/test/client.contract.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 exports.
- Produces: `export function parseConnectionConfig(config: unknown): Record<string, unknown> | null` — `undefined`/`null` → `null`; non-object/array → `INVALID_INPUT` "\"config\" must be an object"; if `config.endpoint !== undefined` it must pass `assertOutboundUrlShape(endpoint, 'config.endpoint')` and is stored trimmed.

- [ ] **Step 1: Failing tests.**

`packages/core/test/adapters/connectionConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseConnectionConfig } from '../../src/adapters/connectionConfig';

describe('parseConnectionConfig', () => {
  it('passes through null/undefined as null', () => {
    expect(parseConnectionConfig(undefined)).toBeNull();
    expect(parseConnectionConfig(null)).toBeNull();
  });
  it('rejects non-objects', () => {
    for (const bad of [123, 'x', [1]]) expect(() => parseConnectionConfig(bad)).toThrow('"config" must be an object');
  });
  it('validates and trims config.endpoint', () => {
    expect(parseConnectionConfig({ endpoint: ' https://api.example.com/graphql ', extra: 1 })).toEqual({
      endpoint: 'https://api.example.com/graphql',
      extra: 1,
    });
    expect(() => parseConnectionConfig({ endpoint: 'https://u:p@x.example/' })).toThrow('must not contain a username or password');
    expect(() => parseConnectionConfig({ endpoint: 'file:///etc/passwd' })).toThrow('http or https');
  });
});
```

Add to the existing GraphQL client test file (`packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`; reuse its existing host constant/imports and import `setOutboundPolicy` from `'../../../src/net/outboundPolicy'`):

```ts
  it('refuses a private-network endpoint before sending the vendor token', async () => {
    setOutboundPolicy({ lookup: async () => ['10.0.0.9'] });
    const scope = nock('https://internal.example').post('/graphql').reply(200, { data: {} });
    const client = new GraphQLHttpClient('https://internal.example/graphql', 'passthrough', 'tok');
    await expect(client.execute({ query: '{ a }' })).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED', status: 502 });
    expect(scope.isDone()).toBe(false);
  });

  it('maps a timeout to VENDOR_UNREACHABLE', async () => {
    setOutboundPolicy({ timeoutMs: 50 });
    nock('https://api.example.com').post('/graphql').delay(300).reply(200, { data: {} });
    const client = new GraphQLHttpClient('https://api.example.com/graphql', 'passthrough', 'tok');
    await expect(client.execute({ query: '{ a }' })).rejects.toMatchObject({ code: 'VENDOR_UNREACHABLE', status: 502 });
  });

  it('maps a body that stalls past the timeout to VENDOR_UNREACHABLE', async () => {
    setOutboundPolicy({ timeoutMs: 80 });
    nock('https://api.example.com').post('/graphql').delayBody(400).reply(200, { data: {} });
    const client = new GraphQLHttpClient('https://api.example.com/graphql', 'passthrough', 'tok');
    await expect(client.execute({ query: '{ a }' })).rejects.toMatchObject({ code: 'VENDOR_UNREACHABLE' });
  });

  it('does not follow redirects', async () => {
    nock('https://api.example.com').post('/graphql').reply(307, '', { location: 'https://elsewhere.example/graphql' });
    const client = new GraphQLHttpClient('https://api.example.com/graphql', 'passthrough', 'tok');
    await expect(client.execute({ query: '{ a }' })).rejects.toMatchObject({ code: 'VENDOR_UNREACHABLE' });
  });
```

Add to `packages/core/test/auth/oauthClient.test.ts` (use its existing constants for the generic-OAuth token URL; import `setOutboundPolicy` from src):

```ts
  it('rejects a tokenUrl with embedded credentials', () => {
    expect(() =>
      parseManagedCredentials('graphql', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://u:p@login.example/token' })
    ).toThrow('must not contain a username or password');
  });

  it('refuses a token endpoint on a private network', async () => {
    setOutboundPolicy({ lookup: async () => ['192.168.1.20'] });
    await expect(
      requestClientCredentialsToken('graphql', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://login.example/token' })
    ).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_BLOCKED' });
  });

  it('maps a stalled token response body to VENDOR_AUTH_UNREACHABLE', async () => {
    setOutboundPolicy({ timeoutMs: 80 });
    nock('https://login.example').post('/token').delayBody(400).reply(200, { access_token: 'x', expires_in: 60 });
    await expect(
      requestClientCredentialsToken('graphql', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://login.example/token' })
    ).rejects.toMatchObject({ code: 'VENDOR_AUTH_UNREACHABLE' });
  });
```

`apps/server/test/outboundGuard.integration.test.ts` — set up an app like `graphql.integration.test.ts` (copy its `beforeEach`/`afterEach` verbatim, host `https://api.example-graphql-test.com`), then:

```ts
import { setOutboundPolicy } from '@graphtorest/core';

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
```

Add to `apps/cli/test/client.contract.test.ts` inside the `connections` describe (runs for both modes):

```ts
    it('rejects a connection endpoint with embedded credentials', async () => {
      expect(
        await codeOf(
          h.client.createConnection({ name: 'bad', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: 'https://u:p@x.example/g' } })
        )
      ).toBe('INVALID_INPUT');
    });
```

- [ ] **Step 2: Run** the touched test files → FAIL.

- [ ] **Step 3: Implement.**

`packages/core/src/adapters/connectionConfig.ts`:

```ts
import { GatewayError } from '../gateway/errors';
import { assertOutboundUrlShape } from '../net/outboundUrl';

/** Validates a connection's free-form `config` at write time (admin API and embedded CLI share this). */
export function parseConnectionConfig(config: unknown): Record<string, unknown> | null {
  if (config === undefined || config === null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new GatewayError('INVALID_INPUT', '"config" must be an object', 400);
  }
  const parsed = { ...(config as Record<string, unknown>) };
  if (parsed.endpoint !== undefined) parsed.endpoint = assertOutboundUrlShape(parsed.endpoint, 'config.endpoint');
  return parsed;
}
```

Export it from `index.ts`: `export { parseConnectionConfig } from './adapters/connectionConfig';`

`adminRouter.ts` POST `/connections`: after the presence check, `const parsedConfig = parseConnectionConfig(config);` and pass `config: parsedConfig`. `EmbeddedClient.createConnection`: same call before `store.createConnection` (it already mirrors adminRouter's validation; keep the error codes identical — `GatewayError` → `toCliError` yields `INVALID_INPUT`).

`GraphQLHttpClient.execute` — replace the fetch and body read:

```ts
  async execute(input: GraphQLExecuteInput): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      response = await outboundFetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.vendorToken}` },
        body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      });
      text = await response.text();
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError('VENDOR_UNREACHABLE', 'Could not reach the GraphQL endpoint', 502, {
        vendor: 'graphql',
        message: (err as Error).message,
      });
    }
    // ... unchanged from `let body: GraphQLHttpResponse | null = null;` onwards
```

`oauthClient.ts`:
- Delete `requireHttpsUrl` and `TOKEN_REQUEST_TIMEOUT_MS`; replace the two `requireHttpsUrl(raw.x, 'x')` calls with `assertOutboundUrlShape(raw.x, 'x', { httpsOnly: true })`.
- In `postTokenRequest`, replace `fetch(tokenUrl, {...})` with `outboundFetch(tokenUrl, { method, headers, body, redirect: 'manual' })` (drop the explicit `signal`; the policy supplies the timeout; keep `redirect: 'manual'` and its comment — the existing 3xx check gives a clearer error than `redirect: 'error'`), move `const text = await response.text();` inside the same `try`, and make the catch rethrow `GatewayError`s unchanged:

```ts
  let response: Response;
  let text: string;
  try {
    response = await outboundFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      // Never follow redirects: a 307/308 would re-POST the form (client secret, tokens) to another host or over http.
      redirect: 'manual',
    });
    text = await response.text();
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError('VENDOR_AUTH_UNREACHABLE', 'Could not reach the vendor token endpoint', 502, { message: (err as Error).message });
  }
  if (response.status >= 300 && response.status < 400) { /* unchanged */ }
```

Note the Microsoft Graph login host (`login.microsoftonline.com`) now also goes through the guard — fine, it is public.

`EmbeddedClient.open(dbPath, env)`: first line `setOutboundPolicy(outboundPolicyFromEnv(env));` so the CLI honours `OUTBOUND_TIMEOUT_MS`/`ALLOW_PRIVATE_NETWORK_TARGETS` for `mapping generate` and managed-token fetches. (The CLI test harness passes a small env; `outboundPolicyFromEnv` only patches timeout/allow-private and leaves the test `lookup` stub from the setup file in place.)

`apps/server/src/index.ts`: right after the logger is created, `setOutboundPolicy({ timeoutMs: config.outboundTimeoutMs, allowPrivateNetworkTargets: config.allowPrivateNetworkTargets });`.

- [ ] **Step 4: Run** `npm test` → all green. If an existing test used a GraphQL endpoint whose URL now fails shape validation, fix the fixture (never loosen the check).

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server apps/cli
git commit -m "feat: guard outbound GraphQL/OAuth fetches, validate connection URLs, map stalled bodies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Vendor error redaction

**Files:**
- Create: `packages/core/src/gateway/redact.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/auth/oauthClient.ts`, `packages/core/src/adapters/graphql/GraphQLHttpClient.ts`, `packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts`, `apps/server/src/routers/adminRouter.ts` (oauth callback)
- Test: `packages/core/test/gateway/redact.test.ts`, extend `oauthClient.test.ts`, `GraphQLHttpClient.test.ts`

**Interfaces:**
- Produces: `export const REDACTED = '[redacted]'; export function redactVendorText(text: string, maxLength?: number /* 200 */): string`

- [ ] **Step 1: Failing tests** — `packages/core/test/gateway/redact.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redactVendorText } from '../../src/gateway/redact';

describe('redactVendorText', () => {
  it('leaves ordinary text alone', () => {
    expect(redactVendorText('Client authentication failed')).toBe('Client authentication failed');
  });
  it('redacts JWT-shaped strings', () => {
    expect(redactVendorText('bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-part here')).toBe('bad token [redacted] here');
  });
  it('redacts long token-like runs', () => {
    const secret = 'A'.repeat(20) + 'b1-._~+/=' + 'C'.repeat(10);
    expect(redactVendorText(`secret=${secret} end`)).toBe('secret=[redacted] end');
  });
  it('keeps runs shorter than 32 characters', () => {
    expect(redactVendorText('id 0123456789abcdef0123456789abcde')).toBe('id 0123456789abcdef0123456789abcde');
  });
  it('truncates after redacting', () => {
    const out = redactVendorText('word '.repeat(100));
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
    expect(redactVendorText('abc', 2)).toBe('ab…');
  });
});
```

Extend `oauthClient.test.ts`:

```ts
  it('redacts secrets echoed in error_description', async () => {
    const echoed = 'client_secret=' + 'S'.repeat(40);
    nock('https://login.example').post('/token').reply(401, { error: 'invalid_client', error_description: echoed });
    const err = await requestClientCredentialsToken('graphql', {
      grant: 'client_credentials', clientId: 'a', clientSecret: 'S'.repeat(40), tokenUrl: 'https://login.example/token',
    }).catch((e) => e);
    expect(err.message).not.toContain('S'.repeat(40));
    expect(err.message).toContain('[redacted]');
  });
```

Extend `GraphQLHttpClient.test.ts`:

```ts
  it('redacts token-like text in GraphQL error messages and bodies', async () => {
    const leaked = 'T'.repeat(48);
    nock('https://api.example.com').post('/graphql').reply(200, { errors: [{ message: `bad auth ${leaked}`, extensions: { code: 'UNAUTHENTICATED' } }] });
    const client = new GraphQLHttpClient('https://api.example.com/graphql', 'passthrough', 'tok');
    const err = await client.execute({ query: '{ a }' }).catch((e) => e);
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(leaked);
  });
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/gateway/redact.ts`:

```ts
export const REDACTED = '[redacted]';

const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const LONG_TOKEN = /[A-Za-z0-9._~+/=-]{32,}/g;

/** Scrubs token-like content from vendor-supplied text, then truncates it, before it reaches an error or a log. */
export function redactVendorText(text: string, maxLength = 200): string {
  const scrubbed = String(text).replace(JWT, REDACTED).replace(LONG_TOKEN, REDACTED);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}
```

Export: `export { redactVendorText, REDACTED } from './gateway/redact';`

Apply:
- `oauthClient.ts`: `const description = typeof body?.error_description === 'string' ? redactVendorText(body.error_description) : undefined;` and `vendorError: typeof body?.error === 'string' ? redactVendorText(body.error, 100) : undefined`.
- `GraphQLHttpClient.ts`: every vendor message goes through `redactVendorText`; `details.body` becomes `redactVendorText(body ? JSON.stringify(body) : text, 500)`; the GraphQL-errors branch uses `errors: body.errors.map((e) => ({ message: redactVendorText(String(e.message)), code: e.extensions?.code }))`.
- `GraphHttpClient.ts` `toGatewayError`: `redactVendorText(graphErr.message ?? 'Microsoft Graph request failed')` and `body: graphErr.body === undefined ? undefined : redactVendorText(typeof graphErr.body === 'string' ? graphErr.body : JSON.stringify(graphErr.body), 500)`.
- `adminRouter.ts` oauth callback: replace `${error.slice(0, 100)}` with `${redactVendorText(error, 100)}`.

Existing tests asserting the old `details.body`/`details.errors` shapes: update them to the new string/array shapes (behaviour change is intentional).

- [ ] **Step 4: Run** `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server/src/routers/adminRouter.ts
git commit -m "feat(core): redact and truncate vendor-supplied error text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Async scrypt, uniform-cost failures, password length cap

**Files:**
- Modify: `packages/core/src/auth/apiKeys.ts`, `packages/core/src/auth/adminAuth.ts`, `packages/core/src/storage/MappingStore.ts` (`assertAcceptablePassword`), `packages/core/src/index.ts`, `apps/server/src/middleware/apiKeyAuth.ts`, `apps/server/src/routers/adminRouter.ts` (login handler)
- Test: `packages/core/test/auth/apiKeys.test.ts`, `packages/core/test/auth/adminAuth.test.ts`, `packages/core/test/storage/MappingStore.test.ts`, `apps/cli/test/client.contract.test.ts`, `apps/cli/test/otherCommands.test.ts`, `apps/server/test/adminAuth.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function verifySecret(secret: string, hashedSecret: string): Promise<boolean>; // was sync
  export const DUMMY_SECRET_HASH: string;             // fixed hash verified against on unknown ids/usernames
  export const MAX_PASSWORD_LENGTH = 1024;             // exported from core index
  export async function loginAdmin(store, username, password, ttlMs?): Promise<{ token: string; expiresAt: string } | null>; // was sync
  ```
- `hashSecret` stays synchronous (admin/key creation only).

- [ ] **Step 1: Failing tests.**

In `packages/core/test/auth/apiKeys.test.ts` change the two assertions to `expect(await verifySecret(...)).toBe(true|false)` (make the `it` callbacks `async`) and add:

```ts
  it('verifies asynchronously without blocking the event loop for the whole hash', async () => {
    const key = generateApiKey();
    let ticked = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { ticked = true; resolve(); }));
    const result = verifySecret(key.plaintext.split('.')[1], key.hashedSecret);
    await tick;
    expect(ticked).toBe(true);
    expect(await result).toBe(true);
  });

  it('DUMMY_SECRET_HASH is a well-formed hash that matches nothing presented', async () => {
    expect(DUMMY_SECRET_HASH).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifySecret('anything', DUMMY_SECRET_HASH)).toBe(false);
  });
```

In `packages/core/test/auth/adminAuth.test.ts` make every `loginAdmin(...)` call `await loginAdmin(...)` and add:

```ts
  it('rejects an over-long password without hashing it', async () => {
    expect(await loginAdmin(store, 'admin', 'x'.repeat(1025))).toBeNull();
  });
```

In `packages/core/test/storage/MappingStore.test.ts` await `verifySecret` at line ~151 and add:

```ts
  it('rejects admin passwords longer than 1024 characters', () => {
    expect(() => store.createAdminUser({ username: 'long', password: 'x'.repeat(1025) })).toThrow('at most 1024');
    store.createAdminUser({ username: 'ok', password: 'x'.repeat(1024) });
    expect(() => store.setAdminPassword('ok', 'y'.repeat(1025))).toThrow('at most 1024');
  });
```

In `apps/cli/test/client.contract.test.ts` lines ~225/235: `expect(await loginAdmin(...)).not.toBeNull()` / `.toBeNull()`.

In `apps/cli/test/otherCommands.test.ts` line ~58 the sync `withStore` would close the DB before the async login finishes; replace that line with:

```ts
    const db = openDb(c.dbPath);
    try {
      expect(await loginAdmin(new MappingStore(db), 'ops', 'correct-horse-battery')).not.toBeNull();
    } finally {
      db.close();
    }
```

In `apps/server/test/adminAuth.integration.test.ts` add:

```ts
  it('rejects an over-long password on POST /admin/admin-users', async () => {
    const res = await admin.post('/admin/admin-users').send({ username: 'long', password: 'x'.repeat(1025) });
    expect(res.status).toBe(400);
  });
```

(use that file's existing admin client variable name).

- [ ] **Step 2: Run** `npm test` → FAIL (sync functions, missing exports).

- [ ] **Step 3: Implement.**

`packages/core/src/auth/apiKeys.ts`:

```ts
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

// ... GeneratedApiKey, generateApiKey, hashSecret unchanged ...

/** Verified against when the presented key id or username is unknown, so every failure path costs one scrypt. */
export const DUMMY_SECRET_HASH = hashSecret('graphtorest-dummy-secret');

export async function verifySecret(secret: string, hashedSecret: string): Promise<boolean> {
  const [salt, storedHex] = hashedSecret.split(':');
  if (!salt || !storedHex) return false;
  const derived = await scryptAsync(secret, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}
```

`packages/core/src/auth/adminAuth.ts`:

```ts
import { DUMMY_SECRET_HASH, verifySecret } from './apiKeys';
import type { MappingStore } from '../storage/MappingStore';

export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_PASSWORD_LENGTH = 1024;

export async function loginAdmin(
  store: MappingStore,
  username: string,
  password: string,
  ttlMs: number = DEFAULT_ADMIN_SESSION_TTL_MS
): Promise<{ token: string; expiresAt: string } | null> {
  if (password.length > MAX_PASSWORD_LENGTH) return null; // never hash attacker-sized input
  const user = store.findAdminUserByUsername(username);
  // Unknown usernames verify against a dummy hash so "no such user" and "wrong password" cost the same.
  const passwordOk = await verifySecret(password, user ? user.hashedPassword : DUMMY_SECRET_HASH);
  if (!user || !passwordOk) return null;
  return store.createAdminSession(user.id, ttlMs);
}
```

`MappingStore.ts`: import `MAX_PASSWORD_LENGTH` from `'../auth/adminAuth'` — **careful**: `adminAuth.ts` imports `type MappingStore` only, so no runtime cycle; if your build complains, move `MAX_PASSWORD_LENGTH` into `apiKeys.ts` and re-export it from `adminAuth.ts`. Extend `assertAcceptablePassword`:

```ts
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new GatewayError('INVALID_INPUT', `Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  }
```

`index.ts`: `export { generateApiKey, hashSecret, verifySecret, parsePresentedKey, DUMMY_SECRET_HASH } from './auth/apiKeys';` and `export { loginAdmin, DEFAULT_ADMIN_SESSION_TTL_MS, MAX_PASSWORD_LENGTH } from './auth/adminAuth';`

`apps/server/src/middleware/apiKeyAuth.ts`:

```ts
import type { RequestHandler, Response } from 'express';
import { parsePresentedKey, verifySecret, DUMMY_SECRET_HASH, type MappingStore } from '@graphtorest/core';

function reject(res: Response, message: string): void {
  res.locals.errorCode = 'UNAUTHORIZED';
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message, details: {} } });
}

export function createApiKeyAuth(mappingStore: MappingStore): RequestHandler {
  return async (req, res, next) => {
    try {
      const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
      if (!match) {
        reject(res, 'Missing API key');
        return;
      }
      const parsed = parsePresentedKey(match[1]);
      const record = parsed ? mappingStore.findApiKeyById(parsed.id) : null;
      // Always pay for one scrypt so malformed keys, unknown ids and wrong secrets are indistinguishable by timing.
      const secretOk = await verifySecret(parsed?.secret ?? '', record?.hashedKey ?? DUMMY_SECRET_HASH);
      if (!parsed || !record || !secretOk) {
        reject(res, 'Invalid API key');
        return;
      }
      mappingStore.touchApiKeyLastUsed(record.id);
      res.locals.apiKeyId = record.id;
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

`adminRouter.ts` login: make the handler `async (req, res, next) => { try { ... const result = await loginAdmin(...); ... } catch (err) { next(err); } }` (Express 4 does not catch async rejections itself). Leave everything else in the handler unchanged.

Also check `apps/cli/src/commands/admin.ts`'s `missing` help text mentions "12+ characters" — change it to "12–1024 characters".

- [ ] **Step 4: Run** `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server apps/cli
git commit -m "feat(auth): async scrypt with uniform-cost failures and a 1024-char password cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Admin login throttling

**Files:**
- Create: `apps/server/src/middleware/loginThrottle.ts`
- Modify: `apps/server/src/app.ts` (`AppDeps.loginThrottle`), `apps/server/src/routers/adminRouter.ts` (login handler, `AdminRouterOptions.loginThrottle`)
- Test: `apps/server/test/loginThrottle.test.ts`, `apps/server/test/loginThrottle.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LoginThrottleOptions { maxFailures?: number; windowMs?: number; baseLockoutMs?: number; maxLockoutMs?: number; now?: () => number; sweepIntervalMs?: number }
  export class LoginThrottle {
    constructor(options?: LoginThrottleOptions);
    retryAfterMs(keys: string[]): number;   // 0 = allowed; otherwise the longest remaining lockout among keys
    recordFailure(keys: string[]): void;
    recordSuccess(key: string): void;
    stop(): void;
  }
  export function loginThrottleKeys(username: string, ip: string | undefined): [userKey: string, ipKey: string];
  AppDeps.loginThrottle?: LoginThrottle; AdminRouterOptions.loginThrottle?: LoginThrottle
  ```
  Defaults: 5 failures / 15 min window → 60 s lockout, doubling per further failure, capped at 15 min; sweep every 60 s (`unref`'d).

- [ ] **Step 1: Failing unit test** — `apps/server/test/loginThrottle.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { LoginThrottle, loginThrottleKeys } from '../src/middleware/loginThrottle';

let t = 0;
const throttles: LoginThrottle[] = [];
function make() {
  t = 1_000_000;
  const throttle = new LoginThrottle({ now: () => t });
  throttles.push(throttle);
  return throttle;
}
afterEach(() => throttles.splice(0).forEach((x) => x.stop()));

const MIN = 60_000;
const keys = loginThrottleKeys('Admin ', '1.2.3.4');

describe('LoginThrottle', () => {
  it('normalizes the username key', () => {
    expect(keys).toEqual(['user:admin', 'ip:1.2.3.4']);
    expect(loginThrottleKeys('x', undefined)[1]).toBe('ip:unknown');
  });

  it('locks out after 5 failures for 1 minute', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(0);
    th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(MIN);
    t += MIN;
    expect(th.retryAfterMs(keys)).toBe(0);
  });

  it('doubles the lockout per further failure, capped at 15 minutes', () => {
    const th = make();
    for (let i = 0; i < 5; i++) th.recordFailure(keys);
    const lockouts: number[] = [];
    for (let i = 0; i < 6; i++) {
      t += th.retryAfterMs(keys);
      th.recordFailure(keys);
      lockouts.push(th.retryAfterMs(keys));
    }
    expect(lockouts).toEqual([2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN, 15 * MIN, 15 * MIN]);
  });

  it('forgets failures older than the window', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    t += 15 * MIN + 1;
    th.recordFailure(keys);
    expect(th.retryAfterMs(keys)).toBe(0);
  });

  it('a lockout on either key blocks', () => {
    const th = make();
    for (let i = 0; i < 5; i++) th.recordFailure(['user:a', 'ip:9.9.9.9']);
    expect(th.retryAfterMs(['user:b', 'ip:9.9.9.9'])).toBe(MIN);
    expect(th.retryAfterMs(['user:a', 'ip:8.8.8.8'])).toBe(MIN);
  });

  it('success clears the username key only', () => {
    const th = make();
    for (let i = 0; i < 4; i++) th.recordFailure(keys);
    th.recordSuccess(keys[0]);
    th.recordFailure(keys);
    expect(th.retryAfterMs([keys[0], 'ip:other'])).toBe(0);
    expect(th.retryAfterMs(['user:other', keys[1]])).toBe(MIN);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `apps/server/src/middleware/loginThrottle.ts`:

```ts
export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  now?: () => number;
  sweepIntervalMs?: number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export function loginThrottleKeys(username: string, ip: string | undefined): [string, string] {
  return [`user:${username.trim().toLowerCase()}`, `ip:${ip ?? 'unknown'}`];
}

/** In-memory failed-login counters per username and per client IP (single-process deployment). */
export class LoginThrottle {
  private entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly baseLockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.baseLockoutMs = options.baseLockoutMs ?? 60_000;
    this.maxLockoutMs = options.maxLockoutMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  retryAfterMs(keys: string[]): number {
    const now = this.now();
    return Math.max(0, ...keys.map((key) => (this.entries.get(key)?.lockedUntil ?? 0) - now));
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      let entry = this.entries.get(key);
      if (!entry || this.isExpired(entry, now)) {
        entry = { failures: 0, windowStart: now, lockedUntil: 0 };
        this.entries.set(key, entry);
      }
      entry.failures += 1;
      if (entry.failures >= this.maxFailures) {
        const lockout = Math.min(this.baseLockoutMs * 2 ** (entry.failures - this.maxFailures), this.maxLockoutMs);
        entry.lockedUntil = now + lockout;
      }
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * A never-locked entry expires one window after its first failure. A key that has been locked out keeps
   * escalating until it goes a full window without failing after its last lockout ended.
   */
  private isExpired(entry: Entry, now: number): boolean {
    return entry.lockedUntil === 0 ? now - entry.windowStart > this.windowMs : now - entry.lockedUntil > this.windowMs;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (this.isExpired(entry, now)) this.entries.delete(key);
  }
}
```

- [ ] **Step 4: Run** unit test → PASS.

- [ ] **Step 5: Failing integration test** — `apps/server/test/loginThrottle.integration.test.ts` (set up like `adminAuth.integration.test.ts`, but construct the app with `loginThrottle: new LoginThrottle({ now: () => clock })` and a `let clock = 1_000_000`; stop it in `afterEach`):

```ts
  it('returns 429 LOGIN_THROTTLED with Retry-After after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/admin/login').send({ username: 'test-admin', password: 'wrong-password-000' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_THROTTLED');
    expect(blocked.headers['retry-after']).toBe('60');
    clock += 60_000;
    const ok = await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('counts an over-long password as a failure', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/admin/login').send({ username: 'test-admin', password: 'x'.repeat(2000) });
    expect((await request(app).post('/admin/login').send({ username: 'test-admin', password: TEST_ADMIN_PASSWORD })).status).toBe(429);
  });
```

(`TEST_ADMIN_PASSWORD` and the `test-admin` user come from `createAdminClient` in `./helpers`.)

- [ ] **Step 6: Wire in.** `AdminRouterOptions.loginThrottle?: LoginThrottle`; in `createAdminRouter`: `const loginThrottle = options.loginThrottle ?? new LoginThrottle();`. Login handler, after input validation:

```ts
      const keys = loginThrottleKeys(username, req.ip);
      const retryMs = loginThrottle.retryAfterMs(keys);
      if (retryMs > 0) {
        const retryAfterSeconds = Math.ceil(retryMs / 1000);
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.locals.errorCode = 'LOGIN_THROTTLED';
        res.status(429).json({
          error: { code: 'LOGIN_THROTTLED', message: 'Too many failed login attempts; try again later', details: { retryAfterSeconds } },
        });
        return;
      }
      const result = await loginAdmin(mappingStore, username, password, options.sessionTtlMs);
      if (!result) {
        loginThrottle.recordFailure(keys);
        // ...existing 401
      }
      loginThrottle.recordSuccess(keys[0]);
```

`AppDeps.loginThrottle?: LoginThrottle` passed through to the admin router options.

- [ ] **Step 7: Run** `npm test` → green.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(server): throttle failed admin logins per username and client IP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Rate-limit settings — core types, storage and admin API

**Files:**
- Create: `packages/core/src/rateLimit/rateLimitConfig.ts`, `packages/core/src/rateLimit/TokenBucket.ts`
- Modify: `packages/core/src/storage/MappingStore.ts`, `packages/core/src/index.ts`, `apps/server/src/routers/adminRouter.ts`
- Test: `packages/core/test/rateLimit/rateLimitConfig.test.ts`, `packages/core/test/rateLimit/TokenBucket.test.ts`, `packages/core/test/storage/MappingStore.test.ts`, `apps/server/test/adminEndpoints.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateLimit { requestsPerMinute: number; burst: number }
  export type RateLimitSetting = RateLimit | 'unlimited' | null;   // null = server default
  export const MAX_RATE_LIMIT = 1_000_000;
  export function parseRateLimitSetting(input: unknown): RateLimitSetting;              // GatewayError INVALID_INPUT
  export function serializeRateLimitSetting(setting: RateLimitSetting): string | null;
  export function deserializeRateLimitSetting(text: string | null): RateLimitSetting;   // invalid stored JSON → null
  export function effectiveRateLimit(setting: RateLimitSetting, serverDefault: RateLimit | null): RateLimit | null; // null = unlimited
  export function formatRateLimitSetting(setting: RateLimitSetting): string;            // 'default' | 'unlimited' | '60/min (burst 20)'
  export interface TakeResult { allowed: boolean; remaining: number; retryAfterMs: number; resetMs: number }
  export class TokenBucket { constructor(limit: RateLimit, now: number, initialTokens?: number); readonly limit: RateLimit; take(now: number): TakeResult; tokensAt(now: number): number; isFull(now: number): boolean }
  // MappingStore
  ApiKeySummary gains `rateLimit: RateLimitSetting`
  createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): GeneratedApiKey & ApiKeyRecord & { rateLimit: RateLimitSetting }
  findApiKeyById(id): { id: string; hashedKey: string; rateLimit: RateLimitSetting } | null
  getApiKey(id: string): ApiKeySummary | null
  setApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): ApiKeySummary | null
  // Admin API
  POST  /admin/api-keys        body { label?, rateLimit? } → 201 { id, plaintext, label, rateLimit }
  PATCH /admin/api-keys/:id    body { rateLimit }          → 200 ApiKeySummary | 400 | 404
  GET   /admin/api-keys        → ApiKeySummary[] (with rateLimit)
  ```

- [ ] **Step 1: Failing tests.**

`packages/core/test/rateLimit/rateLimitConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseRateLimitSetting, serializeRateLimitSetting, deserializeRateLimitSetting, effectiveRateLimit, formatRateLimitSetting,
} from '../../src/rateLimit/rateLimitConfig';

describe('rate-limit settings', () => {
  it('parses null, unlimited and objects (burst defaults to the rate)', () => {
    expect(parseRateLimitSetting(null)).toBeNull();
    expect(parseRateLimitSetting('unlimited')).toBe('unlimited');
    expect(parseRateLimitSetting({ requestsPerMinute: 60 })).toEqual({ requestsPerMinute: 60, burst: 60 });
    expect(parseRateLimitSetting({ requestsPerMinute: 60, burst: 5 })).toEqual({ requestsPerMinute: 60, burst: 5 });
  });

  it.each([[0], ['60'], [{}], [{ requestsPerMinute: 0 }], [{ requestsPerMinute: 1.5 }], [{ requestsPerMinute: 10, burst: 0 }],
    [{ requestsPerMinute: 2_000_000 }], [{ requestsPerMinute: 10, extra: 1 }], [[]], ['UNLIMITED']])('rejects %j', (input) => {
    expect(() => parseRateLimitSetting(input)).toThrow();
  });

  it('round-trips through storage and tolerates corrupt rows', () => {
    for (const s of [null, 'unlimited', { requestsPerMinute: 5, burst: 2 }] as const) {
      expect(deserializeRateLimitSetting(serializeRateLimitSetting(s))).toEqual(s);
    }
    expect(deserializeRateLimitSetting('{not json')).toBeNull();
  });

  it('resolves the effective limit', () => {
    const def = { requestsPerMinute: 60, burst: 60 };
    expect(effectiveRateLimit(null, def)).toEqual(def);
    expect(effectiveRateLimit(null, null)).toBeNull();
    expect(effectiveRateLimit('unlimited', def)).toBeNull();
    expect(effectiveRateLimit({ requestsPerMinute: 1, burst: 1 }, def)).toEqual({ requestsPerMinute: 1, burst: 1 });
  });

  it('formats for display', () => {
    expect(formatRateLimitSetting(null)).toBe('default');
    expect(formatRateLimitSetting('unlimited')).toBe('unlimited');
    expect(formatRateLimitSetting({ requestsPerMinute: 60, burst: 20 })).toBe('60/min (burst 20)');
  });
});
```

`packages/core/test/rateLimit/TokenBucket.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/rateLimit/TokenBucket';

describe('TokenBucket', () => {
  it('allows a burst then refuses with the time until the next token', () => {
    const b = new TokenBucket({ requestsPerMinute: 60, burst: 3 }, 0); // 1 token/second
    expect([b.take(0), b.take(0), b.take(0)].every((r) => r.allowed)).toBe(true);
    const refused = b.take(0);
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    expect(refused.resetMs).toBe(3000);
  });

  it('refills at the configured rate up to the burst', () => {
    const b = new TokenBucket({ requestsPerMinute: 60, burst: 2 }, 0);
    b.take(0); b.take(0);
    expect(b.take(500).allowed).toBe(false);
    expect(b.take(1000).allowed).toBe(true);
    expect(b.tokensAt(60_000)).toBe(2);
    expect(b.isFull(60_000)).toBe(true);
  });

  it('caps initial tokens at the burst', () => {
    expect(new TokenBucket({ requestsPerMinute: 10, burst: 1 }, 0, 50).tokensAt(0)).toBe(1);
  });
});
```

Add to `MappingStore.test.ts`:

```ts
  it('stores, lists and updates per-key rate limits', () => {
    const plain = store.createApiKey({ label: 'a' });
    const limited = store.createApiKey({ label: 'b', rateLimit: { requestsPerMinute: 10, burst: 2 } });
    expect(plain.rateLimit).toBeNull();
    expect(store.findApiKeyById(limited.id)!.rateLimit).toEqual({ requestsPerMinute: 10, burst: 2 });
    expect(store.setApiKeyRateLimit(plain.id, 'unlimited')!.rateLimit).toBe('unlimited');
    expect(store.listApiKeys().map((k) => k.rateLimit)).toEqual(['unlimited', { requestsPerMinute: 10, burst: 2 }]);
    expect(store.setApiKeyRateLimit('missing', null)).toBeNull();
    expect(store.getApiKey(limited.id)!.label).toBe('b');
  });
```

Add to `apps/server/test/adminEndpoints.integration.test.ts` (use that file's admin client):

```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/rateLimit/rateLimitConfig.ts`:

```ts
import { GatewayError } from '../gateway/errors';

export interface RateLimit {
  requestsPerMinute: number;
  burst: number;
}

/** A key's stored override: a limit, "unlimited", or null to use the server default. */
export type RateLimitSetting = RateLimit | 'unlimited' | null;

export const MAX_RATE_LIMIT = 1_000_000;

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_RATE_LIMIT) {
    throw invalid(`"${field}" must be an integer from 1 to ${MAX_RATE_LIMIT}`);
  }
  return value;
}

export function parseRateLimitSetting(input: unknown): RateLimitSetting {
  if (input === null) return null;
  if (input === 'unlimited') return 'unlimited';
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('"rateLimit" must be null, "unlimited", or { requestsPerMinute, burst? }');
  }
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== 'requestsPerMinute' && key !== 'burst');
  if (unknown.length > 0) throw invalid(`Unknown rateLimit field(s): ${unknown.join(', ')}`);
  const requestsPerMinute = positiveInt(raw.requestsPerMinute, 'rateLimit.requestsPerMinute');
  const burst = raw.burst === undefined ? requestsPerMinute : positiveInt(raw.burst, 'rateLimit.burst');
  return { requestsPerMinute, burst };
}

export function serializeRateLimitSetting(setting: RateLimitSetting): string | null {
  return setting === null ? null : JSON.stringify(setting);
}

export function deserializeRateLimitSetting(text: string | null): RateLimitSetting {
  if (text === null) return null;
  try {
    return parseRateLimitSetting(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The limit that applies to a key, or null for unlimited. */
export function effectiveRateLimit(setting: RateLimitSetting, serverDefault: RateLimit | null): RateLimit | null {
  if (setting === 'unlimited') return null;
  return setting ?? serverDefault;
}

export function formatRateLimitSetting(setting: RateLimitSetting): string {
  if (setting === null) return 'default';
  if (setting === 'unlimited') return 'unlimited';
  return `${setting.requestsPerMinute}/min (burst ${setting.burst})`;
}
```

`packages/core/src/rateLimit/TokenBucket.ts`:

```ts
import type { RateLimit } from './rateLimitConfig';

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until one token is available (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the bucket is full again. */
  resetMs: number;
}

/** Classic token bucket: capacity `burst`, refilled at `requestsPerMinute`. Time is always passed in (testable). */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(readonly limit: RateLimit, now: number, initialTokens: number = limit.burst) {
    this.tokens = Math.min(initialTokens, limit.burst);
    this.updatedAt = now;
  }

  private get perMs(): number {
    return this.limit.requestsPerMinute / 60_000;
  }

  private refill(now: number): void {
    if (now > this.updatedAt) {
      this.tokens = Math.min(this.limit.burst, this.tokens + (now - this.updatedAt) * this.perMs);
      this.updatedAt = now;
    }
  }

  tokensAt(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  isFull(now: number): boolean {
    return this.tokensAt(now) >= this.limit.burst;
  }

  take(now: number): TakeResult {
    this.refill(now);
    const allowed = this.tokens >= 1;
    if (allowed) this.tokens -= 1;
    return {
      allowed,
      remaining: this.tokens,
      retryAfterMs: allowed ? 0 : Math.ceil((1 - this.tokens) / this.perMs),
      resetMs: Math.ceil((this.limit.burst - this.tokens) / this.perMs),
    };
  }
}
```

Export from `index.ts`:

```ts
export {
  parseRateLimitSetting, serializeRateLimitSetting, deserializeRateLimitSetting, effectiveRateLimit, formatRateLimitSetting, MAX_RATE_LIMIT,
} from './rateLimit/rateLimitConfig';
export type { RateLimit, RateLimitSetting } from './rateLimit/rateLimitConfig';
export { TokenBucket } from './rateLimit/TokenBucket';
export type { TakeResult } from './rateLimit/TokenBucket';
```

`MappingStore.ts`:
- `import { serializeRateLimitSetting, deserializeRateLimitSetting, type RateLimitSetting } from '../rateLimit/rateLimitConfig';`
- `ApiKeySummary` gains `rateLimit: RateLimitSetting;`
- Add a private row mapper and use it in `listApiKeys`/`getApiKey`:

```ts
const API_KEY_COLUMNS = 'id, label, created_at as createdAt, last_used_at as lastUsedAt, rate_limit_config as rateLimitConfig';
type ApiKeyRow = Omit<ApiKeySummary, 'rateLimit'> & { rateLimitConfig: string | null };
function mapApiKeyRow({ rateLimitConfig, ...rest }: ApiKeyRow): ApiKeySummary {
  return { ...rest, rateLimit: deserializeRateLimitSetting(rateLimitConfig) };
}
```

```ts
  createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): GeneratedApiKey & ApiKeyRecord & { rateLimit: RateLimitSetting } {
    const generated = generateApiKey();
    const label = input.label ?? null;
    const rateLimit = input.rateLimit ?? null;
    this.db
      .prepare('INSERT INTO api_keys (id, hashed_key, label, rate_limit_config) VALUES (?, ?, ?, ?)')
      .run(generated.id, generated.hashedSecret, label, serializeRateLimitSetting(rateLimit));
    return { ...generated, label, rateLimit };
  }

  findApiKeyById(id: string): { id: string; hashedKey: string; rateLimit: RateLimitSetting } | null {
    const row = this.db
      .prepare('SELECT id, hashed_key as hashedKey, rate_limit_config as rateLimitConfig FROM api_keys WHERE id = ?')
      .get(id) as { id: string; hashedKey: string; rateLimitConfig: string | null } | undefined;
    return row ? { id: row.id, hashedKey: row.hashedKey, rateLimit: deserializeRateLimitSetting(row.rateLimitConfig) } : null;
  }

  getApiKey(id: string): ApiKeySummary | null {
    const row = this.db.prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(id) as ApiKeyRow | undefined;
    return row ? mapApiKeyRow(row) : null;
  }

  setApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): ApiKeySummary | null {
    const changes = this.db.prepare('UPDATE api_keys SET rate_limit_config = ? WHERE id = ?').run(serializeRateLimitSetting(rateLimit), id).changes;
    return changes > 0 ? this.getApiKey(id) : null;
  }

  listApiKeys(): ApiKeySummary[] {
    return (this.db.prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys ORDER BY created_at, id`).all() as ApiKeyRow[]).map(mapApiKeyRow);
  }
```

`adminRouter.ts`:

```ts
  router.post('/api-keys', (req, res) => {
    const { label, rateLimit } = req.body ?? {};
    const created = mappingStore.createApiKey({ label, rateLimit: rateLimit === undefined ? null : parseRateLimitSetting(rateLimit) });
    res.status(201).json({ id: created.id, plaintext: created.plaintext, label: created.label, rateLimit: created.rateLimit });
  });

  router.patch('/api-keys/:id', (req, res) => {
    const body = req.body ?? {};
    if (!Object.prototype.hasOwnProperty.call(body, 'rateLimit')) throw new GatewayError('INVALID_INPUT', '"rateLimit" is required', 400);
    const updated = mappingStore.setApiKeyRateLimit(req.params.id, parseRateLimitSetting(body.rateLimit));
    if (!updated) throw new GatewayError('NOT_FOUND', 'API key not found', 404);
    res.json(updated);
  });
```

Update any existing test that `toEqual`s an `ApiKeySummary`/created-key body to include `rateLimit: null`.

- [ ] **Step 4: Run** `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server
git commit -m "feat: per-API-key rate-limit settings in storage and the admin API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Rate-limiting middleware on /api

**Files:**
- Create: `apps/server/src/middleware/rateLimit.ts`
- Modify: `apps/server/src/middleware/apiKeyAuth.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/rateLimit.integration.test.ts`

**Interfaces:**
- Consumes: Task 8 (`TokenBucket`, `effectiveRateLimit`, `RateLimit`, `RateLimitSetting`, `findApiKeyById().rateLimit`), `ServerConfig.rateLimitDefault`.
- Produces:
  ```ts
  export interface RateLimiterOptions { defaultLimit: RateLimit | null; now?: () => number; sweepIntervalMs?: number }
  export class RateLimiter { constructor(options: RateLimiterOptions); middleware(): RequestHandler; stop(): void }
  AppDeps.rateLimiter?: RateLimiter   // default: new RateLimiter({ defaultLimit: null })
  res.locals.apiKeyRateLimit: RateLimitSetting   // set by apiKeyAuth
  ```

- [ ] **Step 1: Failing test** — `apps/server/test/rateLimit.integration.test.ts` (DB/app setup like `requestLogging.integration.test.ts`; build the app through a helper so each test can choose the default):

```ts
let clock = 1_000_000;
let limiter: RateLimiter;

function build(defaultLimit: RateLimit | null) {
  limiter = new RateLimiter({ defaultLimit, now: () => clock });
  app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: true, adminEnabled: true, rateLimiter: limiter });
  admin = createAdminClient(app, store);
}
afterEach(() => limiter.stop());

async function seed() {
  const conn = await admin.post('/admin/connections').send({ name: 'm', adapterType: 'mock', authMode: 'passthrough' });
  await admin.post('/admin/mappings').send({ connectionId: conn.body.id, route: '/users/{id}', method: 'GET', operation: { resource: 'user' } });
}
const call = (key: string) => request(app).get('/api/users/1').set('Authorization', `Bearer ${key}`);

describe('rate limiting', () => {
  it('is off by default', async () => {
    build(null);
    await seed();
    const key = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    for (let i = 0; i < 20; i++) expect((await call(key)).status).toBe(200);
    expect((await call(key)).headers['ratelimit-limit']).toBeUndefined();
  });

  it('enforces the server default with 429, Retry-After and RateLimit headers', async () => {
    build({ requestsPerMinute: 60, burst: 2 });
    await seed();
    const key = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    const first = await call(key);
    expect(first.headers).toMatchObject({ 'ratelimit-limit': '2', 'ratelimit-remaining': '1' });
    await call(key);
    const refused = await call(key);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 1 } });
    expect(refused.headers['retry-after']).toBe('1');
    clock += 1000;
    expect((await call(key)).status).toBe(200);
  });

  it('per-key overrides beat the default, including unlimited', async () => {
    build({ requestsPerMinute: 60, burst: 1 });
    await seed();
    const open = (await admin.post('/admin/api-keys').send({ rateLimit: 'unlimited' })).body.plaintext;
    const roomy = (await admin.post('/admin/api-keys').send({ rateLimit: { requestsPerMinute: 60, burst: 5 } })).body.plaintext;
    for (let i = 0; i < 5; i++) expect((await call(roomy)).status).toBe(200);
    expect((await call(roomy)).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await call(open)).status).toBe(200);
  });

  it('applies a changed limit on the next request', async () => {
    build(null);
    await seed();
    const created = (await admin.post('/admin/api-keys').send({ rateLimit: { requestsPerMinute: 600, burst: 100 } })).body;
    for (let i = 0; i < 3; i++) await call(created.plaintext);
    await admin.patch(`/admin/api-keys/${created.id}`).send({ rateLimit: { requestsPerMinute: 1, burst: 1 } });
    expect((await call(created.plaintext)).status).toBe(200);
    expect((await call(created.plaintext)).status).toBe(429);
  });

  it('limits keys independently and does not count rejected auth', async () => {
    build({ requestsPerMinute: 60, burst: 1 });
    await seed();
    const a = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    const b = (await admin.post('/admin/api-keys').send({})).body.plaintext;
    await call(a);
    expect((await call(a)).status).toBe(429);
    expect((await call(b)).status).toBe(200);
    expect((await call('bogus.key')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `apps/server/src/middleware/rateLimit.ts`:

```ts
import type { RequestHandler } from 'express';
import { TokenBucket, effectiveRateLimit, type RateLimit, type RateLimitSetting } from '@graphtorest/core';

export interface RateLimiterOptions {
  defaultLimit: RateLimit | null;
  now?: () => number;
  sweepIntervalMs?: number;
}

/** In-memory token buckets per API key id (single-process deployment, spec §6.3). Runs after API-key auth. */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  middleware(): RequestHandler {
    return (_req, res, next) => {
      const keyId = res.locals.apiKeyId as string | undefined;
      const setting = (res.locals.apiKeyRateLimit as RateLimitSetting | undefined) ?? null;
      const limit = effectiveRateLimit(setting, this.options.defaultLimit);
      if (!keyId || !limit) {
        next();
        return;
      }
      const now = this.now();
      let bucket = this.buckets.get(keyId);
      if (!bucket || bucket.limit.requestsPerMinute !== limit.requestsPerMinute || bucket.limit.burst !== limit.burst) {
        // A changed limit applies immediately; carry over at most the new burst so lowering a limit cannot grant a burst.
        bucket = new TokenBucket(limit, now, bucket ? bucket.tokensAt(now) : limit.burst);
        this.buckets.set(keyId, bucket);
      }
      const result = bucket.take(now);
      res.setHeader('RateLimit-Limit', String(limit.burst));
      res.setHeader('RateLimit-Remaining', String(Math.floor(result.remaining)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
      if (result.allowed) {
        next();
        return;
      }
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.locals.errorCode = 'RATE_LIMITED';
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded', details: { retryAfterSeconds } } });
    };
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [keyId, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(keyId);
  }
}
```

`apiKeyAuth.ts`: after `res.locals.apiKeyId = record.id;` add `res.locals.apiKeyRateLimit = record.rateLimit;`.

`app.ts`: `rateLimiter?: RateLimiter` in `AppDeps`; `const rateLimiter = deps.rateLimiter ?? new RateLimiter({ defaultLimit: null });`; `/api` chain becomes `createRequestLogger(...), createActivityLogger(...), createApiKeyAuth(...), rateLimiter.middleware(), createApiRouter(...)`.

`index.ts`: `const rateLimiter = new RateLimiter({ defaultLimit: config.rateLimitDefault });` passed to `createApp` (Task 14 stops it on shutdown).

- [ ] **Step 4: Run** `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): enforce per-API-key token-bucket rate limits on /api

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Rate limits in the CLI and web UI

**Files:**
- Modify: `apps/cli/src/client/types.ts`, `apps/cli/src/client/embedded.ts`, `apps/cli/src/client/remote.ts`, `apps/cli/src/commands/apikey.ts`, `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/pages/ApiKeysPage.tsx`
- Test: `apps/cli/test/client.contract.test.ts`, `apps/cli/test/otherCommands.test.ts`, `apps/web/test/apiKeys.test.tsx`

**Interfaces:**
- Consumes: Task 8 core exports and admin API.
- Produces:
  ```ts
  // CLI GtrClient
  createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): Promise<CreatedApiKey>  // CreatedApiKey gains rateLimit
  updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): Promise<ApiKeySummary>
  // CLI command helper (exported for tests)
  export function rateLimitFromFlags(opts: { rateLimit?: string; burst?: string; unlimited?: boolean; default?: boolean }): RateLimitSetting | undefined
  // web
  export type RateLimitSetting = { requestsPerMinute: number; burst: number } | 'unlimited' | null;
  api.createApiKey(input: { label?: string; rateLimit?: RateLimitSetting })
  api.updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting)
  ```

- [ ] **Step 1: Failing tests.**

`client.contract.test.ts` (both modes), new describe:

```ts
  describe('api key rate limits', () => {
    it('creates with a limit, updates, clears and validates', async () => {
      const created = await h.client.createApiKey({ label: 'ci', rateLimit: { requestsPerMinute: 30, burst: 30 } });
      expect(created.rateLimit).toEqual({ requestsPerMinute: 30, burst: 30 });
      expect((await h.client.updateApiKeyRateLimit(created.id, 'unlimited')).rateLimit).toBe('unlimited');
      expect((await h.client.updateApiKeyRateLimit(created.id, null)).rateLimit).toBeNull();
      expect(await codeOf(h.client.updateApiKeyRateLimit(created.id, { requestsPerMinute: 0, burst: 1 }))).toBe('INVALID_INPUT');
      expect(await codeOf(h.client.updateApiKeyRateLimit('missing', null))).toBe('NOT_FOUND');
    });
  });
```

`otherCommands.test.ts` — update the two existing apikey tests: the `--json` keys become `['id', 'label', 'plaintext', 'rateLimit']`, and the list header regex becomes `^ID\\s+LABEL\\s+RATE LIMIT\\s+CREATED\\s+LAST USED\\n${key.id}\\s+ci\\s+default\\s+\\S.*\\s+never\\n$`. Add:

```ts
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
```

`apps/web/test/apiKeys.test.tsx` — add `rateLimit: null` to `KEY`, then:

```ts
  it('shows each key’s rate limit', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [{ ...KEY, rateLimit: { requestsPerMinute: 60, burst: 10 } }] }]);
    renderApp('/api-keys');
    expect(await screen.findByText('60/min (burst 10)')).toBeTruthy();
  });

  it('creates a key with a rate limit', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.s', label: null, rateLimit: { requestsPerMinute: 30, burst: 30 } } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.change(screen.getByLabelText('Rate limit (requests/min, empty = server default)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByText('k2.s');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ rateLimit: { requestsPerMinute: 30, burst: 30 } });
  });

  it('edits a key’s rate limit', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [KEY] },
      { method: 'PATCH', path: '/admin/api-keys/k1', body: { ...KEY, rateLimit: 'unlimited' } },
    ]);
    renderApp('/api-keys');
    const row = (await screen.findByText('dev')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: 'unlimited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ rateLimit: 'unlimited' });
  });
```

The existing "shows a new key once" test must still see exactly `{ label: 'ci' }` as the POST body — only include `rateLimit` when the field is filled.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement CLI.**

`types.ts`: import `RateLimitSetting` from `@graphtorest/core` and re-export it; `CreatedApiKey` gains `rateLimit: RateLimitSetting;`; change `createApiKey(input: { label?: string; rateLimit?: RateLimitSetting })`; add `updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): Promise<ApiKeySummary>;`.

`embedded.ts`:

```ts
  async createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): Promise<CreatedApiKey> {
    const rateLimit = input.rateLimit === undefined ? null : parseRateLimitSetting(input.rateLimit);
    const created = this.store.createApiKey({ label: input.label, rateLimit });
    return { id: created.id, plaintext: created.plaintext, label: created.label, rateLimit: created.rateLimit };
  }

  async updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting) {
    const updated = this.store.setApiKeyRateLimit(id, parseRateLimitSetting(rateLimit));
    if (!updated) throw notFound('API key not found');
    return updated;
  }
```

`remote.ts`:

```ts
  createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): Promise<CreatedApiKey> {
    return this.request('POST', '/api-keys', { body: input });
  }

  updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): Promise<ApiKeySummary> {
    return this.request('PATCH', `/api-keys/${enc(id)}`, { body: { rateLimit } });
  }
```

`commands/apikey.ts` — add (and export) the flag parser, and extend the commands:

```ts
import { formatRateLimitSetting, type RateLimitSetting } from '@graphtorest/core';
import { usageError } from '../errors';

interface RateLimitFlags {
  rateLimit?: string;
  burst?: string;
  unlimited?: boolean;
  default?: boolean;
}

function positiveIntFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${flag} must be a positive integer`);
  return n;
}

/** Maps the flags to a setting; undefined means "no rate-limit flag given". */
export function rateLimitFromFlags(opts: RateLimitFlags): RateLimitSetting | undefined {
  const chosen = [opts.rateLimit !== undefined, opts.unlimited === true, opts.default === true].filter(Boolean).length;
  if (chosen > 1) throw usageError('Use only one of --rate-limit, --unlimited, --default');
  if (opts.burst !== undefined && opts.rateLimit === undefined) throw usageError('--burst requires --rate-limit');
  if (opts.unlimited) return 'unlimited';
  if (opts.default) return null;
  if (opts.rateLimit === undefined) return undefined;
  const requestsPerMinute = positiveIntFlag(opts.rateLimit, '--rate-limit');
  return { requestsPerMinute, burst: opts.burst === undefined ? requestsPerMinute : positiveIntFlag(opts.burst, '--burst') };
}
```

`create`: add `.option('--rate-limit <perMinute>', 'requests per minute for this key (default: server default)')`, `.option('--burst <n>', 'bucket size (default: the rate)')`, `.option('--unlimited', 'exempt this key from rate limiting')`; in the action `const rateLimit = rateLimitFromFlags(opts);` then `createApiKey({ label: opts.label, ...(rateLimit !== undefined ? { rateLimit } : {}) })`. Keep the existing human output; when `k.rateLimit !== null` append `\nRate limit: ${formatRateLimitSetting(k.rateLimit)}`.

New `update <id>` command:

```ts
  apikey
    .command('update <id>')
    .description("change an API key's rate limit")
    .option('--rate-limit <perMinute>', 'requests per minute')
    .option('--burst <n>', 'bucket size (default: the rate)')
    .option('--unlimited', 'exempt this key from rate limiting')
    .option('--default', 'use the server default (RATE_LIMIT_DEFAULT)')
    .action(
      action(ctx, async (rt, id: string, opts: RateLimitFlags) => {
        const rateLimit = rateLimitFromFlags(opts);
        if (rateLimit === undefined) throw usageError('Nothing to update: pass --rate-limit, --unlimited or --default');
        const updated = await rt.client().updateApiKeyRateLimit(id, rateLimit);
        rt.out.result(updated, (k) => `API key ${k.id} rate limit: ${formatRateLimitSetting(k.rateLimit)}.`);
      })
    );
```

`list` table: headers `['ID', 'LABEL', 'RATE LIMIT', 'CREATED', 'LAST USED']`, row `[k.id, k.label ?? '-', formatRateLimitSetting(k.rateLimit), k.createdAt, k.lastUsedAt ?? 'never']`.

Note: flag validation happens before `rt.client()` so a usage error never opens a DB or makes a request.

- [ ] **Step 4: Implement web.**

`types.ts`:

```ts
export type RateLimitSetting = { requestsPerMinute: number; burst: number } | 'unlimited' | null;
// ApiKeySummary gains:
  rateLimit: RateLimitSetting;
// CreatedApiKey gains:
  rateLimit: RateLimitSetting;
```

`api.ts`:

```ts
  createApiKey: (input: { label?: string; rateLimit?: RateLimitSetting }) =>
    apiFetch<CreatedApiKey>('/admin/api-keys', { method: 'POST', body: input }),
  updateApiKeyRateLimit: (id: string, rateLimit: RateLimitSetting) =>
    apiFetch<ApiKeySummary>(`/admin/api-keys/${enc(id)}`, { method: 'PATCH', body: { rateLimit } }),
```

`ApiKeysPage.tsx` changes:
- Local formatter (the web bundle does not import core):

```ts
function formatRateLimit(setting: RateLimitSetting): string {
  if (setting === null) return 'server default';
  if (setting === 'unlimited') return 'unlimited';
  return `${setting.requestsPerMinute}/min (burst ${setting.burst})`;
}
```

  The list test expects `60/min (burst 10)`; `null` shows "server default".
- Create form: two new state fields `rate` and `burst` (strings) with inputs labelled exactly `Rate limit (requests/min, empty = server default)` and `Burst (optional)`, `type="number" min={1}`. `mutationFn` builds the body:

```ts
    mutationFn: () => {
      const input: { label?: string; rateLimit?: RateLimitSetting } = {};
      if (label.trim()) input.label = label.trim();
      if (rate.trim()) {
        const requestsPerMinute = Number(rate);
        input.rateLimit = { requestsPerMinute, burst: burst.trim() ? Number(burst) : requestsPerMinute };
      }
      return api.createApiKey(input);
    },
```

  (server-side validation reports bad numbers through `FormError`). Reset `rate`/`burst` on success.
- Table: add a `Rate limit` column showing `formatRateLimit(key.rateLimit)` and, next to Revoke, a `button` "Edit limit" that sets `editing = key.id`. When `editing === key.id`, render below the table a `RateLimitEditor`:

```tsx
function RateLimitEditor({ apiKey, onDone }: { apiKey: ApiKeySummary; onDone: () => void }) {
  const initialMode = apiKey.rateLimit === null ? 'default' : apiKey.rateLimit === 'unlimited' ? 'unlimited' : 'custom';
  const [mode, setMode] = useState<'default' | 'unlimited' | 'custom'>(initialMode);
  const custom = typeof apiKey.rateLimit === 'object' && apiKey.rateLimit !== null ? apiKey.rateLimit : null;
  const [rate, setRate] = useState(custom ? String(custom.requestsPerMinute) : '');
  const [burst, setBurst] = useState(custom ? String(custom.burst) : '');
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const setting: RateLimitSetting =
        mode === 'default' ? null : mode === 'unlimited' ? 'unlimited' : { requestsPerMinute: Number(rate), burst: burst.trim() ? Number(burst) : Number(rate) };
      return api.updateApiKeyRateLimit(apiKey.id, setting);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      onDone();
    },
  });
  return (
    <div className="panel">
      <h2>Rate limit for {apiKey.label ?? apiKey.id}</h2>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>
          Limit
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="default">Server default</option>
            <option value="unlimited">Unlimited</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {mode === 'custom' && (
          <>
            <label>
              Requests per minute
              <input type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} required />
            </label>
            <label>
              Burst
              <input type="number" min={1} value={burst} onChange={(e) => setBurst(e.target.value)} />
            </label>
          </>
        )}
        <FormError error={save.error} />
        <div className="toolbar">
          <button type="submit" disabled={save.isPending}>Save limit</button>
          <button type="button" onClick={onDone}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
```

  The create form labels its burst input `Burst (optional)` and the editor labels its own `Burst`, so `getByLabelText` stays unambiguous when both are on screen.

- [ ] **Step 5: Run** `npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add apps/cli apps/web
git commit -m "feat(cli,web): set and show per-API-key rate limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Response cache (core) and the per-mapping `cacheTtlSeconds` field

**Files:**
- Create: `packages/core/src/gateway/ResponseCache.ts`
- Modify: `packages/core/src/storage/db.ts`, `packages/core/src/storage/MappingStore.ts`, `packages/core/src/mappingEngine/mappingFields.ts`, `packages/core/src/mappingEngine/yamlTransform.ts`, `packages/core/src/mappingEngine/mappingYaml.ts`, `packages/core/src/index.ts`, `apps/server/src/routers/adminRouter.ts` (POST/PATCH mappings), `apps/cli/src/client/embedded.ts` (createMapping/updateMapping parity)
- Test: `packages/core/test/gateway/ResponseCache.test.ts`, `packages/core/test/storage/MappingStore.test.ts`, `packages/core/test/mappingEngine/mappingFields.test.ts`, `packages/core/test/mappingEngine/mappingYaml.test.ts`, `apps/server/test/adminEndpoints.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // MappingRecord gains an OPTIONAL field, present only when caching is on for the mapping:
  cacheTtlSeconds?: number;
  export const MAX_CACHE_TTL_SECONDS = 86_400;
  MappingFields.cacheTtlSeconds?: number | null            // 0 is normalized to null (= off)
  MappingStore.createMapping(input: { ...; cacheTtlSeconds?: number | null })
  MappingStore.updateMapping(id, patch: { ...; cacheTtlSeconds?: number | null; source?: 'generated' | 'manual' }) // source now optional = keep
  MappingYamlEntry.cacheTtlSeconds?: number; MappingInput.cacheTtlSeconds: number | null
  export interface ResponseCacheOptions { maxEntries: number; maxTtlSeconds: number; now?: () => number }
  export interface CacheKeyParts { mappingId: string; path: string; query: Record<string, unknown>; identity: string }
  export function cacheIdentity(connection: { id: string; authMode: string }, vendorToken: string | undefined): string;
  export class ResponseCache {
    constructor(options: ResponseCacheOptions);
    static key(parts: CacheKeyParts): string;
    ttlFor(cacheTtlSeconds: number | undefined): number;   // effective seconds, 0 = do not cache
    get(key: string): unknown | undefined;
    set(key: string, value: unknown, meta: { mappingId: string; connectionId: string; ttlSeconds: number }): void;
    evictMapping(mappingId: string): void; evictConnection(connectionId: string): void; clear(): void; readonly size: number;
  }
  ```
- Admin API: `POST /admin/mappings` and `PATCH /admin/mappings/:id` accept `cacheTtlSeconds` (integer 0–86400 or null). A PATCH that changes **only** `cacheTtlSeconds` keeps the mapping's `source`; any other field still flips it to `manual`.

- [ ] **Step 1: Failing tests.**

`packages/core/test/gateway/ResponseCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ResponseCache, cacheIdentity } from '../../src/gateway/ResponseCache';

let t = 0;
const make = (maxEntries = 10, maxTtlSeconds = 300) => {
  t = 0;
  return new ResponseCache({ maxEntries, maxTtlSeconds, now: () => t });
};
const meta = (ttlSeconds: number, mappingId = 'm1', connectionId = 'c1') => ({ mappingId, connectionId, ttlSeconds });

describe('ResponseCache', () => {
  it('returns a copy of a stored value until its TTL passes', () => {
    const cache = make();
    const value = { a: 1 };
    cache.set('k', value, meta(10));
    value.a = 2;
    expect(cache.get('k')).toEqual({ a: 1 });
    t = 9_999;
    expect(cache.get('k')).toEqual({ a: 1 });
    t = 10_000;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = make(2);
    cache.set('a', 1, meta(60));
    cache.set('b', 2, meta(60));
    cache.get('a');
    cache.set('c', 3, meta(60));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });

  it('caps TTLs at maxTtlSeconds and treats 0/absent as off', () => {
    const cache = make(10, 30);
    expect(cache.ttlFor(600)).toBe(30);
    expect(cache.ttlFor(5)).toBe(5);
    expect(cache.ttlFor(undefined)).toBe(0);
    expect(make(0).ttlFor(60)).toBe(0);
    expect(make(10, 0).ttlFor(60)).toBe(0);
  });

  it('evicts by mapping and by connection', () => {
    const cache = make();
    cache.set('a', 1, meta(60, 'm1', 'c1'));
    cache.set('b', 2, meta(60, 'm2', 'c1'));
    cache.set('c', 3, meta(60, 'm3', 'c2'));
    cache.evictMapping('m1');
    expect(cache.get('a')).toBeUndefined();
    cache.evictConnection('c1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('builds keys that differ by path, query (order-insensitive) and identity', () => {
    const base = { mappingId: 'm', path: '/api/u/1', query: { b: '2', a: '1' }, identity: 'conn:c' };
    expect(ResponseCache.key(base)).toBe(ResponseCache.key({ ...base, query: { a: '1', b: '2' } }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, path: '/api/u/2' }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, query: { a: '1' } }));
    expect(ResponseCache.key(base)).not.toBe(ResponseCache.key({ ...base, identity: 'conn:d' }));
  });

  it('derives identity from the connection for managed and from the token for passthrough', () => {
    expect(cacheIdentity({ id: 'c1', authMode: 'managed' }, 'ignored')).toBe('conn:c1');
    const a = cacheIdentity({ id: 'c1', authMode: 'passthrough' }, 'token-a');
    expect(a).not.toContain('token-a');
    expect(a).not.toBe(cacheIdentity({ id: 'c1', authMode: 'passthrough' }, 'token-b'));
    expect(a).not.toBe(cacheIdentity({ id: 'c1', authMode: 'passthrough' }, undefined));
  });

  it('never stores when TTL is 0 or the value is not JSON', () => {
    const cache = make();
    cache.set('a', 1, meta(0));
    cache.set('b', undefined, meta(60));
    expect(cache.size).toBe(0);
  });
});
```

`MappingStore.test.ts`:

```ts
  it('stores cacheTtlSeconds only when positive and keeps source on TTL-only updates', () => {
    const conn = store.createConnection({ name: 'ttl', adapterType: 'mock', authMode: 'passthrough' });
    const m = store.createMapping({ connectionId: conn.id, route: '/t', method: 'GET', operation: {}, cacheTtlSeconds: 60 });
    expect(m.cacheTtlSeconds).toBe(60);
    expect(store.getMapping(m.id)!.cacheTtlSeconds).toBe(60);
    const cleared = store.updateMapping(m.id, { cacheTtlSeconds: null })!;
    expect(cleared.cacheTtlSeconds).toBeUndefined();
    expect(cleared.source).toBe('generated');
    const plain = store.createMapping({ connectionId: conn.id, route: '/p', method: 'GET', operation: {} });
    expect('cacheTtlSeconds' in plain).toBe(false);
  });
```

`mappingFields.test.ts`:

```ts
  it('validates cacheTtlSeconds', () => {
    expect(parseMappingFields({ cacheTtlSeconds: 30 }).cacheTtlSeconds).toBe(30);
    expect(parseMappingFields({ cacheTtlSeconds: 0 }).cacheTtlSeconds).toBeNull();
    expect(parseMappingFields({ cacheTtlSeconds: null }).cacheTtlSeconds).toBeNull();
    for (const bad of [-1, 1.5, '30', 86_401]) expect(() => parseMappingFields({ cacheTtlSeconds: bad })).toThrow('cacheTtlSeconds');
  });
```

`mappingYaml.test.ts` (reuse that file's store/connection fixtures):

```ts
  it('round-trips cacheTtlSeconds and clears it when an updated entry omits it', () => {
    const m = store.createMapping({ connectionId: conn.id, route: '/c', method: 'GET', operation: { query: 'q' }, cacheTtlSeconds: 45 });
    const yaml = exportMappingsYaml(store, {});
    expect(yaml).toContain('cacheTtlSeconds: 45');
    importMappingsYaml(store, yaml.replace('cacheTtlSeconds: 45\n', ''));
    expect(store.getMapping(m.id)!.cacheTtlSeconds).toBeUndefined();
  });

  it('rejects an invalid cacheTtlSeconds in YAML', () => {
    const yaml = ['- connection: ' + conn.name, '  route: "GET /bad"', '  source: manual', '  operation: { query: q }',
      '  response: { shape: passthrough }', '  auth: inherit', '  cacheTtlSeconds: -5'].join('\n');
    expect(() => importMappingsYaml(store, yaml)).toThrow('cacheTtlSeconds');
  });
```

`adminEndpoints.integration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

`db.ts` — generalize the column helper and add the new column:

```ts
  ensureColumn(db, 'connections', 'config', 'TEXT');
  ensureColumn(db, 'mappings', 'cache_ttl_seconds', 'INTEGER');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
```

(delete `ensureConnectionsConfigColumn`).

`mappingFields.ts`: add `cacheTtlSeconds?: number | null;` to `MappingFields`, `export const MAX_CACHE_TTL_SECONDS = 86_400;` and:

```ts
  if (input.cacheTtlSeconds !== undefined) {
    const ttl = input.cacheTtlSeconds;
    if (ttl !== null && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_SECONDS)) {
      throw invalid(`"cacheTtlSeconds" must be null or an integer from 0 to ${MAX_CACHE_TTL_SECONDS}`);
    }
    fields.cacheTtlSeconds = ttl === 0 ? null : ttl;
  }
```

`MappingStore.ts`:
- `MappingRecord` gets `/** Present only when response caching is enabled for this mapping. */ cacheTtlSeconds?: number;`
- `MappingRow` gets `cacheTtlSeconds: number | null`; `MAPPING_COLUMNS` appends `, cache_ttl_seconds as cacheTtlSeconds`.
- `mapMappingRow` returns `...(row.cacheTtlSeconds ? { cacheTtlSeconds: row.cacheTtlSeconds } : {})` after `source`.
- A small helper `const ttlColumn = (ttl: number | null | undefined) => (ttl && ttl > 0 ? ttl : null);`
- `createMapping` input gets `cacheTtlSeconds?: number | null`; INSERT adds the `cache_ttl_seconds` column/value `ttlColumn(input.cacheTtlSeconds)`; the returned record spreads `...(ttl ? { cacheTtlSeconds: ttl } : {})`.
- `updateMapping` patch gets `cacheTtlSeconds?: number | null` and `source?: 'generated' | 'manual'` (optional now). Compute:

```ts
    const ttl = patch.cacheTtlSeconds !== undefined ? ttlColumn(patch.cacheTtlSeconds) : (existing.cacheTtlSeconds ?? null);
    const next: MappingRecord = {
      id: existing.id,
      connectionId: existing.connectionId,
      route: patch.route ?? existing.route,
      method: patch.method ?? existing.method,
      operation: patch.operation ?? existing.operation,
      responseTemplate: patch.responseTemplate !== undefined ? patch.responseTemplate : existing.responseTemplate,
      source: patch.source ?? existing.source,
      ...(ttl ? { cacheTtlSeconds: ttl } : {}),
    };
```

  and the UPDATE statement sets `cache_ttl_seconds = ?` with `ttl`.

`yamlTransform.ts`:
- `MappingYamlEntry` gets `cacheTtlSeconds?: number;`, `MappingInput` gets `cacheTtlSeconds: number | null;`.
- `mappingToYamlEntry` adds `...(mapping.cacheTtlSeconds ? { cacheTtlSeconds: mapping.cacheTtlSeconds } : {})` as the last key.
- `yamlEntryToMappingInput` validates:

```ts
  const ttl = entry.cacheTtlSeconds;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_SECONDS)) {
    throw new Error(`Mapping "${entry.route}" has an invalid cacheTtlSeconds (expected an integer from 0 to ${MAX_CACHE_TTL_SECONDS})`);
  }
  // ... return { ..., cacheTtlSeconds: ttl ? ttl : null };
```

  (YAML entries are full replacements, like `response`: omitting `cacheTtlSeconds` turns caching off for that mapping.)

`mappingYaml.ts` `applyWrites`: pass `cacheTtlSeconds: item.input.cacheTtlSeconds` to both `updateMapping` (keeps `source: 'manual'`) and `createMapping`.

`adminRouter.ts`:
- POST `/mappings`: pass `cacheTtlSeconds` into `parseMappingFields({...})` and `cacheTtlSeconds: fields.cacheTtlSeconds` into `createMapping`.
- PATCH `/mappings/:id`:

```ts
    const fields = parseMappingFields(req.body ?? {});
    const definitional =
      fields.route !== undefined || fields.method !== undefined || fields.operation !== undefined || fields.responseTemplate !== undefined;
    if (!definitional && fields.cacheTtlSeconds === undefined) {
      throw new GatewayError('INVALID_INPUT', 'At least one of route, method, operation, responseTemplate, cacheTtlSeconds is required', 400);
    }
    // ...
      const updated = mappingStore.updateMapping(req.params.id, {
        route: fields.route,
        method: fields.method,
        operation: fields.operation,
        responseTemplate: fields.responseTemplate,
        cacheTtlSeconds: fields.cacheTtlSeconds,
        // Any definitional edit flips a mapping to manual (spec §5.2); a cache-TTL-only change is operational and keeps the source.
        source: definitional ? 'manual' : undefined,
      });
```

`embedded.ts`: mirror both changes exactly in `createMapping` (pass `cacheTtlSeconds: input.cacheTtlSeconds` into `parseMappingFields` and `createMapping`) and `updateMapping` (same `definitional` logic and message). `CreateMappingInput`/`MappingPatch` in `apps/cli/src/client/types.ts` gain `cacheTtlSeconds?: number | null` now so this compiles (Task 13 adds the flags).

`index.ts` exports: `export { ResponseCache, cacheIdentity } from './gateway/ResponseCache'; export type { ResponseCacheOptions, CacheKeyParts } from './gateway/ResponseCache'; export { parseMappingFields, MAX_CACHE_TTL_SECONDS } from './mappingEngine/mappingFields';` (replace the existing `parseMappingFields` export line).

`packages/core/src/gateway/ResponseCache.ts`:

```ts
import crypto from 'node:crypto';

export interface ResponseCacheOptions {
  maxEntries: number;
  maxTtlSeconds: number;
  now?: () => number;
}

export interface CacheKeyParts {
  mappingId: string;
  path: string;
  query: Record<string, unknown>;
  identity: string;
}

interface Entry {
  body: string;
  expiresAt: number;
  mappingId: string;
  connectionId: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Whose data a response is. Managed connections call the vendor as one identity, so every API key shares entries;
 * passthrough responses belong to the vendor token (hashed — raw tokens are never kept), including "no token".
 */
export function cacheIdentity(connection: { id: string; authMode: string }, vendorToken: string | undefined): string {
  return connection.authMode === 'managed' ? `conn:${connection.id}` : `tok:${sha256(vendorToken ?? '')}`;
}

/** In-memory LRU of successful GET responses with per-entry TTLs (single-process deployment, spec §6.3). */
export class ResponseCache {
  private entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: ResponseCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  static key(parts: CacheKeyParts): string {
    const query = Object.keys(parts.query)
      .sort()
      .map((name) => [name, parts.query[name]]);
    return sha256(JSON.stringify([parts.mappingId, parts.path, query, parts.identity]));
  }

  ttlFor(cacheTtlSeconds: number | undefined): number {
    if (this.options.maxEntries <= 0 || !cacheTtlSeconds || cacheTtlSeconds <= 0) return 0;
    return Math.min(cacheTtlSeconds, this.options.maxTtlSeconds);
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry); // most recently used goes last
    return JSON.parse(entry.body);
  }

  set(key: string, value: unknown, meta: { mappingId: string; connectionId: string; ttlSeconds: number }): void {
    if (meta.ttlSeconds <= 0 || this.options.maxEntries <= 0) return;
    const body = JSON.stringify(value);
    if (body === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, { body, expiresAt: this.now() + meta.ttlSeconds * 1000, mappingId: meta.mappingId, connectionId: meta.connectionId });
    while (this.entries.size > this.options.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  evictMapping(mappingId: string): void {
    for (const [key, entry] of this.entries) if (entry.mappingId === mappingId) this.entries.delete(key);
  }

  evictConnection(connectionId: string): void {
    for (const [key, entry] of this.entries) if (entry.connectionId === connectionId) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run** `npm test` → green (fix any test that asserted the old PATCH "at least one of" message).

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server apps/cli
git commit -m "feat(core): response cache and per-mapping cacheTtlSeconds across store, API and YAML

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Serve cached responses from the gateway, invalidate on admin changes

**Files:**
- Modify: `packages/core/src/gateway/GatewayEngine.ts`, `apps/server/src/routers/apiRouter.ts`, `apps/server/src/routers/adminRouter.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `packages/core/test/gateway/GatewayEngine.test.ts`, `apps/server/test/responseCache.integration.test.ts`

**Interfaces:**
- Consumes: Task 11 `ResponseCache`, `cacheIdentity`, `MappingRecord.cacheTtlSeconds`.
- Produces:
  ```ts
  new GatewayEngine(mappingStore, tokenProvider?, cache?: ResponseCache)
  GatewayHooks.onCacheStatus?: (status: 'HIT' | 'MISS') => void
  GatewayHooks.onVendorLatency?: (ms: number) => void
  AppDeps.responseCache?: ResponseCache; AdminRouterOptions.responseCache?: ResponseCache
  res.locals.cache ('HIT' | 'MISS'), res.locals.vendorLatencyMs (number)   // read by Task 2's request logger
  Response header X-Cache: HIT | MISS   // only when the mapping is cacheable for this request
  ```

- [ ] **Step 1: Failing tests.**

Add to `packages/core/test/gateway/GatewayEngine.test.ts` (reuse its store/registry setup; register a counting adapter):

```ts
describe('GatewayEngine response caching', () => {
  it('serves a cached GET without calling the adapter again and reports HIT/MISS and latency', async () => {
    let calls = 0;
    registerAdapter('counting', () => ({
      type: 'counting',
      introspect: async () => ({}),
      generateMappings: async () => [],
      execute: async (_op, params) => ({ n: ++calls, id: params.id }),
    }));
    const conn = store.createConnection({ name: 'cc', adapterType: 'counting', authMode: 'managed' });
    store.createMapping({ connectionId: conn.id, route: '/c/{id}', method: 'GET', operation: {}, cacheTtlSeconds: 60 });
    const cache = new ResponseCache({ maxEntries: 10, maxTtlSeconds: 300 });
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' }, cache);
    const statuses: string[] = [];
    const latencies: number[] = [];
    const hooks = { onCacheStatus: (s: string) => statuses.push(s), onVendorLatency: (ms: number) => latencies.push(ms) };
    expect(await engine.handle('GET', '/c/1', {}, {}, hooks)).toEqual({ n: 1, id: '1' });
    expect(await engine.handle('GET', '/c/1', {}, {}, hooks)).toEqual({ n: 1, id: '1' });
    expect(await engine.handle('GET', '/c/2', {}, {}, hooks)).toEqual({ n: 2, id: '2' });
    expect(statuses).toEqual(['MISS', 'HIT', 'MISS']);
    expect(latencies).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    let fail = true;
    registerAdapter('flaky', () => ({
      type: 'flaky',
      introspect: async () => ({}),
      generateMappings: async () => [],
      execute: async () => {
        if (fail) throw new GatewayError('VENDOR_ERROR', 'down', 502);
        return { ok: true };
      },
    }));
    const conn = store.createConnection({ name: 'fl', adapterType: 'flaky', authMode: 'passthrough' });
    store.createMapping({ connectionId: conn.id, route: '/f', method: 'GET', operation: {}, cacheTtlSeconds: 60 });
    const engine = new GatewayEngine(store, undefined, new ResponseCache({ maxEntries: 10, maxTtlSeconds: 300 }));
    await expect(engine.handle('GET', '/f')).rejects.toThrow('down');
    fail = false;
    expect(await engine.handle('GET', '/f')).toEqual({ ok: true });
  });
});
```

`apps/server/test/responseCache.integration.test.ts` — GraphQL passthrough so responses can differ per vendor token (copy the `beforeEach`/`afterEach`/`seedGraphQLConnection` scaffolding from `graphql.integration.test.ts`, but construct `const responseCache = new ResponseCache({ maxEntries: 100, maxTtlSeconds: 300 })`, pass it to both `new GatewayEngine(mappingStore, managedAuth, responseCache)` and `createApp({ ..., responseCache, managedAuth })`, where `managedAuth = new ManagedTokenService(mappingStore, new CredentialCipher('00'.repeat(32)))`):

```ts
async function seedCachedMapping(connectionId: string, extra: Record<string, unknown> = {}) {
  const res = await admin
    .post('/admin/mappings')
    .send({ connectionId, route: '/me', method: 'GET', operation: { query: '{ me { id } }' }, cacheTtlSeconds: 60, ...extra });
  return res.body.id as string;
}
const me = (apiKey: string, token?: string) => {
  const r = request(app).get('/api/me').set('Authorization', `Bearer ${apiKey}`);
  return token === undefined ? r : r.set('X-Vendor-Token', token);
};
const replyFor = (token: string, id: string) =>
  nock(HOST).post('/graphql').matchHeader('authorization', `Bearer ${token}`).reply(200, { data: { me: { id } } });

describe('response caching end-to-end', () => {
  it('returns MISS then HIT without a second vendor call', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice'); // exactly one interceptor: a second vendor call would fail the test
    const first = await me(apiKey, 'tok-a');
    const second = await me(apiKey, 'tok-a');
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  it('never shares entries between passthrough tokens', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    replyFor('tok-b', 'bob');
    await me(apiKey, 'tok-a');
    const bob = await me(apiKey, 'tok-b');
    expect(bob.headers['x-cache']).toBe('MISS');
    expect(JSON.stringify(bob.body)).toContain('bob');
  });

  it("no-token requests do not hit a token-holder's entry", async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    await me(apiKey, 'tok-a');
    const anonymous = await me(apiKey);
    expect(anonymous.headers['x-cache']).toBe('MISS');
    expect(JSON.stringify(anonymous.body)).not.toContain('alice');
  });

  it('adds no X-Cache header when the mapping has no TTL', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await seedCachedMapping(connectionId, { cacheTtlSeconds: null });
    replyFor('tok-a', 'alice');
    expect((await me(apiKey, 'tok-a')).headers['x-cache']).toBeUndefined();
  });

  it('never caches non-GET mappings', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await admin.post('/admin/mappings').send({ connectionId, route: '/do', method: 'POST', operation: { query: 'mutation { do }' }, cacheTtlSeconds: 60 });
    nock(HOST).post('/graphql').twice().reply(200, { data: { do: true } });
    const res = await request(app).post('/api/do').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 't');
    expect(res.headers['x-cache']).toBeUndefined();
  });

  it('evicts on mapping update', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    const mappingId = await seedCachedMapping(connectionId);
    replyFor('tok-a', 'alice');
    await me(apiKey, 'tok-a');
    await admin.patch(`/admin/mappings/${mappingId}`).send({ responseTemplate: { who: '$.me.id' } });
    replyFor('tok-a', 'alice-2');
    const after = await me(apiKey, 'tok-a');
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body).toEqual({ who: 'alice-2' });
  });

  it('evicts on credentials change', async () => {
    const conn = await admin
      .post('/admin/connections')
      .send({ name: 'managed-gql', adapterType: 'graphql', authMode: 'managed', config: { endpoint: ENDPOINT } });
    responseCache.set('seeded', { stale: true }, { mappingId: 'm', connectionId: conn.body.id, ttlSeconds: 60 });
    await admin
      .put(`/admin/connections/${conn.body.id}/credentials`)
      .send({ grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://login.example/token' });
    expect(responseCache.get('seeded')).toBeUndefined();
  });

  it('evicts on mapping delete, import and connection delete', async () => {
    const { connectionId } = await seedGraphQLConnection();
    const mappingId = await seedCachedMapping(connectionId);
    const seed = () => responseCache.set('x', 1, { mappingId, connectionId, ttlSeconds: 60 });
    seed();
    await admin.post('/admin/mappings/import').send({ yaml: '[]' });
    expect(responseCache.size).toBe(0);
    seed();
    await admin.delete(`/admin/mappings/${mappingId}`);
    expect(responseCache.size).toBe(0);
    seed();
    await admin.delete(`/admin/connections/${connectionId}`);
    expect(responseCache.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

`GatewayEngine.ts`:

```ts
import { ResponseCache, cacheIdentity } from './ResponseCache';

export interface GatewayHooks {
  /** Called once the request has been matched to a mapping, before anything that can fail. */
  onMatch?: (mapping: MappingRecord) => void;
  /** Called for cacheable requests only: HIT when served from the cache, MISS when the vendor is called. */
  onCacheStatus?: (status: 'HIT' | 'MISS') => void;
  /** Milliseconds spent in the adapter call (reported even when it throws). */
  onVendorLatency?: (ms: number) => void;
}

export class GatewayEngine {
  constructor(
    private mappingStore: MappingStore,
    private tokenProvider?: AccessTokenProvider,
    private cache?: ResponseCache
  ) {}

  // resolve() unchanged

  async handle(method, path, incomingAuth = {}, request = {}, hooks = {}): Promise<unknown> {
    const resolved = this.resolve(method, path);
    if (!resolved) throw new GatewayError('NOT_FOUND', `No mapping for ${method} ${path}`, 404);
    const { mapping, params } = resolved;
    hooks.onMatch?.(mapping);
    const connection = this.mappingStore.getConnection(mapping.connectionId);
    if (!connection) throw new GatewayError('CONNECTION_NOT_FOUND', `Connection ${mapping.connectionId} not found`, 500);

    // Only successful GETs are cached; the key always includes whose data it is (see cacheIdentity).
    const ttlSeconds = this.cache && method.toUpperCase() === 'GET' ? this.cache.ttlFor(mapping.cacheTtlSeconds) : 0;
    const cacheKey =
      ttlSeconds > 0
        ? ResponseCache.key({ mappingId: mapping.id, path, query: request.query ?? {}, identity: cacheIdentity(connection, incomingAuth.vendorToken) })
        : undefined;
    if (cacheKey) {
      const cached = this.cache!.get(cacheKey);
      if (cached !== undefined) {
        hooks.onCacheStatus?.('HIT');
        return cached;
      }
      hooks.onCacheStatus?.('MISS');
    }

    const adapter = createAdapter(connection.adapterType);
    const operation = resolveVariables(mapping.operation, params);
    const authContext = await buildAuthContext(connection, incomingAuth.vendorToken, this.tokenProvider);
    const started = performance.now();
    let raw: unknown;
    try {
      raw = await adapter.execute(operation, params, authContext, request);
    } finally {
      hooks.onVendorLatency?.(Math.round(performance.now() - started));
    }
    const shaped = shapeResponse(raw, mapping.responseTemplate);
    if (cacheKey) this.cache!.set(cacheKey, shaped, { mappingId: mapping.id, connectionId: connection.id, ttlSeconds });
    return shaped;
  }
}
```

(keep the existing parameter types on `handle`.)

`apiRouter.ts` hooks object gains:

```ts
          onCacheStatus: (status) => {
            res.locals.cache = status;
            res.setHeader('X-Cache', status);
          },
          onVendorLatency: (ms) => {
            res.locals.vendorLatencyMs = ms;
          },
```

`adminRouter.ts`: `responseCache?: ResponseCache` in options; `const cache = options.responseCache;` then:
- PATCH `/mappings/:id` success → `cache?.evictMapping(req.params.id)`
- DELETE `/mappings/:id` success → `cache?.evictMapping(req.params.id)`
- POST `/mappings/import` success → `cache?.clear()`
- POST `/connections/:id/mappings/generate` success → `cache?.evictConnection(connection.id)`
- DELETE `/connections/:id` → `cache?.evictConnection(connectionId)`
- PUT and DELETE `/connections/:id/credentials` → `cache?.evictConnection(connection.id)`
- GET `/oauth/callback` after `completeAuthorization` succeeds → `cache?.evictConnection(connectionId)`

`app.ts`: `responseCache?: ResponseCache` in `AppDeps`, passed into the admin router options.

`index.ts`:

```ts
const responseCache = new ResponseCache({ maxEntries: config.cacheMaxEntries, maxTtlSeconds: config.cacheMaxTtlSeconds });
const gatewayEngine = new GatewayEngine(mappingStore, managedAuth, responseCache);
// ...createApp({ ..., responseCache })
```

Known limitation (goes in the README in Task 16): edits made with the embedded CLI against a running server's DB are not seen by that server's in-memory cache until entries expire (at most `CACHE_MAX_TTL_SECONDS`).

- [ ] **Step 4: Run** `npm test` → green. Also check `requestLogging.integration.test.ts` still passes; optionally extend its first test to assert `vendorLatencyMs` is a number.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server
git commit -m "feat: serve cacheable GETs from the response cache and evict on admin changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Cache TTL in the CLI and web UI

**Files:**
- Modify: `apps/cli/src/commands/mapping.ts`, `apps/web/src/types.ts`, `apps/web/src/pages/MappingEditForm.tsx`
- Test: `apps/cli/test/mappingCommands.test.ts`, `apps/cli/test/client.contract.test.ts`, `apps/web/test/mappings.test.tsx`

**Interfaces:**
- Consumes: Task 11 (`cacheTtlSeconds` on client types, admin API, embedded client).
- Produces: `gtr mapping create|update --cache-ttl <seconds>`; `gtr mapping list` CACHE column (`60s` or `-`); web `Mapping.cacheTtlSeconds?: number`, `MappingPatch.cacheTtlSeconds: number | null`.

- [ ] **Step 1: Failing tests.**

`client.contract.test.ts` (both modes):

```ts
    it('sets and clears cacheTtlSeconds without flipping source on a TTL-only update', async () => {
      const conn = await h.client.createConnection({ name: 'ttl', adapterType: 'mock', authMode: 'passthrough' });
      const m = await h.client.createMapping({ connectionId: conn.id, method: 'GET', route: '/ttl', operation: {}, cacheTtlSeconds: 30 });
      expect(m.cacheTtlSeconds).toBe(30);
      const cleared = await h.client.updateMapping(m.id, { cacheTtlSeconds: null });
      expect(cleared.cacheTtlSeconds).toBeUndefined();
      expect(cleared.source).toBe('manual'); // created manual by the CLI; unchanged
      expect(await codeOf(h.client.updateMapping(m.id, { cacheTtlSeconds: -1 }))).toBe('INVALID_INPUT');
    });
```

`mappingCommands.test.ts` (uses that file's `run` and `withConnection` helpers):

```ts
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
```

Update the existing expectation of the update message ("source is now manual" → "source is manual"). The existing list regex becomes `/^ID\s+METHOD\s+ROUTE\s+CONNECTION\s+SOURCE\s+CACHE\n\S+\s+GET\s+\/users\/\{id\}\s+c1\s+manual\s+-\n$/`.

`apps/web/test/mappings.test.tsx`: in the existing "saves an edit as a PATCH with parsed JSON" test the PATCH body `toEqual` gains `cacheTtlSeconds: null`. Add (using that file's `openMappingsTab` helper and `MAPPING` fixture):

```ts
  it('saves a cache TTL from the edit form', async () => {
    const { calls } = await openMappingsTab([{ method: 'PATCH', path: '/admin/mappings/m1', body: { ...MAPPING, cacheTtlSeconds: 120, source: 'manual' } }]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    expect((screen.getByLabelText('Cache TTL (seconds, 0 = off)') as HTMLInputElement).value).toBe('0');
    fireEvent.change(screen.getByLabelText('Cache TTL (seconds, 0 = off)'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ cacheTtlSeconds: 120 });
  });

  it('rejects a non-integer cache TTL locally', async () => {
    const { calls } = await openMappingsTab([]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Cache TTL (seconds, 0 = off)'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('Cache TTL must be a whole number of seconds from 0 to 86400')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement CLI** (`commands/mapping.ts`):

```ts
function parseCacheTtl(text: string): number | null {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 86_400) throw usageError('--cache-ttl must be a whole number of seconds from 0 to 86400');
  return n === 0 ? null : n;
}
```

- `create`: `.option('--cache-ttl <seconds>', 'cache successful GET responses for this long (0 = off)')`; pass `cacheTtlSeconds: opts.cacheTtl === undefined ? undefined : parseCacheTtl(opts.cacheTtl)` (parse before `rt.client()`).
- `update`: same option; `if (opts.cacheTtl !== undefined) patch.cacheTtlSeconds = parseCacheTtl(opts.cacheTtl);`; description becomes `'edit a mapping (route/operation/template edits make it source=manual)'`; output `Updated mapping ${m.method} ${m.route} (${m.id}); source is ${m.source}.`
- `list`: headers `['ID', 'METHOD', 'ROUTE', 'CONNECTION', 'SOURCE', 'CACHE']`, cell `m.cacheTtlSeconds ? \`${m.cacheTtlSeconds}s\` : '-'`.

- [ ] **Step 4: Implement web.**

`types.ts`: `Mapping` gains `cacheTtlSeconds?: number;`; `MappingPatch` gains `cacheTtlSeconds: number | null;`.

`MappingEditForm.tsx`: state `const [cacheTtl, setCacheTtl] = useState(String(mapping.cacheTtlSeconds ?? 0));`; in `submit`, before `save.mutate`:

```ts
    const ttl = Number(cacheTtl);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86_400) {
      setLocalError('Cache TTL must be a whole number of seconds from 0 to 86400');
      return;
    }
    save.mutate({ method, route, operation: parsedOperation.value, responseTemplate, cacheTtlSeconds: ttl === 0 ? null : ttl });
```

and a field after the template textarea:

```tsx
        <label>
          Cache TTL (seconds, 0 = off)
          <input type="number" min={0} max={86400} step={1} value={cacheTtl} onChange={(e) => setCacheTtl(e.target.value)} />
        </label>
```

- [ ] **Step 5: Run** `npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add apps/cli apps/web
git commit -m "feat(cli,web): set per-mapping cache TTLs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `/healthz`, DB file permissions, graceful shutdown and startup errors

**Files:**
- Create: `apps/server/src/shutdown.ts`
- Modify: `packages/core/src/storage/db.ts`, `packages/core/src/storage/MappingStore.ts` (`healthCheck`), `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `packages/core/test/storage/db.test.ts` (create if absent), `apps/server/test/healthz.integration.test.ts`, `apps/server/test/shutdown.test.ts`

**Interfaces:**
- Produces:
  ```ts
  MappingStore.healthCheck(): boolean
  GET /healthz → 200 {"status":"ok"} | 503 {"status":"error"}   // always registered, unauthenticated, not in request_log
  export interface ClosableServer { close(callback?: (err?: Error) => void): unknown; closeIdleConnections(): void; closeAllConnections(): void }
  export interface ShutdownOptions { server: ClosableServer; cleanup: () => void; logger: Logger; timeoutMs?: number; exit?: (code: number) => void }
  export function createShutdown(options: ShutdownOptions): (signal: string) => void;
  export function installShutdownHandlers(shutdown: (signal: string) => void, proc?: Pick<NodeJS.Process, 'on'>): void;
  ```

- [ ] **Step 1: Failing tests.**

`packages/core/test/storage/db.test.ts` (add to the file if it exists):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')('openDb file permissions', () => {
  it('creates a missing directory 0700 and the DB file 0600', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-perm-'));
    dirs.push(root);
    const file = path.join(root, 'nested', 'g.db');
    openDb(file).close();
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('tightens an existing DB file but leaves an existing directory alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-perm-'));
    dirs.push(root);
    fs.chmodSync(root, 0o755);
    const file = path.join(root, 'g.db');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
    openDb(file).close();
    expect(mode(file)).toBe(0o600);
    expect(mode(root)).toBe(0o755);
  });
});
```

`apps/server/test/healthz.integration.test.ts` (DB setup as in other server tests):

```ts
  it('is available with API and admin disabled and is not logged to request_log', async () => {
    const app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: false, adminEnabled: false });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(store.listRequests({ limit: 10 })).toEqual([]);
  });

  it('returns 503 when the database is unusable', async () => {
    const app = createApp({ mappingStore: store, gatewayEngine: new GatewayEngine(store), openApiGenerator: new OpenApiGenerator(), apiEnabled: true, adminEnabled: true });
    db.close();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error' });
  });
```

(in the second test, make `afterEach` tolerate an already-closed DB: guard `db.open && db.close()`.)

`apps/server/test/shutdown.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { silentLogger } from '@graphtorest/core';
import { createShutdown, installShutdownHandlers } from '../src/shutdown';

function fakeServer() {
  let onClosed: (() => void) | undefined;
  return {
    close: vi.fn((cb?: () => void) => { onClosed = cb; }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
    drained: () => onClosed?.(),
  };
}

afterEach(() => vi.useRealTimers());

describe('graceful shutdown', () => {
  it('stops accepting, drains, cleans up once and exits 0', () => {
    const server = fakeServer();
    const cleanup = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, cleanup, logger: silentLogger, exit });
    shutdown('SIGTERM');
    shutdown('SIGINT'); // ignored
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    server.drained();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces connections closed and exits 1 after the timeout', () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const cleanup = vi.fn();
    const exit = vi.fn();
    createShutdown({ server, cleanup, logger: silentLogger, exit, timeoutMs: 10_000 })('SIGTERM');
    vi.advanceTimersByTime(10_000);
    expect(server.closeAllConnections).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    server.drained(); // a late close callback must not clean up or exit twice
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('wires SIGTERM and SIGINT', () => {
    const proc = new EventEmitter();
    const shutdown = vi.fn();
    installShutdownHandlers(shutdown, proc as unknown as Pick<NodeJS.Process, 'on'>);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

`db.ts` `openDb`:

```ts
export function openDb(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The file holds hashed API keys and encrypted vendor credentials: owner-only, whether new or pre-existing.
  if (filePath !== ':memory:') {
    for (const file of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
  }
  // ...migrations and ensureColumn calls unchanged
```

`MappingStore.healthCheck()`:

```ts
  /** True when the database answers a trivial query. */
  healthCheck(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
```

`app.ts`, first route (before `express.json` is fine):

```ts
  app.get('/healthz', (_req, res) => {
    const ok = deps.mappingStore.healthCheck();
    logger.debug('healthcheck', { ok });
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error' });
  });
```

`apps/server/src/shutdown.ts`:

```ts
import type { Logger } from '@graphtorest/core';

export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface ShutdownOptions {
  server: ClosableServer;
  cleanup: () => void;
  logger: Logger;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/** Stop accepting connections, let in-flight requests finish (up to timeoutMs), then clean up and exit. Idempotent. */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? 10_000;
  let started = false;
  let finished = false;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    let exitCode = code;
    try {
      options.cleanup();
    } catch (err) {
      options.logger.error('shutdown_cleanup_failed', { error: err });
      exitCode = 1;
    }
    options.logger.info('shutdown_complete', { exitCode });
    exit(exitCode);
  };

  return (signal: string) => {
    if (started) return;
    started = true;
    options.logger.info('shutdown_started', { signal });
    const timer = setTimeout(() => {
      options.logger.warn('shutdown_timeout', { timeoutMs });
      options.server.closeAllConnections();
      finish(1);
    }, timeoutMs);
    options.server.close(() => {
      clearTimeout(timer);
      finish(0);
    });
    options.server.closeIdleConnections();
  };
}

export function installShutdownHandlers(shutdown: (signal: string) => void, proc: Pick<NodeJS.Process, 'on'> = process): void {
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}
```

`apps/server/src/index.ts` — rewrite as a `main()` with startup-error reporting. Everything from Tasks 2, 4, 7, 9 and 12 ends up here:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  ResponseCache,
  registerDefaultAdapters,
  createLogger,
  setOutboundPolicy,
  type Logger,
} from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';
import { RateLimiter } from './middleware/rateLimit';
import { LoginThrottle } from './middleware/loginThrottle';
import { createShutdown, installShutdownHandlers } from './shutdown';

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'SQLITE_CANTOPEN', 'SQLITE_READONLY']);

function main(): void {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  setOutboundPolicy({ timeoutMs: config.outboundTimeoutMs, allowPrivateNetworkTargets: config.allowPrivateNetworkTargets });
  registerDefaultAdapters();

  const db = openDb(config.dbPath);
  const mappingStore = new MappingStore(db);
  const managedAuth = config.credentialEncryptionKey
    ? new ManagedTokenService(mappingStore, new CredentialCipher(config.credentialEncryptionKey))
    : undefined;
  const responseCache = new ResponseCache({ maxEntries: config.cacheMaxEntries, maxTtlSeconds: config.cacheMaxTtlSeconds });
  const gatewayEngine = new GatewayEngine(mappingStore, managedAuth, responseCache);
  const rateLimiter = new RateLimiter({ defaultLimit: config.rateLimitDefault });
  const loginThrottle = new LoginThrottle();

  // apps/server/dist/index.js → apps/web/dist (same layout in the Docker image).
  const webDist = path.resolve(__dirname, '../../web/dist');
  const webRoot = config.webEnabled && fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;

  const app = createApp({
    mappingStore,
    gatewayEngine,
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: config.apiEnabled,
    adminEnabled: config.adminEnabled,
    managedAuth,
    publicBaseUrl: config.publicBaseUrl,
    activityRetention: config.activityRetention,
    webRoot,
    logger,
    rateLimiter,
    loginThrottle,
    responseCache,
  });

  warnAboutConfiguration(config, mappingStore, logger, Boolean(managedAuth), webRoot, webDist);

  const server = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, dbPath: config.dbPath });
  });
  installShutdownHandlers(
    createShutdown({
      server,
      logger,
      cleanup: () => {
        rateLimiter.stop();
        loginThrottle.stop();
        db.close();
      },
    })
  );
}

function warnAboutConfiguration(
  config: ReturnType<typeof loadConfig>,
  store: MappingStore,
  logger: Logger,
  managedAuthEnabled: boolean,
  webRoot: string | undefined,
  webDist: string
): void {
  if (!managedAuthEnabled) {
    logger.warn('managed_auth_disabled', {
      warning: 'CREDENTIAL_ENCRYPTION_KEY is not set; connections with authMode "managed" cannot be used.',
    });
  }
  if (config.adminEnabled && store.countAdminUsers() === 0) {
    logger.warn('no_admin_users', {
      warning:
        'No admin users exist, so /admin/* cannot be used. Set GTR_BOOTSTRAP_ADMIN_USERNAME and GTR_BOOTSTRAP_ADMIN_PASSWORD and restart, or run: gtr admin create --username <name> (password via --password or GTR_ADMIN_PASSWORD, 12+ characters)',
    });
  }
  if (config.webEnabled && !webRoot) {
    logger.warn('web_ui_unavailable', { warning: `No built web UI found at ${webDist}; serving the API and admin API only.` });
  }
}

try {
  main();
} catch (err) {
  // Config may be what failed, so report with a default logger.
  const code = (err as { code?: unknown })?.code;
  createLogger().error('startup_failed', {
    message: err instanceof Error ? err.message : String(err),
    ...(typeof code === 'string' && PERMISSION_CODES.has(code)
      ? {
          hint:
            'The database path is not writable by this user. The image runs as the unprivileged "node" user; if the volume was created by an older image that ran as root, fix ownership once with: docker compose run --rm --user root --entrypoint chown graphtorest -R node:node /data',
        }
      : {}),
  });
  process.exit(1);
}
```

- [ ] **Step 4: Run** `npm test` and `npm run build` → green. Manual check:

```bash
PORT=3999 DB_PATH=$(mktemp -d)/g.db node apps/server/dist/index.js &
sleep 1; curl -s localhost:3999/healthz; kill -TERM %1; wait %1; echo "exit=$?"
```

Expected: `{"status":"ok"}`, log lines `shutdown_started` and `shutdown_complete`, `exit=0`. Also `PORT=abc node apps/server/dist/index.js; echo $?` → one `startup_failed` JSON line naming `PORT`, exit 1.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server
git commit -m "feat(server): /healthz, owner-only DB file, graceful shutdown and clear startup errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: First-run admin bootstrap from env vars

**Files:**
- Create: `apps/server/src/bootstrap.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/bootstrap.test.ts`

**Interfaces:**
- Consumes: `ServerConfig.bootstrapAdmin` (Task 1), `Logger` (Task 2).
- Produces: `export function bootstrapAdmin(store: MappingStore, bootstrap: { username: string; password: string } | null, logger: Logger): 'created' | 'skipped' | 'not-configured'` — throws `GatewayError` (`INVALID_INPUT`) for an invalid password.

- [ ] **Step 1: Failing test** — `apps/server/test/bootstrap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, MappingStore, createLogger, loginAdmin } from '@graphtorest/core';
import { bootstrapAdmin } from '../src/bootstrap';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let lines: string[];
const logger = () => createLogger({ write: (line) => lines.push(line) });

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `gtr-bootstrap-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  lines = [];
});
afterEach(() => {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
});

const ADMIN = { username: 'root', password: 'correct-horse-battery' };

describe('bootstrapAdmin', () => {
  it('does nothing when not configured', () => {
    expect(bootstrapAdmin(store, null, logger())).toBe('not-configured');
    expect(store.countAdminUsers()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('creates the first admin and logs the username only', async () => {
    expect(bootstrapAdmin(store, ADMIN, logger())).toBe('created');
    expect(await loginAdmin(store, 'root', ADMIN.password)).not.toBeNull();
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'bootstrap_admin_created', username: 'root' });
    expect(lines.join('\n')).not.toContain(ADMIN.password);
  });

  it('skips when an admin already exists', () => {
    store.createAdminUser({ username: 'existing', password: 'another-long-password' });
    expect(bootstrapAdmin(store, ADMIN, logger())).toBe('skipped');
    expect(store.findAdminUserByUsername('root')).toBeNull();
    expect(JSON.parse(lines[0]).msg).toBe('bootstrap_admin_skipped');
  });

  it('throws on an invalid password and creates nothing', () => {
    expect(() => bootstrapAdmin(store, { username: 'root', password: 'short' }, logger())).toThrow('at least 12');
    expect(store.countAdminUsers()).toBe(0);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `apps/server/src/bootstrap.ts`:

```ts
import type { Logger, MappingStore } from '@graphtorest/core';

/** Creates the first admin from GTR_BOOTSTRAP_ADMIN_* when no admin exists yet; a no-op afterwards. */
export function bootstrapAdmin(
  store: MappingStore,
  bootstrap: { username: string; password: string } | null,
  logger: Logger
): 'created' | 'skipped' | 'not-configured' {
  if (!bootstrap) return 'not-configured';
  if (store.countAdminUsers() > 0) {
    logger.info('bootstrap_admin_skipped', { reason: 'admin users already exist; GTR_BOOTSTRAP_ADMIN_* can be removed' });
    return 'skipped';
  }
  const user = store.createAdminUser(bootstrap); // validates username and password (12–1024 characters)
  logger.info('bootstrap_admin_created', { username: user.username });
  return 'created';
}
```

In `index.ts` `main()`, right after `const mappingStore = new MappingStore(db);`:

```ts
  try {
    bootstrapAdmin(mappingStore, config.bootstrapAdmin, logger);
  } catch (err) {
    throw new Error(`GTR_BOOTSTRAP_ADMIN_PASSWORD was rejected: ${(err as Error).message}`);
  }
```

(it runs before `warnAboutConfiguration`, so a successful bootstrap suppresses the `no_admin_users` warning).

- [ ] **Step 4: Run** `npm test` → green, then manual check:

```bash
D=$(mktemp -d); GTR_BOOTSTRAP_ADMIN_USERNAME=root GTR_BOOTSTRAP_ADMIN_PASSWORD=short PORT=3998 DB_PATH=$D/g.db node apps/server/dist/index.js; echo "exit=$?"
```

Expected: one `startup_failed` line mentioning `GTR_BOOTSTRAP_ADMIN_PASSWORD was rejected`, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): bootstrap the first admin from GTR_BOOTSTRAP_ADMIN_* env vars

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Slim non-root Docker image, compose and README

**Files:**
- Create: `.dockerignore`, `README.md`
- Modify: `Dockerfile`, `docker-compose.yml`

**Interfaces:**
- Consumes: `/healthz` (Task 14), startup `hint` (Task 14), all env vars (Global Constraints).
- Produces: image that runs as `node` (uid 1000), `HEALTHCHECK`, no devDependencies, `gtr` on `PATH`.

- [ ] **Step 1: Record the baseline image size.**

```bash
docker build -t graphtorest:before . && docker image ls graphtorest:before --format '{{.Size}}'
```

Write the size down for the commit message.

- [ ] **Step 2: Create `.dockerignore`:**

```
node_modules
**/node_modules
.git
.claude
.worktrees
**/dist
data
coverage
*.log
docs
```

- [ ] **Step 3: Rewrite `Dockerfile`:**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages/core packages/core
COPY apps/server apps/server
COPY apps/cli apps/cli
COPY apps/web apps/web
RUN npm run build --workspaces --if-present

# Production dependencies only, and only for the packages the runtime image runs (not the web app's build chain).
FROM node:20-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace=@graphtorest/core --workspace=@graphtorest/server --workspace=@graphtorest/cli

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/graphtorest.db
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/cli/package.json apps/cli/package.json
COPY --from=build /app/apps/cli/dist apps/cli/dist
COPY --from=build /app/apps/cli/bin apps/cli/bin
# Only the built bundle; the web app has no runtime dependencies of its own.
COPY --from=build /app/apps/web/dist apps/web/dist
# npm links workspace bins during `npm ci`, before apps/cli/bin/gtr.js exists in that stage, so link it explicitly.
RUN ln -sf ../@graphtorest/cli/bin/gtr.js node_modules/.bin/gtr \
  && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/server/dist/index.js"]
```

- [ ] **Step 4: Build and verify.**

```bash
docker build -t graphtorest:after .
docker image ls graphtorest:after --format '{{.Size}}'
docker run --rm --entrypoint sh graphtorest:after -c 'ls node_modules | grep -xE "vitest|vite|esbuild|typescript|jsdom|react|swagger-ui-react|nock|supertest" || echo NONE'
docker run --rm --entrypoint id graphtorest:after
docker run --rm --entrypoint gtr graphtorest:after --help
docker run --rm -e ALLOW_PRIVATE_NETWORK_TARGETS=maybe graphtorest:after; echo "exit=$?"
```

Expected: size clearly below the baseline; `NONE`; `uid=1000(node)`; `gtr` usage text; a `startup_failed` line naming `ALLOW_PRIVATE_NETWORK_TARGETS` and `exit=1`.

If the `grep` finds web-only packages (`react`, `swagger-ui-react`), this npm version did not filter by `--workspace`. Keep the workspace flags anyway and add `RUN npm prune --omit=dev` after `npm ci` in `prod-deps`. If web runtime packages still remain, accept them and list them with their sizes (`du -sh node_modules/<pkg>`) in the commit message. The dev packages (`vitest`, `vite`, `esbuild`, `typescript`, `jsdom`, `nock`, `supertest`) must be absent either way.

- [ ] **Step 5: Update `docker-compose.yml`.** Keep the existing content and comments; add under `environment:`:

```yaml
      # First run only: creates this admin when none exists (password 12–1024 characters). Remove after first start.
      # GTR_BOOTSTRAP_ADMIN_USERNAME: admin
      # GTR_BOOTSTRAP_ADMIN_PASSWORD: ${GTR_BOOTSTRAP_ADMIN_PASSWORD:-}
      # Default per-API-key limit in requests/minute (unset = unlimited); keys can override it.
      RATE_LIMIT_DEFAULT: ${RATE_LIMIT_DEFAULT:-}
      RATE_LIMIT_DEFAULT_BURST: ${RATE_LIMIT_DEFAULT_BURST:-}
      # Upper bound for per-mapping response-cache TTLs, and the cache size (0 disables caching).
      CACHE_MAX_TTL_SECONDS: ${CACHE_MAX_TTL_SECONDS:-300}
      CACHE_MAX_ENTRIES: ${CACHE_MAX_ENTRIES:-1000}
      # Outbound GraphQL/OAuth requests: timeout, and whether private/loopback/link-local destinations are allowed
      # (needed when a GraphQL endpoint runs on the same Docker network or LAN).
      OUTBOUND_TIMEOUT_MS: ${OUTBOUND_TIMEOUT_MS:-30000}
      ALLOW_PRIVATE_NETWORK_TARGETS: ${ALLOW_PRIVATE_NETWORK_TARGETS:-false}
      LOG_LEVEL: ${LOG_LEVEL:-info}
```

and replace the header comment's admin-creation instructions with: first run via the bootstrap env vars, or `docker compose run --rm -e GTR_ADMIN_PASSWORD --entrypoint gtr graphtorest admin create --username admin`; plus: "Upgrading from an image before Plan 8 (which ran as root)? Run once: `docker compose run --rm --user root --entrypoint chown graphtorest -R node:node /data`".

- [ ] **Step 6: Create `README.md`** at the repo root with these sections (keep it factual and short):
  1. **What it is** — one paragraph (GraphQL/Microsoft Graph → REST gateway with admin web UI and `gtr` CLI).
  2. **Quick start** — `docker compose up -d` with `CREDENTIAL_ENCRYPTION_KEY` and the bootstrap vars; open `http://localhost:3000`.
  3. **Configuration** — a table of every env var: the existing ones (`PORT`, `DB_PATH`, `API_ENABLED`, `ADMIN_ENABLED`, `WEB_ENABLED`, `CREDENTIAL_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `ACTIVITY_RETENTION`) and the new ones from the Global Constraints, with defaults.
  4. **Rate limiting** — token bucket per key; `RATE_LIMIT_DEFAULT`; per-key override via web UI / `gtr apikey update <id> --rate-limit 60 --burst 10 | --unlimited | --default`; 429 + `Retry-After` + `RateLimit-*`.
  5. **Response caching** — per-mapping `cacheTtlSeconds` (web UI, `gtr mapping update <id> --cache-ttl 60`, YAML), GET + 2xx only, `X-Cache`, keyed per vendor token for passthrough and shared per connection for managed; limitation: edits made with the embedded CLI against a running server's DB are not seen by that server's cache until entries expire.
  6. **Outbound network safety** — private-network destinations blocked unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`; plain http only for opted-in private destinations; redirects not followed; known gap: DNS rebinding between the check and the connection.
  7. **Operations** — `/healthz`, JSON logs on stdout/stderr (`request_completed` fields), graceful shutdown on SIGTERM, runs as non-root; the upgrade `chown` command.

- [ ] **Step 7: Commit**

```bash
git add .dockerignore Dockerfile docker-compose.yml README.md
git commit -m "build: slim non-root runtime image with healthcheck; document configuration

Image size: <before> -> <after>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Upgrade the test toolchain and clear `npm audit`

**Files:**
- Modify: `package.json`, `packages/core/package.json`, `apps/server/package.json`, `apps/cli/package.json`, `apps/web/package.json`, `package-lock.json`, `vitest.config.ts`, any test broken by the upgrade

**Interfaces:**
- Consumes: `test/setup/outboundPolicy.ts` (Task 3) must remain a setup file for every test project.

- [ ] **Step 1: Record the current advisories.**

```bash
npm audit 2>&1 | tail -20
```

- [ ] **Step 2: Upgrade.** Find the patched majors with `npm view vitest version`, `npm view vite version`, `npm view @vitejs/plugin-react version`, and check vitest's `peerDependencies` for the matching vite range (`npm view vitest@<version> peerDependencies`). Then:

```bash
npm install -D vitest@^<vitest-major> -w @graphtorest/core -w @graphtorest/server -w @graphtorest/cli -w @graphtorest/web --include-workspace-root
npm install -D vite@^<vite-major> @vitejs/plugin-react@^<plugin-major> -w @graphtorest/web
```

If `jsdom` or `@testing-library/*` peer ranges conflict, bump them to the versions npm suggests.

- [ ] **Step 3: Migrate `vitest.config.ts`.** `environmentMatchGlobs` is removed in current vitest; use projects:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    setupFiles: ['test/setup/outboundPolicy.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'web', environment: 'jsdom', include: ['apps/web/test/**/*.test.{ts,tsx}'] },
      },
    ],
  },
});
```

If the installed vite no longer honours the `esbuild` option for JSX (vite versions using oxc), replace it with the equivalent that version documents (e.g. `oxc: { jsx: { runtime: 'automatic' } }`) — confirm by running the web tests.

- [ ] **Step 4: Run** `npm test`. Fix breakages caused by the upgrade only (typical: mock restore semantics, fake-timer defaults, stricter `vi.fn` typing). Do not change production code in this task unless a test exposes a real bug — if it does, stop and report it.

- [ ] **Step 5: Verify builds and audit.**

```bash
npm run build
npm audit
npm audit --omit=dev
```

Expected: build succeeds (including `vite build` for the web app); `npm audit` reports 0 vulnerabilities. If an advisory has no fix available, `npm audit --omit=dev` must report 0 and the remaining dev-only advisory (package, severity, advisory id) goes in the commit message.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/*/package.json apps/*/package.json vitest.config.ts apps packages test
git commit -m "build: upgrade vitest/vite toolchain to clear npm audit advisories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Final verification and container smoke test

**Files:** none (verification only; fix-forward commits if something fails).

- [ ] **Step 1: Full suite and build.**

```bash
npm test 2>&1 | tail -5
npm run build
grep -rn "console\." apps/server/src packages/core/src || echo "no console calls"
```

Expected: all tests pass (more than the 576 baseline); build succeeds; "no console calls".

- [ ] **Step 2: Container smoke.**

```bash
IMG=graphtorest:plan8
docker build -t $IMG .
docker volume create gtr-smoke
docker run -d --name gtr-smoke -p 127.0.0.1:3900:3000 -v gtr-smoke:/data --health-interval=2s \
  -e GTR_BOOTSTRAP_ADMIN_USERNAME=admin -e GTR_BOOTSTRAP_ADMIN_PASSWORD=correct-horse-battery \
  -e RATE_LIMIT_DEFAULT=2 -e RATE_LIMIT_DEFAULT_BURST=2 $IMG
until curl -sf localhost:3900/healthz; do sleep 1; done; echo
J='content-type: application/json'
TOKEN=$(curl -s -X POST localhost:3900/admin/login -H "$J" -d '{"username":"admin","password":"correct-horse-battery"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
A="authorization: Bearer $TOKEN"
CONN=$(curl -s -X POST localhost:3900/admin/connections -H "$A" -H "$J" -d '{"name":"m","adapterType":"mock","authMode":"passthrough"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST localhost:3900/admin/mappings -H "$A" -H "$J" -d "{\"connectionId\":\"$CONN\",\"route\":\"/users/{id}\",\"method\":\"GET\",\"operation\":{},\"cacheTtlSeconds\":60}" >/dev/null
KEY=$(curl -s -X POST localhost:3900/admin/api-keys -H "$A" -H "$J" -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).plaintext')
for i in 1 2 3; do curl -s -o /dev/null -D - localhost:3900/api/users/1 -H "authorization: Bearer $KEY" | grep -iE '^(HTTP|x-cache|ratelimit-remaining|retry-after)'; done
docker inspect --format '{{.State.Health.Status}}' gtr-smoke
docker exec gtr-smoke id -u
docker run --rm -v gtr-smoke:/data --entrypoint gtr $IMG apikey list
docker logs gtr-smoke 2>&1 | grep -c request_completed
docker logs gtr-smoke 2>&1 | grep -q correct-horse-battery && echo "PASSWORD LEAKED" || echo "no password in logs"
docker stop gtr-smoke && docker inspect --format 'exit={{.State.ExitCode}}' gtr-smoke
docker logs gtr-smoke 2>&1 | grep -E 'bootstrap_admin_created|shutdown_complete'
```

Expected: `{"status":"ok"}`; requests 1–2 → `HTTP/1.1 200` with `X-Cache: MISS` then `HIT` and falling `RateLimit-Remaining`; request 3 → `429` with `Retry-After`; health `healthy`; uid `1000`; `gtr apikey list` shows the key with RATE LIMIT `default`; `request_completed` count ≥ 3; "no password in logs"; `exit=0`; both log lines present.

- [ ] **Step 3: Upgrade path from a root-owned volume.**

```bash
docker volume create gtr-legacy
docker run --rm --user root -v gtr-legacy:/data --entrypoint node $IMG -e "require('fs').writeFileSync('/data/graphtorest.db','')"
docker run --rm -v gtr-legacy:/data $IMG; echo "exit=$?"
docker run --rm --user root -v gtr-legacy:/data --entrypoint chown $IMG -R node:node /data
docker run -d --name gtr-legacy -v gtr-legacy:/data $IMG && sleep 2 && docker logs gtr-legacy 2>&1 | grep server_started
```

Expected: the first run prints `startup_failed` with the `hint` containing the `chown` command and exits 1; after the `chown`, the server starts.

- [ ] **Step 4: Clean up.**

```bash
docker rm -f gtr-smoke gtr-legacy; docker volume rm gtr-smoke gtr-legacy
```

- [ ] **Step 5: Report** test count, image sizes before/after, audit result, and any deviations from this plan. If anything above failed, fix it in a new commit (`fix: ...`) with the attribution trailer and rerun this task.

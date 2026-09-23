# GraphToRest Plan 6: WebUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the browser admin console the parent spec promises: a React SPA served at `/` that manages connections, credentials, mappings and API keys through `/admin/*`, embeds a Swagger test panel over `/api/*`, and shows an Activity view backed by a new SQLite request log. It uses a cookie-based admin session protected against CSRF.

**Architecture:** Core gains storage for the request log plus list/delete methods, a shared YAML import/export module (moved out of the CLI), a `GatewayEngine` `onMatch` hook, and `ManagedTokenService.clearCredentials`/`abandonAuthorization`. The server gains cookie sessions + CSRF checks in the existing admin-auth middleware, the endpoints the UI needs, an activity-log middleware on `/api`, static serving of the built SPA with a CSP header, and UI redirects from the OAuth callback. A new `apps/web` workspace (React 18 + Vite + React Router + TanStack Query) talks to `/admin/*` with `credentials: 'same-origin'`. The Dockerfile builds it and copies `apps/web/dist` into the runtime image.

**Tech Stack:** Existing: Node 20, TypeScript, Express 4, better-sqlite3, vitest 2, supertest, nock. New in `apps/web`: `react`/`react-dom` 18.3, `react-router-dom` 6, `@tanstack/react-query` 5, `swagger-ui-react` 5, `vite` 5 + `@vitejs/plugin-react` 4; dev: `jsdom`, `@testing-library/react` 16 + `@testing-library/dom` 10. New in core: `yaml` (moved from the CLI).

**Spec:** `docs/superpowers/specs/2026-09-22-graphtorest-06-webui-design.md` (binding for this plan), whose parent is `docs/superpowers/specs/2026-09-17-graphtorest-design.md` (§3, §5, §7.3, §9, §10).

## Global Constraints

- Admin session cookie: name `gtr_admin_session`; attributes `HttpOnly; SameSite=Strict; Path=/admin; Max-Age=<ttl seconds>`, plus `Secure` only when `PUBLIC_BASE_URL` starts with `https://`. A cookie login response body is `{ username, expiresAt }` and never contains the token.
- CSRF (cookie-authenticated, method not GET/HEAD/OPTIONS) → `403 CSRF_REJECTED` unless: `Origin` present and (`new URL(origin).host === Host header` or `new URL(origin).origin === new URL(PUBLIC_BASE_URL).origin`), or `Origin` absent and `Sec-Fetch-Site: same-origin`. Also, a request with a body must be `application/json`, with no exceptions. Bearer-authenticated requests are exempt.
- SPA CSP header, exactly: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.
- The SPA fallback never answers a path equal to `/api` or `/admin` or starting with `/api/` or `/admin/`. (`/api-keys` is a UI route and *does* get `index.html`.)
- `request_log` never stores query strings, headers or bodies. `ACTIVITY_RETENTION` defaults to 1000; `GET /admin/activity` `limit` is 1–200, default 50.
- Error bodies stay `{ "error": { "code", "message", "details" } }` via `GatewayError`/`toErrorResponse`. Sync route handlers may `throw new GatewayError(...)` (the app error handler honors it); async handlers must `try`/`catch` themselves (Express 4).
- Out of scope (spec §2): any admin-user creation in the UI, a browser E2E suite, stdout JSON logs/rate limiting/caching/image slimming, CLI access to activity.
- Test conventions: vitest; temp SQLite files under `os.tmpdir()` removed in `afterEach`; `supertest` for server; `apps/*` resolve `@graphtorest/core` from its built `dist/`, so **after any core change run `npm run build -w @graphtorest/core` before testing `apps/*`**. Web tests run under jsdom and mock `fetch`; they never hit a real server.
- Commit messages: conventional-commit style, ending with the exact line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Design Decisions (made in this plan, refining the spec)

1. **`onMatch` is a separate optional 5th parameter** of `GatewayEngine.handle` (`hooks: GatewayHooks`), not a field of `RequestContext`, because `RequestContext` is handed to adapters.
2. **`request_log.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`.** Ids still increase monotonically because pruning only removes the *oldest* rows, and this avoids SQLite creating an extra `sqlite_sequence` table.
3. **Test panel API key:** the generated OpenAPI document declares no `securitySchemes`, so Swagger UI shows no Authorize dialog. The `/test` page therefore has its own API-key field (stored in `sessionStorage` key `gtr_test_api_key`), and a Swagger `requestInterceptor` adds `Authorization: Bearer <key>`.
4. **`DELETE /admin/connections/:id/credentials` with managed auth off returns `503 MANAGED_AUTH_DISABLED`.** That is the code the existing PUT really uses; the spec's `MANAGED_AUTH_UNAVAILABLE` was a mislabel for "matches the existing PUT".
5. **OAuth callback with `?error=`** consumes the pending state via the new `abandonAuthorization(state)`, which returns the connection id used for the redirect target. This also closes the Plan 5 deferred minor "vendor error= callback doesn't consume pending state". When `completeAuthorization` itself fails, the connection is unknown to the route, so the redirect goes to `/connections?oauth=error&code=…`.
6. **App-wide JSON body limit becomes 1 MB** (`express.json({ limit: '1mb' })`) so `POST /admin/mappings/import` can accept 1 MB of YAML.
7. **Import conflicts** (a `UNIQUE(method, route)` collision) return `409 CONFLICT` whose message contains SQLite's text (the CLI's existing test matches `/UNIQUE/`). All other import validation failures return `400 INVALID_INPUT`. The core function returns warnings instead of printing them; the CLI prints them after a successful import.
8. **React 18.3** (swagger-ui-react 5 supports React <20; 18 is the conservative choice). `SwaggerPanel` is lazy-loaded so the ~1 MB Swagger bundle only loads on `/test`.
9. **Browser side effects** (`window.location.assign`, file downloads) go through `apps/web/src/browser.ts` so jsdom tests can `vi.mock` them.

---

## File Structure

```
packages/core/
  package.json                          # + "yaml" dependency (Task 2)
  src/storage/migrations.ts             # + request_log migration (Task 1)
  src/storage/MappingStore.ts           # + delete/list methods, request log, session details (Task 1)
  src/mappingEngine/mappingYaml.ts      # NEW exportMappingsYaml / importMappingsYaml (Task 2)
  src/gateway/GatewayEngine.ts          # + GatewayHooks.onMatch (Task 3)
  src/auth/managedTokenService.ts       # + clearCredentials, abandonAuthorization (Task 3)
  src/index.ts                          # exports (Tasks 1–3)
  test/storage/webuiStore.test.ts       # NEW (Task 1)
  test/mappingEngine/mappingYaml.test.ts# NEW (Task 2)
  test/gateway/onMatch.test.ts          # NEW (Task 3)
  test/auth/managedTokenLifecycle.test.ts # NEW (Task 3)

apps/cli/
  package.json                          # - "yaml" (Task 2)
  src/commands/mappingImport.ts, mappingExport.ts   # thin wrappers over core (Task 2)

apps/server/
  src/middleware/cookies.ts             # NEW cookie parse/serialize (Task 4)
  src/middleware/adminAuth.ts           # cookie + CSRF (Task 4)
  src/middleware/activityLog.ts         # NEW (Task 6)
  src/middleware/apiKeyAuth.ts          # res.locals for activity (Task 6)
  src/routers/adminRouter.ts            # login/session/logout (4), endpoints (5), activity (6), callback redirect (7)
  src/routers/apiRouter.ts              # onMatch + errorCode (Task 6)
  src/web.ts                            # NEW static SPA handler (Task 7)
  src/app.ts, config.ts, index.ts       # wiring (Tasks 5–7)
  test/cookieSession.integration.test.ts, adminEndpoints.integration.test.ts,
  test/activity.integration.test.ts, webServing.integration.test.ts   # NEW
  test/managedAuth.integration.test.ts, config.test.ts               # extended

apps/web/                               # NEW workspace (Tasks 8–11)
  package.json, tsconfig.json, vite.config.ts, index.html
  src/main.tsx, App.tsx, api.ts, types.ts, session.tsx, browser.ts, testApiKey.ts, styles.css
  src/components/Layout.tsx, ErrorPanel.tsx, ConfirmButton.tsx, OAuthBanner.tsx
  src/pages/LoginPage.tsx, ConnectionsPage.tsx, ConnectionPage.tsx, OverviewTab.tsx, CredentialsTab.tsx,
            MappingsTab.tsx, MappingEditForm.tsx, ApiKeysPage.tsx, TestPanelPage.tsx, SwaggerPanel.tsx, ActivityPage.tsx
  test/render.tsx + *.test.ts(x)

vitest.config.ts                        # tsx tests, jsdom for apps/web, automatic JSX (Task 8)
Dockerfile, docker-compose.yml          # web build + runtime copy, PUBLIC_BASE_URL note (Task 12)
```

---

### Task 1: Core storage — request log, list/delete methods, session details

**Files:**
- Modify: `packages/core/src/storage/migrations.ts`
- Modify: `packages/core/src/storage/MappingStore.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/storage/db.test.ts`
- Test: `packages/core/test/storage/webuiStore.test.ts` (create)

**Interfaces:**
- Produces (on `MappingStore`):
  - `deleteConnection(id: string): boolean`: deletes the connection's mappings and the connection row (which holds its encrypted credentials) in one transaction; `false` if unknown
  - `deleteMapping(id: string): boolean`
  - `listApiKeys(): ApiKeySummary[]` and `deleteApiKey(id: string): boolean`
  - `recordRequest(entry: RequestLogInput, retention: number): void` and `listRequests(options: { limit: number; before?: number }): RequestLogRecord[]`
  - `findAdminSessionDetails(token: string): { user: AdminUserRecord; expiresAt: string } | null`
- Produces types (exported from the core barrel): `ApiKeySummary`, `RequestLogInput`, `RequestLogRecord`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/storage/webuiStore.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';

let dbPath: string;
let db: ReturnType<typeof openDb>;

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore(): MappingStore {
  dbPath = path.join(os.tmpdir(), `graphtorest-webui-store-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  return new MappingStore(db);
}

function seedMapping(store: MappingStore, connectionId: string, route: string) {
  return store.createMapping({ connectionId, route, method: 'GET', operation: { query: 'q' } });
}

describe('deleteConnection', () => {
  it('removes the connection, its mappings and its stored credentials, leaving other connections alone', () => {
    const store = freshStore();
    const doomed = store.createConnection({ name: 'doomed', adapterType: 'mock', authMode: 'managed' });
    const kept = store.createConnection({ name: 'kept', adapterType: 'mock', authMode: 'passthrough' });
    store.setConnectionCredentials(doomed.id, 'v1:encrypted');
    seedMapping(store, doomed.id, '/a');
    const keptMapping = seedMapping(store, kept.id, '/b');

    expect(store.deleteConnection(doomed.id)).toBe(true);

    expect(store.getConnection(doomed.id)).toBeNull();
    expect(store.getConnectionCredentials(doomed.id)).toBeNull();
    expect(store.listMappings()).toEqual([keptMapping]);
    expect(store.getConnection(kept.id)).not.toBeNull();
  });

  it('returns false for an unknown connection', () => {
    expect(freshStore().deleteConnection('nope')).toBe(false);
  });
});

describe('deleteMapping', () => {
  it('deletes one mapping and reports whether it existed', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'c', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = seedMapping(store, connection.id, '/a');
    expect(store.deleteMapping(mapping.id)).toBe(true);
    expect(store.getMapping(mapping.id)).toBeNull();
    expect(store.deleteMapping(mapping.id)).toBe(false);
  });
});

describe('API key listing and deletion', () => {
  it('lists key metadata without any hash, and deletes keys', () => {
    const store = freshStore();
    const first = store.createApiKey({ label: 'first' });
    const second = store.createApiKey({});
    store.touchApiKeyLastUsed(first.id);

    const listed = store.listApiKeys();
    expect(listed.map((k) => k.id).sort()).toEqual([first.id, second.id].sort());
    const firstRow = listed.find((k) => k.id === first.id)!;
    expect(Object.keys(firstRow).sort()).toEqual(['createdAt', 'id', 'label', 'lastUsedAt']);
    expect(firstRow.label).toBe('first');
    expect(typeof firstRow.createdAt).toBe('string');
    expect(typeof firstRow.lastUsedAt).toBe('string');
    expect(listed.find((k) => k.id === second.id)!.lastUsedAt).toBeNull();

    expect(store.deleteApiKey(first.id)).toBe(true);
    expect(store.findApiKeyById(first.id)).toBeNull();
    expect(store.deleteApiKey(first.id)).toBe(false);
  });
});

describe('request log', () => {
  const base = { method: 'GET', status: 200, durationMs: 5 };

  it('returns rows newest first with the API key label and connection name joined in', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'conn-a', adapterType: 'mock', authMode: 'passthrough' });
    const key = store.createApiKey({ label: 'dev key' });
    store.recordRequest({ ...base, ts: '2026-09-22T10:00:00.000Z', path: '/api/one' }, 1000);
    store.recordRequest(
      { ...base, ts: '2026-09-22T10:00:01.000Z', path: '/api/two', status: 502, errorCode: 'VENDOR_ERROR', apiKeyId: key.id, connectionId: connection.id, mappingId: 'm-1' },
      1000
    );

    const rows = store.listRequests({ limit: 10 });
    expect(rows.map((r) => r.path)).toEqual(['/api/two', '/api/one']);
    expect(rows[0]).toMatchObject({
      method: 'GET',
      status: 502,
      durationMs: 5,
      errorCode: 'VENDOR_ERROR',
      apiKeyId: key.id,
      apiKeyLabel: 'dev key',
      connectionId: connection.id,
      connectionName: 'conn-a',
      mappingId: 'm-1',
    });
    expect(rows[1]).toMatchObject({ errorCode: null, apiKeyId: null, apiKeyLabel: null, connectionId: null, connectionName: null, mappingId: null });
    expect(typeof rows[0].id).toBe('number');
  });

  it('pages backwards with "before"', () => {
    const store = freshStore();
    for (let i = 1; i <= 5; i++) store.recordRequest({ ...base, ts: `2026-09-22T10:00:0${i}.000Z`, path: `/api/${i}` }, 1000);
    const firstPage = store.listRequests({ limit: 2 });
    expect(firstPage.map((r) => r.path)).toEqual(['/api/5', '/api/4']);
    const secondPage = store.listRequests({ limit: 2, before: firstPage[1].id });
    expect(secondPage.map((r) => r.path)).toEqual(['/api/3', '/api/2']);
  });

  it('keeps only the newest "retention" rows', () => {
    const store = freshStore();
    for (let i = 1; i <= 5; i++) store.recordRequest({ ...base, ts: `2026-09-22T10:00:0${i}.000Z`, path: `/api/${i}` }, 3);
    expect(store.listRequests({ limit: 10 }).map((r) => r.path)).toEqual(['/api/5', '/api/4', '/api/3']);
  });

  it('rejects a retention that is not a positive integer', () => {
    const store = freshStore();
    expect(() => store.recordRequest({ ...base, ts: 't', path: '/api/x' }, 0)).toThrow(/retention/);
  });

  it('keeps log rows after their connection is deleted, with a null connection name', () => {
    const store = freshStore();
    const connection = store.createConnection({ name: 'gone', adapterType: 'mock', authMode: 'passthrough' });
    store.recordRequest({ ...base, ts: 't', path: '/api/x', connectionId: connection.id }, 1000);
    store.deleteConnection(connection.id);
    expect(store.listRequests({ limit: 10 })[0]).toMatchObject({ connectionId: connection.id, connectionName: null });
  });
});

describe('findAdminSessionDetails', () => {
  it('returns the user and the session expiry, and null for an unknown token', () => {
    const store = freshStore();
    const user = store.createAdminUser({ username: 'admin', password: 'correct-horse-battery' });
    const { token, expiresAt } = store.createAdminSession(user.id, 60_000);
    expect(store.findAdminSessionDetails(token)).toEqual({ user: { id: user.id, username: 'admin' }, expiresAt });
    expect(store.findAdminSessionDetails('bogus')).toBeNull();
  });
});
```

In `packages/core/test/storage/db.test.ts`, update the two table assertions for the new table:

```ts
    expect(tables).toEqual(['admin_sessions', 'admin_users', 'api_keys', 'connections', 'mappings', 'request_log']);
```

and in the idempotency test:

```ts
    expect(tables.length).toBe(6);
```

(Rename the first test's title from "creates all five tables" to "creates all six tables".)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/storage`
Expected: FAIL. `webuiStore.test.ts` fails with "store.deleteConnection is not a function" (and similar), and `db.test.ts` fails because `request_log` is missing.

- [ ] **Step 3: Add the migration**

In `packages/core/src/storage/migrations.ts`, append a third element to `MIGRATIONS` (after the `admin_sessions` one):

```ts
  `
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    error_code TEXT,
    api_key_id TEXT,
    connection_id TEXT,
    mapping_id TEXT
  );
  `,
```

- [ ] **Step 4: Add the types and methods to `MappingStore`**

In `packages/core/src/storage/MappingStore.ts`, add these exported interfaces after `AdminUserRecord`:

```ts
export interface ApiKeySummary {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RequestLogInput {
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string | null;
  apiKeyId?: string | null;
  connectionId?: string | null;
  mappingId?: string | null;
}

export interface RequestLogRecord {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  connectionId: string | null;
  connectionName: string | null;
  mappingId: string | null;
}
```

Add these methods to the class. Put `deleteConnection` after `getConnectionCredentials`, `deleteMapping` after `updateMapping`, the two API-key methods after `touchApiKeyLastUsed`, and the request-log methods at the end of the class:

```ts
  /** Deletes a connection and its mappings in one transaction (stored credentials live on the connection row). Returns false if it does not exist. */
  deleteConnection(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM mappings WHERE connection_id = ?').run(id);
      return this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
    });
  }
```

```ts
  deleteMapping(id: string): boolean {
    return this.db.prepare('DELETE FROM mappings WHERE id = ?').run(id).changes > 0;
  }
```

```ts
  /** Key metadata only — never the hash. */
  listApiKeys(): ApiKeySummary[] {
    return this.db
      .prepare('SELECT id, label, created_at as createdAt, last_used_at as lastUsedAt FROM api_keys ORDER BY created_at, id')
      .all() as ApiKeySummary[];
  }

  deleteApiKey(id: string): boolean {
    return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
  }
```

```ts
  /** Appends one request-log row, then prunes everything but the newest `retention` rows. */
  recordRequest(entry: RequestLogInput, retention: number): void {
    if (!Number.isInteger(retention) || retention < 1) throw new Error('Activity retention must be a positive integer');
    this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          'INSERT INTO request_log (ts, method, path, status, duration_ms, error_code, api_key_id, connection_id, mapping_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          entry.ts,
          entry.method,
          entry.path,
          entry.status,
          entry.durationMs,
          entry.errorCode ?? null,
          entry.apiKeyId ?? null,
          entry.connectionId ?? null,
          entry.mappingId ?? null
        );
      this.db.prepare('DELETE FROM request_log WHERE id <= ?').run(Number(lastInsertRowid) - retention);
    });
  }

  /** Newest-first page of the request log; `before` is an exclusive upper bound on `id`. */
  listRequests(options: { limit: number; before?: number }): RequestLogRecord[] {
    const where = options.before !== undefined ? 'WHERE r.id < ?' : '';
    const params = options.before !== undefined ? [options.before, options.limit] : [options.limit];
    return this.db
      .prepare(
        `SELECT r.id, r.ts, r.method, r.path, r.status, r.duration_ms as durationMs, r.error_code as errorCode,
                r.api_key_id as apiKeyId, k.label as apiKeyLabel, r.connection_id as connectionId, c.name as connectionName,
                r.mapping_id as mappingId
         FROM request_log r
         LEFT JOIN api_keys k ON k.id = r.api_key_id
         LEFT JOIN connections c ON c.id = r.connection_id
         ${where}
         ORDER BY r.id DESC
         LIMIT ?`
      )
      .all(...params) as RequestLogRecord[];
  }
```

Replace the existing `findAdminSession` with a version that delegates to a new `findAdminSessionDetails`, so there is still exactly one expiry check:

```ts
  findAdminSessionDetails(token: string): { user: AdminUserRecord; expiresAt: string } | null {
    const row = this.db
      .prepare(
        'SELECT u.id as id, u.username as username, s.expires_at as expiresAt FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id WHERE s.token_hash = ?'
      )
      .get(hashSessionToken(token)) as { id: string; username: string; expiresAt: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expiresAt) <= Date.now()) {
      this.deleteAdminSession(token);
      return null;
    }
    return { user: { id: row.id, username: row.username }, expiresAt: row.expiresAt };
  }

  findAdminSession(token: string): AdminUserRecord | null {
    return this.findAdminSessionDetails(token)?.user ?? null;
  }
```

- [ ] **Step 5: Export the new types**

In `packages/core/src/index.ts`, replace the `MappingStore` type export line with:

```ts
export type {
  ConnectionRecord,
  MappingRecord,
  ApiKeyRecord,
  AdminUserRecord,
  ApiKeySummary,
  RequestLogInput,
  RequestLogRecord,
} from './storage/MappingStore';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core`
Expected: PASS. All core tests pass, including the new `webuiStore.test.ts` (10 tests) and the updated `db.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/storage packages/core/src/index.ts packages/core/test/storage
git commit -m "$(cat <<'EOF'
feat(core): add request log storage, list/delete methods and session details for the web UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Core YAML import/export (moved out of the CLI)

**Files:**
- Create: `packages/core/src/mappingEngine/mappingYaml.ts`
- Modify: `packages/core/package.json` (add `"yaml": "^2.6.0"` to `dependencies`)
- Modify: `packages/core/src/index.ts`
- Modify: `apps/cli/src/commands/mappingImport.ts`, `apps/cli/src/commands/mappingExport.ts`
- Modify: `apps/cli/package.json` (remove `"yaml"` from `dependencies`)
- Test: `packages/core/test/mappingEngine/mappingYaml.test.ts` (create). The existing CLI tests `apps/cli/test/{commands,carryOvers,mappingLifecycle}.test.ts` must keep passing unchanged.

**Interfaces:**
- Consumes: `mappingToYamlEntry`, `yamlEntryToMappingInput`, `MappingYamlEntry`, `MappingInput` from `./yamlTransform`; `MappingStore.transaction`.
- Produces:
  - `exportMappingsYaml(store: MappingStore, options?: { connectionId?: string }): string`: throws `GatewayError('NOT_FOUND', 'Connection not found', 404)` for an unknown `connectionId`
  - `importMappingsYaml(store: MappingStore, yamlText: string): MappingImportResult`, where `interface MappingImportResult { records: MappingRecord[]; warnings: string[] }`: throws `GatewayError` `INVALID_INPUT` 400 or `CONFLICT` 409, and writes nothing when it throws

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/mappingEngine/mappingYaml.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { exportMappingsYaml, importMappingsYaml } from '../../src/mappingEngine/mappingYaml';

let dbPath: string;
let db: ReturnType<typeof openDb>;

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore(): MappingStore {
  dbPath = path.join(os.tmpdir(), `graphtorest-mapping-yaml-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  return new MappingStore(db);
}

function seed(store: MappingStore) {
  const a = store.createConnection({ name: 'conn-a', adapterType: 'mock', authMode: 'passthrough' });
  const b = store.createConnection({ name: 'conn-b', adapterType: 'mock', authMode: 'passthrough' });
  const ma = store.createMapping({ connectionId: a.id, route: '/a', method: 'GET', operation: { query: 'a' } });
  const mb = store.createMapping({ connectionId: b.id, route: '/b', method: 'GET', operation: { query: 'b' } });
  return { a, b, ma, mb };
}

describe('exportMappingsYaml', () => {
  it('exports every mapping, naming each connection', () => {
    const store = freshStore();
    seed(store);
    const entries = YAML.parse(exportMappingsYaml(store));
    expect(entries.map((e: { route: string; connection: string }) => [e.route, e.connection])).toEqual([
      ['GET /a', 'conn-a'],
      ['GET /b', 'conn-b'],
    ]);
  });

  it('limits the export to one connection', () => {
    const store = freshStore();
    const { b } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store, { connectionId: b.id }));
    expect(entries).toHaveLength(1);
    expect(entries[0].route).toBe('GET /b');
  });

  it('throws NOT_FOUND for an unknown connection', () => {
    const store = freshStore();
    expect(() => exportMappingsYaml(store, { connectionId: 'nope' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
  });
});

describe('importMappingsYaml', () => {
  it('round-trips an export, flipping edited generated mappings to manual with a warning', () => {
    const store = freshStore();
    const { ma } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store));
    entries[0].route = 'GET /a-renamed';
    const result = importMappingsYaml(store, YAML.stringify(entries));
    expect(result.records).toHaveLength(2);
    expect(store.getMapping(ma.id)).toMatchObject({ route: '/a-renamed', source: 'manual' });
    expect(result.warnings).toEqual([
      '2 generated mapping(s) are now source=manual and will be skipped by regeneration unless forced',
    ]);
  });

  it('creates new mappings from entries without an id', () => {
    const store = freshStore();
    seed(store);
    const yamlText = YAML.stringify([
      { route: 'POST /new', connection: 'conn-a', source: 'manual', operation: { query: 'n' }, response: { shape: 'passthrough' }, auth: 'inherit' },
    ]);
    const result = importMappingsYaml(store, yamlText);
    expect(result.records[0]).toMatchObject({ route: '/new', method: 'POST', source: 'manual' });
    expect(result.warnings).toEqual([]);
  });

  it('warns that a changed "connection" on an existing mapping is ignored', () => {
    const store = freshStore();
    const { ma } = seed(store);
    const entries = YAML.parse(exportMappingsYaml(store, { connectionId: ma.connectionId }));
    entries[0].connection = 'conn-b';
    const result = importMappingsYaml(store, YAML.stringify(entries));
    expect(result.warnings).toContain(
      `Ignoring "connection" on mapping ${ma.id}: an existing mapping's connection cannot be changed by import`
    );
    expect(store.getMapping(ma.id)!.connectionId).toBe(ma.connectionId);
  });

  it('treats an empty document as nothing to import', () => {
    const store = freshStore();
    expect(importMappingsYaml(store, '# nothing here\n')).toEqual({ records: [], warnings: [] });
  });

  it.each([
    ['unparseable YAML', 'route: [unclosed', /Invalid YAML/],
    ['a non-list document', 'route: GET /x', /must be a list/],
    ['a non-object entry', '- just a string', /must be a mapping object/],
    [
      'an unknown connection',
      YAML.stringify([{ route: 'GET /x', connection: 'nope', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]),
      /No connection named "nope"/,
    ],
    [
      'an unknown mapping id',
      YAML.stringify([{ id: 'missing', route: 'GET /x', connection: 'conn-a', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' }]),
      /No mapping with id missing/,
    ],
    [
      'an invalid entry',
      YAML.stringify([{ route: 'GET /x', connection: 'conn-a', source: 'manual', operation: {}, response: { shape: 'template' }, auth: 'inherit' }]),
      /template/,
    ],
  ])('rejects %s with INVALID_INPUT and writes nothing', (_label, yamlText, message) => {
    const store = freshStore();
    seed(store);
    const before = store.listMappings();
    let caught: unknown;
    try {
      importMappingsYaml(store, yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect((caught as Error).message).toMatch(message);
    expect(store.listMappings()).toEqual(before);
  });

  it('rejects a method+route collision with CONFLICT and rolls back every write', () => {
    const store = freshStore();
    seed(store);
    const before = store.listMappings();
    const yamlText = YAML.stringify([
      { route: 'GET /fresh', connection: 'conn-a', source: 'manual', operation: { query: 'f' }, response: { shape: 'passthrough' }, auth: 'inherit' },
      { route: 'GET /b', connection: 'conn-a', source: 'manual', operation: { query: 'dup' }, response: { shape: 'passthrough' }, auth: 'inherit' },
    ]);
    let caught: unknown;
    try {
      importMappingsYaml(store, yamlText);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect((caught as Error).message).toMatch(/UNIQUE/);
    expect(store.listMappings()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/mappingEngine/mappingYaml.test.ts`
Expected: FAIL with "Cannot find module '../../src/mappingEngine/mappingYaml'" (or failure to resolve `yaml`, since core does not depend on it yet).

- [ ] **Step 3: Add the dependency**

In `packages/core/package.json` `dependencies`, add `"yaml": "^2.6.0"`. In `apps/cli/package.json` `dependencies`, remove `"yaml"`. Then run `npm install` at the repo root to update `package-lock.json`.

- [ ] **Step 4: Implement `mappingYaml.ts`**

Create `packages/core/src/mappingEngine/mappingYaml.ts`:

```ts
import YAML from 'yaml';
import type { MappingRecord, MappingStore } from '../storage/MappingStore';
import { GatewayError } from '../gateway/errors';
import { mappingToYamlEntry, yamlEntryToMappingInput, type MappingInput, type MappingYamlEntry } from './yamlTransform';

export interface MappingImportResult {
  records: MappingRecord[];
  warnings: string[];
}

type ResolvedWrite = { kind: 'update'; id: string; input: MappingInput } | { kind: 'create'; connectionId: string; input: MappingInput };

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

/** Serializes mappings to the YAML format shared by `gtr mapping-export` and the admin API. */
export function exportMappingsYaml(store: MappingStore, options: { connectionId?: string } = {}): string {
  const connections = store.listConnections();
  if (options.connectionId !== undefined && !connections.some((c) => c.id === options.connectionId)) {
    throw new GatewayError('NOT_FOUND', 'Connection not found', 404);
  }
  const connectionNames = new Map(connections.map((c) => [c.id, c.name]));
  const mappings = store
    .listMappings()
    .filter((m) => options.connectionId === undefined || m.connectionId === options.connectionId);
  return YAML.stringify(mappings.map((m) => mappingToYamlEntry(m, connectionNames.get(m.connectionId) ?? m.connectionId)));
}

/**
 * Validates every entry first, then applies all writes in one transaction — nothing is written if anything is
 * invalid or a write fails. Imported mappings become source=manual. Warnings are returned, not printed.
 */
export function importMappingsYaml(store: MappingStore, yamlText: string): MappingImportResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw invalid(`Invalid YAML: ${(err as Error).message}`);
  }
  const entries = parsed ?? [];
  if (!Array.isArray(entries)) throw invalid('The YAML document must be a list of mapping entries');

  const warnings: string[] = [];
  const connections = store.listConnections();
  const connectionIdsByName = new Map(connections.map((c) => [c.name, c.id]));
  const connectionNamesById = new Map(connections.map((c) => [c.id, c.name]));
  let flippedToManual = 0;

  // Pass 1: validate and resolve every entry without writing anything.
  const resolved: ResolvedWrite[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalid('Each YAML entry must be a mapping object');
    }
    const entry = raw as MappingYamlEntry;
    if (entry.id) {
      const existing = store.getMapping(entry.id);
      if (!existing) throw invalid(`No mapping with id ${entry.id} to update (from YAML import)`);
      if (existing.source === 'generated') flippedToManual += 1;
      if (entry.connection !== connectionNamesById.get(existing.connectionId)) {
        warnings.push(`Ignoring "connection" on mapping ${entry.id}: an existing mapping's connection cannot be changed by import`);
      }
      resolved.push({ kind: 'update', id: entry.id, input: toInput(entry, '') });
      continue;
    }
    const connectionId = connectionIdsByName.get(entry.connection);
    if (!connectionId) throw invalid(`No connection named "${entry.connection}" (from YAML import)`);
    resolved.push({ kind: 'create', connectionId, input: toInput(entry, connectionId) });
  }

  // Pass 2: one transaction, so a failure pass 1 cannot anticipate (a UNIQUE(method, route) collision) rolls everything back.
  let records: MappingRecord[];
  try {
    records = store.transaction(() => applyWrites(store, resolved));
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new GatewayError('CONFLICT', `Import conflicts with an existing mapping: ${(err as Error).message}`, 409);
    }
    throw err;
  }
  if (flippedToManual > 0) {
    warnings.push(`${flippedToManual} generated mapping(s) are now source=manual and will be skipped by regeneration unless forced`);
  }
  return { records, warnings };
}

function toInput(entry: MappingYamlEntry, connectionId: string): MappingInput {
  try {
    return yamlEntryToMappingInput(entry, connectionId);
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw invalid((err as Error).message);
  }
}

function applyWrites(store: MappingStore, resolved: ResolvedWrite[]): MappingRecord[] {
  const results: MappingRecord[] = [];
  for (const item of resolved) {
    if (item.kind === 'update') {
      const updated = store.updateMapping(item.id, {
        route: item.input.route,
        method: item.input.method,
        operation: item.input.operation,
        responseTemplate: item.input.responseTemplate,
        source: 'manual',
      });
      if (!updated) throw invalid(`No mapping with id ${item.id} to update (from YAML import)`);
      results.push(updated);
      continue;
    }
    results.push(
      store.createMapping({
        connectionId: item.connectionId,
        route: item.input.route,
        method: item.input.method,
        operation: item.input.operation,
        responseTemplate: item.input.responseTemplate,
        source: 'manual',
      })
    );
  }
  return results;
}
```

Export it from `packages/core/src/index.ts` (next to the `yamlTransform` export):

```ts
export { exportMappingsYaml, importMappingsYaml } from './mappingEngine/mappingYaml';
export type { MappingImportResult } from './mappingEngine/mappingYaml';
```

- [ ] **Step 5: Run the core tests**

Run: `npx vitest run packages/core/test/mappingEngine`
Expected: PASS, including 12 tests in `mappingYaml.test.ts` (3 export, 4 import, 6 `it.each` rejections, 1 conflict; the exact count may differ by the `it.each` expansion, but all must pass).

- [ ] **Step 6: Make the CLI commands thin wrappers**

Replace `apps/cli/src/commands/mappingImport.ts` with:

```ts
import fs from 'node:fs';
import { importMappingsYaml, type MappingRecord, type MappingStore } from '@graphtorest/core';

export function mappingImport(store: MappingStore, args: { file: string; warn?: (message: string) => void }): MappingRecord[] {
  const warn = args.warn ?? ((message: string) => console.warn(message));
  const { records, warnings } = importMappingsYaml(store, fs.readFileSync(args.file, 'utf8'));
  for (const warning of warnings) warn(warning);
  return records;
}
```

Replace `apps/cli/src/commands/mappingExport.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { exportMappingsYaml, type MappingStore } from '@graphtorest/core';

export function mappingExport(store: MappingStore, args: { outFile?: string }): string {
  const yamlText = exportMappingsYaml(store);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    const tempFile = `${args.outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, yamlText, 'utf8');
    fs.renameSync(tempFile, args.outFile);
  }
  return yamlText;
}
```

- [ ] **Step 7: Run the CLI tests against the rebuilt core**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/cli packages/core`
Expected: PASS, with every existing CLI test unchanged (`commands.test.ts`, `carryOvers.test.ts`, `mappingLifecycle.test.ts`, etc.). Also run `npm run build -w @graphtorest/cli` and expect no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/cli package-lock.json
git commit -m "$(cat <<'EOF'
refactor(core,cli): move YAML mapping import/export into core for reuse by the admin API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Core hooks — `onMatch` and managed-credential lifecycle

**Files:**
- Modify: `packages/core/src/gateway/GatewayEngine.ts`
- Modify: `packages/core/src/auth/managedTokenService.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/gateway/onMatch.test.ts` (create), `packages/core/test/auth/managedTokenLifecycle.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface GatewayHooks { onMatch?: (mapping: MappingRecord) => void }`
  - `GatewayEngine.handle(method, path, incomingAuth = {}, request = {}, hooks: GatewayHooks = {})`: calls `hooks.onMatch(mapping)` once, right after the route resolves, before anything that can fail
  - `ManagedTokenService.clearCredentials(connectionId: string): void`: sets the stored credentials to `null`, drops cached and in-flight tokens (via the existing private `invalidateInFlight`), and discards pending authorizations for that connection
  - `ManagedTokenService.abandonAuthorization(state: string): string | null`: consumes a pending state and returns its connection id, or `null` if the state is unknown or expired

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/gateway/onMatch.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { registerAdapter } from '../../src/adapters/registry';
import { MockAdapter } from '../../src/adapters/MockAdapter';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  registerAdapter('mock', () => new MockAdapter());
  dbPath = path.join(os.tmpdir(), `graphtorest-onmatch-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('GatewayEngine onMatch hook', () => {
  it('reports the matched mapping once', async () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
    });
    const onMatch = vi.fn();
    await new GatewayEngine(store).handle('GET', '/users/42', {}, {}, { onMatch });
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenCalledWith(mapping);
  });

  it('reports the mapping even when the connection it points at is missing', async () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/x', method: 'GET', operation: { query: 'q' } });
    vi.spyOn(store, 'getConnection').mockReturnValue(null);
    const onMatch = vi.fn();
    await expect(new GatewayEngine(store).handle('GET', '/x', {}, {}, { onMatch })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    expect(onMatch).toHaveBeenCalledWith(mapping);
  });

  it('is not called when no mapping matches', async () => {
    const onMatch = vi.fn();
    await expect(new GatewayEngine(store).handle('GET', '/nowhere', {}, {}, { onMatch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(onMatch).not.toHaveBeenCalled();
  });
});
```

Create `packages/core/test/auth/managedTokenLifecycle.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { openDb } from '../../src/storage/db';
import { MappingStore, type ConnectionRecord } from '../../src/storage/MappingStore';
import { CredentialCipher } from '../../src/auth/credentialCipher';
import { ManagedTokenService } from '../../src/auth/managedTokenService';

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';
const REDIRECT = 'https://gtr.example.test/admin/oauth/callback';
const CC_INPUT = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };
const AC_INPUT = { ...CC_INPUT, grant: 'authorization_code' };

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let connection: ConnectionRecord;
let clock: number;
let service: ManagedTokenService;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-life-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  connection = store.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
  clock = 1_000_000;
  service = new ManagedTokenService(store, new CredentialCipher('00'.repeat(32)), () => clock);
});

afterEach(() => {
  nock.cleanAll();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('clearCredentials', () => {
  it('removes stored credentials and forgets a cached token', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'cached-token', expires_in: 3600 });
    await expect(service.getAccessToken(connection)).resolves.toBe('cached-token');

    service.clearCredentials(connection.id);

    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: false });
    expect(store.getConnectionCredentials(connection.id)).toBeNull();
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'MANAGED_CREDENTIALS_MISSING' });
  });

  it('invalidates pending authorizations for that connection', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    service.clearCredentials(connection.id);
    await expect(service.completeAuthorization(state, 'code')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('abandonAuthorization', () => {
  it('returns the connection id once and consumes the state', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    expect(service.abandonAuthorization(state)).toBe(connection.id);
    expect(service.abandonAuthorization(state)).toBeNull();
    await expect(service.completeAuthorization(state, 'code')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('returns null for an unknown or expired state', () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = new URL(service.beginAuthorization(connection, REDIRECT)).searchParams.get('state')!;
    expect(service.abandonAuthorization('made-up')).toBeNull();
    clock += 11 * 60_000;
    expect(service.abandonAuthorization(state)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/gateway/onMatch.test.ts packages/core/test/auth/managedTokenLifecycle.test.ts`
Expected: FAIL. `onMatch` is never called, and `service.clearCredentials is not a function`.

- [ ] **Step 3: Implement the hook**

In `packages/core/src/gateway/GatewayEngine.ts`, add after the `ResolvedRequest` interface:

```ts
export interface GatewayHooks {
  /** Called once the request has been matched to a mapping, before anything that can fail. */
  onMatch?: (mapping: MappingRecord) => void;
}
```

Change `handle`'s signature and the start of its body to:

```ts
  async handle(
    method: string,
    path: string,
    incomingAuth: { vendorToken?: string } = {},
    request: RequestContext = {},
    hooks: GatewayHooks = {}
  ): Promise<unknown> {
    const resolved = this.resolve(method, path);
    if (!resolved) {
      throw new GatewayError('NOT_FOUND', `No mapping for ${method} ${path}`, 404);
    }
    const { mapping, params } = resolved;
    hooks.onMatch?.(mapping);
```

(the rest of the method is unchanged).

In `packages/core/src/index.ts`, change `export type { ResolvedRequest } from './gateway/GatewayEngine';` to:

```ts
export type { ResolvedRequest, GatewayHooks } from './gateway/GatewayEngine';
```

- [ ] **Step 4: Implement the service methods**

In `packages/core/src/auth/managedTokenService.ts`, add these public methods after `getCredentialStatus`:

```ts
  /** Removes stored credentials; cached/in-flight tokens and pending authorizations for the connection are discarded. */
  clearCredentials(connectionId: string): void {
    this.store.setConnectionCredentials(connectionId, null);
    this.invalidateInFlight(connectionId);
    for (const [state, entry] of this.pending) {
      if (entry.connectionId === connectionId) this.pending.delete(state);
    }
  }

  /** Consumes a pending authorization the vendor rejected. Returns its connection id, or null if unknown or expired. */
  abandonAuthorization(state: string): string | null {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= this.now()) return null;
    return pending.connectionId;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core`
Expected: PASS. The new files have 3 + 4 tests, and all existing core tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test/gateway/onMatch.test.ts packages/core/test/auth/managedTokenLifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add a gateway onMatch hook and managed-credential clear/abandon operations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 4: Server — cookie admin sessions and CSRF protection

**Files:**
- Create: `apps/server/src/middleware/cookies.ts`
- Modify: `apps/server/src/middleware/adminAuth.ts`
- Modify: `apps/server/src/routers/adminRouter.ts` (login, `GET /session`, logout)
- Test: `apps/server/test/cookieSession.integration.test.ts` (create)

**Interfaces:**
- Consumes: `MappingStore.findAdminSessionDetails` (Task 1), `loginAdmin`.
- Produces:
  - `ADMIN_SESSION_COOKIE = 'gtr_admin_session'`, `parseCookies(header: string | undefined): Record<string, string>`, `sessionCookie(value: string, options: { maxAgeSeconds: number; secure: boolean }): string` (all in `cookies.ts`)
  - `createAdminAuth(store: MappingStore, options?: { publicBaseUrl?: string }): RequestHandler`, which sets `res.locals.adminUser`, `res.locals.adminToken`, `res.locals.adminSessionExpiresAt: string` and `res.locals.adminSessionViaCookie: boolean`
  - Routes: `POST /admin/login` with an optional `session: "cookie"`, `GET /admin/session`, and `POST /admin/logout`, which clears the cookie

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/cookieSession.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

const PASSWORD = 'correct-horse-battery';
const BASE_URL = 'http://gtr.example.test';

let dbPath: string;
let store: MappingStore;

function buildApp(publicBaseUrl = BASE_URL) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    publicBaseUrl,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-cookie-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  store.createAdminUser({ username: 'admin', password: PASSWORD });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

/** Logs in with a cookie session and returns the raw Set-Cookie header and the "name=value" pair to send back. */
async function cookieLogin(app: ReturnType<typeof createApp>) {
  const res = await request(app).post('/admin/login').send({ username: 'admin', password: PASSWORD, session: 'cookie' });
  expect(res.status).toBe(200);
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
  return { res, setCookie, cookie: setCookie.split(';')[0] };
}

const CONNECTION = { name: 'c1', adapterType: 'mock', authMode: 'passthrough' };

describe('cookie login', () => {
  it('sets an HttpOnly SameSite=Strict cookie scoped to /admin and keeps the token out of the body', async () => {
    const app = buildApp();
    const { res, setCookie } = await cookieLogin(app);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'username']);
    expect(res.body.username).toBe('admin');
    expect(setCookie).toMatch(/^gtr_admin_session=[^;]+/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/admin');
    expect(setCookie).toMatch(/Max-Age=(28[0-7]\d\d|28800)\b/); // default 8h TTL, allowing for elapsed seconds
    expect(setCookie).not.toContain('Secure');
  });

  it('marks the cookie Secure when PUBLIC_BASE_URL is https', async () => {
    const { setCookie } = await cookieLogin(buildApp('https://gtr.example.test'));
    expect(setCookie).toContain('Secure');
  });

  it('keeps the bearer-token login unchanged when "session" is absent', async () => {
    const res = await request(buildApp()).post('/admin/login').send({ username: 'admin', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an unknown "session" value', async () => {
    const res = await request(buildApp()).post('/admin/login').send({ username: 'admin', password: PASSWORD, session: 'jar' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('cookie-authenticated requests', () => {
  it('authenticates reads and reports the session', async () => {
    const app = buildApp();
    const { cookie, res: login } = await cookieLogin(app);
    expect((await request(app).get('/admin/connections').set('Cookie', cookie)).status).toBe(200);
    const session = await request(app).get('/admin/session').set('Cookie', cookie);
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ username: 'admin', expiresAt: login.body.expiresAt });
  });

  it('reports 401 from /admin/session without a session', async () => {
    expect((await request(buildApp()).get('/admin/session')).status).toBe(401);
  });

  it('accepts a write whose Origin matches the Host header', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app)
      .post('/admin/connections')
      .set('Cookie', cookie)
      .set('Host', 'lan-box:3000')
      .set('Origin', 'http://lan-box:3000')
      .send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('accepts a write whose Origin matches PUBLIC_BASE_URL', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set('Origin', BASE_URL).send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('accepts a write without Origin when Sec-Fetch-Site is same-origin', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set('Sec-Fetch-Site', 'same-origin').send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it.each([
    ['a cross-site Origin', { Origin: 'https://evil.example' }],
    ['an unparseable Origin', { Origin: 'null' }],
    ['no Origin and no Sec-Fetch-Site', {}],
    ['no Origin and a cross-site Sec-Fetch-Site', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('rejects a write with %s and changes nothing', async (_label, headers) => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/connections').set('Cookie', cookie).set(headers as Record<string, string>).send(CONNECTION);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect(store.listConnections()).toEqual([]);
  });

  it('rejects a same-origin write whose body is not JSON', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app)
      .post('/admin/connections')
      .set('Cookie', cookie)
      .set('Origin', BASE_URL)
      .set('Content-Type', 'text/plain')
      .send('name=c1');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('does not apply CSRF checks to GET requests', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).get('/admin/connections').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it('exempts bearer-authenticated requests from CSRF checks', async () => {
    const app = buildApp();
    const login = await request(app).post('/admin/login').send({ username: 'admin', password: PASSWORD });
    const res = await request(app)
      .post('/admin/connections')
      .set('Authorization', `Bearer ${login.body.token}`)
      .set('Origin', 'https://evil.example')
      .send(CONNECTION);
    expect(res.status).toBe(201);
  });

  it('uses the Authorization header when present, even if a valid cookie is also sent', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).get('/admin/connections').set('Cookie', cookie).set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('cookie logout', () => {
  it('deletes the session and clears the cookie', async () => {
    const app = buildApp();
    const { cookie } = await cookieLogin(app);
    const res = await request(app).post('/admin/logout').set('Cookie', cookie).set('Origin', BASE_URL);
    expect(res.status).toBe(204);
    const cleared = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cleared).toMatch(/^gtr_admin_session=;/);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/admin');
    expect((await request(app).get('/admin/session').set('Cookie', cookie)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/cookieSession.integration.test.ts`
Expected: FAIL. No `Set-Cookie` header is sent, and `/admin/session` returns 404.

- [ ] **Step 3: Create the cookie helpers**

Create `apps/server/src/middleware/cookies.ts`:

```ts
export const ADMIN_SESSION_COOKIE = 'gtr_admin_session';

/** Minimal Cookie-header parser: first occurrence of a name wins; values are URI-decoded when possible. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name in cookies) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

/** Serializes the admin session cookie. An empty value with maxAgeSeconds 0 clears it. */
export function sessionCookie(value: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
```

- [ ] **Step 4: Rewrite the admin-auth middleware**

Replace `apps/server/src/middleware/adminAuth.ts` with:

```ts
import type { Request, RequestHandler } from 'express';
import type { MappingStore } from '@graphtorest/core';
import { ADMIN_SESSION_COOKIE, parseCookies } from './cookies';

export interface AdminAuthOptions {
  publicBaseUrl?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the admin session from `Authorization: Bearer` (CLI, scripts) or, when that header is absent, from the
 * HttpOnly session cookie (web UI). Cookie-authenticated state-changing requests must pass CSRF checks.
 */
export function createAdminAuth(store: MappingStore, options: AdminAuthOptions = {}): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization');
    const viaCookie = header === undefined;
    const token = viaCookie ? parseCookies(req.header('cookie'))[ADMIN_SESSION_COOKIE] : /^Bearer (.+)$/.exec(header)?.[1];
    const session = token ? store.findAdminSessionDetails(token) : null;
    if (!token || !session) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } });
      return;
    }
    if (viaCookie && !SAFE_METHODS.has(req.method)) {
      const rejection = csrfRejection(req, options.publicBaseUrl);
      if (rejection) {
        res.status(403).json({ error: { code: 'CSRF_REJECTED', message: rejection, details: {} } });
        return;
      }
    }
    res.locals.adminUser = session.user;
    res.locals.adminToken = token;
    res.locals.adminSessionExpiresAt = session.expiresAt;
    res.locals.adminSessionViaCookie = viaCookie;
    next();
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Returns a rejection message, or null when the request is acceptable. */
function csrfRejection(req: Request, publicBaseUrl: string | undefined): string | null {
  const origin = req.header('origin');
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return 'Cross-site request rejected';
    }
    const matchesHost = parsed.host === req.header('host');
    const matchesPublicBase = publicBaseUrl !== undefined && originOf(publicBaseUrl) === parsed.origin;
    if (!matchesHost && !matchesPublicBase) return 'Cross-site request rejected';
  } else if (req.header('sec-fetch-site') !== 'same-origin') {
    return 'Cross-site request rejected';
  }
  const hasBody = Number(req.header('content-length') ?? 0) > 0 || req.header('transfer-encoding') !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(req.header('content-type') ?? '')) {
    return 'Admin requests with a body must be sent as application/json';
  }
  return null;
}
```

Note: `new URL('null')` throws, so an opaque `Origin: null` is rejected.

- [ ] **Step 5: Update login, add `/session`, update logout**

In `apps/server/src/routers/adminRouter.ts`:

1. Add the import: `import { parseCookies, sessionCookie, ADMIN_SESSION_COOKIE } from '../middleware/cookies';`
2. Pass the base URL to the middleware: `const requireAdmin = createAdminAuth(mappingStore, { publicBaseUrl: options.publicBaseUrl });`
3. Add a helper inside `createAdminRouter` (after `findManagedConnection`):

```ts
  const secureCookies = (options.publicBaseUrl ?? '').startsWith('https://');
```

4. Replace the `POST /login` handler with:

```ts
  router.post('/login', (req, res) => {
    const { username, password, session } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'username and password required', details: {} } });
      return;
    }
    if (session !== undefined && session !== 'cookie') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: '"session" must be "cookie" when provided', details: {} } });
      return;
    }
    const result = loginAdmin(mappingStore, username, password, options.sessionTtlMs);
    if (!result) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } });
      return;
    }
    if (session !== 'cookie') {
      res.json(result);
      return;
    }
    const details = mappingStore.findAdminSessionDetails(result.token);
    res.setHeader(
      'Set-Cookie',
      sessionCookie(result.token, { maxAgeSeconds: (Date.parse(result.expiresAt) - Date.now()) / 1000, secure: secureCookies })
    );
    // The token travels only in the HttpOnly cookie, never in a body page scripts could read.
    res.json({ username: details?.user.username ?? username, expiresAt: result.expiresAt });
  });
```

5. Directly after `router.use(requireAdmin);`, add:

```ts
  router.get('/session', (_req, res) => {
    res.json({ username: res.locals.adminUser.username as string, expiresAt: res.locals.adminSessionExpiresAt as string });
  });
```

6. Replace the `POST /logout` handler with:

```ts
  router.post('/logout', (req, res) => {
    mappingStore.deleteAdminSession(res.locals.adminToken as string);
    if (parseCookies(req.header('cookie'))[ADMIN_SESSION_COOKIE] !== undefined) {
      res.setHeader('Set-Cookie', sessionCookie('', { maxAgeSeconds: 0, secure: secureCookies }));
    }
    res.status(204).end();
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS: `cookieSession.integration.test.ts` (17 tests including the `it.each` cases) and every existing server test, since bearer behavior is unchanged. Also run `npx tsc --noEmit -p apps/server` and expect it to be clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src apps/server/test/cookieSession.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add HttpOnly cookie admin sessions with CSRF checks and a session endpoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Server — admin endpoints for the UI

**Files:**
- Modify: `apps/server/src/routers/adminRouter.ts`
- Modify: `apps/server/src/app.ts` (JSON body limit)
- Test: `apps/server/test/adminEndpoints.integration.test.ts` (create)

**Interfaces:**
- Consumes: `listAdapterTypes`, `exportMappingsYaml`, `importMappingsYaml` (Task 2), `MappingStore.listApiKeys/deleteApiKey/deleteConnection/deleteMapping` (Task 1), `ManagedTokenService.clearCredentials` (Task 3).
- Produces these routes. All sit behind `requireAdmin`, and all but the three noted list endpoints are new:
  - `GET /admin/adapters` returns `string[]`.
  - `GET /admin/api-keys` returns `ApiKeySummary[]`. `DELETE /admin/api-keys/:id` returns 204, or 404 `NOT_FOUND`.
  - `DELETE /admin/connections/:id` returns 204, or 404.
  - `DELETE /admin/connections/:id/credentials` returns 204. Errors: 503 `MANAGED_AUTH_DISABLED`, 404, or 400 if the connection is not managed.
  - `DELETE /admin/mappings/:id` returns 204, or 404.
  - `GET /admin/mappings/export?connectionId=` returns `text/yaml`.
  - `POST /admin/mappings/import` takes `{ yaml }` and returns `{ imported: number, warnings: string[] }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/adminEndpoints.integration.test.ts`:

```ts
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
```

Continue the file:

```ts
describe('DELETE /admin/mappings/:id', () => {
  it('deletes a mapping and 404s afterwards', async () => {
    const { mapping } = seedConnectionWithMapping();
    expect((await admin.delete(`/admin/mappings/${mapping.id}`)).status).toBe(204);
    expect(store.getMapping(mapping.id)).toBeNull();
    expect((await admin.delete(`/admin/mappings/${mapping.id}`)).status).toBe(404);
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
```

`yaml` is a dependency of core. The server test resolves it from the hoisted root `node_modules`; if it doesn't resolve, add `"yaml": "^2.6.0"` to `apps/server/package.json` `devDependencies` and run `npm install`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/adminEndpoints.integration.test.ts`
Expected: FAIL. The new routes return 404.

- [ ] **Step 3: Raise the JSON body limit**

In `apps/server/src/app.ts`, change `app.use(express.json());` to:

```ts
  // 1 MB so the web UI can import a mappings YAML file through POST /admin/mappings/import.
  app.use(express.json({ limit: '1mb' }));
```

- [ ] **Step 4: Add the routes**

In `apps/server/src/routers/adminRouter.ts`, add `listAdapterTypes`, `exportMappingsYaml` and `importMappingsYaml` to the `@graphtorest/core` import. Then add these handlers after the `GET /session` route from Task 4:

```ts
  router.get('/adapters', (_req, res) => {
    res.json(listAdapterTypes());
  });
```

After `router.get('/connections', ...)`:

```ts
  router.delete('/connections/:id', (req, res) => {
    const connectionId = req.params.id;
    if (!mappingStore.getConnection(connectionId)) throw new GatewayError('NOT_FOUND', 'Connection not found', 404);
    options.managedAuth?.clearCredentials(connectionId); // drop cached tokens and pending authorizations first
    mappingStore.deleteConnection(connectionId);
    res.status(204).end();
  });

  router.delete('/connections/:id/credentials', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    managedAuth.clearCredentials(connection.id);
    res.status(204).end();
  });
```

After `router.get('/mappings', ...)`:

```ts
  router.get('/mappings/export', (req, res) => {
    const { connectionId } = req.query;
    if (connectionId !== undefined && typeof connectionId !== 'string') {
      throw new GatewayError('INVALID_INPUT', '"connectionId" must be a single value', 400);
    }
    res.type('text/yaml').send(exportMappingsYaml(mappingStore, { connectionId }));
  });

  router.post('/mappings/import', (req, res) => {
    const { yaml } = req.body ?? {};
    if (typeof yaml !== 'string') throw new GatewayError('INVALID_INPUT', '"yaml" must be a string', 400);
    const { records, warnings } = importMappingsYaml(mappingStore, yaml);
    res.json({ imported: records.length, warnings });
  });

  router.delete('/mappings/:id', (req, res) => {
    if (!mappingStore.deleteMapping(req.params.id)) throw new GatewayError('NOT_FOUND', 'Mapping not found', 404);
    res.status(204).end();
  });
```

After `router.post('/api-keys', ...)`:

```ts
  router.get('/api-keys', (_req, res) => {
    res.json(mappingStore.listApiKeys());
  });

  router.delete('/api-keys/:id', (req, res) => {
    if (!mappingStore.deleteApiKey(req.params.id)) throw new GatewayError('NOT_FOUND', 'API key not found', 404);
    res.status(204).end();
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS. The new file and all existing server tests pass. `npx tsc --noEmit -p apps/server` is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server package-lock.json
git commit -m "$(cat <<'EOF'
feat(server): add list/delete, credential-clear and YAML import/export admin endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Server — activity logging and `GET /admin/activity`

**Files:**
- Create: `apps/server/src/middleware/activityLog.ts`
- Modify: `apps/server/src/middleware/apiKeyAuth.ts`, `apps/server/src/routers/apiRouter.ts`, `apps/server/src/routers/adminRouter.ts`, `apps/server/src/app.ts`, `apps/server/src/config.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/activity.integration.test.ts` (create); `apps/server/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `MappingStore.recordRequest/listRequests` (Task 1), `GatewayHooks` (Task 3).
- Produces:
  - `createActivityLogger(store: MappingStore, retention: number): RequestHandler` and `DEFAULT_ACTIVITY_RETENTION = 1000`
  - `AppDeps.activityRetention?: number`
  - `ServerConfig.activityRetention: number`, from the `ACTIVITY_RETENTION` env var; an invalid value throws at startup
  - `res.locals` keys `apiKeyId`, `connectionId`, `mappingId` and `errorCode`, set on `/api` requests
  - `GET /admin/activity?limit=&before=`, returning `{ items: RequestLogRecord[], nextBefore: number | null }`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/activity.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

let dbPath: string;
let store: MappingStore;
let app: ReturnType<typeof createApp>;
let admin: AdminClient;

function buildApp(activityRetention?: number) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
    activityRetention,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-activity-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = buildApp();
  admin = createAdminClient(app, store);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seed() {
  const connection = store.createConnection({ name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough' });
  const mapping = store.createMapping({
    connectionId: connection.id,
    route: '/users/{id}',
    method: 'GET',
    operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
  });
  const key = store.createApiKey({ label: 'dev key' });
  return { connection, mapping, key };
}

/** supertest resolves before the response 'finish' listener has run; wait one macrotask for the log write. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('activity logging', () => {
  it('records a successful call with key, connection and mapping, but never the query string', async () => {
    const { connection, mapping, key } = seed();
    const res = await request(app).get('/api/users/42?secret=hunter2').set('Authorization', `Bearer ${key.plaintext}`);
    expect(res.status).toBe(200);
    await settle();

    const [row] = store.listRequests({ limit: 10 });
    expect(row).toMatchObject({
      method: 'GET',
      path: '/api/users/42',
      status: 200,
      errorCode: null,
      apiKeyId: key.id,
      apiKeyLabel: 'dev key',
      connectionId: connection.id,
      connectionName: 'mock-conn',
      mappingId: mapping.id,
    });
    expect(typeof row.durationMs).toBe('number');
    expect(JSON.stringify(store.listRequests({ limit: 10 }))).not.toContain('hunter2');
  });

  it('records a gateway error with its code', async () => {
    const { key } = seed();
    await request(app).get('/api/nowhere').set('Authorization', `Bearer ${key.plaintext}`);
    await settle();
    expect(store.listRequests({ limit: 1 })[0]).toMatchObject({ path: '/api/nowhere', status: 404, errorCode: 'NOT_FOUND', apiKeyId: key.id, mappingId: null });
  });

  it('records an API-key rejection without a key id', async () => {
    seed();
    await request(app).get('/api/users/1').set('Authorization', 'Bearer bogus.key');
    await settle();
    expect(store.listRequests({ limit: 1 })[0]).toMatchObject({ status: 401, errorCode: 'UNAUTHORIZED', apiKeyId: null });
  });

  it('does not log the OpenAPI document or the admin API', async () => {
    await request(app).get('/api/openapi.json');
    await admin.get('/admin/connections');
    await settle();
    expect(store.listRequests({ limit: 10 })).toEqual([]);
  });

  it('prunes to the configured retention', async () => {
    const small = buildApp(2);
    const { key } = seed();
    for (const id of ['1', '2', '3']) {
      await request(small).get(`/api/users/${id}`).set('Authorization', `Bearer ${key.plaintext}`);
      await settle();
    }
    expect(store.listRequests({ limit: 10 }).map((r) => r.path)).toEqual(['/api/users/3', '/api/users/2']);
  });

  it('never lets a failed log write affect the API response', async () => {
    const { key } = seed();
    vi.spyOn(store, 'recordRequest').mockImplementation(() => {
      throw new Error('disk full');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${key.plaintext}`);
    await settle();
    expect(res.status).toBe(200);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('activity_log_write_failed'));
  });
});

describe('GET /admin/activity', () => {
  it('pages newest first with nextBefore', async () => {
    const { key } = seed();
    for (const id of ['1', '2', '3']) {
      await request(app).get(`/api/users/${id}`).set('Authorization', `Bearer ${key.plaintext}`);
      await settle();
    }
    const first = await admin.get('/admin/activity?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((r: { path: string }) => r.path)).toEqual(['/api/users/3', '/api/users/2']);
    expect(first.body.nextBefore).toBe(first.body.items[1].id);

    const second = await admin.get(`/admin/activity?limit=2&before=${first.body.nextBefore}`);
    expect(second.body.items.map((r: { path: string }) => r.path)).toEqual(['/api/users/1']);
    expect(second.body.nextBefore).toBeNull();
  });

  it('defaults to 50 items', async () => {
    for (let i = 0; i < 55; i++) {
      store.recordRequest({ ts: new Date().toISOString(), method: 'GET', path: `/api/${i}`, status: 200, durationMs: 1 }, 1000);
    }
    const res = await admin.get('/admin/activity');
    expect(res.body.items).toHaveLength(50);
  });

  it.each(['0', '201', 'abc', '1.5'])('rejects limit=%s', async (limit) => {
    const res = await admin.get(`/admin/activity?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-integer before', async () => {
    expect((await admin.get('/admin/activity?before=x')).status).toBe(400);
  });

  it('requires an admin session', async () => {
    expect((await request(app).get('/admin/activity')).status).toBe(401);
  });
});
```

In `apps/server/test/config.test.ts`, add `activityRetention: 1000` to the expected object in "applies defaults", and add `ACTIVITY_RETENTION: '250'` / `activityRetention: 250` to the env and expected object in "reads overrides". Then add:

```ts
  it.each(['0', '-1', '1.5', 'many'])('rejects ACTIVITY_RETENTION=%s', (value) => {
    expect(() => loadConfig({ ACTIVITY_RETENTION: value })).toThrow(/ACTIVITY_RETENTION/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/activity.integration.test.ts apps/server/test/config.test.ts`
Expected: FAIL. No rows are recorded, `/admin/activity` returns 404, and `activityRetention` is missing from the config.

- [ ] **Step 3: Create the activity logger**

Create `apps/server/src/middleware/activityLog.ts`:

```ts
import type { RequestHandler } from 'express';
import type { MappingStore } from '@graphtorest/core';

export const DEFAULT_ACTIVITY_RETENTION = 1000;

/**
 * Writes one request_log row per /api request when the response finishes. Only the path is stored — never the
 * query string, headers or body. A failed write is logged and never affects the response.
 */
export function createActivityLogger(store: MappingStore, retention: number): RequestHandler {
  return (req, res, next) => {
    const startedAt = new Date();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        store.recordRequest(
          {
            ts: startedAt.toISOString(),
            method: req.method,
            path: req.originalUrl.split('?')[0],
            status: res.statusCode,
            durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
            errorCode: (res.locals.errorCode as string | undefined) ?? null,
            apiKeyId: (res.locals.apiKeyId as string | undefined) ?? null,
            connectionId: (res.locals.connectionId as string | undefined) ?? null,
            mappingId: (res.locals.mappingId as string | undefined) ?? null,
          },
          retention
        );
      } catch (err) {
        console.error(JSON.stringify({ msg: 'activity_log_write_failed', error: err instanceof Error ? err.message : String(err) }));
      }
    });
    next();
  };
}
```

- [ ] **Step 4: Record key, match and error details**

In `apps/server/src/middleware/apiKeyAuth.ts`:
- Before each of the two `res.status(401)` responses, add `res.locals.errorCode = 'UNAUTHORIZED';`.
- After `mappingStore.touchApiKeyLastUsed(record.id);`, add `res.locals.apiKeyId = record.id;`.

In `apps/server/src/routers/apiRouter.ts`, replace the `gatewayEngine.handle(...)` call and the `catch` block so the handler reads:

```ts
  router.use(async (req, res) => {
    try {
      const vendorToken = req.header('x-vendor-token') ?? undefined;
      const result = await gatewayEngine.handle(
        req.method,
        req.path,
        { vendorToken },
        { query: req.query as Record<string, string>, body: req.body },
        {
          onMatch: (mapping) => {
            res.locals.connectionId = mapping.connectionId;
            res.locals.mappingId = mapping.id;
          },
        }
      );
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.locals.errorCode = body.error.code;
      res.status(status).json(body);
    }
  });
```

- [ ] **Step 5: Wire it into the app and config**

In `apps/server/src/app.ts`:
- Import: `import { createActivityLogger, DEFAULT_ACTIVITY_RETENTION } from './middleware/activityLog';`
- Add `activityRetention?: number;` to `AppDeps`.
- Change the `/api` mount to:

```ts
    app.use(
      '/api',
      createActivityLogger(deps.mappingStore, deps.activityRetention ?? DEFAULT_ACTIVITY_RETENTION),
      createApiKeyAuth(deps.mappingStore),
      createApiRouter(deps.gatewayEngine)
    );
```

(The `/api/openapi.json` and `/api/docs` handlers are registered earlier and answer first, so they are not logged.)

In `apps/server/src/config.ts`, add `activityRetention: number;` to `ServerConfig`. Add this function:

```ts
function parseActivityRetention(value: string | undefined): number {
  if (value === undefined || value === '') return 1000;
  const retention = Number(value);
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error(`ACTIVITY_RETENTION must be a positive integer, got "${value}"`);
  }
  return retention;
}
```

Also add `activityRetention: parseActivityRetention(env.ACTIVITY_RETENTION),` to the returned object.

In `apps/server/src/index.ts`, pass `activityRetention: config.activityRetention,` to `createApp`.

- [ ] **Step 6: Add the admin route**

In `apps/server/src/routers/adminRouter.ts`, after the `GET /adapters` route, add:

```ts
  router.get('/activity', (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new GatewayError('INVALID_INPUT', '"limit" must be an integer from 1 to 200', 400);
    }
    const before = req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      throw new GatewayError('INVALID_INPUT', '"before" must be a positive integer', 400);
    }
    const items = mappingStore.listRequests({ limit, before });
    res.json({ items, nextBefore: items.length === limit ? items[items.length - 1].id : null });
  });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS, including every existing server test (the `/api` behavior is unchanged apart from logging). `npx tsc --noEmit -p apps/server` is clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): log /api requests to a capped request_log and expose GET /admin/activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Server — serve the SPA and redirect the OAuth callback into it

**Files:**
- Create: `apps/server/src/web.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/config.ts`, `apps/server/src/index.ts`, `apps/server/src/routers/adminRouter.ts`
- Test: `apps/server/test/webServing.integration.test.ts` (create); extend `apps/server/test/managedAuth.integration.test.ts` and `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `ManagedTokenService.abandonAuthorization` (Task 3).
- Produces:
  - `WEB_CSP` and `createWebHandler(webRoot: string): Router` (in `web.ts`)
  - `AppDeps.webRoot?: string` and `AdminRouterOptions.webUiRedirects?: boolean`
  - `ServerConfig.webEnabled: boolean`, from `WEB_ENABLED !== 'false'`
  - The OAuth callback redirects to `/connections/<id>?oauth=success`, `/connections/<id>?oauth=error&code=<CODE>`, or `/connections?oauth=error&code=<CODE>` when `webRoot` is set, and returns JSON otherwise

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/webServing.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient } from './helpers';

const INDEX_HTML = '<!doctype html><html><head><title>gtr-test-index</title></head><body></body></html>';
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

let dbPath: string;
let webRoot: string;
let store: MappingStore;

function buildApp(options: { webRoot?: string; apiEnabled?: boolean; adminEnabled?: boolean } = {}) {
  return createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: options.apiEnabled ?? true,
    adminEnabled: options.adminEnabled ?? true,
    webRoot: options.webRoot,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-web-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graphtorest-webroot-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(webRoot, 'assets'));
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("app");');
});

afterEach(() => {
  fs.rmSync(webRoot, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('SPA serving', () => {
  it('serves index.html at / with the CSP header', async () => {
    const res = await request(buildApp({ webRoot })).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('gtr-test-index');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('serves static assets with the CSP header', async () => {
    const res = await request(buildApp({ webRoot })).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log("app")');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it.each(['/connections', '/connections/abc?oauth=success', '/api-keys', '/activity', '/test'])(
    'falls back to index.html for the client route %s',
    async (url) => {
      const res = await request(buildApp({ webRoot })).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('gtr-test-index');
    }
  );

  it('never answers /api/* with index.html', async () => {
    const res = await request(buildApp({ webRoot })).get('/api/unknown');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('gtr-test-index');
  });

  it('never answers unknown /admin/* paths with index.html', async () => {
    const app = buildApp({ webRoot });
    const admin = createAdminClient(app, store);
    const res = await admin.get('/admin/no-such-route');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('gtr-test-index');
  });

  it('does not serve index.html for /api or /admin even when those surfaces are disabled', async () => {
    const app = buildApp({ webRoot, apiEnabled: false, adminEnabled: false });
    for (const url of ['/api', '/api/users/1', '/admin', '/admin/login']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('gtr-test-index');
    }
  });

  it('serves nothing at / without a webRoot', async () => {
    const res = await request(buildApp()).get('/');
    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
```

In `apps/server/test/managedAuth.integration.test.ts`:

1. Extend `buildApp` so it forwards a web root. Change its options type to `{ publicBaseUrl?: string; webRoot?: string }` (keeping the default `{ publicBaseUrl: BASE_URL }`) and pass `webRoot: options.webRoot` to `createApp`.
2. Append:

```ts
describe('OAuth callback with the web UI enabled', () => {
  const AC_BODY = { ...CC_BODY, grant: 'authorization_code' };
  let webRoot: string;
  let webApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graphtorest-webroot-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    webApp = buildApp(true, { publicBaseUrl: BASE_URL, webRoot });
  });

  afterEach(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  /**
   * Runs the whole flow on webApp: each buildApp() owns its own ManagedTokenService, so the pending state from
   * oauth/start only exists in the app that issued it. The admin session lives in the shared store, so admin.token works here.
   */
  async function startAuthorization() {
    const { connectionId } = await seedManagedGraphConnection();
    const auth = { Authorization: `Bearer ${admin.token}` };
    await request(webApp).put(`/admin/connections/${connectionId}/credentials`).set(auth).send(AC_BODY);
    const start = await request(webApp).post(`/admin/connections/${connectionId}/oauth/start`).set(auth).send({});
    return { connectionId, state: new URL(start.body.authorizationUrl).searchParams.get('state')! };
  }

  it('redirects to the connection page on success', async () => {
    const { connectionId, state } = await startAuthorization();
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'delegated-token', refresh_token: 'rt-1', expires_in: 3600 });
    const callback = await request(webApp).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`/connections/${connectionId}?oauth=success`);
  });

  it('redirects a vendor error to the connection page and consumes the state', async () => {
    const { connectionId, state } = await startAuthorization();
    const denied = await request(webApp).get(`/admin/oauth/callback?error=access_denied&state=${state}`);
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe(`/connections/${connectionId}?oauth=error&code=AUTHORIZATION_DENIED`);

    const replay = await request(webApp).get(`/admin/oauth/callback?code=x&state=${state}`);
    expect(replay.headers.location).toBe('/connections?oauth=error&code=INVALID_STATE');
  });

  it('redirects to the connections list when the state is unknown', async () => {
    const res = await request(webApp).get('/admin/oauth/callback?code=x&state=made-up');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/connections?oauth=error&code=INVALID_STATE');
  });

  it('keeps the vendor error text out of the redirect', async () => {
    const res = await request(webApp).get('/admin/oauth/callback?error=secret_vendor_text&state=nope');
    expect(res.headers.location).toBe('/connections?oauth=error&code=AUTHORIZATION_DENIED');
  });
});
```

Finally, the existing test "rejects a callback with unknown state, missing params, or a vendor error" (JSON mode) must keep passing unchanged.

In `apps/server/test/config.test.ts`, add `webEnabled: true` to the defaults' expected object, add `WEB_ENABLED: 'false'` / `webEnabled: false` to the overrides test, and keep everything else.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/webServing.integration.test.ts apps/server/test/managedAuth.integration.test.ts apps/server/test/config.test.ts`
Expected: FAIL. `/` returns 404 with a webRoot, the callback returns JSON instead of 302, and `webEnabled` is missing.

- [ ] **Step 3: Create the web handler**

Create `apps/server/src/web.ts`:

```ts
import express, { type Router } from 'express';
import path from 'node:path';

export const WEB_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

function isReservedPath(requestPath: string): boolean {
  return requestPath === '/api' || requestPath.startsWith('/api/') || requestPath === '/admin' || requestPath.startsWith('/admin/');
}

/** Serves the built SPA from `webRoot`, falling back to index.html for client routes. Never answers /api or /admin paths. */
export function createWebHandler(webRoot: string): Router {
  const router = express.Router();
  const serveStatic = express.static(webRoot, { index: 'index.html' });
  const indexFile = path.join(webRoot, 'index.html');

  router.use((req, res, next) => {
    if (isReservedPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Content-Security-Policy', WEB_CSP);
    serveStatic(req, res, next);
  });

  router.get('*', (req, res, next) => {
    if (isReservedPath(req.path)) {
      next();
      return;
    }
    res.sendFile(indexFile);
  });

  return router;
}
```

- [ ] **Step 4: Wire it into the app and config**

In `apps/server/src/app.ts`:
- Import: `import { createWebHandler } from './web';`
- Add `webRoot?: string;` to `AppDeps`.
- Pass `webUiRedirects: deps.webRoot !== undefined,` in the `createAdminRouter` options.
- After the `if (deps.adminEnabled) { ... }` block and before the error handler, add:

```ts
  if (deps.webRoot) {
    app.use(createWebHandler(deps.webRoot));
  }
```

In `apps/server/src/config.ts`, add `webEnabled: boolean;` to `ServerConfig` and `webEnabled: env.WEB_ENABLED !== 'false',` to the returned object.

In `apps/server/src/index.ts`, add `import fs from 'node:fs';` and `import path from 'node:path';`, then before `createApp`:

```ts
// apps/server/dist/index.js → apps/web/dist (same layout in the Docker image).
const webDist = path.resolve(__dirname, '../../web/dist');
const webRoot = config.webEnabled && fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;
```

Pass `webRoot,` to `createApp`, and after the existing startup warnings add:

```ts
if (config.webEnabled && !webRoot) {
  console.warn(JSON.stringify({ msg: 'web_ui_unavailable', warning: `No built web UI found at ${webDist}; serving the API and admin API only.` }));
}
```

- [ ] **Step 5: Redirect the OAuth callback**

In `apps/server/src/routers/adminRouter.ts`, add `webUiRedirects?: boolean;` to `AdminRouterOptions`, and replace the `GET /oauth/callback` handler with:

```ts
  router.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    let connectionId: string | null = null;
    try {
      const managedAuth = requireManagedAuth();
      if (typeof error === 'string') {
        connectionId = typeof state === 'string' ? managedAuth.abandonAuthorization(state) : null;
        throw new GatewayError('AUTHORIZATION_DENIED', `The vendor reported an authorization error: ${error.slice(0, 100)}`, 400);
      }
      if (typeof code !== 'string' || typeof state !== 'string') {
        throw new GatewayError('INVALID_INPUT', '"code" and "state" query parameters are required', 400);
      }
      ({ connectionId } = await managedAuth.completeAuthorization(state, code));
      if (options.webUiRedirects) {
        res.redirect(302, `/connections/${encodeURIComponent(connectionId)}?oauth=success`);
        return;
      }
      res.json({ status: 'authorized', connectionId });
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      if (options.webUiRedirects) {
        // Only the error code goes into the URL — never vendor-supplied text.
        const target = connectionId ? `/connections/${encodeURIComponent(connectionId)}` : '/connections';
        res.redirect(302, `${target}?oauth=error&code=${encodeURIComponent(body.error.code)}`);
        return;
      }
      res.status(status).json(body);
    }
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS, including every existing server test. `npx tsc --noEmit -p apps/server` is clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): serve the web UI with a CSP and redirect the OAuth callback into it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 8: Web app scaffold — API client, session, login, layout

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `App.tsx`, `api.ts`, `types.ts`, `session.tsx`, `browser.ts`, `styles.css`
- Create: `apps/web/src/components/Layout.tsx`, `ErrorPanel.tsx`, `ConfirmButton.tsx`, `OAuthBanner.tsx`
- Create: `apps/web/src/pages/LoginPage.tsx`, plus minimal placeholder pages `ConnectionsPage.tsx`, `ConnectionPage.tsx`, `ApiKeysPage.tsx`, `TestPanelPage.tsx`, `ActivityPage.tsx` (Tasks 9–11 replace them)
- Create: `apps/web/test/render.tsx`, `apps/web/test/api.test.ts`, `apps/web/test/login.test.tsx`
- Modify: `vitest.config.ts` (root)

**Interfaces:**
- Produces (used by Tasks 9–11):
  - In `api.ts`:
    - `class ApiError extends Error { status: number; code: string; details: Record<string, unknown> }`
    - `setUnauthorizedHandler(handler: () => void): void`
    - `apiFetch<T>(path, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>`
    - the `api` object whose methods are listed in Step 4
  - `types.ts`: `Session`, `Connection`, `NewConnection`, `Mapping`, `MappingPatch`, `GenerationResult`, `ImportResult`, `ApiKeySummary`, `CreatedApiKey`, `CredentialStatus`, `ActivityItem`, `ActivityPage`
  - `session.tsx`: `SESSION_KEY`, `useSession()`, `<RequireSession>`
  - `browser.ts`: `redirectBrowser(url: string): void`, `downloadText(filename: string, text: string): void`, `readFileText(file: Blob): Promise<string>`
  - Components:
    - `<ErrorPanel error onRetry? />`, `<FormError error />` and `errorMessage(error: unknown): string`
    - `<ConfirmButton message onConfirm disabled? className?>`
    - `<OAuthBanner />`
  - `App.tsx`: `AppRoutes` (a `<Routes>` tree; the caller supplies the router)
  - Test helpers in `test/render.tsx`: `renderApp(path)`, `mockFetch(routes)`, `SESSION_ROUTE`

- [ ] **Step 1: Create the workspace and tooling config**

Create `apps/web/package.json`:

```json
{
  "name": "@graphtorest/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "swagger-ui-react": "^5.17.14"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/swagger-ui-react": "^4.18.3",
    "@vitejs/plugin-react": "^4.3.3",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.0",
    "vite": "^5.4.10",
    "vitest": "^2.1.0"
  }
}
```

Create `apps/web/tsconfig.json` (standalone; the browser bundle does not use the repo's CommonJS base config):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`. The proxy keys are regular expressions so the UI route `/api-keys` is **not** proxied:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '^/api/': 'http://localhost:3000',
      '^/admin/': 'http://localhost:3000',
    },
  },
});
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GraphToRest</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Replace the root `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['apps/web/**', 'jsdom']],
  },
});
```

Run `npm install` at the repo root to add the workspace and its dependencies to `package-lock.json`.

- [ ] **Step 2: Write the test helpers and the failing tests**

Create `apps/web/test/render.tsx`:

```tsx
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { setUnauthorizedHandler } from '../src/api';
import { SESSION_KEY } from '../src/session';

export interface MockRoute {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
  text?: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const SESSION_ROUTE: MockRoute = { path: '/admin/session', body: { username: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' } };

/** Stubs global fetch. The first route matching method + exact path (including query) wins; unmatched calls get a 404 envelope. */
export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find((r) => (r.method ?? 'GET') === method && r.path === url);
    if (!route) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${method} ${url}`, details: {} } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    if (route.text !== undefined) return new Response(route.text, { status, headers: { 'Content-Type': 'text/yaml' } });
    return new Response(JSON.stringify(route.body ?? null), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setUnauthorizedHandler(() => queryClient.setQueryData(SESSION_KEY, null));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...utils, queryClient };
}
```

Create `apps/web/test/api.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiFetch, ApiError, setUnauthorizedHandler } from '../src/api';
import { mockFetch } from './render';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => {});
});

describe('apiFetch', () => {
  it('sends JSON bodies with the session cookie and parses JSON responses', async () => {
    const { fetchMock } = mockFetch([{ method: 'POST', path: '/admin/connections', status: 201, body: { id: 'c1' } }]);
    await expect(apiFetch('/admin/connections', { method: 'POST', body: { name: 'x' } })).resolves.toEqual({ id: 'c1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"name":"x"}' });
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('sends no Content-Type when there is no body', async () => {
    const { fetchMock } = mockFetch([{ method: 'POST', path: '/admin/logout', status: 204 }]);
    await expect(apiFetch('/admin/logout', { method: 'POST' })).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Content-Type');
  });

  it('returns text for non-JSON responses', async () => {
    mockFetch([{ path: '/admin/mappings/export', text: '- route: GET /a\n' }]);
    await expect(apiFetch('/admin/mappings/export')).resolves.toBe('- route: GET /a\n');
  });

  it('turns the error envelope into an ApiError', async () => {
    mockFetch([{ path: '/admin/x', status: 409, body: { error: { code: 'CONFLICT', message: 'Already exists', details: { a: 1 } } } }]);
    const error = await apiFetch('/admin/x').catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Already exists', details: { a: 1 } });
  });

  it('falls back to a generic ApiError for non-envelope errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(apiFetch('/admin/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(apiFetch('/admin/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('calls the unauthorized handler on 401, except for the login request itself', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const envelope = { error: { code: 'UNAUTHORIZED', message: 'nope', details: {} } };
    mockFetch([
      { path: '/admin/connections', status: 401, body: envelope },
      { method: 'POST', path: '/admin/login', status: 401, body: envelope },
    ]);
    await expect(apiFetch('/admin/connections')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(apiFetch('/admin/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

Create `apps/web/test/login.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';

const UNAUTHORIZED = { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillLogin(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('login', () => {
  it('sends an unauthenticated visitor to the login page, then back to where they were going', async () => {
    const { calls } = mockFetch([
      { path: '/admin/session', ...UNAUTHORIZED },
      { method: 'POST', path: '/admin/login', body: { username: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' } },
    ]);
    renderApp('/activity');
    expect(await screen.findByRole('heading', { name: 'GraphToRest' })).toBeTruthy();
    expect(screen.getByText(/gtr admin-create/)).toBeTruthy();

    fillLogin('admin', 'correct-horse-battery');

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(calls.find((c) => c.path === '/admin/login')!.body).toEqual({
      username: 'admin',
      password: 'correct-horse-battery',
      session: 'cookie',
    });
    expect(screen.getByText('admin')).toBeTruthy();
  });

  it('shows the server message on a failed login', async () => {
    mockFetch([
      { path: '/admin/session', ...UNAUTHORIZED },
      { method: 'POST', path: '/admin/login', status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } } },
    ]);
    renderApp('/connections');
    await screen.findByLabelText('Username');
    fillLogin('admin', 'wrong-password-123');
    expect(await screen.findByText('Invalid username or password')).toBeTruthy();
  });

  it('lets a signed-in admin log out', async () => {
    const { calls } = mockFetch([SESSION_ROUTE, { method: 'POST', path: '/admin/logout', status: 204 }]);
    renderApp('/connections');
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/admin/logout')).toBe(true);
  });

  it('shows an error panel when the session check fails for another reason', async () => {
    mockFetch([{ path: '/admin/session', status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } } }]);
    renderApp('/connections');
    expect(await screen.findByText('Internal server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/web`
Expected: FAIL with "Failed to resolve import '../src/App'" / "../src/api".

- [ ] **Step 4: Write the API layer and types**

Create `apps/web/src/types.ts`:

```ts
export interface Session {
  username: string;
  expiresAt: string;
}

export interface Connection {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: Record<string, unknown> | null;
}

export interface NewConnection {
  name: string;
  adapterType: string;
  authMode: string;
  config?: Record<string, unknown>;
}

export interface Mapping {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
  source: 'generated' | 'manual';
}

export interface MappingPatch {
  method: string;
  route: string;
  operation: unknown;
  responseTemplate: unknown;
}

export interface GenerationResult {
  created: unknown[];
  updated: unknown[];
  skipped: unknown[];
  conflicts: unknown[];
}

export interface ImportResult {
  imported: number;
  warnings: string[];
}

export interface ApiKeySummary {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  plaintext: string;
  label: string | null;
}

export type CredentialStatus =
  | { configured: false }
  | { configured: true; grant: 'client_credentials' | 'authorization_code'; hasRefreshToken: boolean };

export interface ActivityItem {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  connectionId: string | null;
  connectionName: string | null;
  mappingId: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextBefore: number | null;
}
```

Create `apps/web/src/api.ts`:

```ts
import type {
  ActivityPage,
  ApiKeySummary,
  Connection,
  CreatedApiKey,
  CredentialStatus,
  GenerationResult,
  ImportResult,
  Mapping,
  MappingPatch,
  NewConnection,
  Session,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: () => void = () => {};

/** Registered by the app root: a 401 from any admin call (other than login) ends the client-side session. */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method: init.method ?? 'GET', headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server');
  }
  if (response.status === 401 && path !== '/admin/login') unauthorizedHandler();
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await response.json() : await response.text()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const error = (await response.json())?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return new ApiError(response.status, error.code, error.message, error.details ?? {});
    }
  } catch {
    // not a JSON error envelope
  }
  return new ApiError(response.status, 'HTTP_ERROR', `Request failed with status ${response.status}`);
}

const enc = encodeURIComponent;

export const api = {
  session: () => apiFetch<Session>('/admin/session'),
  login: (username: string, password: string) =>
    apiFetch<Session>('/admin/login', { method: 'POST', body: { username, password, session: 'cookie' } }),
  logout: () => apiFetch<void>('/admin/logout', { method: 'POST' }),

  adapters: () => apiFetch<string[]>('/admin/adapters'),
  connections: () => apiFetch<Connection[]>('/admin/connections'),
  createConnection: (input: NewConnection) => apiFetch<Connection>('/admin/connections', { method: 'POST', body: input }),
  deleteConnection: (id: string) => apiFetch<void>(`/admin/connections/${enc(id)}`, { method: 'DELETE' }),

  credentialStatus: (id: string) => apiFetch<CredentialStatus>(`/admin/connections/${enc(id)}/credentials`),
  saveCredentials: (id: string, input: Record<string, unknown>) =>
    apiFetch<CredentialStatus>(`/admin/connections/${enc(id)}/credentials`, { method: 'PUT', body: input }),
  clearCredentials: (id: string) => apiFetch<void>(`/admin/connections/${enc(id)}/credentials`, { method: 'DELETE' }),
  startAuthorization: (id: string) =>
    apiFetch<{ authorizationUrl: string }>(`/admin/connections/${enc(id)}/oauth/start`, { method: 'POST' }),

  mappings: () => apiFetch<Mapping[]>('/admin/mappings'),
  generateMappings: (connectionId: string, options: { force?: boolean; vendorToken?: string }) =>
    apiFetch<GenerationResult>(`/admin/connections/${enc(connectionId)}/mappings/generate`, {
      method: 'POST',
      body: { force: options.force === true },
      headers: options.vendorToken ? { 'X-Vendor-Token': options.vendorToken } : {},
    }),
  updateMapping: (id: string, patch: MappingPatch) => apiFetch<Mapping>(`/admin/mappings/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteMapping: (id: string) => apiFetch<void>(`/admin/mappings/${enc(id)}`, { method: 'DELETE' }),
  exportMappings: (connectionId?: string) =>
    apiFetch<string>(`/admin/mappings/export${connectionId ? `?connectionId=${enc(connectionId)}` : ''}`, {
      headers: { Accept: 'text/yaml' },
    }),
  importMappings: (yaml: string) => apiFetch<ImportResult>('/admin/mappings/import', { method: 'POST', body: { yaml } }),

  apiKeys: () => apiFetch<ApiKeySummary[]>('/admin/api-keys'),
  createApiKey: (label?: string) => apiFetch<CreatedApiKey>('/admin/api-keys', { method: 'POST', body: label ? { label } : {} }),
  deleteApiKey: (id: string) => apiFetch<void>(`/admin/api-keys/${enc(id)}`, { method: 'DELETE' }),

  activity: (before?: number) =>
    apiFetch<ActivityPage>(`/admin/activity?limit=50${before !== undefined ? `&before=${before}` : ''}`),
};
```

Create `apps/web/src/browser.ts`:

```ts
/** Browser side effects, isolated so tests can vi.mock them (jsdom cannot navigate or download). */
export function redirectBrowser(url: string): void {
  window.location.assign(url);
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
```

- [ ] **Step 5: Write the session, shared components, pages and routes**

Create `apps/web/src/components/ErrorPanel.tsx`:

```tsx
import { ApiError } from '../api';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CSRF_REJECTED') {
      return `${error.message}. Check that PUBLIC_BASE_URL matches the address in your browser.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}
```

Create `apps/web/src/components/ConfirmButton.tsx`:

```tsx
import type { ReactNode } from 'react';

export function ConfirmButton(props: { message: string; onConfirm: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="danger"
      disabled={props.disabled}
      onClick={() => {
        if (window.confirm(props.message)) props.onConfirm();
      }}
    >
      {props.children}
    </button>
  );
}
```

Create `apps/web/src/components/OAuthBanner.tsx`:

```tsx
import { useSearchParams } from 'react-router-dom';

/** Shows the result the OAuth callback redirect put in the query string (?oauth=success|error&code=...). */
export function OAuthBanner() {
  const [params] = useSearchParams();
  const result = params.get('oauth');
  if (result === 'success') {
    return (
      <p className="success" role="status">
        Authorization completed.
      </p>
    );
  }
  if (result === 'error') {
    return (
      <p className="form-error" role="alert">
        Authorization failed ({params.get('code') ?? 'UNKNOWN'}).
      </p>
    );
  }
  return null;
}
```

Create `apps/web/src/session.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { ErrorPanel } from './components/ErrorPanel';
import type { Session } from './types';

export const SESSION_KEY = ['session'] as const;

export function useSession() {
  return useQuery<Session | null>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return await api.session();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <p className="muted">Loading…</p>;
  if (session.isError) return <ErrorPanel error={session.error} onRetry={() => void session.refetch()} />;
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
```

Create `apps/web/src/components/Layout.tsx`:

```tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { SESSION_KEY, useSession } from '../session';

export function Layout() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(SESSION_KEY, null);
      navigate('/login');
    },
  });
  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">GraphToRest</span>
        <nav>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/api-keys">API keys</NavLink>
          <NavLink to="/test">Test</NavLink>
          <NavLink to="/activity">Activity</NavLink>
        </nav>
        <span className="user">{session.data?.username}</span>
        <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Log out
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
```

Create `apps/web/src/pages/LoginPage.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { FormError } from '../components/ErrorPanel';
import { SESSION_KEY } from '../session';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/connections';
  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_KEY, session);
      navigate(from, { replace: true });
    },
  });
  return (
    <div className="login">
      <h1>GraphToRest</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <FormError error={login.error} />
        <button type="submit" disabled={login.isPending}>
          Log in
        </button>
      </form>
      <p className="muted">
        First time? Create an admin account on the server with <code>gtr admin-create --username &lt;name&gt;</code>.
      </p>
    </div>
  );
}
```

Create the placeholder pages (Tasks 9–11 replace each file entirely):

`apps/web/src/pages/ConnectionsPage.tsx`:
```tsx
export function ConnectionsPage() {
  return <h1>Connections</h1>;
}
```
`apps/web/src/pages/ConnectionPage.tsx`:
```tsx
export function ConnectionPage() {
  return <h1>Connection</h1>;
}
```
`apps/web/src/pages/ApiKeysPage.tsx`:
```tsx
export function ApiKeysPage() {
  return <h1>API keys</h1>;
}
```
`apps/web/src/pages/TestPanelPage.tsx`:
```tsx
export function TestPanelPage() {
  return <h1>Test</h1>;
}
```
`apps/web/src/pages/ActivityPage.tsx`:
```tsx
export function ActivityPage() {
  return <h1>Activity</h1>;
}
```

Create `apps/web/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { TestPanelPage } from './pages/TestPanelPage';
import { ActivityPage } from './pages/ActivityPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireSession>
            <Layout />
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/connections" replace />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="connections/:id" element={<ConnectionPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="test" element={<TestPanelPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
```

Create `apps/web/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from './App';
import { setUnauthorizedHandler } from './api';
import { SESSION_KEY } from './session';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
setUnauthorizedHandler(() => queryClient.setQueryData(SESSION_KEY, null));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

Create `apps/web/src/styles.css`:

```css
:root {
  --bg: #f7f7f8;
  --panel: #ffffff;
  --text: #1d1d1f;
  --muted: #6b6b73;
  --border: #d9d9de;
  --accent: #2b59c3;
  --danger: #b3261e;
  --success: #1e7a3d;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--text);
  background: var(--bg);
}
body { margin: 0; }
.topbar { display: flex; align-items: center; gap: 1.5rem; padding: 0.75rem 1.5rem; background: var(--panel); border-bottom: 1px solid var(--border); }
.topbar nav { display: flex; gap: 1rem; flex: 1; }
.topbar nav a { color: var(--muted); text-decoration: none; }
.topbar nav a.active { color: var(--accent); font-weight: 600; }
.brand { font-weight: 700; }
main { padding: 1.5rem; max-width: 1100px; }
.login { max-width: 360px; margin: 10vh auto; padding: 2rem; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
form { display: flex; flex-direction: column; gap: 0.75rem; }
label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
label.inline { flex-direction: row; align-items: center; gap: 0.5rem; }
input, select, textarea { font: inherit; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; }
textarea { font-family: ui-monospace, monospace; min-height: 8rem; }
button { font: inherit; padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); cursor: pointer; }
button[type='submit'] { background: var(--accent); color: #fff; border-color: var(--accent); }
button.danger { color: var(--danger); border-color: var(--danger); }
button.link { border: none; background: none; color: var(--accent); padding: 0; text-align: left; }
button:disabled { opacity: 0.6; cursor: default; }
table { width: 100%; border-collapse: collapse; background: var(--panel); margin: 1rem 0; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tr.selected { background: #eef2fb; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
.panel.highlight { border-color: var(--accent); }
.tabs { display: flex; gap: 0.5rem; margin: 1rem 0; }
.tabs button.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.toolbar { display: flex; gap: 0.5rem; align-items: center; }
.muted { color: var(--muted); }
.form-error, .error-panel { color: var(--danger); }
.success { color: var(--success); }
.warning { color: #8a5a00; }
code.secret { display: block; padding: 0.5rem; background: #f0f0f3; word-break: break-all; margin: 0.5rem 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { color: var(--muted); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/web`
Expected: PASS: `api.test.ts` (7 tests) and `login.test.tsx` (4 tests).

Then run: `npm run build -w @graphtorest/web`
Expected: `tsc` reports no errors, and `vite build` writes `apps/web/dist/index.html` plus `apps/web/dist/assets/*.js`. Also confirm with `grep -c '<script>' apps/web/dist/index.html` that it has no inline scripts: the output must be `0`, since there is only a `<script type="module" src=...>` tag.

Also run the whole suite to confirm the root vitest config change broke nothing: `npm run build -w @graphtorest/core && npx vitest run`.

- [ ] **Step 7: Commit**

```bash
git add apps/web vitest.config.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(web): scaffold the React web UI with the admin API client, cookie session and login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Make sure `apps/web/dist` is not committed. If the root `.gitignore` does not already cover `dist/` (it does for the other workspaces; check with `git status`), add `apps/web/dist/`.

---
### Task 9: Web — connections list, create, import, overview and credentials

**Files:**
- Replace: `apps/web/src/pages/ConnectionsPage.tsx`, `apps/web/src/pages/ConnectionPage.tsx`
- Create: `apps/web/src/pages/OverviewTab.tsx`, `apps/web/src/pages/CredentialsTab.tsx`, `apps/web/src/pages/MappingsTab.tsx` (placeholder; Task 10 replaces it)
- Test: `apps/web/test/connections.test.tsx` (create)

**Interfaces:**
- Consumes: `api`, `ApiError`, the types, `ErrorPanel`, `FormError`, `ConfirmButton`, `OAuthBanner`, and `redirectBrowser`/`readFileText` (Task 8).
- Produces:
  - `MappingsTab({ connection }: { connection: Connection })` (the placeholder)
  - `toCredentialInput(adapterType: string, form: CredentialForm): Record<string, unknown>` and `interface CredentialForm { grant: 'client_credentials' | 'authorization_code'; clientId: string; clientSecret: string; tenantId: string; tokenUrl: string; authorizeUrl: string; scopes: string }` (exported from `CredentialsTab.tsx`)
  - React Query keys: `['connections']`, `['adapters']`, `['credentials', <id>]`, `['mappings']`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/connections.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { redirectBrowser } from '../src/browser';
import { toCredentialInput } from '../src/pages/CredentialsTab';

vi.mock('../src/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser')>()),
  redirectBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(redirectBrowser).mockReset();
});

const MOCK_CONN = { id: 'c1', name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough', config: null };
const GQL_CONN = { id: 'c2', name: 'gql', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: 'https://api.example.com/graphql' } };
const MS_CONN = { id: 'c3', name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed', config: null };
const ADAPTERS = { path: '/admin/adapters', body: ['mock', 'microsoft-graph', 'graphql'] };

describe('connections list', () => {
  it('lists connections with links', async () => {
    mockFetch([SESSION_ROUTE, ADAPTERS, { path: '/admin/connections', body: [MOCK_CONN, GQL_CONN] }]);
    renderApp('/connections');
    const link = await screen.findByRole('link', { name: 'mock-conn' });
    expect(link.getAttribute('href')).toBe('/connections/c1');
    expect(screen.getByRole('link', { name: 'gql' })).toBeTruthy();
  });

  it('creates a GraphQL connection with its endpoint and opens it', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN, GQL_CONN] },
      { method: 'POST', path: '/admin/connections', status: 201, body: GQL_CONN },
    ]);
    renderApp('/connections');
    await screen.findByRole('link', { name: 'mock-conn' });
    await screen.findByRole('option', { name: 'graphql' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'gql' } });
    fireEvent.change(screen.getByLabelText('Adapter'), { target: { value: 'graphql' } });
    fireEvent.change(screen.getByLabelText('GraphQL endpoint URL'), { target: { value: 'https://api.example.com/graphql' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    expect(await screen.findByRole('heading', { name: 'gql' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/connections')!.body).toEqual({
      name: 'gql',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.example.com/graphql' },
    });
  });

  it('omits config for non-GraphQL adapters and shows server errors', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [] },
      { method: 'POST', path: '/admin/connections', status: 409, body: { error: { code: 'CONFLICT', message: 'A connection with this name already exists', details: {} } } },
    ]);
    renderApp('/connections');
    await screen.findByText('No connections yet.');
    await screen.findByRole('option', { name: 'mock' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(await screen.findByText('A connection with this name already exists')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'dup', adapterType: 'mock', authMode: 'passthrough' });
  });

  it('imports mappings from a YAML file and shows the result and warnings', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN] },
      { method: 'POST', path: '/admin/mappings/import', body: { imported: 2, warnings: ['2 generated mapping(s) are now source=manual'] } },
    ]);
    renderApp('/connections');
    await screen.findByRole('link', { name: 'mock-conn' });
    const file = new File(['- route: GET /a\n'], 'mappings.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('YAML file'), { target: { files: [file] } });
    expect(await screen.findByText('Imported 2 mapping(s).')).toBeTruthy();
    expect(screen.getByText('2 generated mapping(s) are now source=manual')).toBeTruthy();
    expect(calls.find((c) => c.path === '/admin/mappings/import')!.body).toEqual({ yaml: '- route: GET /a\n' });
  });

  it('shows an OAuth error banner on the list page', async () => {
    mockFetch([SESSION_ROUTE, ADAPTERS, { path: '/admin/connections', body: [] }]);
    renderApp('/connections?oauth=error&code=INVALID_STATE');
    expect(await screen.findByText('Authorization failed (INVALID_STATE).')).toBeTruthy();
  });
});

describe('connection page', () => {
  it('shows the overview and deletes after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN] },
      { method: 'DELETE', path: '/admin/connections/c1', status: 204 },
    ]);
    renderApp('/connections/c1');
    expect(await screen.findByRole('heading', { name: 'mock-conn' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Credentials' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
    await screen.findByRole('heading', { name: 'Connections' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/connections/c1')).toBe(true);
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { calls } = mockFetch([SESSION_ROUTE, { path: '/admin/connections', body: [MOCK_CONN] }]);
    renderApp('/connections/c1');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('reports an unknown connection', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/connections', body: [MOCK_CONN] }]);
    renderApp('/connections/nope');
    expect(await screen.findByRole('heading', { name: 'Connection not found' })).toBeTruthy();
  });
});

describe('credentials tab', () => {
  it('saves Microsoft client credentials and shows the new status', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: false } },
      { method: 'PUT', path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'client_credentials', hasRefreshToken: false } },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    expect(await screen.findByText('No credentials stored.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'shh' } });
    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'tenant-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

    expect(await screen.findByText('Configured: client_credentials grant.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ grant: 'client_credentials', clientId: 'cid', clientSecret: 'shh', tenantId: 'tenant-1' });
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  });

  it('starts authorization and sends the browser to the vendor', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'authorization_code', hasRefreshToken: false } },
      { method: 'POST', path: '/admin/connections/c3/oauth/start', body: { authorizationUrl: 'https://login.example/authorize?x=1' } },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    expect(await screen.findByText('Configured: authorization_code grant, not yet authorized.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(redirectBrowser).toHaveBeenCalledWith('https://login.example/authorize?x=1'));
  });

  it('opens on the credentials tab with the OAuth result banner after the callback redirect', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'authorization_code', hasRefreshToken: true } },
    ]);
    renderApp('/connections/c3?oauth=success');
    expect(await screen.findByText('Authorization completed.')).toBeTruthy();
    expect(await screen.findByText('Configured: authorization_code grant, authorized.')).toBeTruthy();
  });

  it('clears credentials after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'client_credentials', hasRefreshToken: false } },
      { method: 'DELETE', path: '/admin/connections/c3/credentials', status: 204 },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear credentials' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});

describe('toCredentialInput', () => {
  const form = {
    grant: 'authorization_code' as const,
    clientId: 'cid',
    clientSecret: 'shh',
    tenantId: 't1',
    tokenUrl: 'https://auth.example/token',
    authorizeUrl: 'https://auth.example/authorize',
    scopes: ' read  write ',
  };

  it('builds a Microsoft payload with a tenant and split scopes', () => {
    expect(toCredentialInput('microsoft-graph', form)).toEqual({
      grant: 'authorization_code',
      clientId: 'cid',
      clientSecret: 'shh',
      tenantId: 't1',
      scopes: ['read', 'write'],
    });
  });

  it('builds a generic payload with token and authorize URLs', () => {
    expect(toCredentialInput('graphql', { ...form, scopes: '' })).toEqual({
      grant: 'authorization_code',
      clientId: 'cid',
      clientSecret: 'shh',
      tokenUrl: 'https://auth.example/token',
      authorizeUrl: 'https://auth.example/authorize',
    });
    expect(toCredentialInput('graphql', { ...form, grant: 'client_credentials', scopes: '' })).not.toHaveProperty('authorizeUrl');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/connections.test.tsx`
Expected: FAIL, because the placeholder pages render no links or forms.

- [ ] **Step 3: Implement the list page**

Replace `apps/web/src/pages/ConnectionsPage.tsx`:

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { readFileText } from '../browser';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';

export function ConnectionsPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  return (
    <section>
      <h1>Connections</h1>
      <OAuthBanner />
      {connections.isError ? (
        <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
      ) : connections.isPending ? (
        <p className="muted">Loading…</p>
      ) : connections.data.length === 0 ? (
        <p className="muted">No connections yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Adapter</th>
              <th>Auth mode</th>
            </tr>
          </thead>
          <tbody>
            {connections.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/connections/${c.id}`}>{c.name}</Link>
                </td>
                <td>{c.adapterType}</td>
                <td>{c.authMode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateConnectionForm />
      <ImportMappingsForm />
    </section>
  );
}

function CreateConnectionForm() {
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters });
  const [name, setName] = useState('');
  const [adapterType, setAdapterType] = useState('');
  const [authMode, setAuthMode] = useState('passthrough');
  const [endpoint, setEndpoint] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const selectedAdapter = adapterType || adapters.data?.[0] || '';
  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        name,
        adapterType: selectedAdapter,
        authMode,
        ...(selectedAdapter === 'graphql' ? { config: { endpoint } } : {}),
      }),
    onSuccess: (connection) => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      navigate(`/connections/${connection.id}`);
    },
  });
  return (
    <div className="panel">
      <h2>New connection</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Adapter
          <select value={selectedAdapter} onChange={(e) => setAdapterType(e.target.value)}>
            {(adapters.data ?? []).map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Auth mode
          <select value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
            <option value="passthrough">passthrough</option>
            <option value="managed">managed</option>
          </select>
        </label>
        {selectedAdapter === 'graphql' && (
          <label>
            GraphQL endpoint URL
            <input type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          </label>
        )}
        <FormError error={create.error ?? adapters.error} />
        <button type="submit" disabled={create.isPending || !selectedAdapter}>
          Create connection
        </button>
      </form>
    </div>
  );
}

function ImportMappingsForm() {
  const queryClient = useQueryClient();
  const importMutation = useMutation({
    mutationFn: async (file: File) => api.importMappings(await readFileText(file)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  return (
    <div className="panel">
      <h2>Import mappings from YAML</h2>
      <p className="muted">Uses the same format as <code>gtr mapping-export</code>. Nothing is written if any entry is invalid.</p>
      <input
        type="file"
        accept=".yaml,.yml,text/yaml"
        aria-label="YAML file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) importMutation.mutate(file);
          event.target.value = '';
        }}
      />
      <FormError error={importMutation.error} />
      {importMutation.data && <p className="success">Imported {importMutation.data.imported} mapping(s).</p>}
      {importMutation.data?.warnings.map((warning) => (
        <p key={warning} className="warning">
          {warning}
        </p>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement the connection page and its tabs**

Replace `apps/web/src/pages/ConnectionPage.tsx`:

```tsx
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';
import { OverviewTab } from './OverviewTab';
import { CredentialsTab } from './CredentialsTab';
import { MappingsTab } from './MappingsTab';

type Tab = 'overview' | 'credentials' | 'mappings';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', credentials: 'Credentials', mappings: 'Mappings' };

export function ConnectionPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.has('oauth') ? 'credentials' : 'overview');
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });

  if (connections.isError) return <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />;
  if (connections.isPending) return <p className="muted">Loading…</p>;
  const connection = connections.data.find((c) => c.id === id);
  if (!connection) {
    return (
      <section>
        <h1>Connection not found</h1>
        <Link to="/connections">Back to connections</Link>
      </section>
    );
  }
  const tabs: Tab[] = connection.authMode === 'managed' ? ['overview', 'credentials', 'mappings'] : ['overview', 'mappings'];
  const activeTab = tabs.includes(tab) ? tab : 'overview';
  return (
    <section>
      <p>
        <Link to="/connections">← Connections</Link>
      </p>
      <h1>{connection.name}</h1>
      <OAuthBanner />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={activeTab === t} className={activeTab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {activeTab === 'overview' && <OverviewTab connection={connection} />}
      {activeTab === 'credentials' && <CredentialsTab connection={connection} />}
      {activeTab === 'mappings' && <MappingsTab connection={connection} />}
    </section>
  );
}
```

Create `apps/web/src/pages/OverviewTab.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { FormError } from '../components/ErrorPanel';
import type { Connection } from '../types';

export function OverviewTab({ connection }: { connection: Connection }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api.deleteConnection(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      void queryClient.invalidateQueries({ queryKey: ['mappings'] });
      navigate('/connections');
    },
  });
  return (
    <div className="panel">
      <dl>
        <dt>Adapter</dt>
        <dd>{connection.adapterType}</dd>
        <dt>Auth mode</dt>
        <dd>{connection.authMode}</dd>
        <dt>Config</dt>
        <dd>
          <code>{connection.config ? JSON.stringify(connection.config) : 'none'}</code>
        </dd>
        <dt>ID</dt>
        <dd>
          <code>{connection.id}</code>
        </dd>
      </dl>
      <ConfirmButton
        message={`Delete connection "${connection.name}" and all of its mappings? This cannot be undone.`}
        onConfirm={() => remove.mutate()}
        disabled={remove.isPending}
      >
        Delete connection
      </ConfirmButton>
      <FormError error={remove.error} />
    </div>
  );
}
```

Create `apps/web/src/pages/CredentialsTab.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { redirectBrowser } from '../browser';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import type { Connection, CredentialStatus } from '../types';

export interface CredentialForm {
  grant: 'client_credentials' | 'authorization_code';
  clientId: string;
  clientSecret: string;
  tenantId: string;
  tokenUrl: string;
  authorizeUrl: string;
  scopes: string;
}

/** Builds the PUT /credentials payload the server's parseManagedCredentials expects for this adapter. */
export function toCredentialInput(adapterType: string, form: CredentialForm): Record<string, unknown> {
  const input: Record<string, unknown> = { grant: form.grant, clientId: form.clientId, clientSecret: form.clientSecret };
  if (adapterType === 'microsoft-graph') {
    input.tenantId = form.tenantId;
  } else {
    input.tokenUrl = form.tokenUrl;
    if (form.grant === 'authorization_code') input.authorizeUrl = form.authorizeUrl;
  }
  const scopes = form.scopes.split(/\s+/).filter(Boolean);
  if (scopes.length > 0) input.scopes = scopes;
  return input;
}

function describeStatus(status: CredentialStatus): string {
  if (!status.configured) return 'No credentials stored.';
  if (status.grant === 'client_credentials') return 'Configured: client_credentials grant.';
  return `Configured: authorization_code grant, ${status.hasRefreshToken ? 'authorized' : 'not yet authorized'}.`;
}

const EMPTY_FORM: CredentialForm = {
  grant: 'client_credentials',
  clientId: '',
  clientSecret: '',
  tenantId: '',
  tokenUrl: '',
  authorizeUrl: '',
  scopes: '',
};

export function CredentialsTab({ connection }: { connection: Connection }) {
  const key = ['credentials', connection.id];
  const status = useQuery({ queryKey: key, queryFn: () => api.credentialStatus(connection.id) });
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const isMicrosoft = connection.adapterType === 'microsoft-graph';
  const update = (field: keyof CredentialForm) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const save = useMutation({
    mutationFn: () => api.saveCredentials(connection.id, toCredentialInput(connection.adapterType, form)),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      setForm((current) => ({ ...current, clientSecret: '' }));
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearCredentials(connection.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const authorize = useMutation({
    mutationFn: () => api.startAuthorization(connection.id),
    onSuccess: ({ authorizationUrl }) => redirectBrowser(authorizationUrl),
  });

  return (
    <div>
      <div className="panel">
        <h2>Status</h2>
        {status.isError ? (
          <ErrorPanel error={status.error} onRetry={() => void status.refetch()} />
        ) : status.isPending ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>{describeStatus(status.data)}</p>
            <div className="toolbar">
              {status.data.configured && status.data.grant === 'authorization_code' && (
                <button type="button" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
                  Authorize
                </button>
              )}
              {status.data.configured && (
                <ConfirmButton message="Clear the stored credentials for this connection?" onConfirm={() => clear.mutate()} disabled={clear.isPending}>
                  Clear credentials
                </ConfirmButton>
              )}
            </div>
            <FormError error={authorize.error ?? clear.error} />
          </>
        )}
      </div>
      <div className="panel">
        <h2>Set credentials</h2>
        <p className="muted">Secrets are encrypted on the server and never shown again.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label>
            Grant
            <select value={form.grant} onChange={update('grant')}>
              <option value="client_credentials">client_credentials</option>
              <option value="authorization_code">authorization_code</option>
            </select>
          </label>
          <label>
            Client ID
            <input value={form.clientId} onChange={update('clientId')} required />
          </label>
          <label>
            Client secret
            <input type="password" value={form.clientSecret} onChange={update('clientSecret')} autoComplete="off" required />
          </label>
          {isMicrosoft ? (
            <label>
              Tenant ID
              <input value={form.tenantId} onChange={update('tenantId')} required />
            </label>
          ) : (
            <>
              <label>
                Token URL
                <input type="url" value={form.tokenUrl} onChange={update('tokenUrl')} required />
              </label>
              {form.grant === 'authorization_code' && (
                <label>
                  Authorize URL
                  <input type="url" value={form.authorizeUrl} onChange={update('authorizeUrl')} required />
                </label>
              )}
            </>
          )}
          <label>
            Scopes (space-separated, optional)
            <input value={form.scopes} onChange={update('scopes')} />
          </label>
          <FormError error={save.error} />
          <button type="submit" disabled={save.isPending}>
            Save credentials
          </button>
        </form>
      </div>
    </div>
  );
}
```

Create the placeholder `apps/web/src/pages/MappingsTab.tsx` (Task 10 replaces it):

```tsx
import type { Connection } from '../types';

export function MappingsTab({ connection }: { connection: Connection }) {
  return <p className="muted">Mappings for {connection.name}.</p>;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/web`
Expected: PASS: `connections.test.tsx` (14 tests) plus Task 8's tests. Then run `npm run build -w @graphtorest/web` and expect no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add connection list, creation, YAML import, overview and credential management

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Web — mappings tab (generate, edit, delete, export)

**Files:**
- Replace: `apps/web/src/pages/MappingsTab.tsx`
- Create: `apps/web/src/pages/MappingEditForm.tsx`
- Test: `apps/web/test/mappings.test.tsx` (create)

**Interfaces:**
- Consumes: `api.mappings/generateMappings/updateMapping/deleteMapping/exportMappings`, `downloadText`, `ConfirmButton`, `FormError`, `ErrorPanel` (Task 8).
- Produces: `MappingsTab({ connection })`, `MappingEditForm({ mapping, onDone })`, and `summarizeOperation(operation: Record<string, unknown>): string`, which truncates to 80 characters with `...`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/mappings.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { downloadText } from '../src/browser';
import { summarizeOperation } from '../src/pages/MappingsTab';

vi.mock('../src/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser')>()),
  downloadText: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(downloadText).mockReset();
});

const CONN = { id: 'c1', name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough', config: null };
const MAPPING = {
  id: 'm1',
  connectionId: 'c1',
  route: '/users/{id}',
  method: 'GET',
  operation: { query: 'user(id: $id) { id }' },
  responseTemplate: { id: '$.id' },
  source: 'generated',
};
const OTHER = { ...MAPPING, id: 'm2', connectionId: 'other', route: '/elsewhere' };

async function openMappingsTab(extraRoutes: Parameters<typeof mockFetch>[0] = []) {
  const mocked = mockFetch([
    SESSION_ROUTE,
    { path: '/admin/connections', body: [CONN] },
    { path: '/admin/mappings', body: [MAPPING, OTHER] },
    ...extraRoutes,
  ]);
  renderApp('/connections/c1');
  fireEvent.click(await screen.findByRole('tab', { name: 'Mappings' }));
  await screen.findByRole('button', { name: '/users/{id}' });
  return mocked;
}

describe('mappings tab', () => {
  it('lists only this connection’s mappings', async () => {
    await openMappingsTab();
    expect(screen.queryByText('/elsewhere')).toBeNull();
    expect(screen.getByText('generated')).toBeTruthy();
  });

  it('generates with the vendor token header and reports counts', async () => {
    const { calls } = await openMappingsTab([
      { method: 'POST', path: '/admin/connections/c1/mappings/generate', body: { created: [1, 2], updated: [], skipped: [1], conflicts: [] } },
    ]);
    fireEvent.change(screen.getByLabelText('Vendor token'), { target: { value: 'vendor-abc' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overwrite manual mappings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate mappings' }));
    expect(await screen.findByText('Created 2, updated 0, skipped 1, conflicts 0.')).toBeTruthy();
    const call = calls.find((c) => c.path === '/admin/connections/c1/mappings/generate')!;
    expect(call.body).toEqual({ force: true });
    expect(call.headers['X-Vendor-Token']).toBe('vendor-abc');
  });

  it('saves an edit as a PATCH with parsed JSON', async () => {
    const { calls } = await openMappingsTab([{ method: 'PATCH', path: '/admin/mappings/m1', body: { ...MAPPING, route: '/people/{id}', source: 'manual' } }]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: '/people/{id}' } });
    fireEvent.change(screen.getByLabelText('Response template (JSON, empty for passthrough)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      method: 'GET',
      route: '/people/{id}',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: null,
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull());
  });

  it('shows server validation errors inline and keeps the form open', async () => {
    await openMappingsTab([
      {
        method: 'PATCH',
        path: '/admin/mappings/m1',
        status: 400,
        body: { error: { code: 'INVALID_INPUT', message: '"route" must be a path starting with "/" and containing no whitespace', details: {} } },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: 'no-slash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('"route" must be a path starting with "/" and containing no whitespace')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeTruthy();
  });

  it('rejects invalid JSON locally without calling the server', async () => {
    const { calls } = await openMappingsTab();
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Operation (JSON)'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText(/Operation is not valid JSON/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('deletes a mapping after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = await openMappingsTab([{ method: 'DELETE', path: '/admin/mappings/m1', status: 204 }]);
    const row = screen.getByRole('button', { name: '/users/{id}' }).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/mappings/m1')).toBe(true));
  });

  it('downloads this connection’s YAML', async () => {
    await openMappingsTab([{ path: '/admin/mappings/export?connectionId=c1', text: '- route: GET /users/{id}\n' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Export YAML' }));
    await waitFor(() => expect(downloadText).toHaveBeenCalledWith('mock-conn-mappings.yaml', '- route: GET /users/{id}\n'));
  });

  it('hides the vendor token field for managed connections', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [{ ...CONN, authMode: 'managed' }] },
      { path: '/admin/mappings', body: [] },
    ]);
    renderApp('/connections/c1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Mappings' }));
    await screen.findByText('No mappings for this connection yet.');
    expect(screen.queryByLabelText('Vendor token')).toBeNull();
  });
});

describe('summarizeOperation', () => {
  it('truncates long operations', () => {
    expect(summarizeOperation({ q: 'x' })).toBe('{"q":"x"}');
    const long = summarizeOperation({ query: 'y'.repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith('...')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/mappings.test.tsx`
Expected: FAIL. The placeholder tab renders no table, and `summarizeOperation` is not exported.

- [ ] **Step 3: Implement the edit form**

Create `apps/web/src/pages/MappingEditForm.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { FormError } from '../components/ErrorPanel';
import type { Mapping, MappingPatch } from '../types';

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function MappingEditForm({ mapping, onDone }: { mapping: Mapping; onDone: () => void }) {
  const [method, setMethod] = useState(mapping.method);
  const [route, setRoute] = useState(mapping.route);
  const [operation, setOperation] = useState(JSON.stringify(mapping.operation, null, 2));
  const [template, setTemplate] = useState(mapping.responseTemplate ? JSON.stringify(mapping.responseTemplate, null, 2) : '');
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: MappingPatch) => api.updateMapping(mapping.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mappings'] });
      onDone();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    const parsedOperation = parseJson(operation);
    if (!parsedOperation.ok) {
      setLocalError(`Operation is not valid JSON: ${parsedOperation.error}`);
      return;
    }
    let responseTemplate: unknown = null;
    if (template.trim()) {
      const parsedTemplate = parseJson(template);
      if (!parsedTemplate.ok) {
        setLocalError(`Response template is not valid JSON: ${parsedTemplate.error}`);
        return;
      }
      responseTemplate = parsedTemplate.value;
    }
    save.mutate({ method, route, operation: parsedOperation.value, responseTemplate });
  };

  return (
    <div className="panel">
      <h2>
        Edit {mapping.method} {mapping.route}
      </h2>
      <p className="muted">Saving marks this mapping as manual, so regeneration skips it unless forced.</p>
      <form onSubmit={submit}>
        <label>
          Method
          <input value={method} onChange={(e) => setMethod(e.target.value)} required />
        </label>
        <label>
          Route
          <input value={route} onChange={(e) => setRoute(e.target.value)} required />
        </label>
        <label>
          Operation (JSON)
          <textarea value={operation} onChange={(e) => setOperation(e.target.value)} />
        </label>
        <label>
          Response template (JSON, empty for passthrough)
          <textarea value={template} onChange={(e) => setTemplate(e.target.value)} />
        </label>
        {localError && (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        <FormError error={save.error} />
        <div className="toolbar">
          <button type="submit" disabled={save.isPending}>
            Save mapping
          </button>
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Implement the tab**

Replace `apps/web/src/pages/MappingsTab.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { downloadText } from '../browser';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import type { Connection } from '../types';
import { MappingEditForm } from './MappingEditForm';

export function summarizeOperation(operation: Record<string, unknown>): string {
  const text = JSON.stringify(operation);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function MappingsTab({ connection }: { connection: Connection }) {
  const mappings = useQuery({ queryKey: ['mappings'], queryFn: api.mappings });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [vendorToken, setVendorToken] = useState('');
  const [force, setForce] = useState(false);
  const queryClient = useQueryClient();
  const isPassthrough = connection.authMode === 'passthrough';

  const generate = useMutation({
    mutationFn: () => api.generateMappings(connection.id, { force, vendorToken: isPassthrough ? vendorToken : undefined }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMapping(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  const exportYaml = useMutation({
    mutationFn: () => api.exportMappings(connection.id),
    onSuccess: (text) => downloadText(`${connection.name}-mappings.yaml`, text),
  });

  const own = (mappings.data ?? [])
    .filter((m) => m.connectionId === connection.id)
    .sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
  const editing = own.find((m) => m.id === editingId) ?? null;

  return (
    <div>
      <div className="panel">
        <h2>Generate</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            generate.mutate();
          }}
        >
          {isPassthrough && (
            <label>
              Vendor token
              <input type="password" value={vendorToken} onChange={(e) => setVendorToken(e.target.value)} autoComplete="off" required />
            </label>
          )}
          <label className="inline">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Overwrite manual mappings
          </label>
          <button type="submit" disabled={generate.isPending}>
            Generate mappings
          </button>
        </form>
        <FormError error={generate.error} />
        {generate.data && (
          <p className="success">
            Created {generate.data.created.length}, updated {generate.data.updated.length}, skipped {generate.data.skipped.length}, conflicts{' '}
            {generate.data.conflicts.length}.
          </p>
        )}
      </div>

      <div className="toolbar">
        <button type="button" onClick={() => exportYaml.mutate()} disabled={exportYaml.isPending}>
          Export YAML
        </button>
        <FormError error={exportYaml.error} />
      </div>

      {mappings.isError ? (
        <ErrorPanel error={mappings.error} onRetry={() => void mappings.refetch()} />
      ) : mappings.isPending ? (
        <p className="muted">Loading…</p>
      ) : own.length === 0 ? (
        <p className="muted">No mappings for this connection yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Route</th>
              <th>Source</th>
              <th>Operation</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {own.map((m) => (
              <tr key={m.id} className={m.id === editingId ? 'selected' : ''}>
                <td>{m.method}</td>
                <td>
                  <button type="button" className="link" onClick={() => setEditingId(m.id)}>
                    {m.route}
                  </button>
                </td>
                <td>{m.source}</td>
                <td>
                  <code>{summarizeOperation(m.operation)}</code>
                </td>
                <td>
                  <ConfirmButton message={`Delete mapping ${m.method} ${m.route}?`} onConfirm={() => remove.mutate(m.id)} disabled={remove.isPending}>
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FormError error={remove.error} />
      {editing && <MappingEditForm key={editing.id} mapping={editing} onDone={() => setEditingId(null)} />}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/web`
Expected: PASS: `mappings.test.tsx` (9 tests) and all earlier web tests. `npm run build -w @graphtorest/web` is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add the mappings tab with generate, edit, delete and YAML export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 11: Web — API keys, test panel, activity

**Files:**
- Replace: `apps/web/src/pages/ApiKeysPage.tsx`, `apps/web/src/pages/TestPanelPage.tsx`, `apps/web/src/pages/ActivityPage.tsx`
- Create: `apps/web/src/testApiKey.ts`, `apps/web/src/pages/SwaggerPanel.tsx`
- Test: `apps/web/test/apiKeys.test.tsx`, `apps/web/test/testPanel.test.tsx`, `apps/web/test/activity.test.tsx` (create)

**Interfaces:**
- Consumes: `api.apiKeys/createApiKey/deleteApiKey/activity` (Task 8).
- Produces:
  - `TEST_API_KEY_STORAGE = 'gtr_test_api_key'`
  - `readTestApiKey(): string` and `storeTestApiKey(key: string): void`
  - `withApiKey<T extends { headers?: Record<string, string> }>(request: T, key: string): T`
  - The default export of `SwaggerPanel.tsx`: `SwaggerPanel({ apiKey }: { apiKey: string })`
- The `ActivityPage` must render its `<h1>Activity</h1>` in every state (loading, error, data); Task 8's login test relies on it.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/apiKeys.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';

vi.mock('../src/pages/SwaggerPanel', () => ({ default: () => <div>swagger-panel</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const KEY = { id: 'k1', label: 'dev', createdAt: '2026-09-22 10:00:00', lastUsedAt: null };

describe('API keys page', () => {
  it('lists keys', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [KEY] }]);
    renderApp('/api-keys');
    expect(await screen.findByText('dev')).toBeTruthy();
    expect(screen.getByText('never')).toBeTruthy();
  });

  it('shows a new key once, and hides it after Done', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.secret-value', label: 'ci' } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(await screen.findByText('k2.secret-value')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ label: 'ci' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('k2.secret-value')).toBeNull();
  });

  it('hands a new key to the test panel', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.secret-value', label: null } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use in test panel' }));
    expect(await screen.findByRole('heading', { name: 'Test' })).toBeTruthy();
    expect(sessionStorage.getItem('gtr_test_api_key')).toBe('k2.secret-value');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('k2.secret-value');
  });

  it('revokes a key after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [KEY] }, { method: 'DELETE', path: '/admin/api-keys/k1', status: 204 }]);
    renderApp('/api-keys');
    const row = (await screen.findByText('dev')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/api-keys/k1')).toBe(true));
  });
});
```

Create `apps/web/test/testPanel.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { withApiKey, readTestApiKey, storeTestApiKey } from '../src/testApiKey';

vi.mock('../src/pages/SwaggerPanel', () => ({ default: ({ apiKey }: { apiKey: string }) => <div>swagger-panel key={apiKey}</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('withApiKey', () => {
  it('adds a bearer header and keeps existing headers', () => {
    expect(withApiKey({ url: '/api/x', headers: { Accept: 'application/json' } }, 'k.s')).toEqual({
      url: '/api/x',
      headers: { Accept: 'application/json', Authorization: 'Bearer k.s' },
    });
  });

  it('leaves the request alone without a key', () => {
    const request = { url: '/api/x' };
    expect(withApiKey(request, '')).toBe(request);
  });
});

describe('test API key storage', () => {
  it('round-trips through sessionStorage and clears on empty', () => {
    storeTestApiKey('k.s');
    expect(readTestApiKey()).toBe('k.s');
    storeTestApiKey('');
    expect(sessionStorage.getItem('gtr_test_api_key')).toBeNull();
  });
});

describe('test panel page', () => {
  it('pre-fills the stored key and passes edits to the Swagger panel', async () => {
    sessionStorage.setItem('gtr_test_api_key', 'stored.key');
    mockFetch([SESSION_ROUTE]);
    renderApp('/test');
    const input = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(input.value).toBe('stored.key');
    expect(await screen.findByText('swagger-panel key=stored.key')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'new.key' } });
    expect(await screen.findByText('swagger-panel key=new.key')).toBeTruthy();
    expect(sessionStorage.getItem('gtr_test_api_key')).toBe('new.key');
  });
});
```

Create `apps/web/test/activity.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(id: number, path: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ts: '2026-09-22T10:00:00.000Z',
    method: 'GET',
    path,
    status: 200,
    durationMs: 12,
    errorCode: null,
    apiKeyId: 'k1',
    apiKeyLabel: 'dev',
    connectionId: 'c1',
    connectionName: 'mock-conn',
    mappingId: 'm1',
    ...extra,
  };
}

describe('activity page', () => {
  it('shows rows and loads older pages', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/activity?limit=50', body: { items: [row(3, '/api/three'), row(2, '/api/two', { status: 404, errorCode: 'NOT_FOUND', mappingId: null, connectionName: null })], nextBefore: 2 } },
      { path: '/admin/activity?limit=50&before=2', body: { items: [row(1, '/api/one')], nextBefore: null } },
    ]);
    renderApp('/activity');
    expect(await screen.findByText('/api/three')).toBeTruthy();
    expect(screen.getByText('NOT_FOUND')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('/api/one')).toBeTruthy();
    expect(calls.some((c) => c.path === '/admin/activity?limit=50&before=2')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('shows an empty state', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/activity?limit=50', body: { items: [], nextBefore: null } }]);
    renderApp('/activity');
    expect(await screen.findByText('No requests recorded yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/apiKeys.test.tsx apps/web/test/testPanel.test.tsx apps/web/test/activity.test.tsx`
Expected: FAIL. The placeholders render only headings, and `../src/testApiKey` does not exist.

- [ ] **Step 3: Implement the test-key helpers and the Swagger panel**

Create `apps/web/src/testApiKey.ts`:

```ts
export const TEST_API_KEY_STORAGE = 'gtr_test_api_key';

/** The test panel's API key lives in sessionStorage: it survives reloads of this tab only. Storage may be unavailable. */
export function readTestApiKey(): string {
  try {
    return sessionStorage.getItem(TEST_API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function storeTestApiKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(TEST_API_KEY_STORAGE, key);
    else sessionStorage.removeItem(TEST_API_KEY_STORAGE);
  } catch {
    // storage unavailable (private mode, blocked site data): the key just won't persist
  }
}

export function withApiKey<T extends { headers?: Record<string, string> }>(request: T, key: string): T {
  if (!key) return request;
  return { ...request, headers: { ...(request.headers ?? {}), Authorization: `Bearer ${key}` } };
}
```

Create `apps/web/src/pages/SwaggerPanel.tsx`, loaded lazily so the Swagger bundle is only fetched on `/test`:

```tsx
import { useEffect, useRef } from 'react';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import { withApiKey } from '../testApiKey';

export default function SwaggerPanel({ apiKey }: { apiKey: string }) {
  const keyRef = useRef(apiKey);
  useEffect(() => {
    keyRef.current = apiKey;
  }, [apiKey]);
  return (
    <SwaggerUI
      url="/api/openapi.json"
      requestInterceptor={(request) => Object.assign(request, withApiKey(request as { headers?: Record<string, string> }, keyRef.current))}
    />
  );
}
```

- [ ] **Step 4: Implement the pages**

Replace `apps/web/src/pages/TestPanelPage.tsx`:

```tsx
import { lazy, Suspense, useState } from 'react';
import { readTestApiKey, storeTestApiKey } from '../testApiKey';

const SwaggerPanel = lazy(() => import('./SwaggerPanel'));

export function TestPanelPage() {
  const [apiKey, setApiKey] = useState(readTestApiKey);
  return (
    <section>
      <h1>Test</h1>
      <label>
        API key
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          onChange={(event) => {
            setApiKey(event.target.value);
            storeTestApiKey(event.target.value);
          }}
        />
      </label>
      <p className="muted">Requests below go to /api/* with this key, exactly as a real client would send them. Create keys on the API keys page.</p>
      <Suspense fallback={<p className="muted">Loading API explorer…</p>}>
        <SwaggerPanel apiKey={apiKey} />
      </Suspense>
    </section>
  );
}
```

Replace `apps/web/src/pages/ApiKeysPage.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { storeTestApiKey } from '../testApiKey';
import type { CreatedApiKey } from '../types';

export function ApiKeysPage() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.createApiKey(label.trim() || undefined),
    onSuccess: (key) => {
      setCreated(key);
      setLabel('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <section>
      <h1>API keys</h1>
      {created && (
        <div className="panel highlight" role="status">
          <p>Copy this key now. It will not be shown again.</p>
          <code className="secret">{created.plaintext}</code>
          <div className="toolbar">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(created.plaintext)}>
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                storeTestApiKey(created.plaintext);
                navigate('/test');
              }}
            >
              Use in test panel
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Label (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <FormError error={create.error} />
          <button type="submit" disabled={create.isPending}>
            Create API key
          </button>
        </form>
      </div>
      {keys.isError ? (
        <ErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.isPending ? (
        <p className="muted">Loading…</p>
      ) : keys.data.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>ID</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td>{key.label ?? '—'}</td>
                <td>
                  <code>{key.id}</code>
                </td>
                <td>{key.createdAt}</td>
                <td>{key.lastUsedAt ?? 'never'}</td>
                <td>
                  <ConfirmButton
                    message={`Revoke API key "${key.label ?? key.id}"? Clients using it will be rejected immediately.`}
                    onConfirm={() => revoke.mutate(key.id)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FormError error={revoke.error} />
    </section>
  );
}
```

Replace `apps/web/src/pages/ActivityPage.tsx`:

```tsx
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';

export function ActivityPage() {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const activity = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => api.activity(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: autoRefresh ? 5000 : false,
  });
  const items = activity.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>Activity</h1>
      <label className="inline">
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        Refresh every 5 seconds
      </label>
      {activity.isError ? (
        <ErrorPanel error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.isPending ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No requests recorded yet.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th>Duration</th>
                <th>API key</th>
                <th>Connection</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.ts).toLocaleString()}</td>
                  <td>{item.method}</td>
                  <td>
                    <code>{item.path}</code>
                  </td>
                  <td>{item.status}</td>
                  <td>{item.durationMs} ms</td>
                  <td>{item.apiKeyLabel ?? item.apiKeyId ?? '—'}</td>
                  <td>{item.connectionName ?? '—'}</td>
                  <td>{item.errorCode ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {activity.hasNextPage && (
            <button type="button" onClick={() => void activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
              Load older
            </button>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/web`
Expected: PASS: the three new files (4 + 4 + 2 tests) and every earlier web test, including Task 8's login test that lands on `/activity`. Its mock has no `/admin/activity` route, so the page shows an error panel under the `Activity` heading, which is still what that test asserts.

Then run `npm run build -w @graphtorest/web`
Expected: clean, with a separate lazily loaded chunk for the Swagger panel under `apps/web/dist/assets/`.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add API key management, the Swagger test panel and the activity view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Docker image, compose notes and an end-to-end smoke run

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the `apps/web` workspace (Tasks 8–11) and the server's `webRoot` discovery at `apps/server/dist/../../web/dist` (Task 7).

- [ ] **Step 1: Update the Dockerfile**

In the `build` stage, add the web manifest before `npm ci`, the web source before the build, and keep the build command (it builds every workspace, including web):

```dockerfile
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
```

In the `runtime` stage, after `COPY --from=build /app/apps/cli apps/cli`, add:

```dockerfile
# Only the built bundle; the web app has no runtime dependencies of its own.
COPY --from=build /app/apps/web/dist apps/web/dist
```

The runtime image still copies the full hoisted `node_modules`, which now includes the web build tooling. Plan 8 owns image slimming, so leave that as it is.

- [ ] **Step 2: Update docker-compose.yml**

Replace the `PUBLIC_BASE_URL` comment with:

```yaml
      # Externally reachable URL of this server — set it to the address you type into the browser.
      # The OAuth redirect URI is <PUBLIC_BASE_URL>/admin/oauth/callback, the admin cookie is marked Secure
      # when it is https, and the web UI's CSRF check accepts this origin (plus the request's own Host).
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://localhost:3000}
```

and add below it:

```yaml
      # Newest request-log rows kept for the web UI's Activity view.
      ACTIVITY_RETENTION: ${ACTIVITY_RETENTION:-1000}
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, with every core, server, CLI and web test green. Record the total count in your report.

- [ ] **Step 4: Build and smoke-test the Docker image**

Run: `docker build -t graphtorest:plan6 .`
Expected: the build succeeds.

Then:

```bash
docker run -d --name gtr-plan6 -p 127.0.0.1:3900:3000 -e PUBLIC_BASE_URL=http://localhost:3900 graphtorest:plan6
docker exec -e GTR_ADMIN_PASSWORD=correct-horse-battery gtr-plan6 gtr admin-create --username admin
curl -s -o /dev/null -w '%{http_code} %header{content-security-policy}\n' http://localhost:3900/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3900/connections
curl -s -c /tmp/gtr-cookies -H 'Content-Type: application/json' -d '{"username":"admin","password":"correct-horse-battery","session":"cookie"}' http://localhost:3900/admin/login
curl -s -b /tmp/gtr-cookies http://localhost:3900/admin/session
docker rm -f gtr-plan6
```

Expected:
- `200 default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`
- `200` for the client route
- the login body `{"username":"admin","expiresAt":"..."}` with no token
- `/admin/session` returns the same username

(If this machine's curl is older than 7.84 and lacks `%header{}`, use `curl -sI http://localhost:3900/ | grep -i content-security-policy` instead.)

- [ ] **Step 5: Manual browser smoke run**

With the container from Step 4 running (re-run it if you already removed it), or with `npm run build && node apps/server/dist/index.js`, open `http://localhost:3900/` and walk through:
1. Log in.
2. Create a `mock` passthrough connection.
3. Generate mappings (any vendor token works for the mock adapter).
4. Create an API key and click "Use in test panel".
5. On `/test`, execute one route through Swagger and confirm it returns 200.
6. Confirm the request appears on `/activity`.
7. Check the browser console for CSP violations.

If Swagger UI is blocked by the CSP, capture the console error in the report. Do not loosen the CSP yourself; the controller rules on it.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "$(cat <<'EOF'
build: bundle the web UI into the Docker image and document PUBLIC_BASE_URL for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Deferred / Not in This Plan

- First-run admin bootstrap in the UI and via env (Plan 8), and creating additional admins from the UI (CLI only).
- Login throttling (Plan 8; `scryptSync` blocks the event loop). The cookie login inherits this.
- Structured stdout request logs (Plan 8; they should reuse the same `finish`-event data as `activityLog.ts`).
- Runtime image slimming (Plan 8). The web build tooling now also ships in `node_modules`.
- Plan 5 deferred minors not touched here stay deferred (see the memory/ledger list). This plan closes one of them: "vendor error= callback doesn't consume pending state", via `abandonAuthorization`.

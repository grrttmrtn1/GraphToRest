# GraphToRest Plan 3: GraphQL Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic `GraphQLAdapter` that works against any spec-compliant GraphQL endpoint — introspecting via the standard `__schema` query and deriving REST mapping drafts purely from that schema, with zero vendor-specific knowledge — proving the `Adapter` interface built in Plan 1 and exercised by Plan 2's curated Microsoft Graph adapter generalizes to a fully schema-driven adapter.

**Architecture:** Unlike `MicrosoftGraphAdapter` (a fixed base URL, a curated `defaultMappings.ts` table, `$select`/`$filter`/`$expand` translation), `GraphQLAdapter` has no built-in knowledge of any particular API: every connection supplies its own endpoint URL via a new `config` field on `ConnectionRecord`, and every mapping's `operation.query`/`operation.variables` is a literal GraphQL document — no per-vendor query-building logic exists in the adapter at all. The adapter is built from three collaborators: `GraphQLHttpClient` (POSTs `{query, variables}` to the connection's endpoint over Node's built-in `fetch`, normalizing both transport and GraphQL `errors[]` failures into `GatewayError`), `introspection.ts` (the standard `__schema` query plus type-reference-unwrapping helpers to turn raw introspection JSON into a typed `GraphQLSchemaIntrospection`), and `mappingGeneration.ts` (walks the introspected query type's fields and, for each field whose arguments and return type are simple enough to represent as a GET route — zero or one scalar-typed argument, a return type with at least one scalar/enum sub-field — emits a `MappingDraft` with a real GraphQL query string and a `responseTemplate` that unwraps the GraphQL response's `data.<field>` envelope). Fields that don't fit that shape (multiple args, list-typed args, object-only return types with no scalar leaves) are silently skipped — nested-type → nested-resource expansion is explicitly Plan 4's job (spec §5.2). Reaching the endpoint requires widening `AuthContext` (Plan 1) with an additive `config?: Record<string, unknown> | null` field, threaded from the connection record through `GatewayEngine.handle` exactly the way Plan 2 threaded `authMode` — `GraphQLAdapter` reads `authContext.config.endpoint`.

**Tech Stack:** No new npm dependency. GraphQL-over-HTTP is a plain `POST` of `{query, variables}` as JSON; Node 20's built-in global `fetch` (this repo's `engines.node` floor) is used directly. Verified in this session that the existing `nock@14` devDependency intercepts Node's global `fetch` correctly (Plan 2 only proved this indirectly, since `@microsoft/microsoft-graph-client` sits on top of `fetch` — this plan calls `fetch` directly, one layer thinner).

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md` §4.2 (GraphQLAdapter), §4.3 (registry), §5.2 (generate-then-customize flow — the parts explicitly out of scope here), §6.1 (error normalization) — see also `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md` for what surrounding plans cover, and `docs/superpowers/plans/2026-09-18-graphtorest-02-microsoft-graph-adapter.md` for the code this plan runs alongside (same `Adapter` interface, same registry, same `GatewayEngine`).

## Global Constraints

- Node.js + TypeScript throughout (spec §11); same tsconfig/workspace conventions as Plans 1–2 — no new build tooling, no new runtime dependency.
- Error responses stay `{ "error": { "code": "string", "message": "string", "details": {} } }` with an appropriate status (spec §6.1). GraphQL `errors[]` arrays are normalized into `GatewayError` at the `GraphQLHttpClient` boundary, same pattern Plan 2 used for OData errors.
- **Only `authMode: "passthrough"` is implemented**, identical restriction to Plan 2's Microsoft Graph adapter — `"managed"` (encrypted credentials, OAuth flows) is Plan 5's scope. Reject `"managed"` with `501`, exactly mirroring `GraphHttpClient`'s constructor check.
- Vendor-token passthrough reuses the `X-Vendor-Token` header convention Plan 2 established (spec §7.2) — do not invent a second header.
- **No vendor-specific knowledge** (spec §4.2, the whole point of this plan): `generateMappings` must derive every mapping purely from the introspected `__schema` result. No hardcoded table like Plan 2's `defaultMappings.ts` exists or should exist here.
- Nested-type → nested-resource/`?expand=` mapping generation (spec §5.2) is explicitly Plan 4's scope. `generateMappings` in this plan only emits a mapping for a query field when its full selection set can be built from scalar/enum leaves; skip (don't partially generate) anything that needs nesting.
- Mutation→REST-verb mapping is undefined by the spec and out of scope here. `introspect()` still discovers and returns the mutation type's name (satisfying the roadmap's "type/query/mutation discovery" wording), but `generateMappings` only turns **query** fields into GET mappings.
- Generated (and any hand-written) GraphQL routes live under a `/graphql/*` prefix, mirroring Plan 2's `/msgraph/*` vendor-namespacing decision — `mappings` has a global `UNIQUE(method, route)` constraint (Plan 1), so namespacing avoids collisions with other connections' routes.
- Connections need somewhere to store a GraphQL endpoint URL — config, not a secret. Add a nullable `config` JSON column to `connections` via an **idempotent** `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info` (SQLite has no `ADD COLUMN IF NOT EXISTS`, and the existing `MIGRATIONS` array of raw `CREATE TABLE IF NOT EXISTS` strings re-runs on every `openDb` call, so a bare `ALTER TABLE ADD COLUMN` there would fail the second time a file is opened).
- While touching `MappingStore.test.ts` and `GatewayEngine.test.ts` (both on the Plan 1 review's "never close the sqlite handle" list), add `db.close()` in their `afterEach` — cheap since this plan is already modifying both files for the `config` field.

---

## File Structure

```
packages/core/
  src/
    storage/
      db.ts                                    # +ensureConnectionsConfigColumn (Task 1)
      MappingStore.ts                           # +ConnectionRecord.config, createConnection/getConnection/listConnections (Task 1)
    adapters/
      Adapter.ts                                # +AuthContext.config (Task 2)
      defaults.ts                               # +register 'graphql' (Task 6)
      graphql/
        GraphQLHttpClient.ts                    # execute() over fetch + error normalization (Task 3)
        introspection.ts                        # INTROSPECTION_QUERY, parseIntrospection, unwrapType, findType (Task 4)
        mappingGeneration.ts                    # generateMappingsFromIntrospection (Task 5)
        GraphQLAdapter.ts                       # Adapter impl: introspect/generateMappings/execute (Task 6)
    gateway/
      GatewayEngine.ts                          # handle() threads connection.config into authContext (Task 2)
    index.ts                                    # +GraphQLAdapter export (Task 6)
  test/
    storage/
      db.test.ts                                # +config column tests (Task 1)
      MappingStore.test.ts                      # +config round-trip tests, +db.close() (Task 1)
    gateway/
      GatewayEngine.test.ts                     # +authContext.config test, +db.close() (Task 2)
    adapters/
      graphql/
        GraphQLHttpClient.test.ts               # Task 3
        introspection.test.ts                   # Task 4
        mappingGeneration.test.ts               # Task 5
        GraphQLAdapter.test.ts                  # Task 6

apps/server/
  src/routers/adminRouter.ts                    # +config passthrough on POST /connections (Task 7)
  test/
    integration.test.ts                         # +connection config round-trip test (Task 7)
    graphql.integration.test.ts                 # new end-to-end test (Task 8)

apps/cli/
  src/
    commands/connectionCreate.ts                # +config arg (Task 7)
    index.ts                                    # +--config option (Task 7)
  test/commands.test.ts                         # +config round-trip test (Task 7)
```

---

### Task 1: Widen storage layer with a per-connection `config` field

**Files:**
- Modify: `packages/core/src/storage/db.ts`
- Modify: `packages/core/src/storage/MappingStore.ts`
- Test: `packages/core/test/storage/db.test.ts`
- Test: `packages/core/test/storage/MappingStore.test.ts`

**Interfaces:**
- Produces: `ConnectionRecord.config: Record<string, unknown> | null`; `MappingStore.createConnection(input: { name; adapterType; authMode; config?: Record<string, unknown> | null })`. Every later task that creates a connection with a GraphQL endpoint relies on this field round-tripping through `getConnection`/`listConnections`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/storage/db.test.ts` (inside the existing `describe('openDb', ...)` block):

```ts
  it('adds a nullable config column to connections, idempotently across repeated opens', () => {
    const file = tmpDbPath();
    openDb(file).close();
    const db = openDb(file);
    const columns = db.prepare('PRAGMA table_info(connections)').all().map((c: any) => c.name);
    expect(columns).toContain('config');
    db.close();
  });
```

Replace the full contents of `packages/core/test/storage/MappingStore.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingstore-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('MappingStore', () => {
  it('creates and retrieves a connection', () => {
    const created = store.createConnection({ name: 'ms-graph-prod', adapterType: 'mock', authMode: 'passthrough' });
    expect(created.id).toBeTruthy();
    expect(store.getConnection(created.id)).toEqual(created);
    expect(store.listConnections()).toEqual([created]);
  });

  it('returns null for an unknown connection id', () => {
    expect(store.getConnection('nope')).toBeNull();
  });

  it('defaults config to null when not provided', () => {
    const created = store.createConnection({ name: 'c-no-config', adapterType: 'mock', authMode: 'passthrough' });
    expect(created.config).toBeNull();
    expect(store.getConnection(created.id)?.config).toBeNull();
  });

  it('creates and retrieves a connection with a config object', () => {
    const created = store.createConnection({
      name: 'graphql-github',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.github.com/graphql' },
    });
    expect(created.config).toEqual({ endpoint: 'https://api.github.com/graphql' });
    expect(store.getConnection(created.id)?.config).toEqual({ endpoint: 'https://api.github.com/graphql' });
    expect(store.listConnections()).toEqual([created]);
  });

  it('creates and lists a mapping with operation and responseTemplate round-tripped as objects', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id' },
    });
    expect(mapping.source).toBe('generated');
    expect(store.listMappings()).toEqual([mapping]);
  });

  it('defaults mapping source to manual when explicitly requested', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: {},
      source: 'manual',
    });
    expect(mapping.source).toBe('manual');
    expect(mapping.responseTemplate).toBeNull();
  });

  it('creates an api key whose plaintext verifies against the stored hash', () => {
    const created = store.createApiKey({ label: 'test key' });
    const found = store.findApiKeyById(created.id);
    expect(found).not.toBeNull();
    const parsed = parsePresentedKey(created.plaintext);
    expect(verifySecret(parsed!.secret, found!.hashedKey)).toBe(true);
  });

  it('touches last_used_at without throwing', () => {
    const created = store.createApiKey({});
    expect(() => store.touchApiKeyLastUsed(created.id)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/storage/db.test.ts packages/core/test/storage/MappingStore.test.ts`
Expected: FAIL — no `config` column exists yet, `createConnection`/`getConnection` don't know about `config`.

- [ ] **Step 3: Implement `config` column support in `db.ts`**

Replace `packages/core/src/storage/db.ts` with:

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export function openDb(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  ensureConnectionsConfigColumn(db);
  return db;
}

function ensureConnectionsConfigColumn(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'config')) {
    db.exec('ALTER TABLE connections ADD COLUMN config TEXT');
  }
}
```

- [ ] **Step 4: Implement `config` support in `MappingStore.ts`**

In `packages/core/src/storage/MappingStore.ts`, widen `ConnectionRecord`, add a row-mapping helper, and update `createConnection`/`getConnection`/`listConnections`:

```ts
export interface ConnectionRecord {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: Record<string, unknown> | null;
}
```

```ts
interface ConnectionRow {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: string | null;
}

function mapConnectionRow(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    authMode: row.authMode,
    config: row.config ? JSON.parse(row.config) : null,
  };
}
```

```ts
  createConnection(input: {
    name: string;
    adapterType: string;
    authMode: string;
    config?: Record<string, unknown> | null;
  }): ConnectionRecord {
    const id = crypto.randomUUID();
    const config = input.config ?? null;
    this.db
      .prepare('INSERT INTO connections (id, name, adapter_type, auth_mode, config) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.adapterType, input.authMode, config ? JSON.stringify(config) : null);
    return { id, name: input.name, adapterType: input.adapterType, authMode: input.authMode, config };
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode, config FROM connections WHERE id = ?')
      .get(id) as ConnectionRow | undefined;
    return row ? mapConnectionRow(row) : null;
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode, config FROM connections')
      .all() as ConnectionRow[];
    return rows.map(mapConnectionRow);
  }
```

Leave `createMapping`, `listMappings`, `createApiKey`, `findApiKeyById`, `touchApiKeyLastUsed` unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/storage/db.test.ts packages/core/test/storage/MappingStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/storage/db.ts packages/core/src/storage/MappingStore.ts packages/core/test/storage/db.test.ts packages/core/test/storage/MappingStore.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add a config field to connections for adapter-specific settings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Widen `AuthContext` with `config` and thread it through `GatewayEngine`

**Files:**
- Modify: `packages/core/src/adapters/Adapter.ts`
- Modify: `packages/core/src/gateway/GatewayEngine.ts`
- Test: `packages/core/test/gateway/GatewayEngine.test.ts`

**Interfaces:**
- Consumes: `ConnectionRecord.config` (Task 1).
- Produces: `AuthContext.config?: Record<string, unknown> | null`, populated by `GatewayEngine.handle` from `connection.config`. `GraphQLAdapter.execute`/`introspect` (Task 6) read `authContext.config.endpoint`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/gateway/GatewayEngine.test.ts`, inside the `describe('GatewayEngine.handle request context', ...)` block (after the existing `authMode` test):

```ts
  it('passes the connection config through the auth context', async () => {
    const received: unknown[] = [];
    registerAdapter('spy3', () => ({
      type: 'spy3',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, authContext) {
        received.push(authContext.config);
        return {};
      },
    }));
    const connection = store.createConnection({
      name: 'spy3-conn',
      adapterType: 'spy3',
      authMode: 'passthrough',
      config: { endpoint: 'https://example.com/graphql' },
    });
    store.createMapping({ connectionId: connection.id, route: '/spy3/{id}', method: 'GET', operation: {} });

    await engine.handle('GET', '/spy3/1');

    expect(received).toEqual([{ endpoint: 'https://example.com/graphql' }]);
  });
```

Also update the file's `afterEach` to close the db handle (add `db.close()` — `db` isn't currently in scope in this test file, so also update the top of the file):

```ts
let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let engine: GatewayEngine;
```

```ts
beforeEach(() => {
  registerAdapter('mock', () => new MockAdapter());
  dbPath = path.join(os.tmpdir(), `graphtorest-gateway-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  engine = new GatewayEngine(store);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/gateway/GatewayEngine.test.ts`
Expected: FAIL — `authContext.config` is `undefined`, test expects `{ endpoint: ... }`.

- [ ] **Step 3: Widen `AuthContext`**

In `packages/core/src/adapters/Adapter.ts`:

```ts
export interface AuthContext {
  connectionId: string;
  vendorToken?: string;
  authMode?: string;
  config?: Record<string, unknown> | null;
}
```

- [ ] **Step 4: Thread `connection.config` through `GatewayEngine.handle`**

In `packages/core/src/gateway/GatewayEngine.ts`, update the `adapter.execute` call inside `handle`:

```ts
    const raw = await adapter.execute(
      operation,
      params,
      {
        connectionId: connection.id,
        vendorToken: incomingAuth.vendorToken,
        authMode: connection.authMode,
        config: connection.config,
      },
      request
    );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/gateway/GatewayEngine.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/adapters/Adapter.ts packages/core/src/gateway/GatewayEngine.ts packages/core/test/gateway/GatewayEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(core): thread connection config through AuthContext in GatewayEngine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GraphQLHttpClient` — POST over `fetch`, normalize errors

**Files:**
- Create: `packages/core/src/adapters/graphql/GraphQLHttpClient.ts`
- Test: `packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`

**Interfaces:**
- Consumes: `GatewayError` (`../../gateway/errors`, existing).
- Produces: `class GraphQLHttpClient { constructor(endpoint: string, authMode: string, vendorToken: string | undefined); execute(input: { query: string; variables?: Record<string, unknown> }): Promise<unknown> }` — `execute` resolves to the GraphQL response's `data` payload on success, throws `GatewayError` otherwise. `GraphQLAdapter` (Task 6) is the only consumer.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphQLHttpClient } from '../../../src/adapters/graphql/GraphQLHttpClient';
import { GatewayError } from '../../../src/gateway/errors';

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

afterEach(() => {
  nock.cleanAll();
});

describe('GraphQLHttpClient construction', () => {
  it('throws a 501 GatewayError for an unsupported authMode', () => {
    expect(() => new GraphQLHttpClient(ENDPOINT, 'managed', 'token')).toThrow(GatewayError);
    try {
      new GraphQLHttpClient(ENDPOINT, 'managed', 'token');
    } catch (err) {
      expect((err as GatewayError).status).toBe(501);
    }
  });

  it('throws a 401 GatewayError when passthrough has no vendor token', () => {
    expect(() => new GraphQLHttpClient(ENDPOINT, 'passthrough', undefined)).toThrow(GatewayError);
    try {
      new GraphQLHttpClient(ENDPOINT, 'passthrough', undefined);
    } catch (err) {
      expect((err as GatewayError).status).toBe(401);
    }
  });
});

describe('GraphQLHttpClient.execute', () => {
  it('posts {query, variables} with a bearer token and returns data on success', async () => {
    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } })
      .matchHeader('authorization', 'Bearer vendor-token-1')
      .reply(200, { data: { user: { id: '42' } } });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    const result = await client.execute({ query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } });

    expect(result).toEqual({ user: { id: '42' } });
  });

  it('defaults variables to {} when omitted', async () => {
    nock(HOST).post('/graphql', { query: 'query { viewer { id } }', variables: {} }).reply(200, { data: { viewer: { id: '1' } } });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    const result = await client.execute({ query: 'query { viewer { id } }' });

    expect(result).toEqual({ viewer: { id: '1' } });
  });

  it('normalizes a 200-status response with errors[] into a 400 GatewayError', async () => {
    nock(HOST)
      .post('/graphql')
      .reply(200, { errors: [{ message: 'Cannot query field "nope"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({
      status: 400,
      code: 'GRAPHQL_VALIDATION_FAILED',
      message: 'Cannot query field "nope"',
    });
  });

  it('preserves a non-2xx HTTP status from the endpoint', async () => {
    nock(HOST).post('/graphql').reply(503, { errors: [{ message: 'Service unavailable' }] });

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 503 });
  });

  it('normalizes an unreachable endpoint into a 502 GatewayError', async () => {
    nock(HOST).post('/graphql').replyWithError('connection reset');

    const client = new GraphQLHttpClient(ENDPOINT, 'passthrough', 'vendor-token-1');
    await expect(client.execute({ query: 'query { nope }' })).rejects.toMatchObject({ status: 502, code: 'VENDOR_UNREACHABLE' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`
Expected: FAIL with a module-not-found error — `GraphQLHttpClient.ts` doesn't exist yet.

- [ ] **Step 3: Implement `GraphQLHttpClient`**

Create `packages/core/src/adapters/graphql/GraphQLHttpClient.ts`:

```ts
import { GatewayError } from '../../gateway/errors';

export interface GraphQLExecuteInput {
  query: string;
  variables?: Record<string, unknown>;
}

interface GraphQLErrorEntry {
  message: string;
  extensions?: { code?: string };
}

interface GraphQLHttpResponse {
  data?: unknown;
  errors?: GraphQLErrorEntry[];
}

export class GraphQLHttpClient {
  constructor(
    private endpoint: string,
    authMode: string,
    private vendorToken: string | undefined
  ) {
    if (authMode !== 'passthrough') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'GraphQL connections only support authMode "passthrough" until Plan 5 adds managed OAuth',
        501
      );
    }
    if (!vendorToken) {
      throw new GatewayError('MISSING_VENDOR_TOKEN', 'This request requires a vendor access token', 401);
    }
  }

  async execute(input: GraphQLExecuteInput): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.vendorToken}`,
        },
        body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      });
    } catch (err) {
      throw new GatewayError('VENDOR_UNREACHABLE', 'Could not reach the GraphQL endpoint', 502, {
        vendor: 'graphql',
        message: (err as Error).message,
      });
    }

    let body: GraphQLHttpResponse;
    try {
      body = (await response.json()) as GraphQLHttpResponse;
    } catch {
      throw new GatewayError('VENDOR_ERROR', 'GraphQL endpoint returned a non-JSON response', 502, { vendor: 'graphql' });
    }

    if (!response.ok) {
      const firstError = body.errors?.[0];
      throw new GatewayError(
        firstError?.extensions?.code ?? 'VENDOR_ERROR',
        firstError?.message ?? `GraphQL endpoint responded with status ${response.status}`,
        response.status,
        { vendor: 'graphql', body }
      );
    }

    if (body.errors && body.errors.length > 0) {
      const firstError = body.errors[0];
      throw new GatewayError(firstError.extensions?.code ?? 'GRAPHQL_ERROR', firstError.message, 400, {
        vendor: 'graphql',
        errors: body.errors,
      });
    }

    return body.data;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/graphql/GraphQLHttpClient.ts packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add GraphQLHttpClient with fetch-based transport and error normalization

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Introspection query and type-reference utilities

**Files:**
- Create: `packages/core/src/adapters/graphql/introspection.ts`
- Test: `packages/core/test/adapters/graphql/introspection.test.ts`

**Interfaces:**
- Produces: `INTROSPECTION_QUERY: string`; `parseIntrospection(raw: unknown): GraphQLSchemaIntrospection`; `unwrapType(ref: GraphQLTypeRef): UnwrappedType`; `findType(types: GraphQLNamedType[], name: string): GraphQLNamedType | undefined`; `SCALAR_KINDS: Set<string>`; types `GraphQLTypeRef`, `GraphQLField`, `GraphQLFieldArg`, `GraphQLNamedType`, `GraphQLSchemaIntrospection`. Consumed by `GraphQLAdapter.introspect` (Task 6) and `mappingGeneration.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/adapters/graphql/introspection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIntrospection, unwrapType, findType, SCALAR_KINDS, type GraphQLNamedType } from '../../../src/adapters/graphql/introspection';

describe('parseIntrospection', () => {
  it('extracts queryTypeName, mutationTypeName, and types from a raw __schema response', () => {
    const raw = {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: [{ name: 'Query', kind: 'OBJECT', fields: [] }],
      },
    };
    expect(parseIntrospection(raw)).toEqual({
      queryTypeName: 'Query',
      mutationTypeName: 'Mutation',
      types: [{ name: 'Query', kind: 'OBJECT', fields: [] }],
    });
  });

  it('defaults mutationTypeName to null when the schema has no mutations', () => {
    const raw = { __schema: { queryType: { name: 'Query' }, mutationType: null, types: [] } };
    expect(parseIntrospection(raw).mutationTypeName).toBeNull();
  });
});

describe('unwrapType', () => {
  it('unwraps a NON_NULL-wrapped scalar to its named type', () => {
    const ref = { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } };
    expect(unwrapType(ref)).toEqual({ namedType: 'ID', isList: false, isNonNull: true });
  });

  it('unwraps a plain scalar with no wrapping', () => {
    const ref = { kind: 'SCALAR', name: 'String', ofType: null };
    expect(unwrapType(ref)).toEqual({ namedType: 'String', isList: false, isNonNull: false });
  });

  it('detects LIST wrapping', () => {
    const ref = { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'User', ofType: null } };
    expect(unwrapType(ref)).toEqual({ namedType: 'User', isList: true, isNonNull: false });
  });
});

describe('findType', () => {
  it('finds a named type by name', () => {
    const types: GraphQLNamedType[] = [{ name: 'User', kind: 'OBJECT', fields: [] }];
    expect(findType(types, 'User')).toEqual({ name: 'User', kind: 'OBJECT', fields: [] });
  });

  it('returns undefined for an unknown name', () => {
    expect(findType([], 'Nope')).toBeUndefined();
  });
});

describe('SCALAR_KINDS', () => {
  it('contains SCALAR and ENUM', () => {
    expect(SCALAR_KINDS.has('SCALAR')).toBe(true);
    expect(SCALAR_KINDS.has('ENUM')).toBe(true);
    expect(SCALAR_KINDS.has('OBJECT')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/graphql/introspection.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `introspection.ts`**

Create `packages/core/src/adapters/graphql/introspection.ts`:

```ts
export const INTROSPECTION_QUERY = `
  query GraphToRestIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        name
        kind
        fields {
          name
          args { name type { ...TypeRef } }
          type { ...TypeRef }
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

export interface GraphQLTypeRef {
  kind: string;
  name: string | null;
  ofType: GraphQLTypeRef | null;
}

export interface GraphQLFieldArg {
  name: string;
  type: GraphQLTypeRef;
}

export interface GraphQLField {
  name: string;
  args: GraphQLFieldArg[];
  type: GraphQLTypeRef;
}

export interface GraphQLNamedType {
  name: string;
  kind: string;
  fields: GraphQLField[] | null;
}

export interface GraphQLSchemaIntrospection {
  queryTypeName: string | null;
  mutationTypeName: string | null;
  types: GraphQLNamedType[];
}

interface RawIntrospectionResponse {
  __schema: {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    types: GraphQLNamedType[];
  };
}

export function parseIntrospection(raw: unknown): GraphQLSchemaIntrospection {
  const schema = (raw as RawIntrospectionResponse).__schema;
  return {
    queryTypeName: schema.queryType?.name ?? null,
    mutationTypeName: schema.mutationType?.name ?? null,
    types: schema.types ?? [],
  };
}

export interface UnwrappedType {
  namedType: string | null;
  isList: boolean;
  isNonNull: boolean;
}

// Coarse nullability check: true if NON_NULL appears anywhere in the wrapper chain
// (not just outermost). Sufficient for the single scalar-arg case generateMappings uses.
export function unwrapType(ref: GraphQLTypeRef): UnwrappedType {
  let current: GraphQLTypeRef | null = ref;
  let isList = false;
  let isNonNull = false;
  let namedType: string | null = null;
  while (current) {
    if (current.kind === 'LIST') isList = true;
    if (current.kind === 'NON_NULL') isNonNull = true;
    if (current.name) {
      namedType = current.name;
      break;
    }
    current = current.ofType;
  }
  return { namedType, isList, isNonNull };
}

export function findType(types: GraphQLNamedType[], name: string): GraphQLNamedType | undefined {
  return types.find((t) => t.name === name);
}

export const SCALAR_KINDS = new Set(['SCALAR', 'ENUM']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/adapters/graphql/introspection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/graphql/introspection.ts packages/core/test/adapters/graphql/introspection.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add GraphQL __schema introspection query and type-unwrapping utilities

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Schema-driven `generateMappings` (mapping generation logic)

**Files:**
- Create: `packages/core/src/adapters/graphql/mappingGeneration.ts`
- Test: `packages/core/test/adapters/graphql/mappingGeneration.test.ts`

**Interfaces:**
- Consumes: `GraphQLSchemaIntrospection`, `GraphQLField`, `GraphQLNamedType`, `unwrapType`, `findType`, `SCALAR_KINDS` (Task 4); `MappingDraft` (`../Adapter`, existing).
- Produces: `generateMappingsFromIntrospection(introspection: GraphQLSchemaIntrospection): MappingDraft[]`. Consumed by `GraphQLAdapter.generateMappings` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/adapters/graphql/mappingGeneration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateMappingsFromIntrospection } from '../../../src/adapters/graphql/mappingGeneration';
import type { GraphQLSchemaIntrospection } from '../../../src/adapters/graphql/introspection';

const SCHEMA: GraphQLSchemaIntrospection = {
  queryTypeName: 'Query',
  mutationTypeName: null,
  types: [
    {
      name: 'Query',
      kind: 'OBJECT',
      fields: [
        {
          name: 'user',
          args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
          type: { kind: 'OBJECT', name: 'User', ofType: null },
        },
        {
          name: 'count',
          args: [],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
        {
          name: 'viewer',
          args: [],
          type: { kind: 'OBJECT', name: 'OnlyNested', ofType: null },
        },
        {
          name: 'search',
          args: [
            { name: 'query', type: { kind: 'SCALAR', name: 'String', ofType: null } },
            { name: 'limit', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
          ],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
        {
          name: 'usersByTeam',
          args: [{ name: 'teamIds', type: { kind: 'LIST', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
          type: { kind: 'SCALAR', name: 'Int', ofType: null },
        },
      ],
    },
    {
      name: 'User',
      kind: 'OBJECT',
      fields: [
        { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID', ofType: null } },
        { name: 'displayName', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
        { name: 'address', args: [], type: { kind: 'OBJECT', name: 'Address', ofType: null } },
      ],
    },
    { name: 'Address', kind: 'OBJECT', fields: [{ name: 'city', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }] },
    { name: 'OnlyNested', kind: 'OBJECT', fields: [{ name: 'address', args: [], type: { kind: 'OBJECT', name: 'Address', ofType: null } }] },
    { name: 'ID', kind: 'SCALAR', fields: null },
    { name: 'String', kind: 'SCALAR', fields: null },
    { name: 'Int', kind: 'SCALAR', fields: null },
  ],
};

describe('generateMappingsFromIntrospection', () => {
  it('generates a GET mapping with a path param for a single scalar-arg field, selecting only scalar sub-fields', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/user/{id}',
      method: 'GET',
      operation: {
        query: 'query($id: ID!) { user(id: $id) { id displayName } }',
        variables: { id: '$params.id' },
      },
      responseTemplate: { id: '$.user.id', displayName: '$.user.displayName' },
    });
  });

  it('generates a GET mapping with no args and no response template for a scalar-returning field', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/count',
      method: 'GET',
      operation: { query: 'query { count }' },
    });
  });

  it('skips a field whose return type has no scalar sub-fields at all', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('viewer'))).toBe(false);
  });

  it('skips a field with more than one argument', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('search'))).toBe(false);
  });

  it('skips a field whose single argument is list-typed', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('usersByTeam'))).toBe(false);
  });

  it('returns an empty array when the schema has no query type', () => {
    expect(generateMappingsFromIntrospection({ queryTypeName: null, mutationTypeName: null, types: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/graphql/mappingGeneration.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `mappingGeneration.ts`**

Create `packages/core/src/adapters/graphql/mappingGeneration.ts`:

```ts
import type { MappingDraft } from '../Adapter';
import {
  type GraphQLSchemaIntrospection,
  type GraphQLField,
  type GraphQLNamedType,
  unwrapType,
  findType,
  SCALAR_KINDS,
} from './introspection';

interface ScalarSelection {
  text: string;
  fieldNames: string[];
}

export function generateMappingsFromIntrospection(introspection: GraphQLSchemaIntrospection): MappingDraft[] {
  if (!introspection.queryTypeName) return [];
  const queryType = findType(introspection.types, introspection.queryTypeName);
  if (!queryType?.fields) return [];

  const drafts: MappingDraft[] = [];
  for (const field of queryType.fields) {
    const draft = buildMappingDraft(field, introspection.types);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function buildMappingDraft(field: GraphQLField, types: GraphQLNamedType[]): MappingDraft | null {
  if (field.args.length > 1) return null;

  const selection = buildScalarSelection(field, types);
  if (!selection) return null;

  const responseTemplate =
    selection.fieldNames.length > 0
      ? Object.fromEntries(selection.fieldNames.map((name) => [name, `$.${field.name}.${name}`]))
      : undefined;

  if (field.args.length === 0) {
    return {
      route: `/graphql/${field.name}`,
      method: 'GET',
      operation: { query: `query { ${field.name}${selection.text} }` },
      responseTemplate,
    };
  }

  const arg = field.args[0];
  const argType = unwrapType(arg.type);
  if (!argType.namedType || argType.isList) return null;

  const gqlType = `${argType.namedType}${argType.isNonNull ? '!' : ''}`;
  return {
    route: `/graphql/${field.name}/{${arg.name}}`,
    method: 'GET',
    operation: {
      query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name})${selection.text} }`,
      variables: { [arg.name]: `$params.${arg.name}` },
    },
    responseTemplate,
  };
}

function buildScalarSelection(field: GraphQLField, types: GraphQLNamedType[]): ScalarSelection | null {
  const returnType = unwrapType(field.type);
  if (!returnType.namedType) return null;
  if (SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types))) {
    return { text: '', fieldNames: [] };
  }

  const named = findType(types, returnType.namedType);
  const scalarFields = (named?.fields ?? []).filter((f) => {
    const fieldReturn = unwrapType(f.type);
    return fieldReturn.namedType !== null && SCALAR_KINDS.has(scalarKindOf(fieldReturn.namedType, types));
  });
  if (scalarFields.length === 0) return null;

  const fieldNames = scalarFields.map((f) => f.name);
  return { text: ` { ${fieldNames.join(' ')} }`, fieldNames };
}

function scalarKindOf(typeName: string, types: GraphQLNamedType[]): string {
  return findType(types, typeName)?.kind ?? '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/adapters/graphql/mappingGeneration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/graphql/mappingGeneration.ts packages/core/test/adapters/graphql/mappingGeneration.test.ts
git commit -m "$(cat <<'EOF'
feat(core): generate REST mapping drafts purely from GraphQL schema introspection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `GraphQLAdapter` — wire it together and register it

**Files:**
- Create: `packages/core/src/adapters/graphql/GraphQLAdapter.ts`
- Modify: `packages/core/src/adapters/defaults.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/adapters/graphql/GraphQLAdapter.test.ts`

**Interfaces:**
- Consumes: `GraphQLHttpClient` (Task 3), `INTROSPECTION_QUERY`/`parseIntrospection`/`GraphQLSchemaIntrospection` (Task 4), `generateMappingsFromIntrospection` (Task 5), `Adapter`/`AuthContext`/`MappingDraft`/`RequestContext` (`../Adapter`).
- Produces: `class GraphQLAdapter implements Adapter { readonly type = 'graphql' }`, registered in the adapter registry under `'graphql'` and exported from `@graphtorest/core`. Consumed by `GatewayEngine` (via the registry) and directly by the Task 8 integration test.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/adapters/graphql/GraphQLAdapter.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphQLAdapter } from '../../../src/adapters/graphql/GraphQLAdapter';
import { GatewayError } from '../../../src/gateway/errors';
import type { AuthContext } from '../../../src/adapters/Adapter';

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

afterEach(() => {
  nock.cleanAll();
});

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { connectionId: 'c1', authMode: 'passthrough', vendorToken: 'vendor-token-1', config: { endpoint: ENDPOINT }, ...overrides };
}

describe('GraphQLAdapter.introspect', () => {
  it('sends the standard introspection query and returns the parsed schema', async () => {
    nock(HOST)
      .post('/graphql')
      .reply(200, {
        data: { __schema: { queryType: { name: 'Query' }, mutationType: null, types: [{ name: 'Query', kind: 'OBJECT', fields: [] }] } },
      });

    const adapter = new GraphQLAdapter();
    const result = await adapter.introspect(authContext());

    expect(result).toEqual({ queryTypeName: 'Query', mutationTypeName: null, types: [{ name: 'Query', kind: 'OBJECT', fields: [] }] });
  });
});

describe('GraphQLAdapter.generateMappings', () => {
  it('delegates to generateMappingsFromIntrospection', async () => {
    const adapter = new GraphQLAdapter();
    const introspection = {
      queryTypeName: 'Query',
      mutationTypeName: null,
      types: [{ name: 'Query', kind: 'OBJECT', fields: [{ name: 'count', args: [], type: { kind: 'SCALAR', name: 'Int', ofType: null } }] }],
    };
    const drafts = await adapter.generateMappings(introspection);
    expect(drafts).toEqual([{ route: '/graphql/count', method: 'GET', operation: { query: 'query { count }' } }]);
  });
});

describe('GraphQLAdapter.execute', () => {
  it('posts the operation query/variables and returns the client data', async () => {
    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } })
      .reply(200, { data: { user: { id: '42' } } });

    const adapter = new GraphQLAdapter();
    const result = await adapter.execute(
      { query: 'query($id: ID!) { user(id: $id) { id } }', variables: { id: '42' } },
      { id: '42' },
      authContext()
    );

    expect(result).toEqual({ user: { id: '42' } });
  });

  it('throws a 500 GatewayError when the connection has no config.endpoint', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({ query: 'query { x }' }, {}, authContext({ config: null }))).rejects.toMatchObject({
      status: 500,
      code: 'INVALID_CONFIGURATION',
    });
  });

  it('throws a 500 GatewayError when the operation has no query string', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({}, {}, authContext())).rejects.toMatchObject({ status: 500, code: 'UNSUPPORTED_OPERATION' });
  });

  it('is an instance of GatewayError for the missing-query case', async () => {
    const adapter = new GraphQLAdapter();
    await expect(adapter.execute({}, {}, authContext())).rejects.toBeInstanceOf(GatewayError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/graphql/GraphQLAdapter.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `GraphQLAdapter`**

Create `packages/core/src/adapters/graphql/GraphQLAdapter.ts`:

```ts
import type { Adapter, AuthContext, MappingDraft, RequestContext } from '../Adapter';
import { GatewayError } from '../../gateway/errors';
import { GraphQLHttpClient } from './GraphQLHttpClient';
import { INTROSPECTION_QUERY, parseIntrospection, type GraphQLSchemaIntrospection } from './introspection';
import { generateMappingsFromIntrospection } from './mappingGeneration';

export class GraphQLAdapter implements Adapter {
  readonly type = 'graphql';

  async introspect(authContext: AuthContext): Promise<GraphQLSchemaIntrospection> {
    const client = this.clientFor(authContext);
    const raw = await client.execute({ query: INTROSPECTION_QUERY });
    return parseIntrospection(raw);
  }

  async generateMappings(introspection: unknown): Promise<MappingDraft[]> {
    return generateMappingsFromIntrospection(introspection as GraphQLSchemaIntrospection);
  }

  async execute(
    operation: Record<string, unknown>,
    _params: Record<string, string>,
    authContext: AuthContext,
    _request: RequestContext = {}
  ): Promise<unknown> {
    const client = this.clientFor(authContext);
    const query = operation.query as string | undefined;
    if (!query) {
      throw new GatewayError('UNSUPPORTED_OPERATION', 'GraphQL operation is missing a "query" string', 500);
    }
    return client.execute({ query, variables: operation.variables as Record<string, unknown> | undefined });
  }

  private clientFor(authContext: AuthContext): GraphQLHttpClient {
    const endpoint = authContext.config?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new GatewayError('INVALID_CONFIGURATION', 'GraphQL connections require a config.endpoint URL', 500);
    }
    return new GraphQLHttpClient(endpoint, authContext.authMode ?? 'passthrough', authContext.vendorToken);
  }
}
```

Note: `client.execute({ query: INTROSPECTION_QUERY })` returns `body.data`, which for the introspection query (whose single top-level field is `__schema`) is already `{ __schema: {...} }` — exactly the shape `parseIntrospection` expects. Do not re-wrap it.

- [ ] **Step 4: Register the adapter and export it**

In `packages/core/src/adapters/defaults.ts`:

```ts
import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';
import { MicrosoftGraphAdapter } from './microsoftGraph/MicrosoftGraphAdapter';
import { GraphQLAdapter } from './graphql/GraphQLAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
  registerAdapter('microsoft-graph', () => new MicrosoftGraphAdapter());
  registerAdapter('graphql', () => new GraphQLAdapter());
}
```

In `packages/core/src/index.ts`, add alongside the existing `MicrosoftGraphAdapter` export:

```ts
export { GraphQLAdapter } from './adapters/graphql/GraphQLAdapter';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/adapters/graphql/GraphQLAdapter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/adapters/graphql/GraphQLAdapter.ts packages/core/src/adapters/defaults.ts packages/core/src/index.ts packages/core/test/adapters/graphql/GraphQLAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add GraphQLAdapter and register it as a default adapter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Admin API and CLI accept a connection `config`

**Files:**
- Modify: `apps/server/src/routers/adminRouter.ts`
- Modify: `apps/cli/src/commands/connectionCreate.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/server/test/integration.test.ts`
- Test: `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `MappingStore.createConnection` with `config` (Task 1).
- Produces: `POST /admin/connections` accepts an optional `config` body field; `gtr connection-create` accepts an optional `--config <json>` flag. Neither changes any existing required-field behavior.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/integration.test.ts`, inside the `describe('server integration', ...)` block:

```ts
  it('round-trips a connection config object through the admin API', async () => {
    const createRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'graphql-conn', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: 'https://api.example.com/graphql' } });

    expect(createRes.status).toBe(201);
    expect(createRes.body.config).toEqual({ endpoint: 'https://api.example.com/graphql' });

    const listRes = await request(app).get('/admin/connections');
    const found = listRes.body.find((c: { id: string }) => c.id === createRes.body.id);
    expect(found.config).toEqual({ endpoint: 'https://api.example.com/graphql' });
  });

  it('defaults connection config to null when omitted from the admin API', async () => {
    const createRes = await request(app).post('/admin/connections').send({ name: 'no-config-conn', adapterType: 'mock', authMode: 'passthrough' });
    expect(createRes.body.config).toBeNull();
  });
```

Add to `apps/cli/test/commands.test.ts`, inside the `describe('CLI embedded commands', ...)` block:

```ts
  it('connectionCreate persists an optional config object', () => {
    const store = freshStore();
    const created = connectionCreate(store, {
      name: 'graphql-conn',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.example.com/graphql' },
    });
    expect(store.getConnection(created.id)?.config).toEqual({ endpoint: 'https://api.example.com/graphql' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/integration.test.ts apps/cli/test/commands.test.ts`
Expected: FAIL — `config` in the request body is currently silently dropped (`adminRouter.ts` destructures only `name, adapterType, authMode`); `connectionCreate` currently only accepts `name, adapterType, authMode` in its type signature, so the new test won't type-check today.

- [ ] **Step 3: Update `adminRouter.ts`**

In `apps/server/src/routers/adminRouter.ts`, update the `POST /connections` handler:

```ts
  router.post('/connections', (req, res) => {
    const { name, adapterType, authMode, config } = req.body ?? {};
    if (!name || !adapterType || !authMode) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name, adapterType, authMode required', details: {} } });
      return;
    }
    try {
      res.status(201).json(mappingStore.createConnection({ name, adapterType, authMode, config }));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A connection with this name already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });
```

- [ ] **Step 4: Update CLI `connectionCreate` and `index.ts`**

In `apps/cli/src/commands/connectionCreate.ts`:

```ts
import type { MappingStore, ConnectionRecord } from '@graphtorest/core';

export function connectionCreate(
  store: MappingStore,
  args: { name: string; adapterType: string; authMode: string; config?: Record<string, unknown> | null }
): ConnectionRecord {
  return store.createConnection(args);
}
```

In `apps/cli/src/index.ts`, update the `connection-create` command:

```ts
program
  .command('connection-create')
  .requiredOption('--name <name>')
  .requiredOption('--adapter-type <type>')
  .requiredOption('--auth-mode <mode>')
  .option('--config <json>', 'JSON-encoded adapter config, e.g. a GraphQL endpoint URL')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = connectionCreate(store, {
      name: opts.name,
      adapterType: opts.adapterType,
      authMode: opts.authMode,
      config: opts.config ? JSON.parse(opts.config) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/integration.test.ts apps/cli/test/commands.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routers/adminRouter.ts apps/cli/src/commands/connectionCreate.ts apps/cli/src/index.ts apps/server/test/integration.test.ts apps/cli/test/commands.test.ts
git commit -m "$(cat <<'EOF'
feat(server,cli): accept an optional connection config via admin API and CLI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end integration test through the real Express app

**Files:**
- Create: `apps/server/test/graphql.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7 (`createApp`, `registerDefaultAdapters`, `createAdapter`, the admin/api routers, `GraphQLAdapter`).

- [ ] **Step 1: Write the test**

Create `apps/server/test/graphql.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, createAdapter } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let app: ReturnType<typeof createApp>;

const HOST = 'https://api.example-graphql-test.com';
const ENDPOINT = `${HOST}/graphql`;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-graphql-${Date.now()}-${Math.random()}.db`);
  const db = openDb(dbPath);
  const mappingStore = new MappingStore(db);
  const gatewayEngine = new GatewayEngine(mappingStore);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true });
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedGraphQLConnection() {
  const connectionRes = await request(app)
    .post('/admin/connections')
    .send({ name: 'graphql-test', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: ENDPOINT } });
  const apiKeyRes = await request(app).post('/admin/api-keys').send({});
  return { connectionId: connectionRes.body.id as string, apiKey: apiKeyRes.body.plaintext as string };
}

describe('GraphQL adapter end-to-end', () => {
  it('executes a hand-written query mapping and shapes the response by template', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await request(app).post('/admin/mappings').send({
      connectionId,
      route: '/gh/users/{id}',
      method: 'GET',
      operation: { query: 'query($id: ID!) { user(id: $id) { id name } }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.user.id', name: '$.user.name' },
    });

    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id name } }', variables: { id: '42' } })
      .reply(200, { data: { user: { id: '42', name: 'Ada Lovelace' } } });

    const res = await request(app)
      .get('/api/gh/users/42')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', name: 'Ada Lovelace' });
  });

  it('normalizes a 200-status errors[] response to a 400 GatewayError', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await request(app).post('/admin/mappings').send({ connectionId, route: '/gh/broken', method: 'GET', operation: { query: 'query { broken }' } });

    nock(HOST)
      .post('/graphql')
      .reply(200, { errors: [{ message: 'Cannot query field "broken"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });

    const res = await request(app).get('/api/gh/broken').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('preserves a non-2xx HTTP status from the GraphQL endpoint', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await request(app).post('/admin/mappings').send({ connectionId, route: '/gh/down', method: 'GET', operation: { query: 'query { down }' } });

    nock(HOST).post('/graphql').reply(503, { errors: [{ message: 'Service unavailable' }] });

    const res = await request(app).get('/api/gh/down').set('Authorization', `Bearer ${apiKey}`).set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(503);
  });

  it('returns a normalized 401 when no vendor token is supplied', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();
    await request(app).post('/admin/mappings').send({ connectionId, route: '/gh/needs-token', method: 'GET', operation: { query: 'query { viewer }' } });

    const res = await request(app).get('/api/gh/needs-token').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_VENDOR_TOKEN');
  });

  it('generates a working mapping from live schema introspection and serves it end-to-end', async () => {
    const { connectionId, apiKey } = await seedGraphQLConnection();

    nock(HOST)
      .post('/graphql')
      .reply(200, {
        data: {
          __schema: {
            queryType: { name: 'Query' },
            mutationType: null,
            types: [
              {
                name: 'Query',
                kind: 'OBJECT',
                fields: [
                  {
                    name: 'user',
                    args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } } }],
                    type: { kind: 'OBJECT', name: 'User', ofType: null },
                  },
                ],
              },
              {
                name: 'User',
                kind: 'OBJECT',
                fields: [
                  { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID', ofType: null } },
                  { name: 'displayName', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
                ],
              },
              { name: 'ID', kind: 'SCALAR', fields: null },
              { name: 'String', kind: 'SCALAR', fields: null },
            ],
          },
        },
      });

    const adapter = createAdapter('graphql');
    const introspection = await adapter.introspect({ connectionId, authMode: 'passthrough', vendorToken: 'vendor-token-1', config: { endpoint: ENDPOINT } });
    const drafts = await adapter.generateMappings(introspection);

    expect(drafts).toEqual([
      {
        route: '/graphql/user/{id}',
        method: 'GET',
        operation: { query: 'query($id: ID!) { user(id: $id) { id displayName } }', variables: { id: '$params.id' } },
        responseTemplate: { id: '$.user.id', displayName: '$.user.displayName' },
      },
    ]);

    for (const draft of drafts) {
      const created = await request(app).post('/admin/mappings').send({ connectionId, ...draft });
      expect(created.status).toBe(201);
    }

    nock(HOST)
      .post('/graphql', { query: 'query($id: ID!) { user(id: $id) { id displayName } }', variables: { id: '99' } })
      .reply(200, { data: { user: { id: '99', displayName: 'Grace Hopper' } } });

    const res = await request(app)
      .get('/api/graphql/user/99')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '99', displayName: 'Grace Hopper' });
  });
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `npx vitest run apps/server/test/graphql.integration.test.ts`
Expected: Since Tasks 1–7 are already implemented by this point in the plan, this validates the full stack together for the first time. If anything fails, use the failure to find the first broken link (adapter not registered, header not read, nock matcher mismatch, route collision) rather than assuming the design is wrong — check the nock matcher against what `GraphQLHttpClient` actually sends first.

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run apps/server/test/graphql.integration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/graphql.integration.test.ts
git commit -m "$(cat <<'EOF'
test(server): add end-to-end GraphQL adapter integration test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Full workspace build and test verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: exits 0 — every test file across `packages/core`, `apps/server`, and `apps/cli` passes, including all Plan 1/Plan 2 tests (unmodified behavior) and every test added in Tasks 1–8.

- [ ] **Step 2: Run the full workspace build**

Run: `npm run build`
Expected: exits 0 — `packages/core/dist`, `apps/server/dist`, `apps/cli/dist` compile cleanly with the widened `ConnectionRecord`/`AuthContext` types and the new `adapters/graphql/` module.

- [ ] **Step 3: Confirm the adapter registry now reports all three types**

Run: `node -e "const {registerDefaultAdapters, listAdapterTypes} = require('./packages/core/dist'); registerDefaultAdapters(); console.log(listAdapterTypes());"`
Expected: prints `[ 'mock', 'microsoft-graph', 'graphql' ]`.

- [ ] **Step 4: Commit (only if Steps 1–3 required any fixes; otherwise skip — nothing to commit)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: verify Plan 3 workspace build and full test suite

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

# GraphToRest Plan 2: Microsoft Graph Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real `MicrosoftGraphAdapter` on top of `@microsoft/microsoft-graph-client`, register it alongside `MockAdapter` in the Plan 1 registry, and ship curated default REST mappings covering users/groups/mail/calendar/drive/teams — including `$select`/`$filter`/`$expand` translation, normalized cursor pagination (spec §6.2), a delta-query route, and one internally-batched route — so a developer can create a `microsoft-graph` connection and call real Microsoft Graph data through GraphToRest's REST surface.

**Architecture:** Widen `Adapter.execute`/`GatewayEngine.handle` (currently only carry `params`) with an additive `RequestContext { query?, body? }` and an `authMode` field on `AuthContext`, threaded from `apps/server`'s `apiRouter` down to the adapter — this is the query-string/body channel Plan 1's final review flagged as missing. `MicrosoftGraphAdapter` is built from three collaborators: `odata.ts` (REST query ↔ OData param translation, opaque cursor encode/decode, `{param}` path interpolation), `GraphHttpClient` (thin wrapper over `@microsoft/microsoft-graph-client`'s `Client` — `get`/`list`/`batch`, normalizing both pagination and vendor errors), and a static curated `defaultMappings.ts` table the adapter serves from `generateMappings()` regardless of introspection input (per spec §4.1, these are hand-verified, not schema-derived guesses). Curated routes live under an `/msgraph/*` prefix because `mappings` has a global `UNIQUE(method, route)` constraint (Plan 1) — namespacing by vendor avoids collisions with other connections' routes. Only `authMode: "passthrough"` is implemented; `"managed"` (encrypted vendor credentials, MSAL token acquisition/refresh) is explicitly Plan 5's scope per the roadmap, so the adapter rejects it with a clear `501`.

**Tech Stack:** `@microsoft/microsoft-graph-client` (no MSAL yet — see Global Constraints), `nock` for intercepting the client's HTTP calls in tests (it calls Node's global `fetch` directly with no other indirection, which `nock` 14 intercepts natively).

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md` §4.1 (adapter), §4.3 (registry), §6.1 (error normalization), §6.2 (pagination) — see also `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md` for what surrounding plans cover, and `docs/superpowers/plans/2026-09-17-graphtorest-01-foundation.md` for the code this plan extends.

## Global Constraints

- Node.js + TypeScript throughout (spec §11); same tsconfig/workspace conventions as Plan 1 — no new build tooling.
- Error responses stay `{ "error": { "code": "string", "message": "string", "details": {} } }` with an appropriate status (spec §6.1) — Microsoft Graph errors are normalized into `GatewayError` at the `GraphHttpClient` boundary so every later layer (GatewayEngine, apiRouter) is unchanged.
- Pagination is `?limit=&cursor=` request / `{ "data": [...], "nextCursor": "..." }` response (spec §6.2). The **adapter** does this translation (spec: "the adapter is responsible for translating to/from its vendor's native pagination mechanism") — `GatewayEngine` does not need pagination-aware code.
- `$select`/`$filter`/`$expand` (spec §4.1) map 1:1 from REST query params of the same name (`?select=&filter=&expand=`) to Graph's `$select`/`$filter`/`$expand` — this exact naming is this plan's chosen convention since the spec doesn't pin one down; keep it consistent if a later plan (GraphQL adapter, Plan 3) needs the same params.
- Vendor-token passthrough (spec §7.2, "developer supplies both the proxy API key... and their vendor token") needs a header; this plan defines `X-Vendor-Token: <token>` (distinct from `Authorization`, which always carries the proxy API key). Record this convention for Plan 3 to reuse.
- **Only `authMode: "passthrough"` is implemented for Microsoft Graph in this plan.** `"managed"` mode (encrypted-at-rest credentials, MSAL client-credentials/auth-code flow, token refresh — spec §7.1) is Plan 5's scope per the roadmap; `MicrosoftGraphAdapter`/`GraphHttpClient` reject `authMode: "managed"` with a `501` rather than half-implementing it. Do not add `@azure/msal-node` in this plan — it has no caller until Plan 5.
- Curated default mappings live under the `/msgraph/*` route prefix (see Architecture) — this is a deliberate namespacing decision, not a spec requirement; keep using it for any curated mapping this plan adds.
- The curated mapping table is a **representative** slice per resource category (spec: "users, groups, mail, calendar, drive/files, teams"), not an exhaustive vendor catalog — broadening it later is low-risk, additive work for whoever picks it up next; don't block this plan on covering every Graph resource.
- Tests intercept HTTP via `nock` against `https://graph.microsoft.com` (the client's fixed base host). If a step's nock matcher doesn't match what the library actually sends on the wire (exact `$select` value formatting, header casing, etc.), adjust the matcher to what you observe — the behavior under test is the app's normalized status/body, not the client's exact wire format.

---

## File Structure

```
packages/core/
  package.json                                      # +@microsoft/microsoft-graph-client dep, +nock devDep (Task 3)
  src/
    adapters/
      Adapter.ts                                      # +RequestContext, +AuthContext.authMode (Task 1)
      registry.ts                                      # +listAdapterTypes/clearAdapters (Task 1)
      defaults.ts                                       # +register 'microsoft-graph' (Task 5)
      microsoftGraph/
        odata.ts                                        # normalizeRequestQuery, encode/decodeCursor, interpolatePath (Task 2)
        GraphHttpClient.ts                              # get/list/batch + error normalization (Task 3)
        defaultMappings.ts                              # curated MappingDraft[] table (Task 4)
        MicrosoftGraphAdapter.ts                        # Adapter impl dispatching on operation.kind (Task 5)
    gateway/
      GatewayEngine.ts                                  # handle() gains RequestContext param, AuthContext.authMode (Task 1)
    openapi/
      OpenApiGenerator.ts                               # +query params for list/get operation kinds (Task 6)
    index.ts                                            # +new exports (Task 7)
  test/
    adapters/
      registry.test.ts                                  # +listAdapterTypes/clearAdapters tests (Task 1)
      microsoftGraph/
        odata.test.ts                                    # Task 2
        GraphHttpClient.test.ts                           # Task 3
        defaultMappings.test.ts                           # Task 4
        MicrosoftGraphAdapter.test.ts                     # Task 5
    gateway/
      GatewayEngine.test.ts                              # +request-context threading tests (Task 1)
    openapi/
      OpenApiGenerator.test.ts                            # +list/get query-param tests (Task 6)

apps/server/
  package.json                                          # +nock devDep (Task 8)
  src/routers/apiRouter.ts                                # +vendor-token header, query/body threading (Task 1)
  test/
    integration.test.ts                                   # +request-context forwarding test (Task 1)
    microsoftGraph.integration.test.ts                     # end-to-end nock-backed test (Task 8)
```

---

### Task 1: Widen the request-context channel through Adapter → GatewayEngine → apiRouter

**Files:**
- Modify: `packages/core/src/adapters/Adapter.ts`
- Modify: `packages/core/src/adapters/registry.ts`
- Modify: `packages/core/src/gateway/GatewayEngine.ts`
- Modify: `apps/server/src/routers/apiRouter.ts`
- Test: `packages/core/test/adapters/registry.test.ts` (add cases)
- Test: `packages/core/test/gateway/GatewayEngine.test.ts` (add cases)
- Test: `apps/server/test/integration.test.ts` (add a case)

**Interfaces:**
- Consumes: existing `Adapter`, `AuthContext`, `GatewayEngine`, `MappingStore` from Plan 1 (unchanged names, widened shapes below).
- Produces: `interface RequestContext { query?: Record<string, string>; body?: unknown }`; `AuthContext` gains `authMode?: string`; `Adapter.execute` gains an optional 4th param `request?: RequestContext`; `listAdapterTypes(): string[]`; `clearAdapters(): void`; `GatewayEngine.handle(method, path, incomingAuth?, request?: RequestContext): Promise<unknown>` now threads `request` to `adapter.execute` and `connection.authMode` into `authContext.authMode`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/adapters/registry.test.ts` (below the existing `describe` block's other `it`s, inside `describe('adapter registry', ...)`):

```ts
  it('lists all registered adapter types', () => {
    registerAdapter('fake2', () => new FakeAdapter());
    expect(listAdapterTypes()).toContain('fake');
    expect(listAdapterTypes()).toContain('fake2');
  });

  it('clears all registered adapters', () => {
    clearAdapters();
    expect(listAdapterTypes()).toEqual([]);
    expect(() => createAdapter('fake')).toThrow('Unknown adapter type: fake');
  });
```

And widen its import line to:

```ts
import { registerAdapter, createAdapter, listAdapterTypes, clearAdapters } from '../../src/adapters/registry';
```

Add to `packages/core/test/gateway/GatewayEngine.test.ts` (a new `describe` block, after the existing `describe('GatewayEngine.handle', ...)` block):

```ts
describe('GatewayEngine.handle request context', () => {
  it('passes the request context (query, body) through to the adapter', async () => {
    const received: unknown[] = [];
    registerAdapter('spy', () => ({
      type: 'spy',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, _authContext, request) {
        received.push(request);
        return {};
      },
    }));
    const connection = store.createConnection({ name: 'spy-conn', adapterType: 'spy', authMode: 'passthrough' });
    store.createMapping({ connectionId: connection.id, route: '/spy/{id}', method: 'GET', operation: {} });

    await engine.handle('GET', '/spy/1', {}, { query: { select: 'id' }, body: { x: 1 } });

    expect(received).toEqual([{ query: { select: 'id' }, body: { x: 1 } }]);
  });

  it('passes the connection authMode through the auth context', async () => {
    const received: unknown[] = [];
    registerAdapter('spy2', () => ({
      type: 'spy2',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, _params, authContext) {
        received.push(authContext.authMode);
        return {};
      },
    }));
    const connection = store.createConnection({ name: 'spy2-conn', adapterType: 'spy2', authMode: 'managed' });
    store.createMapping({ connectionId: connection.id, route: '/spy2/{id}', method: 'GET', operation: {} });

    await engine.handle('GET', '/spy2/1');

    expect(received).toEqual(['managed']);
  });
});
```

Add to `apps/server/test/integration.test.ts` — widen the import line to include `registerAdapter`:

```ts
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters, registerAdapter } from '@graphtorest/core';
```

and add a new `it` inside `describe('server integration', ...)`:

```ts
  it('forwards query params and the vendor token header to the adapter', async () => {
    let received: any = null;
    registerAdapter('spy', () => ({
      type: 'spy',
      async introspect() {
        return {};
      },
      async generateMappings() {
        return [];
      },
      async execute(_operation, params, authContext, request) {
        received = { params, authContext, request };
        return { ok: true };
      },
    }));
    const connectionRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'spy-conn', adapterType: 'spy', authMode: 'passthrough' });
    await request(app)
      .post('/admin/mappings')
      .send({ connectionId: connectionRes.body.id, route: '/spy/{id}', method: 'GET', operation: { kind: 'noop' } });
    const apiKeyRes = await request(app).post('/admin/api-keys').send({});

    const res = await request(app)
      .get('/api/spy/7?select=id,name')
      .set('Authorization', `Bearer ${apiKeyRes.body.plaintext}`)
      .set('X-Vendor-Token', 'vendor-abc');

    expect(res.status).toBe(200);
    expect(received.params).toEqual({ id: '7' });
    expect(received.authContext.vendorToken).toBe('vendor-abc');
    expect(received.request.query).toEqual({ select: 'id,name' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/adapters/registry.test.ts packages/core/test/gateway/GatewayEngine.test.ts apps/server/test/integration.test.ts`
Expected: FAIL — `listAdapterTypes`/`clearAdapters` don't exist; `request`/`authContext.authMode` are `undefined` where tests expect values; the new integration test gets a 401/404 because `X-Vendor-Token` isn't read yet.

- [ ] **Step 3: Widen `Adapter.ts`**

`packages/core/src/adapters/Adapter.ts`:
```ts
export interface AuthContext {
  connectionId: string;
  vendorToken?: string;
  authMode?: string;
}

export interface RequestContext {
  query?: Record<string, string>;
  body?: unknown;
}

export interface MappingDraft {
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
}

export interface Adapter {
  readonly type: string;
  introspect(authContext: AuthContext): Promise<unknown>;
  generateMappings(introspection: unknown): Promise<MappingDraft[]>;
  execute(
    operation: Record<string, unknown>,
    params: Record<string, string>,
    authContext: AuthContext,
    request?: RequestContext
  ): Promise<unknown>;
}
```

- [ ] **Step 4: Add registry enumeration/reset helpers**

`packages/core/src/adapters/registry.ts`:
```ts
import type { Adapter } from './Adapter';

const registry = new Map<string, () => Adapter>();

export function registerAdapter(type: string, factory: () => Adapter): void {
  registry.set(type, factory);
}

export function createAdapter(type: string): Adapter {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return factory();
}

export function listAdapterTypes(): string[] {
  return [...registry.keys()];
}

export function clearAdapters(): void {
  registry.clear();
}
```

- [ ] **Step 5: Thread `RequestContext` and `authMode` through `GatewayEngine`**

`packages/core/src/gateway/GatewayEngine.ts` (only the parts that change — `resolveVariables`/`shapeResponse`/`resolvePointer` at the bottom are unchanged):
```ts
import type { MappingStore, MappingRecord } from '../storage/MappingStore';
import type { RequestContext } from '../adapters/Adapter';
import { createAdapter } from '../adapters/registry';
import { matchRoute } from './matchRoute';
import { GatewayError } from './errors';

export interface ResolvedRequest {
  mapping: MappingRecord;
  params: Record<string, string>;
}

export class GatewayEngine {
  constructor(private mappingStore: MappingStore) {}

  resolve(method: string, path: string): ResolvedRequest | null {
    for (const mapping of this.mappingStore.listMappings()) {
      if (mapping.method.toUpperCase() !== method.toUpperCase()) continue;
      const params = matchRoute(mapping.route, path);
      if (params) return { mapping, params };
    }
    return null;
  }

  async handle(
    method: string,
    path: string,
    incomingAuth: { vendorToken?: string } = {},
    request: RequestContext = {}
  ): Promise<unknown> {
    const resolved = this.resolve(method, path);
    if (!resolved) {
      throw new GatewayError('NOT_FOUND', `No mapping for ${method} ${path}`, 404);
    }
    const { mapping, params } = resolved;
    const connection = this.mappingStore.getConnection(mapping.connectionId);
    if (!connection) {
      throw new GatewayError('CONNECTION_NOT_FOUND', `Connection ${mapping.connectionId} not found`, 500);
    }
    const adapter = createAdapter(connection.adapterType);
    const operation = resolveVariables(mapping.operation, params);
    const raw = await adapter.execute(
      operation,
      params,
      { connectionId: connection.id, vendorToken: incomingAuth.vendorToken, authMode: connection.authMode },
      request
    );
    return shapeResponse(raw, mapping.responseTemplate);
  }
}
```

- [ ] **Step 6: Read `X-Vendor-Token` and thread query/body in `apiRouter`**

`apps/server/src/routers/apiRouter.ts`:
```ts
import { Router } from 'express';
import { toErrorResponse, GatewayError, type GatewayEngine } from '@graphtorest/core';

export function createApiRouter(gatewayEngine: GatewayEngine): Router {
  const router = Router();
  router.use(async (req, res) => {
    try {
      const vendorToken = req.header('x-vendor-token') ?? undefined;
      const result = await gatewayEngine.handle(
        req.method,
        req.path,
        { vendorToken },
        { query: req.query as Record<string, string>, body: req.body }
      );
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });
  return router;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/adapters/registry.test.ts packages/core/test/gateway/GatewayEngine.test.ts apps/server/test/integration.test.ts`
Expected: PASS — all previous Plan 1 cases in these three files still pass unchanged, plus the new ones.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/adapters/Adapter.ts packages/core/src/adapters/registry.ts packages/core/src/gateway/GatewayEngine.ts apps/server/src/routers/apiRouter.ts packages/core/test/adapters/registry.test.ts packages/core/test/gateway/GatewayEngine.test.ts apps/server/test/integration.test.ts
git commit -m "feat(core,server): thread request context and connection authMode through the gateway" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 2: OData query translation and cursor/path helpers

**Files:**
- Create: `packages/core/src/adapters/microsoftGraph/odata.ts`
- Test: `packages/core/test/adapters/microsoftGraph/odata.test.ts`

**Interfaces:**
- Produces: `interface NormalizedRequestQuery { select?: string; filter?: string; expand?: string; limit?: number; cursor?: string }`; `normalizeRequestQuery(query?: Record<string, string>): NormalizedRequestQuery`; `encodeCursor(nextUrl: string): string`; `decodeCursor(cursor: string): string`; `interpolatePath(template: string, params: Record<string, string>): string`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/adapters/microsoftGraph/odata.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { normalizeRequestQuery, encodeCursor, decodeCursor, interpolatePath } from '../../../src/adapters/microsoftGraph/odata';

describe('normalizeRequestQuery', () => {
  it('picks known REST query params through unchanged', () => {
    expect(normalizeRequestQuery({ select: 'id,displayName', filter: "startswith(displayName,'A')", expand: 'manager' })).toEqual({
      select: 'id,displayName',
      filter: "startswith(displayName,'A')",
      expand: 'manager',
    });
  });

  it('parses a positive limit to a number', () => {
    expect(normalizeRequestQuery({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('ignores a non-numeric or non-positive limit', () => {
    expect(normalizeRequestQuery({ limit: 'abc' })).toEqual({});
    expect(normalizeRequestQuery({ limit: '-5' })).toEqual({});
    expect(normalizeRequestQuery({ limit: '0' })).toEqual({});
  });

  it('passes cursor through unchanged', () => {
    expect(normalizeRequestQuery({ cursor: 'opaque-token' })).toEqual({ cursor: 'opaque-token' });
  });

  it('ignores unrecognized query params', () => {
    expect(normalizeRequestQuery({ unrelated: 'x' })).toEqual({});
  });

  it('returns an empty object for undefined query', () => {
    expect(normalizeRequestQuery(undefined)).toEqual({});
  });
});

describe('cursor encode/decode', () => {
  it('round-trips a Graph nextLink URL', () => {
    const url = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    expect(decodeCursor(encodeCursor(url))).toBe(url);
  });
});

describe('interpolatePath', () => {
  it('substitutes a single path parameter', () => {
    expect(interpolatePath('/users/{id}', { id: '42' })).toBe('/users/42');
  });

  it('substitutes multiple path parameters', () => {
    expect(interpolatePath('/users/{id}/messages/{messageId}', { id: '42', messageId: '7' })).toBe(
      '/users/42/messages/7'
    );
  });

  it('URL-encodes the substituted value', () => {
    expect(interpolatePath('/users/{id}', { id: 'a b' })).toBe('/users/a%20b');
  });

  it('throws when a required parameter is missing', () => {
    expect(() => interpolatePath('/users/{id}', {})).toThrow('Missing path parameter "id"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/odata.test.ts`
Expected: FAIL — `../../../src/adapters/microsoftGraph/odata` does not exist.

- [ ] **Step 3: Implement odata.ts**

`packages/core/src/adapters/microsoftGraph/odata.ts`:
```ts
export interface NormalizedRequestQuery {
  select?: string;
  filter?: string;
  expand?: string;
  limit?: number;
  cursor?: string;
}

export function normalizeRequestQuery(query?: Record<string, string>): NormalizedRequestQuery {
  if (!query) return {};
  const normalized: NormalizedRequestQuery = {};
  if (query.select) normalized.select = query.select;
  if (query.filter) normalized.filter = query.filter;
  if (query.expand) normalized.expand = query.expand;
  if (query.limit) {
    const parsed = Number(query.limit);
    if (Number.isFinite(parsed) && parsed > 0) normalized.limit = parsed;
  }
  if (query.cursor) normalized.cursor = query.cursor;
  return normalized;
}

export function encodeCursor(nextUrl: string): string {
  return Buffer.from(nextUrl, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

export function interpolatePath(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for template "${template}"`);
    }
    return encodeURIComponent(value);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/odata.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/microsoftGraph/odata.ts packages/core/test/adapters/microsoftGraph/odata.test.ts
git commit -m "feat(core): add OData query normalization and cursor/path helpers for Microsoft Graph" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 3: `GraphHttpClient` — get/list/batch over `@microsoft/microsoft-graph-client`

**Files:**
- Modify: `packages/core/package.json` (add dependency + test devDependency)
- Create: `packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts`
- Test: `packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts`

**Interfaces:**
- Consumes: `encodeCursor`, `decodeCursor`, `NormalizedRequestQuery` (Task 2, `./odata`); `GatewayError` (Plan 1, `../../gateway/errors`).
- Produces: `interface GraphListResult { data: unknown[]; nextCursor: string | null }`; `interface GraphBatchRequest { id: string; method: string; path: string }`; `class GraphHttpClient { constructor(authMode: string, vendorToken: string | undefined); get(path: string, query: NormalizedRequestQuery): Promise<unknown>; list(path: string, query: NormalizedRequestQuery): Promise<GraphListResult>; batch(requests: GraphBatchRequest[]): Promise<Record<string, unknown>> }`.

- [ ] **Step 1: Add dependencies**

`packages/core/package.json` — add to `dependencies`:
```json
    "@microsoft/microsoft-graph-client": "^3.0.7"
```
and to `devDependencies`:
```json
    "nock": "^14.0.0"
```

Run: `npm install`
Expected: exits 0; `node_modules/@microsoft/microsoft-graph-client` and `node_modules/nock` exist.

- [ ] **Step 2: Write the failing test**

`packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { GraphHttpClient } from '../../../src/adapters/microsoftGraph/GraphHttpClient';
import { encodeCursor } from '../../../src/adapters/microsoftGraph/odata';
import { GatewayError } from '../../../src/gateway/errors';

afterEach(() => {
  nock.cleanAll();
});

describe('GraphHttpClient construction', () => {
  it('throws a 501 GatewayError for an unsupported authMode', () => {
    expect(() => new GraphHttpClient('managed', 'token')).toThrow(GatewayError);
    try {
      new GraphHttpClient('managed', 'token');
    } catch (err) {
      expect((err as GatewayError).status).toBe(501);
    }
  });

  it('throws a 401 GatewayError when passthrough has no vendor token', () => {
    expect(() => new GraphHttpClient('passthrough', undefined)).toThrow(GatewayError);
    try {
      new GraphHttpClient('passthrough', undefined);
    } catch (err) {
      expect((err as GatewayError).status).toBe(401);
    }
  });
});

describe('GraphHttpClient.get', () => {
  it('fetches a single resource and applies $select', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $select: 'id,displayName' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.get('/users/42', { select: 'id,displayName' });

    expect(result).toEqual({ id: '42', displayName: 'Ada Lovelace' });
  });

  it('normalizes a vendor error response into a GatewayError', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/999')
      .reply(404, { error: { code: 'Request_ResourceNotFound', message: 'User not found' } });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    await expect(client.get('/users/999', {})).rejects.toMatchObject({ status: 404, code: 'Request_ResourceNotFound' });
  });
});

describe('GraphHttpClient.list', () => {
  it('returns data and an encoded nextCursor when @odata.nextLink is present', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users')
      .reply(200, { value: [{ id: '1' }], '@odata.nextLink': nextLink });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users', {});

    expect(result.data).toEqual([{ id: '1' }]);
    expect(result.nextCursor).toBe(encodeCursor(nextLink));
  });

  it('returns a null nextCursor when there is no further page', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/users').reply(200, { value: [{ id: '1' }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users', {});

    expect(result.nextCursor).toBeNull();
  });

  it('falls back to @odata.deltaLink for the nextCursor on a delta query final page', async () => {
    const deltaLink = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=xyz789';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/delta')
      .reply(200, { value: [{ id: '1', displayName: 'Ada Lovelace' }], '@odata.deltaLink': deltaLink });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.list('/users/delta', {});

    expect(result.data).toEqual([{ id: '1', displayName: 'Ada Lovelace' }]);
    expect(result.nextCursor).toBe(encodeCursor(deltaLink));
  });

  it('follows a decoded cursor directly instead of rebuilding the query', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/users').query({ $skiptoken: 'abc123' }).reply(200, { value: [{ id: '2' }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const cursor = encodeCursor('https://graph.microsoft.com/v1.0/users?$skiptoken=abc123');
    const result = await client.list('/users', { cursor });

    expect(result.data).toEqual([{ id: '2' }]);
  });
});

describe('GraphHttpClient.batch', () => {
  it('combines multiple sub-requests into one call, keyed by id', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch', {
        requests: [
          { id: 'user', method: 'GET', url: '/users/42' },
          { id: 'manager', method: 'GET', url: '/users/42/manager' },
        ],
      })
      .reply(200, {
        responses: [
          { id: 'user', status: 200, body: { id: '42', displayName: 'Ada Lovelace' } },
          { id: 'manager', status: 200, body: { id: '99', displayName: 'Grace Hopper' } },
        ],
      });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    const result = await client.batch([
      { id: 'user', method: 'GET', path: '/users/42' },
      { id: 'manager', method: 'GET', path: '/users/42/manager' },
    ]);

    expect(result).toEqual({
      user: { id: '42', displayName: 'Ada Lovelace' },
      manager: { id: '99', displayName: 'Grace Hopper' },
    });
  });

  it('throws a GatewayError if any sub-response failed', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch')
      .reply(200, { responses: [{ id: 'user', status: 404, body: { error: { message: 'not found' } } }] });

    const client = new GraphHttpClient('passthrough', 'vendor-token');
    await expect(client.batch([{ id: 'user', method: 'GET', path: '/users/999' }])).rejects.toBeInstanceOf(GatewayError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts`
Expected: FAIL — `../../../src/adapters/microsoftGraph/GraphHttpClient` does not exist.

- [ ] **Step 4: Implement GraphHttpClient.ts**

`packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts`:
```ts
import { Client } from '@microsoft/microsoft-graph-client';
import { GatewayError } from '../../gateway/errors';
import { encodeCursor, decodeCursor, type NormalizedRequestQuery } from './odata';

export interface GraphListResult {
  data: unknown[];
  nextCursor: string | null;
}

export interface GraphBatchRequest {
  id: string;
  method: string;
  path: string;
}

export class GraphHttpClient {
  private client: Client;

  constructor(authMode: string, vendorToken: string | undefined) {
    if (authMode !== 'passthrough') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'Microsoft Graph connections only support authMode "passthrough" until Plan 5 adds managed OAuth',
        501
      );
    }
    if (!vendorToken) {
      throw new GatewayError('MISSING_VENDOR_TOKEN', 'This request requires a vendor access token', 401);
    }
    this.client = Client.init({
      authProvider: (done) => done(null, vendorToken),
    });
  }

  async get(path: string, query: NormalizedRequestQuery): Promise<unknown> {
    try {
      let req = this.client.api(path);
      if (query.select) req = req.select(query.select);
      if (query.expand) req = req.expand(query.expand);
      return await req.get();
    } catch (err) {
      throw toGatewayError(err);
    }
  }

  async list(path: string, query: NormalizedRequestQuery): Promise<GraphListResult> {
    try {
      let req = query.cursor ? this.client.api(decodeCursor(query.cursor)) : this.client.api(path);
      if (!query.cursor) {
        if (query.select) req = req.select(query.select);
        if (query.filter) req = req.filter(query.filter);
        if (query.expand) req = req.expand(query.expand);
        if (query.limit) req = req.top(query.limit);
      }
      const raw = (await req.get()) as Record<string, unknown>;
      const next = (raw['@odata.nextLink'] as string | undefined) ?? (raw['@odata.deltaLink'] as string | undefined);
      return {
        data: Array.isArray(raw.value) ? (raw.value as unknown[]) : [],
        nextCursor: next ? encodeCursor(next) : null,
      };
    } catch (err) {
      throw toGatewayError(err);
    }
  }

  async batch(requests: GraphBatchRequest[]): Promise<Record<string, unknown>> {
    try {
      const raw = (await this.client.api('/$batch').post({
        requests: requests.map((r) => ({ id: r.id, method: r.method, url: r.path })),
      })) as { responses: Array<{ id: string; status: number; body: unknown }> };
      const byId: Record<string, unknown> = {};
      for (const response of raw.responses) {
        if (response.status >= 400) {
          throw new GatewayError(
            'VENDOR_ERROR',
            `Batch sub-request "${response.id}" failed with status ${response.status}`,
            502,
            { vendor: 'microsoft-graph', body: response.body }
          );
        }
        byId[response.id] = response.body;
      }
      return byId;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw toGatewayError(err);
    }
  }
}

function toGatewayError(err: unknown): GatewayError {
  const graphErr = err as { statusCode?: number; code?: string | null; message?: string; body?: unknown };
  if (typeof graphErr?.statusCode === 'number') {
    return new GatewayError(
      graphErr.code ?? 'VENDOR_ERROR',
      graphErr.message ?? 'Microsoft Graph request failed',
      graphErr.statusCode > 0 ? graphErr.statusCode : 502,
      { vendor: 'microsoft-graph', body: graphErr.body }
    );
  }
  return new GatewayError('VENDOR_ERROR', 'Microsoft Graph request failed', 502, { vendor: 'microsoft-graph' });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts`
Expected: PASS. If a nock matcher doesn't match (e.g. exact `$select`/`$skiptoken` query serialization), inspect the actual request nock reports as unmatched and adjust the `.query({...})` matcher to what the client sent — this is expected debugging, not a design error.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts package-lock.json
git commit -m "feat(core): add GraphHttpClient wrapping microsoft-graph-client with pagination and error normalization" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 4: Curated default mapping table

**Files:**
- Create: `packages/core/src/adapters/microsoftGraph/defaultMappings.ts`
- Test: `packages/core/test/adapters/microsoftGraph/defaultMappings.test.ts`

**Interfaces:**
- Consumes: `MappingDraft` (Plan 1, `../Adapter`).
- Produces: `const DEFAULT_MICROSOFT_GRAPH_MAPPINGS: MappingDraft[]`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/adapters/microsoftGraph/defaultMappings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from '../../../src/adapters/microsoftGraph/defaultMappings';

describe('DEFAULT_MICROSOFT_GRAPH_MAPPINGS', () => {
  it('covers users, groups, mail, calendar, drive, and teams under the /msgraph namespace', () => {
    const routes = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.map((m) => `${m.method} ${m.route}`);
    expect(routes).toEqual([
      'GET /msgraph/users',
      'GET /msgraph/users/{id}',
      'GET /msgraph/users/{id}/overview',
      'GET /msgraph/users/delta',
      'GET /msgraph/groups',
      'GET /msgraph/groups/{id}',
      'GET /msgraph/me/messages',
      'GET /msgraph/me/events',
      'GET /msgraph/me/drive/root/children',
      'GET /msgraph/me/joinedTeams',
    ]);
  });

  it('gives every mapping a recognized operation kind', () => {
    for (const mapping of DEFAULT_MICROSOFT_GRAPH_MAPPINGS) {
      expect(['get', 'list', 'batch']).toContain((mapping.operation as { kind: string }).kind);
    }
  });

  it('defines the overview route as a batch of a user and their manager', () => {
    const overview = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/{id}/overview')!;
    expect(overview.operation).toEqual({
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    });
    expect(overview.responseTemplate).toEqual({
      id: '$.user.id',
      displayName: '$.user.displayName',
      mail: '$.user.mail',
      managerId: '$.manager.id',
      managerDisplayName: '$.manager.displayName',
    });
  });

  it('defines the single-user route as a get with a passthrough-shaped response template', () => {
    const user = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/{id}')!;
    expect(user.operation).toEqual({ kind: 'get', path: '/users/{id}' });
    expect(user.responseTemplate).toEqual({ id: '$.id', displayName: '$.displayName', mail: '$.mail' });
  });

  it('leaves list-route response templates null so the adapter\'s pagination envelope passes through', () => {
    const users = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users')!;
    expect(users.operation).toEqual({ kind: 'list', path: '/users' });
    expect(users.responseTemplate ?? null).toBeNull();
  });

  it('exposes the delta route as a list operation over /users/delta', () => {
    const delta = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/delta')!;
    expect(delta.operation).toEqual({ kind: 'list', path: '/users/delta' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/defaultMappings.test.ts`
Expected: FAIL — `../../../src/adapters/microsoftGraph/defaultMappings` does not exist.

- [ ] **Step 3: Implement defaultMappings.ts**

`packages/core/src/adapters/microsoftGraph/defaultMappings.ts`:
```ts
import type { MappingDraft } from '../Adapter';

export const DEFAULT_MICROSOFT_GRAPH_MAPPINGS: MappingDraft[] = [
  {
    route: '/msgraph/users',
    method: 'GET',
    operation: { kind: 'list', path: '/users' },
  },
  {
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName', mail: '$.mail' },
  },
  {
    route: '/msgraph/users/{id}/overview',
    method: 'GET',
    operation: {
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    },
    responseTemplate: {
      id: '$.user.id',
      displayName: '$.user.displayName',
      mail: '$.user.mail',
      managerId: '$.manager.id',
      managerDisplayName: '$.manager.displayName',
    },
  },
  {
    route: '/msgraph/users/delta',
    method: 'GET',
    operation: { kind: 'list', path: '/users/delta' },
  },
  {
    route: '/msgraph/groups',
    method: 'GET',
    operation: { kind: 'list', path: '/groups' },
  },
  {
    route: '/msgraph/groups/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/groups/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName' },
  },
  {
    route: '/msgraph/me/messages',
    method: 'GET',
    operation: { kind: 'list', path: '/me/messages' },
  },
  {
    route: '/msgraph/me/events',
    method: 'GET',
    operation: { kind: 'list', path: '/me/events' },
  },
  {
    route: '/msgraph/me/drive/root/children',
    method: 'GET',
    operation: { kind: 'list', path: '/me/drive/root/children' },
  },
  {
    route: '/msgraph/me/joinedTeams',
    method: 'GET',
    operation: { kind: 'list', path: '/me/joinedTeams' },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/defaultMappings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/microsoftGraph/defaultMappings.ts packages/core/test/adapters/microsoftGraph/defaultMappings.test.ts
git commit -m "feat(core): add curated default Microsoft Graph mapping table" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 5: `MicrosoftGraphAdapter` + registration

**Files:**
- Create: `packages/core/src/adapters/microsoftGraph/MicrosoftGraphAdapter.ts`
- Modify: `packages/core/src/adapters/defaults.ts`
- Test: `packages/core/test/adapters/microsoftGraph/MicrosoftGraphAdapter.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `AuthContext`, `MappingDraft`, `RequestContext` (Task 1/Plan 1, `../Adapter`); `GatewayError` (Plan 1, `../../gateway/errors`); `GraphHttpClient` (Task 3, `./GraphHttpClient`); `normalizeRequestQuery`, `interpolatePath` (Task 2, `./odata`); `DEFAULT_MICROSOFT_GRAPH_MAPPINGS` (Task 4, `./defaultMappings`); `registerAdapter` (Plan 1, `../registry`).
- Produces: `class MicrosoftGraphAdapter implements Adapter` (`type === 'microsoft-graph'`); `registerDefaultAdapters()` now also registers `'microsoft-graph'`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/adapters/microsoftGraph/MicrosoftGraphAdapter.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import nock from 'nock';
import { MicrosoftGraphAdapter } from '../../../src/adapters/microsoftGraph/MicrosoftGraphAdapter';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from '../../../src/adapters/microsoftGraph/defaultMappings';
import { GatewayError } from '../../../src/gateway/errors';

afterEach(() => {
  nock.cleanAll();
});

describe('MicrosoftGraphAdapter', () => {
  const adapter = new MicrosoftGraphAdapter();

  it('has type "microsoft-graph"', () => {
    expect(adapter.type).toBe('microsoft-graph');
  });

  it('serves the curated mapping table regardless of introspection input', async () => {
    const drafts = await adapter.generateMappings(await adapter.introspect({ connectionId: 'c1' }));
    expect(drafts).toEqual(DEFAULT_MICROSOFT_GRAPH_MAPPINGS);
  });

  it('dispatches a "get" operation to a single Graph resource, applying $expand from the request', async () => {
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $expand: 'manager' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const result = await adapter.execute(
      { kind: 'get', path: '/users/{id}' },
      { id: '42' },
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' },
      { query: { expand: 'manager' } }
    );

    expect(result).toEqual({ id: '42', displayName: 'Ada Lovelace' });
  });

  it('dispatches a "list" operation and returns the normalized pagination envelope', async () => {
    nock('https://graph.microsoft.com').get('/v1.0/groups').reply(200, { value: [{ id: 'g1' }] });

    const result = await adapter.execute(
      { kind: 'list', path: '/groups' },
      {},
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' }
    );

    expect(result).toEqual({ data: [{ id: 'g1' }], nextCursor: null });
  });

  it('dispatches a "batch" operation, interpolating path params into each sub-request', async () => {
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch', {
        requests: [
          { id: 'user', method: 'GET', url: '/users/42' },
          { id: 'manager', method: 'GET', url: '/users/42/manager' },
        ],
      })
      .reply(200, {
        responses: [
          { id: 'user', status: 200, body: { id: '42' } },
          { id: 'manager', status: 200, body: { id: '99' } },
        ],
      });

    const result = await adapter.execute(
      {
        kind: 'batch',
        requests: [
          { id: 'user', method: 'GET', path: '/users/{id}' },
          { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
        ],
      },
      { id: '42' },
      { connectionId: 'c1', vendorToken: 'vendor-token', authMode: 'passthrough' }
    );

    expect(result).toEqual({ user: { id: '42' }, manager: { id: '99' } });
  });

  it('rejects an unsupported operation kind', async () => {
    await expect(
      adapter.execute({ kind: 'delete-everything' }, {}, { connectionId: 'c1', authMode: 'passthrough', vendorToken: 't' })
    ).rejects.toBeInstanceOf(GatewayError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/MicrosoftGraphAdapter.test.ts`
Expected: FAIL — `../../../src/adapters/microsoftGraph/MicrosoftGraphAdapter` does not exist.

- [ ] **Step 3: Implement MicrosoftGraphAdapter.ts**

`packages/core/src/adapters/microsoftGraph/MicrosoftGraphAdapter.ts`:
```ts
import type { Adapter, AuthContext, MappingDraft, RequestContext } from '../Adapter';
import { GatewayError } from '../../gateway/errors';
import { GraphHttpClient } from './GraphHttpClient';
import { normalizeRequestQuery, interpolatePath } from './odata';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from './defaultMappings';

export class MicrosoftGraphAdapter implements Adapter {
  readonly type = 'microsoft-graph';

  async introspect(_authContext: AuthContext): Promise<unknown> {
    return { curatedRoutes: DEFAULT_MICROSOFT_GRAPH_MAPPINGS.map((mapping) => mapping.route) };
  }

  async generateMappings(_introspection: unknown): Promise<MappingDraft[]> {
    return DEFAULT_MICROSOFT_GRAPH_MAPPINGS;
  }

  async execute(
    operation: Record<string, unknown>,
    params: Record<string, string>,
    authContext: AuthContext,
    request: RequestContext = {}
  ): Promise<unknown> {
    const client = new GraphHttpClient(authContext.authMode ?? 'passthrough', authContext.vendorToken);
    const query = normalizeRequestQuery(request.query);
    const kind = operation.kind as string;

    if (kind === 'get') {
      return client.get(interpolatePath(operation.path as string, params), query);
    }

    if (kind === 'list') {
      return client.list(interpolatePath(operation.path as string, params), query);
    }

    if (kind === 'batch') {
      const requests = (operation.requests as Array<{ id: string; method: string; path: string }>).map((r) => ({
        id: r.id,
        method: r.method,
        path: interpolatePath(r.path, params),
      }));
      return client.batch(requests);
    }

    throw new GatewayError('UNSUPPORTED_OPERATION', `Unsupported Microsoft Graph operation kind: ${kind}`, 500);
  }
}
```

- [ ] **Step 4: Register the adapter in defaults**

`packages/core/src/adapters/defaults.ts`:
```ts
import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';
import { MicrosoftGraphAdapter } from './microsoftGraph/MicrosoftGraphAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
  registerAdapter('microsoft-graph', () => new MicrosoftGraphAdapter());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/microsoftGraph/MicrosoftGraphAdapter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/adapters/microsoftGraph/MicrosoftGraphAdapter.ts packages/core/src/adapters/defaults.ts packages/core/test/adapters/microsoftGraph/MicrosoftGraphAdapter.test.ts
git commit -m "feat(core): add MicrosoftGraphAdapter and register it as a default adapter" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 6: OpenAPI query-parameter declarations for list/get operations

**Files:**
- Modify: `packages/core/src/openapi/OpenApiGenerator.ts`
- Test: `packages/core/test/openapi/OpenApiGenerator.test.ts` (add cases)

**Interfaces:**
- Consumes: `MappingRecord` (Plan 1, `../storage/MappingStore`).
- Produces: `OpenApiGenerator.generate` now adds optional `select`/`filter`/`expand`/`limit`/`cursor` query parameters for mappings whose `operation.kind === 'list'`, and `select`/`expand` for `operation.kind === 'get'`. Behavior for mappings with no `operation.kind` (e.g. Plan 1's GraphQL-style mock mapping) is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/openapi/OpenApiGenerator.test.ts`, inside the existing `describe('OpenApiGenerator', ...)` block:

```ts
  it('declares select/filter/expand/limit/cursor query params for a "list" operation kind', () => {
    const listMapping: MappingRecord = {
      id: 'm2',
      connectionId: 'c1',
      route: '/msgraph/users',
      method: 'GET',
      operation: { kind: 'list', path: '/users' },
      responseTemplate: null,
      source: 'generated',
    };
    const doc = generator.generate([listMapping]) as any;
    const queryParams = doc.paths['/msgraph/users'].get.parameters.filter((p: any) => p.in === 'query');
    expect(queryParams.map((p: any) => p.name)).toEqual(['select', 'filter', 'expand', 'limit', 'cursor']);
    expect(queryParams.every((p: any) => p.required === false && p.schema.type === 'string')).toBe(true);
  });

  it('declares select/expand query params for a "get" operation kind', () => {
    const getMapping: MappingRecord = {
      id: 'm3',
      connectionId: 'c1',
      route: '/msgraph/users/{id}',
      method: 'GET',
      operation: { kind: 'get', path: '/users/{id}' },
      responseTemplate: null,
      source: 'generated',
    };
    const doc = generator.generate([getMapping]) as any;
    const queryParams = doc.paths['/msgraph/users/{id}'].get.parameters.filter((p: any) => p.in === 'query');
    expect(queryParams.map((p: any) => p.name)).toEqual(['select', 'expand']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/openapi/OpenApiGenerator.test.ts`
Expected: FAIL — the new mappings' `.get.parameters` has no `in: 'query'` entries yet.

- [ ] **Step 3: Implement the change**

`packages/core/src/openapi/OpenApiGenerator.ts`:
```ts
import type { MappingRecord } from '../storage/MappingStore';

const LIST_QUERY_PARAMS = ['select', 'filter', 'expand', 'limit', 'cursor'];
const GET_QUERY_PARAMS = ['select', 'expand'];

export class OpenApiGenerator {
  generate(mappings: MappingRecord[]): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const mapping of mappings) {
      const pathItem = paths[mapping.route] ?? (paths[mapping.route] = {});
      const paramNames = [...mapping.route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const pathParameters = paramNames.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      const queryParameters = queryParamsFor(mapping).map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
      }));
      pathItem[mapping.method.toLowerCase()] = {
        operationId: `${mapping.method.toLowerCase()}_${mapping.route.replace(/[/{}]/g, '_')}`,
        parameters: [...pathParameters, ...queryParameters],
        responses: {
          '200': {
            description: 'Successful response',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      };
    }
    return {
      openapi: '3.0.3',
      info: { title: 'GraphToRest API', version: '1.0.0' },
      paths,
    };
  }
}

function queryParamsFor(mapping: MappingRecord): string[] {
  const kind = (mapping.operation as { kind?: string } | null)?.kind;
  if (kind === 'list') return LIST_QUERY_PARAMS;
  if (kind === 'get') return GET_QUERY_PARAMS;
  return [];
}
```

- [ ] **Step 4: Run the full OpenApiGenerator test file to verify it passes, including pre-existing cases**

Run: `npx vitest run packages/core/test/openapi/OpenApiGenerator.test.ts`
Expected: PASS — the original test's mapping has `operation: {}` (no `kind`), so `queryParamsFor` returns `[]` and its assertion on `parameters` (path params only) is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/openapi/OpenApiGenerator.ts packages/core/test/openapi/OpenApiGenerator.test.ts
git commit -m "feat(core): declare select/filter/expand/limit/cursor query params in generated OpenAPI docs" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 7: Core barrel export updates

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: barrel now also exports `RequestContext`, `listAdapterTypes`, `clearAdapters`, `MicrosoftGraphAdapter`.

- [ ] **Step 1: Update the barrel file**

`packages/core/src/index.ts`:
```ts
export type { Adapter, AuthContext, MappingDraft, RequestContext } from './adapters/Adapter';
export { registerAdapter, createAdapter, listAdapterTypes, clearAdapters } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
export { MicrosoftGraphAdapter } from './adapters/microsoftGraph/MicrosoftGraphAdapter';
export { registerDefaultAdapters } from './adapters/defaults';

export { openDb } from './storage/db';
export { MappingStore } from './storage/MappingStore';
export type { ConnectionRecord, MappingRecord, ApiKeyRecord } from './storage/MappingStore';

export { generateApiKey, hashSecret, verifySecret, parsePresentedKey } from './auth/apiKeys';
export type { GeneratedApiKey } from './auth/apiKeys';

export { matchRoute } from './gateway/matchRoute';
export { GatewayEngine } from './gateway/GatewayEngine';
export type { ResolvedRequest } from './gateway/GatewayEngine';
export { GatewayError, toErrorResponse } from './gateway/errors';
export type { ErrorResponse } from './gateway/errors';

export { OpenApiGenerator } from './openapi/OpenApiGenerator';
```

- [ ] **Step 2: Build core and run its full test suite**

Run: `npm run build -w @graphtorest/core && npx vitest run packages/core`
Expected: exits 0; every test file under `packages/core/test` passes, including all of Tasks 1–6.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export Microsoft Graph adapter and widened request-context types" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 8: End-to-end integration test through the real Express app

**Files:**
- Modify: `apps/server/package.json` (add `nock` devDependency)
- Create: `apps/server/test/microsoftGraph.integration.test.ts`

**Interfaces:**
- Consumes: `openDb`, `MappingStore`, `GatewayEngine`, `OpenApiGenerator`, `registerDefaultAdapters` (Plan 1 + Task 5–7, `@graphtorest/core`); `createApp` (Plan 1, `../src/app`).

- [ ] **Step 1: Add the dependency**

`apps/server/package.json` — add to `devDependencies`:
```json
    "nock": "^14.0.0"
```

Run: `npm install`
Expected: exits 0.

- [ ] **Step 2: Write the failing test**

`apps/server/test/microsoftGraph.integration.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-msgraph-${Date.now()}-${Math.random()}.db`);
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

async function seedMicrosoftGraphConnection() {
  const connectionRes = await request(app)
    .post('/admin/connections')
    .send({ name: 'ms-graph-test', adapterType: 'microsoft-graph', authMode: 'passthrough' });
  const connectionId = connectionRes.body.id;

  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName', mail: '$.mail' },
  });
  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users',
    method: 'GET',
    operation: { kind: 'list', path: '/users' },
  });
  await request(app).post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}/overview',
    method: 'GET',
    operation: {
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    },
    responseTemplate: {
      id: '$.user.id',
      displayName: '$.user.displayName',
      managerDisplayName: '$.manager.displayName',
    },
  });

  const apiKeyRes = await request(app).post('/admin/api-keys').send({});
  return apiKeyRes.body.plaintext as string;
}

describe('Microsoft Graph adapter end-to-end', () => {
  it('proxies a single-resource get, applying $select from the query string', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/42')
      .query({ $select: 'id,displayName,mail' })
      .reply(200, { id: '42', displayName: 'Ada Lovelace', mail: 'ada@example.com' });

    const res = await request(app)
      .get('/api/msgraph/users/42?select=id,displayName,mail')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', displayName: 'Ada Lovelace', mail: 'ada@example.com' });
  });

  it('normalizes @odata.nextLink into a cursor and honors it on the next request', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    const nextLink = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
    nock('https://graph.microsoft.com')
      .get('/v1.0/users')
      .reply(200, { value: [{ id: '1' }], '@odata.nextLink': nextLink });

    const firstPage = await request(app)
      .get('/api/msgraph/users')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toEqual([{ id: '1' }]);
    expect(typeof firstPage.body.nextCursor).toBe('string');

    nock('https://graph.microsoft.com').get('/v1.0/users').query({ $skiptoken: 'abc123' }).reply(200, { value: [{ id: '2' }] });

    const secondPage = await request(app)
      .get(`/api/msgraph/users?cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(secondPage.status).toBe(200);
    expect(secondPage.body).toEqual({ data: [{ id: '2' }], nextCursor: null });
  });

  it('combines two Graph calls into one response via internal batching', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    nock('https://graph.microsoft.com')
      .post('/v1.0/$batch', {
        requests: [
          { id: 'user', method: 'GET', url: '/users/42' },
          { id: 'manager', method: 'GET', url: '/users/42/manager' },
        ],
      })
      .reply(200, {
        responses: [
          { id: 'user', status: 200, body: { id: '42', displayName: 'Ada Lovelace' } },
          { id: 'manager', status: 200, body: { id: '99', displayName: 'Grace Hopper' } },
        ],
      });

    const res = await request(app)
      .get('/api/msgraph/users/42/overview')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', displayName: 'Ada Lovelace', managerDisplayName: 'Grace Hopper' });
  });

  it('returns a normalized 401 when no vendor token is supplied for a passthrough connection', async () => {
    const apiKey = await seedMicrosoftGraphConnection();

    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_VENDOR_TOKEN');
  });

  it('normalizes a Graph error response to the standard error envelope', async () => {
    const apiKey = await seedMicrosoftGraphConnection();
    nock('https://graph.microsoft.com')
      .get('/v1.0/users/999')
      .query(true)
      .reply(404, { error: { code: 'Request_ResourceNotFound', message: 'User not found' } });

    const res = await request(app)
      .get('/api/msgraph/users/999')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'vendor-token-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Request_ResourceNotFound');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/server/test/microsoftGraph.integration.test.ts`
Expected: FAIL initially — no mapping/adapter wiring exists yet for a fresh test run before Tasks 1–7 land. Since Tasks 1–7 are already implemented by this point in the plan, this step instead validates the full stack together for the first time; if it fails, use the failure to find the first broken link (adapter not registered, header not read, nock matcher mismatch) rather than assuming the design is wrong.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/microsoftGraph.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json apps/server/test/microsoftGraph.integration.test.ts package-lock.json
git commit -m "test(server): add end-to-end Microsoft Graph adapter integration test" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 9: Full workspace build and test verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: exits 0 — every test file across `packages/core`, `apps/server`, and `apps/cli` passes, including all Plan 1 tests (unmodified behavior) and every test added in Tasks 1–8.

- [ ] **Step 2: Run the full workspace build**

Run: `npm run build`
Expected: exits 0 — `packages/core/dist`, `apps/server/dist` compile cleanly with the widened `Adapter`/`GatewayEngine` types and the new `microsoftGraph/` module.

- [ ] **Step 3: Confirm the adapter registry now reports both types**

Run: `node -e "const {registerDefaultAdapters, listAdapterTypes} = require('./packages/core/dist'); registerDefaultAdapters(); console.log(listAdapterTypes());"`
Expected: prints `[ 'mock', 'microsoft-graph' ]`.

- [ ] **Step 4: Commit (only if Steps 1–3 required any fixes; otherwise skip — nothing to commit)**

```bash
git add -A
git commit -m "chore: verify Plan 2 workspace build and full test suite" --author "Garrett Martin <grrttmrtn@live.com>"
```

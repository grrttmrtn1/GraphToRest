# GraphToRest Plan 4: Mapping Engine (generate → customize → regenerate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the per-adapter `introspect()`/`generateMappings()` primitives built in Plans 1–3 into a full generate-then-customize workflow: an engine that persists generated `MappingDraft`s without clobbering hand edits, a nested-type → nested-resource convention for the GraphQL adapter's mapping generation, admin API and CLI commands to trigger generation and edit mappings (flipping `source: generated` to `manual` on edit), and YAML export/import for bulk hand-editing.

**Architecture:** A new adapter-agnostic `generateAndPersistMappings` function in `packages/core` (consumed by both the admin API and the CLI, since the CLI talks to the embedded SQLite store directly rather than over HTTP) calls `adapter.introspect()` then `adapter.generateMappings()` — both already implemented per-adapter — and reconciles the resulting `MappingDraft[]` against existing rows keyed by `(method, route)`: new routes are inserted as `source: 'generated'`, existing `generated` rows are overwritten in place, and existing `manual` rows are left untouched unless `force: true` is passed (spec §5.2's "never overwrite a manual mapping unless --force" rule). A second, independent change extends `GraphQLAdapter`'s `generateMappingsFromIntrospection` (built in Plan 3) to also emit one level of nested-resource routes (e.g. `/graphql/user/{id}/address`) for object-typed sub-fields that themselves carry scalar leaves — the "nested types become nested resources" half of §5.2's convention (the `?expand=` half is not implemented; see Task 3's note on why nested-resource routes were chosen instead, given this codebase's static-precomputed-query architecture). A new `PATCH /admin/mappings/:id` endpoint and `gtr mapping-update` CLI command implement the "flip to manual on edit" rule, and a YAML transform layer (pure data-shape functions in `packages/core`, wrapped by CLI-only `mapping-export`/`mapping-import` commands that own the actual `yaml` dependency) implements bulk hand-editing via re-import.

**Tech Stack:** No new dependency in `packages/core`. `apps/cli` gains one new dependency, `yaml` (a maintained, dependency-free YAML parser/stringifier), used only by the new export/import commands — `packages/core`'s YAML-shaped transform functions operate on plain JS objects and have no YAML-library dependency themselves.

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md` §5 (Mapping Engine: §5.1 mapping record shape, §5.2 generate-then-customize flow) — see also `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md` for what surrounding plans cover, and Plans 1–3's plan documents for the `Adapter`/`MappingStore`/`GatewayEngine` code this plan builds on.

## Global Constraints

- Node.js + TypeScript throughout (spec §11); same tsconfig/workspace conventions as Plans 1–3 — no new build tooling.
- Error responses stay `{ "error": { "code": "string", "message": "string", "details": {} } }` with an appropriate status (spec §6.1); the new admin endpoints reuse `GatewayError`/`toErrorResponse` exactly like `apiRouter.ts` does, since Express 4 in this repo has no async-error-catching middleware installed — every new `async` route handler must wrap its body in `try`/`catch` itself.
- **Regeneration never overwrites a mapping with `source: manual` unless `force` is passed** (spec §5.2, verbatim). Mappings default to `source: generated` until edited, at which point they flip to `manual` (spec §5.2, verbatim) — this flip happens in exactly two places: the new `PATCH /admin/mappings/:id` endpoint and the new CLI `mapping-import` command, both of which unconditionally set `source: 'manual'` regardless of what the caller passes.
- **No vendor-specific knowledge in the generation engine** (continuing Plan 3's constraint): `generateAndPersistMappings` only calls the `Adapter` interface (`introspect`/`generateMappings`) and `MappingStore`; it has zero adapter-type branching.
- Nested-type → nested-resource expansion (this plan's Task 3) only touches `GraphQLAdapter`'s `mappingGeneration.ts` — `MicrosoftGraphAdapter.generateMappings` returns a curated, static table (Plan 2) and has no introspection-driven nesting to extend.
- Only `authMode: "passthrough"` is implemented anywhere in this codebase (Plans 2–3's restriction, unchanged here); the YAML mapping record's `auth` field therefore only ever accepts `"inherit"` — importing an entry with `auth: override` must fail loudly (auth overrides need Plan 5's managed-auth support) rather than silently ignoring it.
- The admin API has no authentication yet (Plan 1's documented gap, closed in Plan 5) — the new `/connections/:id/mappings/generate` and `/mappings/:id` (PATCH) routes follow the same no-auth posture as the existing `/admin/*` routes; do not add auth here.
- Vendor-token passthrough for the generation endpoint reuses the existing `X-Vendor-Token` header convention (spec §7.2, established in Plan 2 and reused by Plan 3) — do not invent a second header. A connection whose adapter needs a live vendor token to introspect (e.g. `GraphQLAdapter`) will surface that adapter's existing 401 `GatewayError` if the header is omitted; this plan does not change that behavior, only threads the header through.
- CLI stays embedded-mode-only with flat command names (Plan 1's documented scope; Plan 7 adds remote mode + nested command UX) — new commands are named `mapping-generate`, `mapping-update`, `mapping-export`, `mapping-import`, matching the existing flat `connection-create`/`mapping-create`/`apikey-create` naming.

---

## File Structure

```
packages/core/
  src/
    storage/
      MappingStore.ts                     # +getMapping, +getMappingByRouteAndMethod, +updateMapping (Task 1)
    mappingEngine/
      generateMappings.ts                 # generateAndPersistMappings (Task 2)
      yamlTransform.ts                    # mappingToYamlEntry, yamlEntryToMappingInput (Task 6)
    adapters/
      graphql/
        mappingGeneration.ts              # +nested-resource route generation (Task 3)
    index.ts                              # +new exports (Tasks 2, 6)
  test/
    storage/
      MappingStore.test.ts                # +tests for Task 1 additions
    mappingEngine/
      generateMappings.test.ts            # Task 2
      yamlTransform.test.ts               # Task 6
    adapters/
      graphql/
        mappingGeneration.test.ts         # +nested-resource tests, updated skip test (Task 3)

apps/server/
  src/routers/adminRouter.ts              # +POST /connections/:id/mappings/generate, +PATCH /mappings/:id (Task 4)
  test/integration.test.ts                # +tests for both new routes (Task 4)

apps/cli/
  package.json                            # +yaml dependency (Task 7)
  src/
    commands/
      mappingGenerate.ts                  # Task 5
      mappingUpdate.ts                    # Task 5
      mappingExport.ts                    # Task 7
      mappingImport.ts                    # Task 7
    index.ts                              # +4 new commands (Tasks 5, 7)
  test/
    commands.test.ts                      # +tests for Task 5's commands
    mappingLifecycle.test.ts              # Task 8, end-to-end
```

---

### Task 1: Widen `MappingStore` with lookup-by-route and in-place update

**Files:**
- Modify: `packages/core/src/storage/MappingStore.ts`
- Test: `packages/core/test/storage/MappingStore.test.ts`

**Interfaces:**
- Produces: `MappingStore.getMapping(id): MappingRecord | null`, `MappingStore.getMappingByRouteAndMethod(method, route): MappingRecord | null`, `MappingStore.updateMapping(id, patch: { route?; method?; operation?; responseTemplate?; source: 'generated' | 'manual' }): MappingRecord | null`. Every later task (the generation engine, the admin PATCH endpoint, the CLI update/import commands) relies on these three methods.

- [ ] **Step 1: Write the failing tests**

Add these `it` blocks inside the existing `describe('MappingStore', ...)` block in `packages/core/test/storage/MappingStore.test.ts`, after the existing mapping-related tests:

```ts
  it('gets a mapping by id', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: {} });
    expect(store.getMapping(mapping.id)).toEqual(mapping);
  });

  it('returns null from getMapping for an unknown id', () => {
    expect(store.getMapping('nope')).toBeNull();
  });

  it('finds a mapping by method and route', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: {} });
    expect(store.getMappingByRouteAndMethod('GET', '/users/{id}')).toEqual(mapping);
  });

  it('returns null from getMappingByRouteAndMethod when nothing matches', () => {
    expect(store.getMappingByRouteAndMethod('GET', '/nope')).toBeNull();
  });

  it('updates a mapping in place and sets the given source', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old' },
      source: 'generated',
    });
    const updated = store.updateMapping(mapping.id, {
      operation: { query: 'new' },
      responseTemplate: { id: '$.id' },
      source: 'manual',
    });
    expect(updated).toEqual({
      id: mapping.id,
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'new' },
      responseTemplate: { id: '$.id' },
      source: 'manual',
    });
    expect(store.getMapping(mapping.id)).toEqual(updated);
  });

  it('updateMapping leaves fields not in the patch unchanged', () => {
    const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old' },
      responseTemplate: { id: '$.id' },
      source: 'generated',
    });
    const updated = store.updateMapping(mapping.id, { source: 'manual' });
    expect(updated).toEqual({ ...mapping, source: 'manual' });
  });

  it('returns null from updateMapping for an unknown id', () => {
    expect(store.updateMapping('nope', { source: 'manual' })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/storage/MappingStore.test.ts`
Expected: FAIL — `getMapping`, `getMappingByRouteAndMethod`, `updateMapping` don't exist yet.

- [ ] **Step 3: Implement the new methods**

Replace the full contents of `packages/core/src/storage/MappingStore.ts` with:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { generateApiKey, type GeneratedApiKey } from '../auth/apiKeys';

export interface ConnectionRecord {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: Record<string, unknown> | null;
}

export interface MappingRecord {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
  source: 'generated' | 'manual';
}

export interface ApiKeyRecord {
  id: string;
  label: string | null;
}

interface ConnectionRow {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: string | null;
}

interface MappingRow {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: string;
  responseTemplate: string | null;
  source: 'generated' | 'manual';
}

const MAPPING_COLUMNS =
  'id, connection_id as connectionId, route, method, operation, response_template as responseTemplate, source';

function mapConnectionRow(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    authMode: row.authMode,
    config: row.config ? JSON.parse(row.config) : null,
  };
}

function mapMappingRow(row: MappingRow): MappingRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    route: row.route,
    method: row.method,
    operation: JSON.parse(row.operation),
    responseTemplate: row.responseTemplate ? JSON.parse(row.responseTemplate) : null,
    source: row.source,
  };
}

export class MappingStore {
  constructor(private db: Database.Database) {}

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

  createMapping(input: {
    connectionId: string;
    route: string;
    method: string;
    operation: Record<string, unknown>;
    responseTemplate?: Record<string, string> | null;
    source?: 'generated' | 'manual';
  }): MappingRecord {
    const id = crypto.randomUUID();
    const source = input.source ?? 'generated';
    const responseTemplate = input.responseTemplate ?? null;
    this.db
      .prepare(
        'INSERT INTO mappings (id, connection_id, route, method, operation, response_template, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.connectionId,
        input.route,
        input.method,
        JSON.stringify(input.operation),
        responseTemplate ? JSON.stringify(responseTemplate) : null,
        source
      );
    return {
      id,
      connectionId: input.connectionId,
      route: input.route,
      method: input.method,
      operation: input.operation,
      responseTemplate,
      source,
    };
  }

  getMapping(id: string): MappingRecord | null {
    const row = this.db.prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings WHERE id = ?`).get(id) as MappingRow | undefined;
    return row ? mapMappingRow(row) : null;
  }

  getMappingByRouteAndMethod(method: string, route: string): MappingRecord | null {
    const row = this.db
      .prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings WHERE method = ? AND route = ?`)
      .get(method, route) as MappingRow | undefined;
    return row ? mapMappingRow(row) : null;
  }

  listMappings(): MappingRecord[] {
    const rows = this.db.prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings`).all() as MappingRow[];
    return rows.map(mapMappingRow);
  }

  updateMapping(
    id: string,
    patch: {
      route?: string;
      method?: string;
      operation?: Record<string, unknown>;
      responseTemplate?: Record<string, string> | null;
      source: 'generated' | 'manual';
    }
  ): MappingRecord | null {
    const existing = this.getMapping(id);
    if (!existing) return null;
    const next: MappingRecord = {
      id: existing.id,
      connectionId: existing.connectionId,
      route: patch.route ?? existing.route,
      method: patch.method ?? existing.method,
      operation: patch.operation ?? existing.operation,
      responseTemplate: patch.responseTemplate !== undefined ? patch.responseTemplate : existing.responseTemplate,
      source: patch.source,
    };
    this.db
      .prepare('UPDATE mappings SET route = ?, method = ?, operation = ?, response_template = ?, source = ? WHERE id = ?')
      .run(
        next.route,
        next.method,
        JSON.stringify(next.operation),
        next.responseTemplate ? JSON.stringify(next.responseTemplate) : null,
        next.source,
        id
      );
    return next;
  }

  createApiKey(input: { label?: string }): GeneratedApiKey & ApiKeyRecord {
    const generated = generateApiKey();
    const label = input.label ?? null;
    this.db
      .prepare('INSERT INTO api_keys (id, hashed_key, label) VALUES (?, ?, ?)')
      .run(generated.id, generated.hashedSecret, label);
    return { ...generated, label };
  }

  findApiKeyById(id: string): { id: string; hashedKey: string } | null {
    const row = this.db
      .prepare('SELECT id, hashed_key as hashedKey FROM api_keys WHERE id = ?')
      .get(id) as { id: string; hashedKey: string } | undefined;
    return row ?? null;
  }

  touchApiKeyLastUsed(id: string): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/storage/MappingStore.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/storage/MappingStore.ts packages/core/test/storage/MappingStore.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add mapping lookup-by-route and in-place update to MappingStore

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `generateAndPersistMappings` — the adapter-agnostic generation engine

**Files:**
- Create: `packages/core/src/mappingEngine/generateMappings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/mappingEngine/generateMappings.test.ts`

**Interfaces:**
- Consumes: `MappingStore.getMappingByRouteAndMethod`/`updateMapping`/`createMapping` (Task 1), `createAdapter` (`../adapters/registry`, existing), `Adapter`/`AuthContext`/`MappingDraft` (`../adapters/Adapter`, existing).
- Produces: `interface GenerationResult { created: MappingRecord[]; updated: MappingRecord[]; skipped: MappingDraft[] }`; `generateAndPersistMappings(store: MappingStore, connection: ConnectionRecord, authContext: AuthContext, options?: { force?: boolean }): Promise<GenerationResult>`. Consumed by the admin API (Task 4) and the CLI `mapping-generate` command (Task 5).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/mappingEngine/generateMappings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { registerAdapter, clearAdapters } from '../../src/adapters/registry';
import { generateAndPersistMappings } from '../../src/mappingEngine/generateMappings';
import type { Adapter, AuthContext, MappingDraft } from '../../src/adapters/Adapter';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  clearAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingengine-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function fakeAdapter(drafts: MappingDraft[]): Adapter {
  return {
    type: 'fake',
    async introspect(_authContext: AuthContext) {
      return {};
    },
    async generateMappings() {
      return drafts;
    },
    async execute() {
      return {};
    },
  };
}

describe('generateAndPersistMappings', () => {
  it('creates new mappings for drafts with no existing route/method match', async () => {
    registerAdapter('fake', () =>
      fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'user(id: $id) { id }' } }])
    );
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ route: '/users/{id}', method: 'GET', source: 'generated' });
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(store.listMappings()).toHaveLength(1);
  });

  it('overwrites an existing generated mapping at the same route/method', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const original = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'old query' },
      source: 'generated',
    });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(original.id);
    expect(result.updated[0].operation).toEqual({ query: 'new query' });
    expect(result.skipped).toEqual([]);
  });

  it('skips a manual mapping at the same route/method without force', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const manual = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'hand-written' },
      source: 'manual',
    });

    const result = await generateAndPersistMappings(store, connection, {
      connectionId: connection.id,
      authMode: connection.authMode,
      config: connection.config,
    });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]);
    expect(store.getMapping(manual.id)?.operation).toEqual({ query: 'hand-written' });
  });

  it('overwrites a manual mapping when force is true', async () => {
    registerAdapter('fake', () => fakeAdapter([{ route: '/users/{id}', method: 'GET', operation: { query: 'new query' } }]));
    const connection = store.createConnection({ name: 'c1', adapterType: 'fake', authMode: 'passthrough' });
    const manual = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'hand-written' },
      source: 'manual',
    });

    const result = await generateAndPersistMappings(
      store,
      connection,
      { connectionId: connection.id, authMode: connection.authMode, config: connection.config },
      { force: true }
    );

    expect(result.created).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(manual.id);
    expect(result.updated[0].source).toBe('generated');
    expect(result.updated[0].operation).toEqual({ query: 'new query' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/mappingEngine/generateMappings.test.ts`
Expected: FAIL with a module-not-found error — `generateMappings.ts` doesn't exist yet.

- [ ] **Step 3: Implement `generateAndPersistMappings`**

Create `packages/core/src/mappingEngine/generateMappings.ts`:

```ts
import type { AuthContext, MappingDraft } from '../adapters/Adapter';
import { createAdapter } from '../adapters/registry';
import type { ConnectionRecord, MappingRecord, MappingStore } from '../storage/MappingStore';

export interface GenerationResult {
  created: MappingRecord[];
  updated: MappingRecord[];
  skipped: MappingDraft[];
}

export async function generateAndPersistMappings(
  store: MappingStore,
  connection: ConnectionRecord,
  authContext: AuthContext,
  options: { force?: boolean } = {}
): Promise<GenerationResult> {
  const adapter = createAdapter(connection.adapterType);
  const introspection = await adapter.introspect(authContext);
  const drafts = await adapter.generateMappings(introspection);

  const created: MappingRecord[] = [];
  const updated: MappingRecord[] = [];
  const skipped: MappingDraft[] = [];

  for (const draft of drafts) {
    const existing = store.getMappingByRouteAndMethod(draft.method, draft.route);

    if (!existing) {
      created.push(
        store.createMapping({
          connectionId: connection.id,
          route: draft.route,
          method: draft.method,
          operation: draft.operation,
          responseTemplate: draft.responseTemplate ?? null,
          source: 'generated',
        })
      );
      continue;
    }

    if (existing.source === 'manual' && !options.force) {
      skipped.push(draft);
      continue;
    }

    const result = store.updateMapping(existing.id, {
      route: draft.route,
      method: draft.method,
      operation: draft.operation,
      responseTemplate: draft.responseTemplate ?? null,
      source: 'generated',
    });
    updated.push(result as MappingRecord);
  }

  return { created, updated, skipped };
}
```

- [ ] **Step 4: Export it from the package**

Add to `packages/core/src/index.ts`, alongside the existing `OpenApiGenerator` export:

```ts
export { generateAndPersistMappings } from './mappingEngine/generateMappings';
export type { GenerationResult } from './mappingEngine/generateMappings';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/mappingEngine/generateMappings.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mappingEngine/generateMappings.ts packages/core/src/index.ts packages/core/test/mappingEngine/generateMappings.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add generateAndPersistMappings, an adapter-agnostic generate-then-persist engine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Nested-type → nested-resource routes in `GraphQLAdapter`'s mapping generation

**Files:**
- Modify: `packages/core/src/adapters/graphql/mappingGeneration.ts`
- Modify: `packages/core/test/adapters/graphql/mappingGeneration.test.ts`

**Interfaces:**
- Consumes: `GraphQLField`, `GraphQLFieldArg`, `GraphQLNamedType`, `unwrapType`, `findType`, `SCALAR_KINDS` (`./introspection`, existing, Plan 3).
- Produces: no change to `generateMappingsFromIntrospection`'s exported signature — it now returns additional `MappingDraft`s per query field. Consumed by `GraphQLAdapter.generateMappings` (existing, Plan 3) with no changes needed there.

This task extends Plan 3's `generateMappingsFromIntrospection`. Previously, a query field whose return type had **zero** scalar leaf fields (e.g. a field that only nests further objects) was skipped entirely. Spec §5.2 says nested types should become nested resources following REST convention — so instead of skipping such fields, this task adds a second pass per query field: for each of its return type's *own* fields that is itself object-typed and has at least one scalar leaf, emit an additional `MappingDraft` at `<parent-route>/<nested-field-name>` that selects only that nested object's scalar leaves. This is deliberately bounded to **one level** of nesting and to nested fields with **no arguments of their own** — going deeper, or handling arguments on nested fields, would require either recursive route generation with cycle detection (two object types nesting each other) or per-request dynamic query construction, both bigger than this plan's scope; `?expand=` query-param-driven inline nesting was considered and rejected for the same reason — this codebase's mapping architecture (Plan 3) treats `operation.query` as a static, precomputed string per mapping, and `?expand=` would require building the GraphQL query dynamically per request, which no adapter does today.

- [ ] **Step 1: Update the failing tests**

In `packages/core/test/adapters/graphql/mappingGeneration.test.ts`, replace the existing test:

```ts
  it('skips a field whose return type has no scalar sub-fields at all', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route.includes('viewer'))).toBe(false);
  });
```

with:

```ts
  it('skips the bare route for a field whose return type has no scalar sub-fields of its own', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts.some((d) => d.route === '/graphql/viewer')).toBe(false);
  });

  it('generates a nested-resource route for a field whose only content is a nested object', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/viewer/address',
      method: 'GET',
      operation: { query: 'query { viewer { address { city } } }' },
      responseTemplate: { city: '$.viewer.address.city' },
    });
  });

  it('generates a nested-resource route alongside a field that also has its own scalar leaves', () => {
    const drafts = generateMappingsFromIntrospection(SCHEMA);
    expect(drafts).toContainEqual({
      route: '/graphql/user/{id}/address',
      method: 'GET',
      operation: {
        query: 'query($id: ID!) { user(id: $id) { address { city } } }',
        variables: { id: '$params.id' },
      },
      responseTemplate: { city: '$.user.address.city' },
    });
  });
```

(The bare `user` route from the pre-existing test — `/graphql/user/{id}` selecting `{ id displayName }` — is unaffected and must still be present alongside this new nested-resource draft.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/adapters/graphql/mappingGeneration.test.ts`
Expected: FAIL — `/graphql/viewer/address` and `/graphql/user/{id}/address` are not yet generated.

- [ ] **Step 3: Implement nested-resource generation**

Replace the full contents of `packages/core/src/adapters/graphql/mappingGeneration.ts` with:

```ts
import type { MappingDraft } from '../Adapter';
import {
  type GraphQLSchemaIntrospection,
  type GraphQLField,
  type GraphQLFieldArg,
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
    drafts.push(...buildMappingDrafts(field, introspection.types));
  }
  return drafts;
}

function buildMappingDrafts(field: GraphQLField, types: GraphQLNamedType[]): MappingDraft[] {
  if (field.args.length > 1) return [];

  let arg: GraphQLFieldArg | null = null;
  if (field.args.length === 1) {
    arg = field.args[0];
    const argType = unwrapType(arg.type);
    if (!argType.namedType || argType.isList) return [];
  }

  const baseRoute = arg ? `/graphql/${field.name}/{${arg.name}}` : `/graphql/${field.name}`;
  const drafts: MappingDraft[] = [];

  const selection = buildScalarSelection(field, types);
  if (selection) {
    drafts.push(buildDraft(field, arg, baseRoute, selection.text, selection.fieldNames));
  }

  drafts.push(...buildNestedResourceDrafts(field, arg, baseRoute, types));

  return drafts;
}

function buildDraft(
  field: GraphQLField,
  arg: GraphQLFieldArg | null,
  route: string,
  selectionText: string,
  fieldNames: string[]
): MappingDraft {
  const responseTemplate =
    fieldNames.length > 0 ? Object.fromEntries(fieldNames.map((name) => [name, `$.${field.name}.${name}`])) : undefined;

  if (!arg) {
    return { route, method: 'GET', operation: { query: `query { ${field.name}${selectionText} }` }, responseTemplate };
  }

  const gqlType = formatArgType(arg);
  return {
    route,
    method: 'GET',
    operation: {
      query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name})${selectionText} }`,
      variables: { [arg.name]: `$params.${arg.name}` },
    },
    responseTemplate,
  };
}

// One level of object-typed sub-fields becomes a nested resource route, e.g.
// /graphql/user/{id}/address. Deeper nesting, and sub-fields that take their
// own arguments, are out of scope — see Plan 4's Task 3 note for why.
function buildNestedResourceDrafts(
  field: GraphQLField,
  arg: GraphQLFieldArg | null,
  baseRoute: string,
  types: GraphQLNamedType[]
): MappingDraft[] {
  const returnType = unwrapType(field.type);
  if (!returnType.namedType) return [];
  const parentType = findType(types, returnType.namedType);
  if (!parentType?.fields) return [];

  const drafts: MappingDraft[] = [];
  for (const subField of parentType.fields) {
    if (subField.args.length > 0) continue;
    const subReturn = unwrapType(subField.type);
    if (!subReturn.namedType || subReturn.isList) continue;
    if (SCALAR_KINDS.has(scalarKindOf(subReturn.namedType, types))) continue;

    const nestedType = findType(types, subReturn.namedType);
    const nestedScalarFields = (nestedType?.fields ?? []).filter((f) => isScalarLeaf(f, types));
    if (nestedScalarFields.length === 0) continue;

    const nestedFieldNames = nestedScalarFields.map((f) => f.name);
    const nestedSelection = `${subField.name} { ${nestedFieldNames.join(' ')} }`;
    const responseTemplate = Object.fromEntries(
      nestedFieldNames.map((name) => [name, `$.${field.name}.${subField.name}.${name}`])
    );
    const route = `${baseRoute}/${subField.name}`;

    if (!arg) {
      drafts.push({
        route,
        method: 'GET',
        operation: { query: `query { ${field.name} { ${nestedSelection} } }` },
        responseTemplate,
      });
      continue;
    }

    const gqlType = formatArgType(arg);
    drafts.push({
      route,
      method: 'GET',
      operation: {
        query: `query($${arg.name}: ${gqlType}) { ${field.name}(${arg.name}: $${arg.name}) { ${nestedSelection} } }`,
        variables: { [arg.name]: `$params.${arg.name}` },
      },
      responseTemplate,
    });
  }
  return drafts;
}

function formatArgType(arg: GraphQLFieldArg): string {
  const argType = unwrapType(arg.type);
  return `${argType.namedType}${argType.isNonNull ? '!' : ''}`;
}

function isScalarLeaf(field: GraphQLField, types: GraphQLNamedType[]): boolean {
  const returnType = unwrapType(field.type);
  return returnType.namedType !== null && SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types));
}

function buildScalarSelection(field: GraphQLField, types: GraphQLNamedType[]): ScalarSelection | null {
  const returnType = unwrapType(field.type);
  if (!returnType.namedType) return null;
  if (SCALAR_KINDS.has(scalarKindOf(returnType.namedType, types))) {
    return { text: '', fieldNames: [] };
  }

  const named = findType(types, returnType.namedType);
  const scalarFields = (named?.fields ?? []).filter((f) => isScalarLeaf(f, types));
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
Expected: PASS (all tests in the file, including the pre-existing ones for `user`, `count`, `search`, `usersByTeam`, and the empty-schema case)

- [ ] **Step 5: Run the whole GraphQL adapter test suite as a regression check**

Run: `npx vitest run packages/core/test/adapters/graphql`
Expected: PASS — `GraphQLAdapter.test.ts`'s `generateMappings` delegation test uses a minimal single-field schema and is unaffected by this change.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/adapters/graphql/mappingGeneration.ts packages/core/test/adapters/graphql/mappingGeneration.test.ts
git commit -m "$(cat <<'EOF'
feat(core): generate nested-resource routes for object-typed GraphQL sub-fields

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Admin API — generate-mappings and edit-mapping endpoints

**Files:**
- Modify: `apps/server/src/routers/adminRouter.ts`
- Test: `apps/server/test/integration.test.ts`

**Interfaces:**
- Consumes: `generateAndPersistMappings` (Task 2), `MappingStore.updateMapping` (Task 1), `GatewayError`/`toErrorResponse` (`@graphtorest/core`, existing).
- Produces: `POST /connections/:id/mappings/generate` (body: `{ force?: boolean }`, header: optional `X-Vendor-Token`) → `GenerationResult` JSON; `PATCH /mappings/:id` (body: any of `route`/`method`/`operation`/`responseTemplate`) → updated `MappingRecord`, always with `source: 'manual'`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/integration.test.ts`, as a new top-level `describe` block (after the existing ones in the file):

```ts
describe('mapping generation and editing', () => {
  it('generates mappings for a connection from its adapter', async () => {
    const connectionRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'gen-conn', adapterType: 'mock', authMode: 'passthrough' });
    const connectionId = connectionRes.body.id;

    const res = await request(app).post(`/admin/connections/${connectionId}/mappings/generate`).send({});

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0]).toMatchObject({ route: '/users/{id}', method: 'GET', source: 'generated' });
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual([]);
  });

  it('returns 404 for an unknown connection', async () => {
    const res = await request(app).post('/admin/connections/nope/mappings/generate').send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('skips a manual mapping on regenerate unless force is set, then overwrites it with force', async () => {
    const connectionRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'gen-conn-2', adapterType: 'mock', authMode: 'passthrough' });
    const connectionId = connectionRes.body.id;
    const mappingRes = await request(app)
      .post('/admin/mappings')
      .send({
        connectionId,
        route: '/users/{id}',
        method: 'GET',
        operation: { query: 'hand-written' },
        source: 'manual',
      });
    const mappingId = mappingRes.body.id;

    const skipRes = await request(app).post(`/admin/connections/${connectionId}/mappings/generate`).send({});
    expect(skipRes.body.skipped).toHaveLength(1);
    const afterSkip = await request(app).get('/admin/mappings');
    expect(afterSkip.body.find((m: { id: string }) => m.id === mappingId).operation).toEqual({ query: 'hand-written' });

    const forceRes = await request(app).post(`/admin/connections/${connectionId}/mappings/generate`).send({ force: true });
    expect(forceRes.body.updated).toHaveLength(1);
    expect(forceRes.body.updated[0].id).toBe(mappingId);
    expect(forceRes.body.updated[0].source).toBe('generated');
  });

  it('updates a mapping and flips its source to manual', async () => {
    const connectionRes = await request(app)
      .post('/admin/connections')
      .send({ name: 'edit-conn', adapterType: 'mock', authMode: 'passthrough' });
    const mappingRes = await request(app).post('/admin/mappings').send({
      connectionId: connectionRes.body.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }' },
    });
    expect(mappingRes.body.source).toBe('generated');

    const res = await request(app)
      .patch(`/admin/mappings/${mappingRes.body.id}`)
      .send({ operation: { query: 'user(id: $id) { id, mail }' } });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('manual');
    expect(res.body.operation).toEqual({ query: 'user(id: $id) { id, mail }' });
  });

  it('returns 404 when updating an unknown mapping', async () => {
    const res = await request(app).patch('/admin/mappings/nope').send({ operation: {} });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/integration.test.ts`
Expected: FAIL — `POST /admin/connections/:id/mappings/generate` and `PATCH /admin/mappings/:id` don't exist yet (404 from Express's default handler, not from the app's own `NOT_FOUND` body).

- [ ] **Step 3: Implement the two routes**

Replace the full contents of `apps/server/src/routers/adminRouter.ts` with:

```ts
import { Router } from 'express';
import { type MappingStore, generateAndPersistMappings, toErrorResponse, GatewayError } from '@graphtorest/core';

export function createAdminRouter(mappingStore: MappingStore): Router {
  const router = Router();

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

  router.get('/connections', (_req, res) => {
    res.json(mappingStore.listConnections());
  });

  router.post('/connections/:id/mappings/generate', async (req, res) => {
    const connection = mappingStore.getConnection(req.params.id);
    if (!connection) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connection not found', details: {} } });
      return;
    }
    const force = Boolean((req.body ?? {}).force);
    const vendorToken = req.header('x-vendor-token') ?? undefined;
    try {
      const result = await generateAndPersistMappings(
        mappingStore,
        connection,
        { connectionId: connection.id, authMode: connection.authMode, config: connection.config, vendorToken },
        { force }
      );
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });

  router.post('/mappings', (req, res) => {
    const { connectionId, route, method, operation, responseTemplate, source } = req.body ?? {};
    if (!connectionId || !route || !method || !operation) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'connectionId, route, method, operation required', details: {} },
      });
      return;
    }
    try {
      res.status(201).json(
        mappingStore.createMapping({ connectionId, route, method, operation, responseTemplate, source })
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A mapping with this route and method already exists', details: {} },
        });
        return;
      }
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        res.status(400).json({
          error: { code: 'INVALID_INPUT', message: 'connectionId does not reference an existing connection', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.get('/mappings', (_req, res) => {
    res.json(mappingStore.listMappings());
  });

  router.patch('/mappings/:id', (req, res) => {
    const { route, method, operation, responseTemplate } = req.body ?? {};
    try {
      const updated = mappingStore.updateMapping(req.params.id, { route, method, operation, responseTemplate, source: 'manual' });
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found', details: {} } });
        return;
      }
      res.json(updated);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A mapping with this route and method already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.post('/api-keys', (req, res) => {
    const { label } = req.body ?? {};
    const created = mappingStore.createApiKey({ label });
    res.status(201).json({ id: created.id, plaintext: created.plaintext, label: created.label });
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/integration.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routers/adminRouter.ts apps/server/test/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add mapping-generation and mapping-edit admin endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI `mapping-generate` and `mapping-update` commands

**Files:**
- Create: `apps/cli/src/commands/mappingGenerate.ts`
- Create: `apps/cli/src/commands/mappingUpdate.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `generateAndPersistMappings` (Task 2), `MappingStore.updateMapping` (Task 1), `parseRoute` (`./mappingCreate`, existing).
- Produces: `mappingGenerate(store, { connectionId, vendorToken?, force? }): Promise<GenerationResult>`; `mappingUpdate(store, { id, route?, operation?, responseTemplate? }): MappingRecord`. Consumed by the new `gtr mapping-generate` / `gtr mapping-update` CLI commands and, in Task 8, by the end-to-end lifecycle test.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/test/commands.test.ts`, inside the existing `describe('CLI embedded commands', ...)` block, and add the two new imports at the top of the file:

```ts
import { mappingGenerate } from '../src/commands/mappingGenerate';
import { mappingUpdate } from '../src/commands/mappingUpdate';
```

```ts
  it('mappingGenerate persists drafts from the connection adapter', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });

    const result = await mappingGenerate(store, { connectionId: connection.id });

    expect(result.created).toHaveLength(1);
    expect(store.listMappings()).toHaveLength(1);
  });

  it('mappingGenerate throws for an unknown connection id', async () => {
    const store = freshStore();
    await expect(mappingGenerate(store, { connectionId: 'nope' })).rejects.toThrow('No connection with id nope');
  });

  it('mappingUpdate flips the mapping source to manual', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const generated = store.createMapping({ connectionId: connection.id, route: '/users/{id}', method: 'GET', operation: { query: 'a' } });

    const updated = mappingUpdate(store, { id: generated.id, operation: { query: 'b' } });

    expect(updated.source).toBe('manual');
    expect(updated.operation).toEqual({ query: 'b' });
  });

  it('mappingUpdate throws for an unknown mapping id', () => {
    const store = freshStore();
    expect(() => mappingUpdate(store, { id: 'nope' })).toThrow('No mapping with id nope');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/test/commands.test.ts`
Expected: FAIL with module-not-found errors — `mappingGenerate.ts`/`mappingUpdate.ts` don't exist yet.

- [ ] **Step 3: Implement the two command functions**

Create `apps/cli/src/commands/mappingGenerate.ts`:

```ts
import type { MappingStore, GenerationResult } from '@graphtorest/core';
import { generateAndPersistMappings } from '@graphtorest/core';

export async function mappingGenerate(
  store: MappingStore,
  args: { connectionId: string; vendorToken?: string; force?: boolean }
): Promise<GenerationResult> {
  const connection = store.getConnection(args.connectionId);
  if (!connection) {
    throw new Error(`No connection with id ${args.connectionId}`);
  }
  return generateAndPersistMappings(
    store,
    connection,
    { connectionId: connection.id, authMode: connection.authMode, config: connection.config, vendorToken: args.vendorToken },
    { force: args.force }
  );
}
```

Create `apps/cli/src/commands/mappingUpdate.ts`:

```ts
import type { MappingStore, MappingRecord } from '@graphtorest/core';
import { parseRoute } from './mappingCreate';

export function mappingUpdate(
  store: MappingStore,
  args: { id: string; route?: string; operation?: Record<string, unknown>; responseTemplate?: Record<string, string> | null }
): MappingRecord {
  const parsed = args.route ? parseRoute(args.route) : undefined;
  const updated = store.updateMapping(args.id, {
    route: parsed?.route,
    method: parsed?.method,
    operation: args.operation,
    responseTemplate: args.responseTemplate,
    source: 'manual',
  });
  if (!updated) {
    throw new Error(`No mapping with id ${args.id}`);
  }
  return updated;
}
```

- [ ] **Step 4: Wire both commands into the CLI**

In `apps/cli/src/index.ts`, add the imports:

```ts
import { mappingGenerate } from './commands/mappingGenerate';
import { mappingUpdate } from './commands/mappingUpdate';
```

Add the two commands (after the existing `mapping-create` command) and switch the final `program.parse()` call to `program.parseAsync()` so the new async action is awaited before the process exits:

```ts
program
  .command('mapping-generate')
  .requiredOption('--connection-id <id>')
  .option('--vendor-token <token>')
  .option('--force', 'overwrite manual mappings too', false)
  .action(async (opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = await mappingGenerate(store, {
      connectionId: opts.connectionId,
      vendorToken: opts.vendorToken,
      force: opts.force,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('mapping-update')
  .requiredOption('--id <id>')
  .option('--route <route>', 'e.g. "GET /users/{id}"')
  .option('--operation <json>', 'JSON-encoded operation object')
  .option('--response-template <json>', 'JSON-encoded response template')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingUpdate(store, {
      id: opts.id,
      route: opts.route,
      operation: opts.operation ? JSON.parse(opts.operation) : undefined,
      responseTemplate: opts.responseTemplate ? JSON.parse(opts.responseTemplate) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });
```

Replace the file's final line:

```ts
program.parse();
```

with:

```ts
program.parseAsync().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/cli/test/commands.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/mappingGenerate.ts apps/cli/src/commands/mappingUpdate.ts apps/cli/src/index.ts apps/cli/test/commands.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add mapping-generate and mapping-update commands

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: YAML transform functions (pure data shapes, no YAML library)

**Files:**
- Create: `packages/core/src/mappingEngine/yamlTransform.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/mappingEngine/yamlTransform.test.ts`

**Interfaces:**
- Consumes: `MappingRecord` (`../storage/MappingStore`, existing).
- Produces: `interface MappingYamlEntry { id?: string; route: string; connection: string; source: 'generated' | 'manual'; operation: Record<string, unknown>; response: { shape: 'passthrough' | 'template'; template?: Record<string, string> }; auth: string }`; `mappingToYamlEntry(mapping: MappingRecord, connectionName: string): MappingYamlEntry`; `yamlEntryToMappingInput(entry: MappingYamlEntry, connectionId: string): { id?: string; connectionId: string; route: string; method: string; operation: Record<string, unknown>; responseTemplate: Record<string, string> | null }` (throws for any `auth` other than `"inherit"`). Consumed by the CLI's `mapping-export`/`mapping-import` commands (Task 7).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/mappingEngine/yamlTransform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mappingToYamlEntry, yamlEntryToMappingInput } from '../../src/mappingEngine/yamlTransform';
import type { MappingRecord } from '../../src/storage/MappingStore';

describe('mappingToYamlEntry', () => {
  it('serializes a mapping with a response template', () => {
    const mapping: MappingRecord = {
      id: 'm1',
      connectionId: 'c1',
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: { id: '$.id' },
      source: 'generated',
    };
    expect(mappingToYamlEntry(mapping, 'ms-graph-prod')).toEqual({
      id: 'm1',
      route: 'GET /users/{id}',
      connection: 'ms-graph-prod',
      source: 'generated',
      operation: { query: 'user(id: $id) { id }' },
      response: { shape: 'template', template: { id: '$.id' } },
      auth: 'inherit',
    });
  });

  it('serializes a mapping with no response template as passthrough', () => {
    const mapping: MappingRecord = {
      id: 'm2',
      connectionId: 'c1',
      route: '/count',
      method: 'GET',
      operation: { query: 'count' },
      responseTemplate: null,
      source: 'manual',
    };
    expect(mappingToYamlEntry(mapping, 'c1').response).toEqual({ shape: 'passthrough' });
  });
});

describe('yamlEntryToMappingInput', () => {
  it('parses a template-shaped entry back into a mapping input', () => {
    const input = yamlEntryToMappingInput(
      {
        id: 'm1',
        route: 'GET /users/{id}',
        connection: 'ms-graph-prod',
        source: 'generated',
        operation: { query: 'user(id: $id) { id }' },
        response: { shape: 'template', template: { id: '$.id' } },
        auth: 'inherit',
      },
      'c1'
    );
    expect(input).toEqual({
      id: 'm1',
      connectionId: 'c1',
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: { id: '$.id' },
    });
  });

  it('parses a passthrough-shaped entry with a null response template', () => {
    const input = yamlEntryToMappingInput(
      {
        route: 'GET /count',
        connection: 'c1',
        source: 'manual',
        operation: { query: 'count' },
        response: { shape: 'passthrough' },
        auth: 'inherit',
      },
      'c1'
    );
    expect(input.responseTemplate).toBeNull();
    expect(input.id).toBeUndefined();
  });

  it('throws for an unsupported auth mode', () => {
    expect(() =>
      yamlEntryToMappingInput(
        { route: 'GET /x', connection: 'c1', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'override' },
        'c1'
      )
    ).toThrow(/override/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/mappingEngine/yamlTransform.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `yamlTransform.ts`**

Create `packages/core/src/mappingEngine/yamlTransform.ts`:

```ts
import type { MappingRecord } from '../storage/MappingStore';

export interface MappingYamlEntry {
  id?: string;
  route: string;
  connection: string;
  source: 'generated' | 'manual';
  operation: Record<string, unknown>;
  response: { shape: 'passthrough' | 'template'; template?: Record<string, string> };
  auth: string;
}

export interface MappingInput {
  id?: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
}

export function mappingToYamlEntry(mapping: MappingRecord, connectionName: string): MappingYamlEntry {
  return {
    id: mapping.id,
    route: `${mapping.method} ${mapping.route}`,
    connection: connectionName,
    source: mapping.source,
    operation: mapping.operation,
    response: mapping.responseTemplate ? { shape: 'template', template: mapping.responseTemplate } : { shape: 'passthrough' },
    auth: 'inherit',
  };
}

export function yamlEntryToMappingInput(entry: MappingYamlEntry, connectionId: string): MappingInput {
  if (entry.auth !== 'inherit') {
    throw new Error(`Unsupported auth mode "${entry.auth}" on mapping "${entry.route}" — auth overrides require managed-auth support (Plan 5)`);
  }
  const { method, route } = parseRouteString(entry.route);
  return {
    id: entry.id,
    connectionId,
    route,
    method,
    operation: entry.operation,
    responseTemplate: entry.response.shape === 'template' ? (entry.response.template ?? null) : null,
  };
}

function parseRouteString(combined: string): { method: string; route: string } {
  const [method, ...rest] = combined.trim().split(/\s+/);
  return { method: method.toUpperCase(), route: rest.join(' ') };
}
```

- [ ] **Step 4: Export the new module**

Add to `packages/core/src/index.ts`, alongside the `generateAndPersistMappings` export:

```ts
export { mappingToYamlEntry, yamlEntryToMappingInput } from './mappingEngine/yamlTransform';
export type { MappingYamlEntry, MappingInput } from './mappingEngine/yamlTransform';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/mappingEngine/yamlTransform.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mappingEngine/yamlTransform.ts packages/core/src/index.ts packages/core/test/mappingEngine/yamlTransform.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add pure YAML-shape transform functions for mapping records

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CLI `mapping-export` and `mapping-import` commands

**Files:**
- Modify: `apps/cli/package.json`
- Create: `apps/cli/src/commands/mappingExport.ts`
- Create: `apps/cli/src/commands/mappingImport.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `mappingToYamlEntry`/`yamlEntryToMappingInput`/`MappingYamlEntry` (Task 6), `MappingStore.listConnections`/`listMappings`/`createMapping`/`updateMapping` (existing + Task 1).
- Produces: `mappingExport(store, { outFile? }): string` (returns the YAML text; also writes it to `outFile` when given); `mappingImport(store, { file }): MappingRecord[]`. Consumed by the new `gtr mapping-export`/`gtr mapping-import` CLI commands and, in Task 8, by the end-to-end lifecycle test.

- [ ] **Step 1: Add the `yaml` dependency**

In `apps/cli/package.json`, add `"yaml": "^2.6.0"` to `dependencies`:

```json
  "dependencies": {
    "@graphtorest/core": "*",
    "commander": "^12.1.0",
    "yaml": "^2.6.0"
  },
```

Run: `npm install` (from the repo root, so the workspace lockfile picks up the new dependency)

- [ ] **Step 2: Write the failing tests**

Add to `apps/cli/test/commands.test.ts`, inside the existing `describe('CLI embedded commands', ...)` block, and add these two imports at the top:

```ts
import { mappingExport } from '../src/commands/mappingExport';
import { mappingImport } from '../src/commands/mappingImport';
```

```ts
  it('mappingExport writes YAML that mappingImport can read back to update the same mapping', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = store.createMapping({
      connectionId: connection.id,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'original' },
      source: 'generated',
    });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-export-${Date.now()}-${Math.random()}.yaml`);

    mappingExport(store, { outFile: yamlPath });
    let yamlText = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlText).toContain('route: GET /users/{id}');
    yamlText = yamlText.replace('original', 'hand-edited');
    fs.writeFileSync(yamlPath, yamlText, 'utf8');

    const imported = mappingImport(store, { file: yamlPath });

    expect(imported).toHaveLength(1);
    expect(store.getMapping(mapping.id)?.operation).toEqual({ query: 'hand-edited' });
    expect(store.getMapping(mapping.id)?.source).toBe('manual');
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport creates a new manual mapping from a hand-authored YAML entry with no id', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-new-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(
      yamlPath,
      [
        '- connection: c1',
        '  route: "GET /widgets/{id}"',
        '  source: generated',
        '  operation:',
        '    query: "widget(id: $id) { id }"',
        '  response:',
        '    shape: passthrough',
        '  auth: inherit',
        '',
      ].join('\n'),
      'utf8'
    );

    const imported = mappingImport(store, { file: yamlPath });

    expect(imported).toHaveLength(1);
    expect(imported[0].route).toBe('/widgets/{id}');
    expect(imported[0].method).toBe('GET');
    expect(imported[0].source).toBe('manual');
    fs.unlinkSync(yamlPath);
  });

  it('mappingImport throws when the YAML entry references an unknown connection', () => {
    const store = freshStore();
    const yamlPath = path.join(os.tmpdir(), `graphtorest-import-badconn-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(
      yamlPath,
      '- connection: nope\n  route: "GET /x"\n  source: manual\n  operation: {}\n  response:\n    shape: passthrough\n  auth: inherit\n',
      'utf8'
    );

    expect(() => mappingImport(store, { file: yamlPath })).toThrow(/nope/);
    fs.unlinkSync(yamlPath);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/cli/test/commands.test.ts`
Expected: FAIL with module-not-found errors — `mappingExport.ts`/`mappingImport.ts` don't exist yet.

- [ ] **Step 4: Implement the two command functions**

Create `apps/cli/src/commands/mappingExport.ts`:

```ts
import fs from 'node:fs';
import YAML from 'yaml';
import type { MappingStore } from '@graphtorest/core';
import { mappingToYamlEntry } from '@graphtorest/core';

export function mappingExport(store: MappingStore, args: { outFile?: string }): string {
  const connectionNames = new Map(store.listConnections().map((c) => [c.id, c.name]));
  const entries = store.listMappings().map((m) => mappingToYamlEntry(m, connectionNames.get(m.connectionId) ?? m.connectionId));
  const yamlText = YAML.stringify(entries);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, yamlText, 'utf8');
  }
  return yamlText;
}
```

Create `apps/cli/src/commands/mappingImport.ts`:

```ts
import fs from 'node:fs';
import YAML from 'yaml';
import type { MappingStore, MappingRecord, MappingYamlEntry } from '@graphtorest/core';
import { yamlEntryToMappingInput } from '@graphtorest/core';

export function mappingImport(store: MappingStore, args: { file: string }): MappingRecord[] {
  const text = fs.readFileSync(args.file, 'utf8');
  const entries = (YAML.parse(text) ?? []) as MappingYamlEntry[];
  const connectionIdsByName = new Map(store.listConnections().map((c) => [c.name, c.id]));

  const results: MappingRecord[] = [];
  for (const entry of entries) {
    if (entry.id) {
      const input = yamlEntryToMappingInput(entry, '');
      const updated = store.updateMapping(entry.id, {
        route: input.route,
        method: input.method,
        operation: input.operation,
        responseTemplate: input.responseTemplate,
        source: 'manual',
      });
      if (!updated) {
        throw new Error(`No mapping with id ${entry.id} to update (from YAML import)`);
      }
      results.push(updated);
      continue;
    }

    const connectionId = connectionIdsByName.get(entry.connection);
    if (!connectionId) {
      throw new Error(`No connection named "${entry.connection}" (from YAML import)`);
    }
    const input = yamlEntryToMappingInput(entry, connectionId);
    results.push(
      store.createMapping({
        connectionId,
        route: input.route,
        method: input.method,
        operation: input.operation,
        responseTemplate: input.responseTemplate,
        source: 'manual',
      })
    );
  }
  return results;
}
```

- [ ] **Step 5: Wire both commands into the CLI**

In `apps/cli/src/index.ts`, add the imports:

```ts
import { mappingExport } from './commands/mappingExport';
import { mappingImport } from './commands/mappingImport';
```

Add the two commands (after the `mapping-update` command added in Task 5):

```ts
program
  .command('mapping-export')
  .option('--out <file>', 'write YAML to this file instead of stdout')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const yamlText = mappingExport(store, { outFile: opts.out });
    if (!opts.out) console.log(yamlText);
  });

program
  .command('mapping-import <file>')
  .action((file) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingImport(store, { file });
    console.log(JSON.stringify(result, null, 2));
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/cli/test/commands.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/cli/package.json apps/cli/src/commands/mappingExport.ts apps/cli/src/commands/mappingImport.ts apps/cli/src/index.ts apps/cli/test/commands.test.ts package-lock.json
git commit -m "$(cat <<'EOF'
feat(cli): add mapping-export and mapping-import commands for YAML round-tripping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(If the workspace doesn't use a single root `package-lock.json`, add whatever lockfile(s) `npm install` updated instead.)

---

### Task 8: End-to-end mapping lifecycle test

**Files:**
- Create: `apps/cli/test/mappingLifecycle.test.ts`

**Interfaces:**
- Consumes: `connectionCreate` (existing), `mappingGenerate`/`mappingUpdate` (Task 5), `mappingExport`/`mappingImport` (Task 7). This task creates no new production interfaces — it's a regression test proving the full generate → edit → regenerate → export → hand-edit → import cycle works together, end to end, through the same embedded-store code path the real CLI binary uses.

- [ ] **Step 1: Write the test**

Create `apps/cli/test/mappingLifecycle.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingGenerate } from '../src/commands/mappingGenerate';
import { mappingUpdate } from '../src/commands/mappingUpdate';
import { mappingExport } from '../src/commands/mappingExport';
import { mappingImport } from '../src/commands/mappingImport';

let dbPath: string;
let yamlPath: string | undefined;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  if (yamlPath && fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
  yamlPath = undefined;
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-lifecycle-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('mapping lifecycle via the CLI embedded commands', () => {
  it('generates, edits, regenerates (skip then force), and round-trips a hand-edit through YAML export/import', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });

    const generated = await mappingGenerate(store, { connectionId: connection.id });
    expect(generated.created).toHaveLength(1);
    const mappingId = generated.created[0].id;

    const edited = mappingUpdate(store, { id: mappingId, operation: { query: 'hand-edited' } });
    expect(edited.source).toBe('manual');

    const skipResult = await mappingGenerate(store, { connectionId: connection.id });
    expect(skipResult.skipped).toHaveLength(1);
    expect(store.getMapping(mappingId)?.operation).toEqual({ query: 'hand-edited' });

    const forceResult = await mappingGenerate(store, { connectionId: connection.id, force: true });
    expect(forceResult.updated).toHaveLength(1);
    expect(store.getMapping(mappingId)?.source).toBe('generated');

    yamlPath = path.join(os.tmpdir(), `graphtorest-lifecycle-export-${Date.now()}-${Math.random()}.yaml`);
    mappingExport(store, { outFile: yamlPath });
    let yamlText = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlText).toContain('source: generated');
    yamlText = yamlText.replace(/query:.*$/m, 'query: edited-again');
    fs.writeFileSync(yamlPath, yamlText, 'utf8');

    const imported = mappingImport(store, { file: yamlPath });
    expect(imported).toHaveLength(1);
    expect(store.getMapping(mappingId)?.operation).toEqual({ query: 'edited-again' });
    expect(store.getMapping(mappingId)?.source).toBe('manual');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/cli/test/mappingLifecycle.test.ts`
Expected: PASS. If it fails, the failure is in the interaction between already-tested units (Tasks 2, 5, 6, 7) rather than in any single one — re-check `mappingImport`'s `id`-present branch against what `mappingExport` actually writes (in particular, that `entry.id` survives the `YAML.stringify`/`YAML.parse` round trip unchanged) before touching any of the earlier tasks' code.

- [ ] **Step 3: Run the full workspace test suite as a final regression check**

Run: `npm test` (or `npx vitest run` from the repo root, whichever this workspace's root script uses — check `package.json`'s `scripts.test`)
Expected: PASS, every test in the workspace (Plans 1–3's suites plus everything added in this plan).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/test/mappingLifecycle.test.ts
git commit -m "$(cat <<'EOF'
test(cli): add end-to-end mapping generate/edit/regenerate/YAML-round-trip test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Deliberately Out of Scope

- `?expand=` query-param-driven nested inclusion (spec §5.2's other convention) — see Task 3's note; this plan implements nested-resource routes only.
- WebUI mapping editor (Plan 6) and CLI nested command UX (Plan 7) — this plan only adds the flat `gtr mapping-*` commands and the admin HTTP endpoints they (and a future webUI) would call.
- `auth: override` (per-mapping auth mode different from the connection's) — rejected with a thrown error in `yamlEntryToMappingInput`; needs Plan 5's managed-auth support to mean anything.
- Deleting a mapping (no `DELETE /admin/mappings/:id` or `gtr mapping-delete`) — not called for by the roadmap's Plan 4 bullet, and "drop fields" in spec §5.2 refers to editing a mapping's field selection, not deleting the mapping row.
- Any change to `OpenApiGenerator` — nested-resource routes are ordinary GET routes with their own path, so they're already served correctly by the existing OpenAPI generation logic with no changes needed.

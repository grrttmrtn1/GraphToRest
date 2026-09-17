# GraphToRest Plan 1: Foundation & Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo and the thinnest possible end-to-end slice of GraphToRest — one hardcoded route (`GET /users/{id}`) flowing through real storage, a real (mock) adapter, the real gateway/response-shaping/error-normalization code paths, real API-key auth, a real generated OpenAPI doc, and a real Docker image — so every later plan adds a subsystem onto working, runnable software instead of onto scaffolding.

**Architecture:** Three npm workspaces (`packages/core`, `apps/server`, `apps/cli`) per the spec's monorepo design. `packages/core` is a vendor-agnostic library (Adapter interface + registry, SQLite-backed `MappingStore`, `GatewayEngine`, `OpenApiGenerator`, API-key crypto). `apps/server` is a single Express process mounting `/api`, `/admin`, and `/api/docs` from `packages/core`'s pieces. `apps/cli` (`gtr`) talks to the same SQLite file directly through `packages/core` (embedded/headless mode only in this plan — remote mode is Plan 7). A single `MockAdapter` stands in for real vendor adapters so the full request path is provable without external credentials.

**Tech Stack:** Node.js 20 + TypeScript (CommonJS), npm workspaces, better-sqlite3, Express, swagger-ui-express, commander, vitest + supertest for testing.

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md` (see also the roadmap at `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md` for what later plans cover)

## Global Constraints

- Node.js + TypeScript throughout (spec §11).
- SQLite, single file, mounted as a Docker volume for persistence (spec §8, §10).
- Storage tables exactly as spec §8 lists them: `connections`, `mappings`, `api_keys`, `admin_users` — all four are created by this plan's migration even though `admin_users` isn't used until Plan 5.
- Error responses are always `{ "error": { "code": "string", "message": "string", "details": {} } }` with an appropriate HTTP status (spec §6.1) — implemented once in this plan and reused by every later plan.
- Pagination shape (`?limit=&cursor=` request, `{ "data": [...], "nextCursor": "..." }` response) is defined in spec §6.2 but **not implemented in this plan** — the one skeleton route returns a single resource, not a list. Plan 2/3 adapters introduce the first paginated routes.
- `/admin/*` requiring login (spec §7.3) is explicitly deferred to Plan 5. In this plan `/admin/*` has no auth — acceptable only because this plan is not deployed anywhere but a developer's own machine/CI; do not ship Plan 1 alone to any shared environment.
- Every internal package name is scoped `@graphtorest/*`.

---

## File Structure

```
package.json                        # npm workspaces root
tsconfig.base.json                  # shared compiler options
vitest.config.ts                    # root test runner, globs all workspaces
.gitignore

packages/core/
  package.json
  tsconfig.json
  src/
    version.ts                      # smoke-test constant (Task 1)
    index.ts                        # public barrel export (Task 10)
    adapters/
      Adapter.ts                    # Adapter interface, AuthContext, MappingDraft (Task 2)
      registry.ts                   # registerAdapter/createAdapter (Task 2)
      MockAdapter.ts                # stub adapter (Task 3)
      defaults.ts                   # registerDefaultAdapters() (Task 3)
    storage/
      migrations.ts                 # SQL migration strings (Task 4)
      db.ts                         # openDb(): apply migrations, return handle (Task 4)
      MappingStore.ts                # CRUD over connections/mappings/api_keys (Task 6)
    auth/
      apiKeys.ts                    # generate/hash/verify/parse (Task 5)
    gateway/
      matchRoute.ts                 # path-pattern matcher (Task 7)
      errors.ts                     # GatewayError, toErrorResponse (Task 8)
      GatewayEngine.ts               # resolve + handle (Task 8)
    openapi/
      OpenApiGenerator.ts            # mappings -> OpenAPI 3 doc (Task 9)
  test/
    version.test.ts
    adapters/registry.test.ts
    adapters/MockAdapter.test.ts
    storage/db.test.ts
    auth/apiKeys.test.ts
    storage/MappingStore.test.ts
    gateway/matchRoute.test.ts
    gateway/GatewayEngine.test.ts
    openapi/OpenApiGenerator.test.ts

apps/server/
  package.json
  tsconfig.json
  src/
    config.ts                       # env parsing (Task 11)
    middleware/apiKeyAuth.ts        # Task 12
    routers/apiRouter.ts            # Task 12
    routers/adminRouter.ts          # Task 12
    app.ts                          # createApp(deps) (Task 12)
    index.ts                        # bootstrap + listen (Task 12)
  test/
    integration.test.ts             # Task 12

apps/cli/
  package.json
  tsconfig.json
  bin/gtr.js
  src/
    embeddedClient.ts                # Task 13
    commands/connectionCreate.ts     # Task 13
    commands/mappingCreate.ts        # Task 13
    commands/apiKeyCreate.ts         # Task 13
    index.ts                         # commander wiring (Task 13)
  test/
    commands.test.ts                 # Task 13

Dockerfile                          # Task 14
docker-compose.yml                  # Task 14
```

---

### Task 1: Monorepo scaffold + `packages/core` bootstrap

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/version.ts`
- Test: `packages/core/test/version.test.ts`

**Interfaces:**
- Produces: `CORE_VERSION: string` constant, importable as `../src/version` (later tasks don't depend on it — it exists only to prove the toolchain works).

- [ ] **Step 1: Create root workspace config**

`package.json`:
```json
{
  "name": "graphtorest",
  "private": true,
  "version": "0.1.0",
  "engines": { "node": ">=20" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "build": "npm run build -w @graphtorest/core && npm run build --workspaces --if-present",
    "test": "npm run build -w @graphtorest/core && vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "declaration": true,
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
data/
*.db
*.db-wal
*.db-shm
*.log
```

- [ ] **Step 2: Scaffold `packages/core` package**

`packages/core/package.json`:
```json
{
  "name": "@graphtorest/core",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "better-sqlite3": "^11.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing smoke test**

`packages/core/test/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/version';

describe('CORE_VERSION', () => {
  it('is defined', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 4: Install dependencies and run test to verify it fails**

Run: `npm install && npx vitest run packages/core/test/version.test.ts`
Expected: FAIL — `packages/core/src/version.ts` does not exist (module not found).

- [ ] **Step 5: Create the source file**

`packages/core/src/version.ts`:
```ts
export const CORE_VERSION = '0.1.0';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/core/test/version.test.ts`
Expected: PASS

- [ ] **Step 7: Verify the build compiles**

Run: `npm run build -w @graphtorest/core`
Expected: exits 0, produces `packages/core/dist/version.js` and `dist/version.d.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts .gitignore packages/core
git commit -m "chore: scaffold monorepo workspaces and core package" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 2: Adapter interface + registry

**Files:**
- Create: `packages/core/src/adapters/Adapter.ts`
- Create: `packages/core/src/adapters/registry.ts`
- Test: `packages/core/test/adapters/registry.test.ts`

**Interfaces:**
- Produces: `interface Adapter { readonly type: string; introspect(authContext: AuthContext): Promise<unknown>; generateMappings(introspection: unknown): Promise<MappingDraft[]>; execute(operation: Record<string, unknown>, params: Record<string, string>, authContext: AuthContext): Promise<unknown>; }`, `interface AuthContext { connectionId: string; vendorToken?: string }`, `interface MappingDraft { route: string; method: string; operation: Record<string, unknown>; responseTemplate?: Record<string, string> | null }`, `registerAdapter(type: string, factory: () => Adapter): void`, `createAdapter(type: string): Adapter`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/adapters/registry.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { registerAdapter, createAdapter } from '../../src/adapters/registry';
import type { Adapter, AuthContext, MappingDraft } from '../../src/adapters/Adapter';

class FakeAdapter implements Adapter {
  readonly type = 'fake';
  async introspect(_ctx: AuthContext): Promise<unknown> { return {}; }
  async generateMappings(_i: unknown): Promise<MappingDraft[]> { return []; }
  async execute(): Promise<unknown> { return { ok: true }; }
}

describe('adapter registry', () => {
  beforeEach(() => {
    registerAdapter('fake', () => new FakeAdapter());
  });

  it('creates a registered adapter by type', () => {
    const adapter = createAdapter('fake');
    expect(adapter.type).toBe('fake');
  });

  it('throws for an unregistered type', () => {
    expect(() => createAdapter('nonexistent')).toThrow('Unknown adapter type: nonexistent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/registry.test.ts`
Expected: FAIL — `../../src/adapters/registry` and `../../src/adapters/Adapter` don't exist.

- [ ] **Step 3: Write the interface and registry**

`packages/core/src/adapters/Adapter.ts`:
```ts
export interface AuthContext {
  connectionId: string;
  vendorToken?: string;
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
    authContext: AuthContext
  ): Promise<unknown>;
}
```

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters packages/core/test/adapters/registry.test.ts
git commit -m "feat(core): add Adapter interface and adapter registry" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 3: MockAdapter + default registration

**Files:**
- Create: `packages/core/src/adapters/MockAdapter.ts`
- Create: `packages/core/src/adapters/defaults.ts`
- Test: `packages/core/test/adapters/MockAdapter.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `AuthContext`, `MappingDraft` from Task 2 (`../adapters/Adapter`); `registerAdapter` from Task 2 (`../adapters/registry`).
- Produces: `class MockAdapter implements Adapter` (`type === 'mock'`), `registerDefaultAdapters(): void`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/adapters/MockAdapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../../src/adapters/MockAdapter';

describe('MockAdapter', () => {
  const adapter = new MockAdapter();

  it('has type "mock"', () => {
    expect(adapter.type).toBe('mock');
  });

  it('generates the canonical GET /users/{id} mapping', async () => {
    const drafts = await adapter.generateMappings(await adapter.introspect({ connectionId: 'c1' }));
    expect(drafts).toEqual([
      {
        route: '/users/{id}',
        method: 'GET',
        operation: {
          query: 'user(id: $id) { id, displayName, mail }',
          variables: { id: '$params.id' },
        },
        responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
      },
    ]);
  });

  it('executes and returns a canned user shaped by the requested id', async () => {
    const result = await adapter.execute({}, { id: '42' }, { connectionId: 'c1' });
    expect(result).toEqual({ id: '42', displayName: 'Mock User', mail: 'mock@example.com' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/adapters/MockAdapter.test.ts`
Expected: FAIL — `../../src/adapters/MockAdapter` does not exist.

- [ ] **Step 3: Implement MockAdapter and defaults**

`packages/core/src/adapters/MockAdapter.ts`:
```ts
import type { Adapter, AuthContext, MappingDraft } from './Adapter';

export class MockAdapter implements Adapter {
  readonly type = 'mock';

  async introspect(_authContext: AuthContext): Promise<unknown> {
    return { types: [{ name: 'user', fields: ['id', 'displayName', 'mail'] }] };
  }

  async generateMappings(_introspection: unknown): Promise<MappingDraft[]> {
    return [
      {
        route: '/users/{id}',
        method: 'GET',
        operation: {
          query: 'user(id: $id) { id, displayName, mail }',
          variables: { id: '$params.id' },
        },
        responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
      },
    ];
  }

  async execute(
    _operation: Record<string, unknown>,
    params: Record<string, string>,
    _authContext: AuthContext
  ): Promise<unknown> {
    return { id: params.id, displayName: 'Mock User', mail: 'mock@example.com' };
  }
}
```

`packages/core/src/adapters/defaults.ts`:
```ts
import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/adapters/MockAdapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/MockAdapter.ts packages/core/src/adapters/defaults.ts packages/core/test/adapters/MockAdapter.test.ts
git commit -m "feat(core): add MockAdapter as the walking-skeleton vendor stub" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 4: SQLite migrations + `openDb`

**Files:**
- Create: `packages/core/src/storage/migrations.ts`
- Create: `packages/core/src/storage/db.ts`
- Test: `packages/core/test/storage/db.test.ts`

**Interfaces:**
- Produces: `openDb(filePath: string): Database.Database` (the `better-sqlite3` handle type), tables `connections`, `mappings`, `api_keys`, `admin_users` per spec §8.

- [ ] **Step 1: Write the failing test**

`packages/core/test/storage/db.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';

const tmpFiles: string[] = [];

function tmpDbPath(): string {
  const file = path.join(os.tmpdir(), `graphtorest-test-${Date.now()}-${Math.random()}.db`);
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
    }
  }
});

describe('openDb', () => {
  it('creates all four tables from a fresh file', () => {
    const db = openDb(tmpDbPath());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['admin_users', 'api_keys', 'connections', 'mappings']);
    db.close();
  });

  it('creates the parent directory if it does not exist', () => {
    const nested = path.join(os.tmpdir(), `graphtorest-nested-${Date.now()}`, 'sub', 'db.sqlite');
    tmpFiles.push(nested);
    const db = openDb(nested);
    expect(fs.existsSync(nested)).toBe(true);
    db.close();
    fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
  });

  it('is idempotent across repeated opens of the same file', () => {
    const file = tmpDbPath();
    openDb(file).close();
    const db = openDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.length).toBe(4);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/storage/db.test.ts`
Expected: FAIL — `../../src/storage/db` does not exist.

- [ ] **Step 3: Implement migrations and db.ts**

`packages/core/src/storage/migrations.ts`:
```ts
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    adapter_type TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    credentials_encrypted TEXT,
    schema_cache TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id),
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    operation TEXT NOT NULL,
    response_template TEXT,
    source TEXT NOT NULL DEFAULT 'generated',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(method, route)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    hashed_key TEXT NOT NULL,
    label TEXT,
    rate_limit_config TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    hashed_password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];
```

`packages/core/src/storage/db.ts`:
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
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/storage/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/storage packages/core/test/storage/db.test.ts
git commit -m "feat(core): add SQLite migrations and openDb" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 5: API key generation, hashing, and verification

**Files:**
- Create: `packages/core/src/auth/apiKeys.ts`
- Test: `packages/core/test/auth/apiKeys.test.ts`

**Interfaces:**
- Produces: `interface GeneratedApiKey { id: string; plaintext: string; hashedSecret: string }`, `generateApiKey(): GeneratedApiKey`, `hashSecret(secret: string): string`, `verifySecret(secret: string, hashedSecret: string): boolean`, `parsePresentedKey(presented: string): { id: string; secret: string } | null`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/auth/apiKeys.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { generateApiKey, verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

describe('apiKeys', () => {
  it('generates a plaintext key in the form "<id>.<secret>"', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^[0-9a-f]{12}\.[A-Za-z0-9_-]+$/);
    expect(key.plaintext.startsWith(key.id + '.')).toBe(true);
  });

  it('verifies the correct secret against the stored hash', () => {
    const key = generateApiKey();
    const parsed = parsePresentedKey(key.plaintext);
    expect(parsed).not.toBeNull();
    expect(verifySecret(parsed!.secret, key.hashedSecret)).toBe(true);
  });

  it('rejects an incorrect secret', () => {
    const key = generateApiKey();
    expect(verifySecret('wrong-secret', key.hashedSecret)).toBe(false);
  });

  it('returns null for a presented key with no separator', () => {
    expect(parsePresentedKey('not-a-valid-key')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/auth/apiKeys.test.ts`
Expected: FAIL — `../../src/auth/apiKeys` does not exist.

- [ ] **Step 3: Implement apiKeys.ts**

`packages/core/src/auth/apiKeys.ts`:
```ts
import crypto from 'node:crypto';

export interface GeneratedApiKey {
  id: string;
  plaintext: string;
  hashedSecret: string;
}

export function generateApiKey(): GeneratedApiKey {
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const hashedSecret = hashSecret(secret);
  return { id, plaintext: `${id}.${secret}`, hashedSecret };
}

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(secret: string, hashedSecret: string): boolean {
  const [salt, storedHex] = hashedSecret.split(':');
  if (!salt || !storedHex) return false;
  const derived = crypto.scryptSync(secret, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

export function parsePresentedKey(presented: string): { id: string; secret: string } | null {
  const idx = presented.indexOf('.');
  if (idx === -1) return null;
  return { id: presented.slice(0, idx), secret: presented.slice(idx + 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/auth/apiKeys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth packages/core/test/auth/apiKeys.test.ts
git commit -m "feat(core): add API key generation, hashing, and verification" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 6: MappingStore (SQLite CRUD)

**Files:**
- Create: `packages/core/src/storage/MappingStore.ts`
- Test: `packages/core/test/storage/MappingStore.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 4, `../storage/db`); `generateApiKey`, `GeneratedApiKey` (Task 5, `../auth/apiKeys`).
- Produces: `interface ConnectionRecord { id, name, adapterType, authMode }`; `interface MappingRecord { id, connectionId, route, method, operation: Record<string, unknown>, responseTemplate: Record<string,string> | null, source: 'generated' | 'manual' }`; `class MappingStore` with `createConnection`, `getConnection`, `listConnections`, `createMapping`, `listMappings`, `createApiKey`, `findApiKeyById`, `touchApiKeyLastUsed`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/storage/MappingStore.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

let dbPath: string;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-mappingstore-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
});

afterEach(() => {
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/storage/MappingStore.test.ts`
Expected: FAIL — `../../src/storage/MappingStore` does not exist.

- [ ] **Step 3: Implement MappingStore.ts**

`packages/core/src/storage/MappingStore.ts`:
```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { generateApiKey, type GeneratedApiKey } from '../auth/apiKeys';

export interface ConnectionRecord {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
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

interface MappingRow {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: string;
  responseTemplate: string | null;
  source: 'generated' | 'manual';
}

export class MappingStore {
  constructor(private db: Database.Database) {}

  createConnection(input: { name: string; adapterType: string; authMode: string }): ConnectionRecord {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO connections (id, name, adapter_type, auth_mode) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.adapterType, input.authMode);
    return { id, name: input.name, adapterType: input.adapterType, authMode: input.authMode };
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode FROM connections WHERE id = ?')
      .get(id) as ConnectionRecord | undefined;
    return row ?? null;
  }

  listConnections(): ConnectionRecord[] {
    return this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode FROM connections')
      .all() as ConnectionRecord[];
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

  listMappings(): MappingRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, connection_id as connectionId, route, method, operation, response_template as responseTemplate, source FROM mappings'
      )
      .all() as MappingRow[];
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      route: row.route,
      method: row.method,
      operation: JSON.parse(row.operation),
      responseTemplate: row.responseTemplate ? JSON.parse(row.responseTemplate) : null,
      source: row.source,
    }));
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/storage/MappingStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/storage/MappingStore.ts packages/core/test/storage/MappingStore.test.ts
git commit -m "feat(core): add MappingStore CRUD over connections/mappings/api_keys" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 7: Route matcher

**Files:**
- Create: `packages/core/src/gateway/matchRoute.ts`
- Test: `packages/core/test/gateway/matchRoute.test.ts`

**Interfaces:**
- Produces: `matchRoute(pattern: string, actualPath: string): Record<string, string> | null`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/gateway/matchRoute.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { matchRoute } from '../../src/gateway/matchRoute';

describe('matchRoute', () => {
  it('matches a single path parameter and extracts it', () => {
    expect(matchRoute('/users/{id}', '/users/42')).toEqual({ id: '42' });
  });

  it('matches multiple path parameters', () => {
    expect(matchRoute('/orgs/{org}/repos/{repo}', '/orgs/acme/repos/widgets')).toEqual({
      org: 'acme',
      repo: 'widgets',
    });
  });

  it('returns null when segment counts differ', () => {
    expect(matchRoute('/users/{id}', '/users/42/extra')).toBeNull();
  });

  it('returns null when a literal segment does not match', () => {
    expect(matchRoute('/users/{id}', '/groups/42')).toBeNull();
  });

  it('matches a route with no parameters', () => {
    expect(matchRoute('/health', '/health')).toEqual({});
  });

  it('decodes URI-encoded parameter values', () => {
    expect(matchRoute('/users/{id}', '/users/a%20b')).toEqual({ id: 'a b' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/gateway/matchRoute.test.ts`
Expected: FAIL — `../../src/gateway/matchRoute` does not exist.

- [ ] **Step 3: Implement matchRoute.ts**

`packages/core/src/gateway/matchRoute.ts`:
```ts
export function matchRoute(pattern: string, actualPath: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const actualSegments = actualPath.split('/').filter(Boolean);
  if (patternSegments.length !== actualSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const actualSegment = actualSegments[i];
    if (patternSegment.startsWith('{') && patternSegment.endsWith('}')) {
      params[patternSegment.slice(1, -1)] = decodeURIComponent(actualSegment);
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/gateway/matchRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gateway/matchRoute.ts packages/core/test/gateway/matchRoute.test.ts
git commit -m "feat(core): add route pattern matcher" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 8: GatewayEngine + error normalization

**Files:**
- Create: `packages/core/src/gateway/errors.ts`
- Create: `packages/core/src/gateway/GatewayEngine.ts`
- Test: `packages/core/test/gateway/GatewayEngine.test.ts`

**Interfaces:**
- Consumes: `MappingStore`, `MappingRecord` (Task 6, `../storage/MappingStore`); `createAdapter` (Task 2, `../adapters/registry`); `registerAdapter` and `MockAdapter` (Tasks 2–3, for the test only); `matchRoute` (Task 7, `./matchRoute`).
- Produces: `class GatewayError extends Error { code: string; status: number; details: Record<string, unknown> }`; `toErrorResponse(err: unknown): { status: number; body: { error: { code: string; message: string; details: Record<string, unknown> } } }`; `interface ResolvedRequest { mapping: MappingRecord; params: Record<string, string> }`; `class GatewayEngine { constructor(mappingStore: MappingStore); resolve(method: string, path: string): ResolvedRequest | null; handle(method: string, path: string, incomingAuth?: { vendorToken?: string }): Promise<unknown> }`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/gateway/GatewayEngine.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { GatewayError } from '../../src/gateway/errors';
import { registerAdapter } from '../../src/adapters/registry';
import { MockAdapter } from '../../src/adapters/MockAdapter';

let dbPath: string;
let store: MappingStore;
let engine: GatewayEngine;

beforeEach(() => {
  registerAdapter('mock', () => new MockAdapter());
  dbPath = path.join(os.tmpdir(), `graphtorest-gateway-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  engine = new GatewayEngine(store);
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seedUserMapping() {
  const connection = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
  return store.createMapping({
    connectionId: connection.id,
    route: '/users/{id}',
    method: 'GET',
    operation: { query: 'user(id: $id) { id, displayName, mail }', variables: { id: '$params.id' } },
    responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
  });
}

describe('GatewayEngine.resolve', () => {
  it('finds a mapping matching method and path, extracting params', () => {
    seedUserMapping();
    const resolved = engine.resolve('GET', '/users/42');
    expect(resolved?.params).toEqual({ id: '42' });
  });

  it('returns null when no mapping matches', () => {
    seedUserMapping();
    expect(engine.resolve('GET', '/groups/42')).toBeNull();
  });

  it('is case-insensitive on method', () => {
    seedUserMapping();
    expect(engine.resolve('get', '/users/42')).not.toBeNull();
  });
});

describe('GatewayEngine.handle', () => {
  it('resolves variables from params, executes the adapter, and shapes the response by template', async () => {
    seedUserMapping();
    const result = await engine.handle('GET', '/users/42');
    expect(result).toEqual({ id: '42', name: 'Mock User', email: 'mock@example.com' });
  });

  it('throws a 404 GatewayError when no mapping matches', async () => {
    seedUserMapping();
    await expect(engine.handle('GET', '/nowhere')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(engine.handle('GET', '/nowhere')).rejects.toBeInstanceOf(GatewayError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/gateway/GatewayEngine.test.ts`
Expected: FAIL — `../../src/gateway/GatewayEngine` and `../../src/gateway/errors` don't exist.

- [ ] **Step 3: Implement errors.ts and GatewayEngine.ts**

`packages/core/src/gateway/errors.ts`:
```ts
export class GatewayError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string; details: Record<string, unknown> } };
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof GatewayError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } } };
}
```

`packages/core/src/gateway/GatewayEngine.ts`:
```ts
import type { MappingStore, MappingRecord } from '../storage/MappingStore';
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

  async handle(method: string, path: string, incomingAuth: { vendorToken?: string } = {}): Promise<unknown> {
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
    const raw = await adapter.execute(operation, params, {
      connectionId: connection.id,
      vendorToken: incomingAuth.vendorToken,
    });
    return shapeResponse(raw, mapping.responseTemplate);
  }
}

function resolveVariables(operation: Record<string, unknown>, params: Record<string, string>): Record<string, unknown> {
  const variables = operation.variables as Record<string, unknown> | undefined;
  if (!variables) return operation;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string' && value.startsWith('$params.')) {
      resolved[key] = params[value.slice('$params.'.length)];
    } else {
      resolved[key] = value;
    }
  }
  return { ...operation, variables: resolved };
}

function shapeResponse(raw: unknown, template: Record<string, string> | null): unknown {
  if (!template) return raw;
  const shaped: Record<string, unknown> = {};
  for (const [key, pointer] of Object.entries(template)) {
    shaped[key] = resolvePointer(raw, pointer);
  }
  return shaped;
}

function resolvePointer(raw: unknown, pointer: string): unknown {
  if (!pointer.startsWith('$.')) return undefined;
  let current: unknown = raw;
  for (const segment of pointer.slice(2).split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/gateway/GatewayEngine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gateway packages/core/test/gateway/GatewayEngine.test.ts
git commit -m "feat(core): add GatewayEngine and normalized error responses" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 9: OpenApiGenerator

**Files:**
- Create: `packages/core/src/openapi/OpenApiGenerator.ts`
- Test: `packages/core/test/openapi/OpenApiGenerator.test.ts`

**Interfaces:**
- Consumes: `MappingRecord` (Task 6, `../storage/MappingStore`).
- Produces: `class OpenApiGenerator { generate(mappings: MappingRecord[]): Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/openapi/OpenApiGenerator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { OpenApiGenerator } from '../../src/openapi/OpenApiGenerator';
import type { MappingRecord } from '../../src/storage/MappingStore';

const mapping: MappingRecord = {
  id: 'm1',
  connectionId: 'c1',
  route: '/users/{id}',
  method: 'GET',
  operation: {},
  responseTemplate: { id: '$.id', name: '$.displayName' },
  source: 'generated',
};

describe('OpenApiGenerator', () => {
  const generator = new OpenApiGenerator();

  it('produces a valid OpenAPI 3 envelope', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('GraphToRest API');
  });

  it('adds a path item keyed by the route with a lowercase method', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get).toBeDefined();
  });

  it('declares path parameters extracted from the route', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('declares a 200 JSON response', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json']).toBeDefined();
  });

  it('returns an empty paths object for no mappings', () => {
    const doc = generator.generate([]) as any;
    expect(doc.paths).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/openapi/OpenApiGenerator.test.ts`
Expected: FAIL — `../../src/openapi/OpenApiGenerator` does not exist.

- [ ] **Step 3: Implement OpenApiGenerator.ts**

`packages/core/src/openapi/OpenApiGenerator.ts`:
```ts
import type { MappingRecord } from '../storage/MappingStore';

export class OpenApiGenerator {
  generate(mappings: MappingRecord[]): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const mapping of mappings) {
      const pathItem = paths[mapping.route] ?? (paths[mapping.route] = {});
      const paramNames = [...mapping.route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      pathItem[mapping.method.toLowerCase()] = {
        operationId: `${mapping.method.toLowerCase()}_${mapping.route.replace(/[/{}]/g, '_')}`,
        parameters: paramNames.map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/openapi/OpenApiGenerator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/openapi packages/core/test/openapi/OpenApiGenerator.test.ts
git commit -m "feat(core): add OpenAPI 3 generator over the mapping set" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 10: Core public barrel export + full build verification

**Files:**
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Produces: single public entry point re-exporting everything Tasks 2–9 built, which `apps/server` and `apps/cli` import as `@graphtorest/core`.

- [ ] **Step 1: Write the barrel file**

`packages/core/src/index.ts`:
```ts
export type { Adapter, AuthContext, MappingDraft } from './adapters/Adapter';
export { registerAdapter, createAdapter } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
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

- [ ] **Step 2: Run the full core test suite**

Run: `npx vitest run packages/core`
Expected: PASS — every test file from Tasks 1–9 passes.

- [ ] **Step 3: Build core and verify declaration files are emitted**

Run: `npm run build -w @graphtorest/core`
Expected: exits 0; `packages/core/dist/index.js` and `packages/core/dist/index.d.ts` exist and re-export everything above.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add public barrel export" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 11: `apps/server` scaffold + config

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Produces: `interface ServerConfig { port: number; dbPath: string; apiEnabled: boolean; adminEnabled: boolean }`, `loadConfig(env?: NodeJS.ProcessEnv): ServerConfig`.

- [ ] **Step 1: Scaffold the package**

`apps/server/package.json`:
```json
{
  "name": "@graphtorest/server",
  "version": "0.1.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@graphtorest/core": "*",
    "express": "^4.21.0",
    "swagger-ui-express": "^5.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.2",
    "@types/swagger-ui-express": "^4.1.6",
    "supertest": "^7.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({ port: 3000, dbPath: './data/graphtorest.db', apiEnabled: true, adminEnabled: true });
  });

  it('reads overrides from the given env', () => {
    const config = loadConfig({ PORT: '8080', DB_PATH: '/data/gtr.db', API_ENABLED: 'false', ADMIN_ENABLED: 'false' });
    expect(config).toEqual({ port: 8080, dbPath: '/data/gtr.db', apiEnabled: false, adminEnabled: false });
  });
});
```

- [ ] **Step 3: Run `npm install` then run test to verify it fails**

Run: `npm install && npx vitest run apps/server/test/config.test.ts`
Expected: FAIL — `../src/config` does not exist.

- [ ] **Step 4: Implement config.ts**

`apps/server/src/config.ts`:
```ts
export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/server/test/config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json apps/server/tsconfig.json apps/server/src/config.ts apps/server/test/config.test.ts
git commit -m "chore(server): scaffold apps/server and add config loader" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 12: Server wiring end-to-end (auth middleware, routers, app, bootstrap)

**Files:**
- Create: `apps/server/src/middleware/apiKeyAuth.ts`
- Create: `apps/server/src/routers/apiRouter.ts`
- Create: `apps/server/src/routers/adminRouter.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Test: `apps/server/test/integration.test.ts`

**Interfaces:**
- Consumes from `@graphtorest/core` (Task 10): `MappingStore`, `GatewayEngine`, `OpenApiGenerator`, `openDb`, `registerDefaultAdapters`, `toErrorResponse`, `parsePresentedKey`, `verifySecret`.
- Consumes: `loadConfig`, `ServerConfig` (Task 11, `../config`).
- Produces: `createApiKeyAuth(mappingStore: MappingStore): RequestHandler`; `createApiRouter(gatewayEngine: GatewayEngine): Router`; `createAdminRouter(mappingStore: MappingStore): Router`; `interface AppDeps { mappingStore, gatewayEngine, openApiGenerator, apiEnabled, adminEnabled }`; `createApp(deps: AppDeps): Express`.

- [ ] **Step 1: Write the failing integration test**

`apps/server/test/integration.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let mappingStore: MappingStore;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-server-${Date.now()}-${Math.random()}.db`);
  mappingStore = new MappingStore(openDb(dbPath));
  const gatewayEngine = new GatewayEngine(mappingStore);
  const openApiGenerator = new OpenApiGenerator();
  app = createApp({ mappingStore, gatewayEngine, openApiGenerator, apiEnabled: true, adminEnabled: true });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedUserRoute() {
  const connectionRes = await request(app)
    .post('/admin/connections')
    .send({ name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
  const connectionId = connectionRes.body.id;
  await request(app)
    .post('/admin/mappings')
    .send({
      connectionId,
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id, displayName, mail }', variables: { id: '$params.id' } },
      responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
    });
  const apiKeyRes = await request(app).post('/admin/api-keys').send({ label: 'test' });
  return apiKeyRes.body.plaintext as string;
}

describe('server integration', () => {
  it('serves the resolved mapping for an authenticated request', async () => {
    const apiKey = await seedUserRoute();
    const res = await request(app).get('/api/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42', name: 'Mock User', email: 'mock@example.com' });
  });

  it('rejects requests with no Authorization header', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/users/42');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with an invalid API key', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/users/42').set('Authorization', 'Bearer bogus.key');
    expect(res.status).toBe(401);
  });

  it('returns a normalized 404 for an unmapped route', async () => {
    const apiKey = await seedUserRoute();
    const res = await request(app).get('/api/nowhere').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No mapping for GET /nowhere', details: {} } });
  });

  it('serves a generated OpenAPI document including the seeded route', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/users/{id}'].get).toBeDefined();
  });

  it('mounts Swagger UI at /api/docs', async () => {
    await seedUserRoute();
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/integration.test.ts`
Expected: FAIL — `../src/app` does not exist (and `@graphtorest/core` may need rebuilding — run `npm run build -w @graphtorest/core` first if the import itself fails to resolve).

- [ ] **Step 3: Implement the middleware, routers, app, and bootstrap**

`apps/server/src/middleware/apiKeyAuth.ts`:
```ts
import type { RequestHandler } from 'express';
import { parsePresentedKey, verifySecret, type MappingStore } from '@graphtorest/core';

export function createApiKeyAuth(mappingStore: MappingStore): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing API key', details: {} } });
      return;
    }
    const parsed = parsePresentedKey(match[1]);
    const record = parsed ? mappingStore.findApiKeyById(parsed.id) : null;
    if (!parsed || !record || !verifySecret(parsed.secret, record.hashedKey)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key', details: {} } });
      return;
    }
    mappingStore.touchApiKeyLastUsed(record.id);
    next();
  };
}
```

`apps/server/src/routers/apiRouter.ts`:
```ts
import { Router } from 'express';
import { toErrorResponse, type GatewayEngine } from '@graphtorest/core';

export function createApiRouter(gatewayEngine: GatewayEngine): Router {
  const router = Router();
  router.use(async (req, res) => {
    try {
      const result = await gatewayEngine.handle(req.method, req.path);
      res.json(result);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });
  return router;
}
```

`apps/server/src/routers/adminRouter.ts`:
```ts
import { Router } from 'express';
import type { MappingStore } from '@graphtorest/core';

export function createAdminRouter(mappingStore: MappingStore): Router {
  const router = Router();

  router.post('/connections', (req, res) => {
    const { name, adapterType, authMode } = req.body ?? {};
    if (!name || !adapterType || !authMode) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name, adapterType, authMode required', details: {} } });
      return;
    }
    res.status(201).json(mappingStore.createConnection({ name, adapterType, authMode }));
  });

  router.get('/connections', (_req, res) => {
    res.json(mappingStore.listConnections());
  });

  router.post('/mappings', (req, res) => {
    const { connectionId, route, method, operation, responseTemplate, source } = req.body ?? {};
    if (!connectionId || !route || !method || !operation) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'connectionId, route, method, operation required', details: {} },
      });
      return;
    }
    res.status(201).json(
      mappingStore.createMapping({ connectionId, route, method, operation, responseTemplate, source })
    );
  });

  router.get('/mappings', (_req, res) => {
    res.json(mappingStore.listMappings());
  });

  router.post('/api-keys', (req, res) => {
    const { label } = req.body ?? {};
    const created = mappingStore.createApiKey({ label });
    res.status(201).json({ id: created.id, plaintext: created.plaintext, label: created.label });
  });

  return router;
}
```

`apps/server/src/app.ts`:
```ts
import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { MappingStore, GatewayEngine, OpenApiGenerator } from '@graphtorest/core';
import { createApiKeyAuth } from './middleware/apiKeyAuth';
import { createApiRouter } from './routers/apiRouter';
import { createAdminRouter } from './routers/adminRouter';

export interface AppDeps {
  mappingStore: MappingStore;
  gatewayEngine: GatewayEngine;
  openApiGenerator: OpenApiGenerator;
  apiEnabled: boolean;
  adminEnabled: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  if (deps.apiEnabled) {
    app.get('/api/openapi.json', (_req, res) => {
      res.json(deps.openApiGenerator.generate(deps.mappingStore.listMappings()));
    });
    app.use(
      '/api/docs',
      swaggerUi.serve,
      swaggerUi.setup(deps.openApiGenerator.generate(deps.mappingStore.listMappings()))
    );
    app.use('/api', createApiKeyAuth(deps.mappingStore), createApiRouter(deps.gatewayEngine));
  }

  if (deps.adminEnabled) {
    app.use('/admin', createAdminRouter(deps.mappingStore));
  }

  return app;
}
```

> Note: `/api/docs` snapshots the OpenAPI doc at app-creation time, so routes added after the app starts won't appear there until restart. Live-refreshing Swagger UI is deferred to Plan 4/6.

`apps/server/src/index.ts`:
```ts
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';

registerDefaultAdapters();
const config = loadConfig();
const db = openDb(config.dbPath);
const mappingStore = new MappingStore(db);
const gatewayEngine = new GatewayEngine(mappingStore);
const openApiGenerator = new OpenApiGenerator();

const app = createApp({
  mappingStore,
  gatewayEngine,
  openApiGenerator,
  apiEnabled: config.apiEnabled,
  adminEnabled: config.adminEnabled,
});

app.listen(config.port, () => {
  console.log(JSON.stringify({ msg: 'server_started', port: config.port, dbPath: config.dbPath }));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/integration.test.ts`
Expected: PASS

- [ ] **Step 5: Build the server package**

Run: `npm run build -w @graphtorest/server`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src apps/server/test/integration.test.ts
git commit -m "feat(server): wire api/admin routers, api-key auth, and OpenAPI/Swagger endpoints" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 13: `apps/cli` (`gtr`) embedded mode

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/bin/gtr.js`
- Create: `apps/cli/src/embeddedClient.ts`
- Create: `apps/cli/src/commands/connectionCreate.ts`
- Create: `apps/cli/src/commands/mappingCreate.ts`
- Create: `apps/cli/src/commands/apiKeyCreate.ts`
- Create: `apps/cli/src/index.ts`
- Test: `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes from `@graphtorest/core` (Task 10): `openDb`, `MappingStore`, `registerDefaultAdapters`.
- Produces: `openEmbeddedStore(dbPath: string): MappingStore`; `connectionCreate(store, args: {name, adapterType, authMode})`; `parseRoute(combined: string): {method: string; route: string}`; `mappingCreate(store, args: {connectionId, route, operation, responseTemplate?})`; `apiKeyCreate(store, args: {label?})`.

> Note: this plan implements embedded (headless) mode only, with flat command names (`connection-create`, `mapping-create`, `apikey-create`). Remote mode, `--server` auto-detection, and nested command UX (`gtr connection create`) are Plan 7.

- [ ] **Step 1: Scaffold the package**

`apps/cli/package.json`:
```json
{
  "name": "@graphtorest/cli",
  "version": "0.1.0",
  "bin": { "gtr": "./bin/gtr.js" },
  "main": "dist/index.js",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@graphtorest/core": "*",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`apps/cli/bin/gtr.js`:
```js
#!/usr/bin/env node
require('../dist/index.js');
```

Run: `chmod +x apps/cli/bin/gtr.js`

- [ ] **Step 2: Write the failing test**

`apps/cli/test/commands.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingCreate, parseRoute } from '../src/commands/mappingCreate';
import { apiKeyCreate } from '../src/commands/apiKeyCreate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-cli-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('parseRoute', () => {
  it('splits "METHOD /path" into method and route', () => {
    expect(parseRoute('GET /users/{id}')).toEqual({ method: 'GET', route: '/users/{id}' });
  });
});

describe('CLI embedded commands', () => {
  it('connectionCreate persists a connection queryable via the same store', () => {
    const store = freshStore();
    const created = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    expect(store.getConnection(created.id)).toEqual(created);
  });

  it('mappingCreate parses the combined route and marks the mapping manual', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const mapping = mappingCreate(store, {
      connectionId: connection.id,
      route: 'GET /users/{id}',
      operation: { query: 'user(id: $id) { id }' },
    });
    expect(mapping.method).toBe('GET');
    expect(mapping.route).toBe('/users/{id}');
    expect(mapping.source).toBe('manual');
  });

  it('apiKeyCreate returns a plaintext key that round-trips through the store', () => {
    const store = freshStore();
    const created = apiKeyCreate(store, { label: 'ci' });
    expect(store.findApiKeyById(created.id)?.id).toBe(created.id);
  });
});
```

- [ ] **Step 3: Run `npm install` then run test to verify it fails**

Run: `npm install && npx vitest run apps/cli/test/commands.test.ts`
Expected: FAIL — none of `../src/embeddedClient`, `../src/commands/*` exist.

- [ ] **Step 4: Implement embeddedClient, commands, and CLI entry**

`apps/cli/src/embeddedClient.ts`:
```ts
import { openDb, MappingStore, registerDefaultAdapters } from '@graphtorest/core';

export function openEmbeddedStore(dbPath: string): MappingStore {
  registerDefaultAdapters();
  return new MappingStore(openDb(dbPath));
}
```

`apps/cli/src/commands/connectionCreate.ts`:
```ts
import type { MappingStore, ConnectionRecord } from '@graphtorest/core';

export function connectionCreate(
  store: MappingStore,
  args: { name: string; adapterType: string; authMode: string }
): ConnectionRecord {
  return store.createConnection(args);
}
```

`apps/cli/src/commands/mappingCreate.ts`:
```ts
import type { MappingStore, MappingRecord } from '@graphtorest/core';

export function parseRoute(combined: string): { method: string; route: string } {
  const [method, ...rest] = combined.trim().split(/\s+/);
  return { method: method.toUpperCase(), route: rest.join(' ') };
}

export function mappingCreate(
  store: MappingStore,
  args: {
    connectionId: string;
    route: string;
    operation: Record<string, unknown>;
    responseTemplate?: Record<string, string>;
  }
): MappingRecord {
  const { method, route } = parseRoute(args.route);
  return store.createMapping({
    connectionId: args.connectionId,
    method,
    route,
    operation: args.operation,
    responseTemplate: args.responseTemplate ?? null,
    source: 'manual',
  });
}
```

`apps/cli/src/commands/apiKeyCreate.ts`:
```ts
import type { MappingStore, ApiKeyRecord, GeneratedApiKey } from '@graphtorest/core';

export function apiKeyCreate(store: MappingStore, args: { label?: string }): GeneratedApiKey & ApiKeyRecord {
  return store.createApiKey(args);
}
```

`apps/cli/src/index.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { openEmbeddedStore } from './embeddedClient';
import { connectionCreate } from './commands/connectionCreate';
import { mappingCreate } from './commands/mappingCreate';
import { apiKeyCreate } from './commands/apiKeyCreate';

const program = new Command();
program.name('gtr').option('--db <path>', 'SQLite file path', process.env.DB_PATH ?? './data/graphtorest.db');

program
  .command('connection-create')
  .requiredOption('--name <name>')
  .requiredOption('--adapter-type <type>')
  .requiredOption('--auth-mode <mode>')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    console.log(JSON.stringify(connectionCreate(store, opts), null, 2));
  });

program
  .command('mapping-create')
  .requiredOption('--connection-id <id>')
  .requiredOption('--route <route>', 'e.g. "GET /users/{id}"')
  .requiredOption('--operation <json>', 'JSON-encoded operation object')
  .option('--response-template <json>', 'JSON-encoded response template')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingCreate(store, {
      connectionId: opts.connectionId,
      route: opts.route,
      operation: JSON.parse(opts.operation),
      responseTemplate: opts.responseTemplate ? JSON.parse(opts.responseTemplate) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('apikey-create')
  .option('--label <label>')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    console.log(JSON.stringify(apiKeyCreate(store, { label: opts.label }), null, 2));
  });

program.parse();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/cli/test/commands.test.ts`
Expected: PASS

- [ ] **Step 6: Build the CLI package**

Run: `npm run build -w @graphtorest/cli`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): add gtr embedded-mode commands for connections, mappings, and api keys" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

### Task 14: Dockerfile, docker-compose, and manual end-to-end verification

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: nothing new — packages the artifacts from Tasks 1–13.

- [ ] **Step 1: Run the full test suite and full build once more before packaging**

Run: `npm test && npm run build`
Expected: all tests pass, all three packages build.

- [ ] **Step 2: Write the Dockerfile**

`Dockerfile`:
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
RUN npm ci
COPY packages/core packages/core
COPY apps/server apps/server
COPY apps/cli apps/cli
RUN npm run build --workspaces --if-present

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/graphtorest.db
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/core packages/core
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/cli apps/cli
EXPOSE 3000
ENTRYPOINT ["node", "apps/server/dist/index.js"]
```

> Note: `node:20-slim` (Debian/glibc) is used instead of `node:20-alpine` because `better-sqlite3` ships prebuilt binaries targeting glibc; alpine (musl) would force a from-source compile in both stages. The runtime image keeps `node_modules` as built (including devDependencies) rather than pruning — image-size optimization is deferred to Plan 8.

- [ ] **Step 3: Write docker-compose.yml**

`docker-compose.yml`:
```yaml
services:
  graphtorest:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - graphtorest-data:/data
    environment:
      PORT: "3000"
      DB_PATH: /data/graphtorest.db

volumes:
  graphtorest-data:
```

- [ ] **Step 4: Build the image**

Run: `docker compose build`
Expected: exits 0.

- [ ] **Step 5: Start the server and verify it's listening**

Run: `docker compose up -d && sleep 2 && docker compose logs graphtorest`
Expected: logs contain a JSON line like `{"msg":"server_started","port":3000,"dbPath":"/data/graphtorest.db"}`.

- [ ] **Step 6: Use the CLI against the same running container's volume to seed data**

Run:
```bash
docker compose run --rm --entrypoint gtr graphtorest connection-create --name c1 --adapter-type mock --auth-mode passthrough
```
Expected: prints a JSON connection record; note its `id`.

```bash
docker compose run --rm --entrypoint gtr graphtorest mapping-create \
  --connection-id <id-from-previous-step> \
  --route "GET /users/{id}" \
  --operation '{"query":"user(id: $id) { id, displayName, mail }","variables":{"id":"$params.id"}}' \
  --response-template '{"id":"$.id","name":"$.displayName","email":"$.mail"}'
```
Expected: prints a JSON mapping record with `"source":"manual"`.

```bash
docker compose run --rm --entrypoint gtr graphtorest apikey-create --label smoke-test
```
Expected: prints a JSON object with a `plaintext` field; note it.

- [ ] **Step 7: Call the running server's REST API with the seeded mapping and API key**

Run: `curl -s -H "Authorization: Bearer <plaintext-from-previous-step>" http://localhost:3000/api/users/42`
Expected: `{"id":"42","name":"Mock User","email":"mock@example.com"}`

Run: `curl -s http://localhost:3000/api/openapi.json | head -c 200`
Expected: JSON starting with `{"openapi":"3.0.3",...` and containing `/users/{id}`.

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/docs/`
Expected: `200`

- [ ] **Step 8: Tear down**

Run: `docker compose down -v`

- [ ] **Step 9: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore: add Docker image and compose file for server+CLI against shared SQLite volume" --author "Garrett Martin <grrttmrtn@live.com>"
```

---

## Definition of Done for Plan 1

- `npm test` passes across all three workspaces.
- `npm run build` produces `dist/` for `packages/core`, `apps/server`, `apps/cli`.
- `docker compose up` serves a working `GET /api/users/{id}` end to end, authenticated by a proxy-issued API key, with a live `/api/openapi.json` and `/api/docs`.
- The same Docker image's `gtr` entrypoint can create connections/mappings/API keys against the same mounted SQLite file the running server uses (spec §3's "both simultaneously" claim).
- Everything under "Out of scope" at the top of each task (admin auth, real adapters, pagination, rate limiting/caching, webUI, remote CLI mode) is explicitly deferred to a named plan in `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md`, not silently dropped.

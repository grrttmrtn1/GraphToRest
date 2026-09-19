# GraphToRest Plan 5: Auth Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two auth gaps left by Plans 1–4: (1) lock `/admin/*` behind a local username/password admin login, and (2) implement `managed` proxy→vendor auth — encrypted-at-rest vendor credentials, client-credentials and authorization-code OAuth flows, and transparent token refresh — so a developer on a `managed` connection needs only a proxy API key.

**Architecture:** Everything security-relevant lives in `packages/core/src/auth/` (a `CredentialCipher` using AES-256-GCM from `node:crypto`; admin login/session helpers; a generic OAuth2 client built on Node's built-in `fetch`; a `ManagedTokenService` that owns credential storage, token caching, single-flight refresh, and the authorization-code state/PKCE bookkeeping). `MappingStore` only ever sees opaque encrypted strings for credentials and hashed tokens for sessions. `GatewayEngine`, the admin generate route and the CLI's `mapping-generate` all build their `AuthContext` through one shared `buildAuthContext` function, so the adapters stay unchanged apart from accepting `authMode: "managed"` (the token has already been resolved into `vendorToken` by then). `apps/server` gains an admin-auth middleware, login/logout/admin-user routes, credential + OAuth routes, and config for the encryption key and public base URL. The CLI gains `admin-create`, `admin-set-password` and `connection-credentials`. The plan also carries over the Plan 4 admin-API validation findings.

**Tech Stack:** No new dependency anywhere. `node:crypto` (AES-256-GCM, scrypt via the existing `hashSecret`, SHA-256 for session-token lookup), Node's built-in `fetch` for token endpoints (nock@14 already intercepts it, as proven in Plan 3), Express 4 as before.

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md` §7 (Auth Model: §7.1 managed mode, §7.2 developer→proxy, §7.3 admin access), §8 (Storage: `connections.credentials_encrypted`, `admin_users`); roadmap entry in `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md`.

## Global Constraints

- Node.js + TypeScript throughout (spec §11); same tsconfig/workspace conventions as Plans 1–4 — no new build tooling, no new npm dependency.
- **§7.1 managed:** vendor credentials are "encrypted at rest in SQLite using a key supplied via env var/mounted secret (the key itself is never persisted in the DB)"; "developers never see a vendor token". Credentials and vendor tokens must never appear in any API response, log line, or `GatewayError.details`.
- **§7.1 passthrough:** "the proxy forwards it unchanged and never stores it" — unchanged by this plan. On a `managed` connection an incoming `X-Vendor-Token` header is ignored.
- **§7.2:** the developer→proxy boundary (proxy-issued API keys on `/api/*`) is independent of §7.1 and is not modified.
- **§7.3:** "`/admin/*` and the webUI require a separate login — local username/password, single-tenant, no SSO in v1."
- **§6.1:** error responses stay `{ "error": { "code": "string", "message": "string", "details": {} } }` with an appropriate status, produced via `GatewayError`/`toErrorResponse`. Express 4 in this repo has no async-error-catching middleware, so every new `async` route handler must wrap its body in `try`/`catch` itself; new *sync* handlers may simply throw a `GatewayError` (Task 3 makes the app-level error handler honour it).
- Only `authMode` values `"passthrough"` and `"managed"` are valid after this plan; any other value still yields a 501 `UNSUPPORTED_AUTH_MODE` from the vendor clients.
- Test conventions: vitest, temp SQLite files under `os.tmpdir()` cleaned in `afterEach`, `nock` for vendor HTTP, `supertest` for server tests. `apps/*` resolve `@graphtorest/core` from its built `dist/`, so **every test command that exercises `apps/*` after a core change must rebuild core first**: `npm run build -w @graphtorest/core && npx vitest run <paths>`.
- Commit messages follow the repo's conventional-commit style and end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (verify the trailer after each subagent dispatch).

## Design Decisions (made in this plan; flag if you disagree before execution)

1. **Generic OAuth2 client instead of MSAL.** Spec §4.1 mentions MSAL for the Graph adapter, but managed auth must also work for the GraphQL adapter (any vendor), and MSAL's auth-code refresh-token persistence needs a custom cache plugin anyway. A ~150-line generic OAuth2 client (`client_credentials`, `authorization_code` + PKCE, `refresh_token`) with a small per-adapter endpoint profile (Microsoft derives its URLs from `tenantId`; everything else supplies explicit `tokenUrl`/`authorizeUrl`) covers both, needs no dependency, and is fully nock-testable.
2. **Admin sessions are opaque bearer tokens**, stored SHA-256-hashed in a new `admin_sessions` table (server-side, revocable, expiring), sent as `Authorization: Bearer <token>`. No cookies (so no CSRF surface); the Plan 6 SPA keeps the token in memory. Default TTL 8 hours.
3. **Authorization-code flow:** an authenticated admin `POST`s `/admin/connections/:id/oauth/start` and receives an `authorizationUrl`; the vendor redirects the browser to `GET /admin/oauth/callback`, which is the *only* unauthenticated admin route besides `/admin/login` — it is protected by a single-use, 10-minute, in-memory `state` (plus PKCE), so it cannot be driven without a prior authenticated `start`. The redirect URI is `${PUBLIC_BASE_URL}/admin/oauth/callback`.
4. **Bootstrap:** the first admin user is created with the CLI (`gtr admin-create`), which works against the SQLite file directly. The server warns on startup if none exist. The env-var-driven first-run bootstrap (spec §12) stays with Plan 8 as the roadmap says.
5. **Not in this plan:** login throttling / rate limiting (Plan 8), certificate-based client credentials, per-mapping `auth: override` (still rejected on YAML import, message reworded), `?dryRun`/route-count bounds on generation (Plan 6 will need dry-run for its preview; deferred there).

---

## File Structure

```
packages/core/
  src/
    auth/
      credentialCipher.ts        # AES-256-GCM encrypt/decrypt with an env-supplied key (Task 1)
      adminAuth.ts               # loginAdmin (Task 2)
      oauthClient.ts             # credential parsing + OAuth2 token/authorize helpers (Task 5)
      managedTokenService.ts     # ManagedTokenService, AccessTokenProvider, CredentialStatus (Task 6)
      authContext.ts             # buildAuthContext (Task 6)
    mappingEngine/
      mappingFields.ts           # parseMappingFields — shared admin-API field validation (Task 10)
    storage/
      migrations.ts              # +admin_sessions table (Task 2)
      MappingStore.ts            # +credential, admin-user, admin-session methods (Tasks 1, 2)
    gateway/GatewayEngine.ts     # optional AccessTokenProvider, uses buildAuthContext (Task 7)
    adapters/microsoftGraph/GraphHttpClient.ts   # accept "managed" (Task 7)
    adapters/graphql/GraphQLHttpClient.ts        # accept "managed" (Task 7)
    mappingEngine/yamlTransform.ts               # reword auth-override error (Task 10)
    index.ts                     # new exports (Tasks 1, 2, 5, 6, 10)
  test/auth/ ...                 # one test file per new auth module

apps/server/
  src/
    middleware/adminAuth.ts      # requireAdmin middleware (Task 3)
    routers/adminRouter.ts       # login/logout/admin-users, credentials, oauth, validation (Tasks 3, 7, 8, 10)
    app.ts, config.ts, index.ts  # wiring (Tasks 3, 8)
  test/
    helpers.ts                   # createAdminClient — authenticated supertest wrapper (Task 3)
    adminAuth.integration.test.ts, managedAuth.integration.test.ts   # new (Tasks 3, 8)

apps/cli/
  src/commands/adminCreate.ts, connectionCredentialsSet.ts   # new (Tasks 4, 9)
  src/commands/mappingGenerate.ts, mappingExport.ts          # modified (Tasks 9, 10)
  src/embeddedClient.ts, src/index.ts                        # wiring (Tasks 4, 9)

docker-compose.yml               # env vars + comment refresh (Task 8)
```

---

### Task 1: CredentialCipher and credential storage

**Files:**
- Create: `packages/core/src/auth/credentialCipher.ts`
- Modify: `packages/core/src/storage/MappingStore.ts` (add two methods after `listConnections`)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/auth/credentialCipher.test.ts`, `packages/core/test/storage/credentials.test.ts`

**Interfaces:**
- Consumes: the existing `connections.credentials_encrypted` column (created in Plan 1, currently unused).
- Produces:
  - `class CredentialCipher { constructor(keyMaterial: string); encrypt(plaintext: string): string; decrypt(payload: string): string }` — `keyMaterial` is 64 hex chars or base64 of 32 bytes; payload format `v1:<iv b64>:<tag b64>:<ciphertext b64>`; `decrypt` throws on tamper/wrong key/bad format.
  - `MappingStore.setConnectionCredentials(id: string, encrypted: string | null): boolean` (false if no such connection) and `MappingStore.getConnectionCredentials(id: string): string | null`.

- [ ] **Step 1: Write the failing cipher test**

Create `packages/core/test/auth/credentialCipher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CredentialCipher } from '../../src/auth/credentialCipher';

const HEX_KEY = '00'.repeat(32);
const OTHER_HEX_KEY = '11'.repeat(32);

describe('CredentialCipher', () => {
  it('round-trips plaintext, including unicode and the empty string', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    for (const text of ['{"clientSecret":"s3cret"}', 'héllo ✓', '']) {
      expect(cipher.decrypt(cipher.encrypt(text))).toBe(text);
    }
  });

  it('accepts a base64-encoded 32-byte key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cipher = new CredentialCipher(key);
    expect(cipher.decrypt(cipher.encrypt('x'))).toBe('x');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CredentialCipher('too-short')).toThrow(/32 bytes/);
    expect(() => new CredentialCipher('ab'.repeat(16))).toThrow(/32 bytes/);
  });

  it('uses a fresh IV per encryption and never contains the plaintext', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    const a = cipher.encrypt('super-secret');
    const b = cipher.encrypt('super-secret');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('super-secret');
  });

  it('fails to decrypt with a different key', () => {
    const payload = new CredentialCipher(HEX_KEY).encrypt('secret');
    expect(() => new CredentialCipher(OTHER_HEX_KEY).decrypt(payload)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    const [version, iv, tag, ciphertext] = cipher.encrypt('secret-value').split(':');
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0xff;
    expect(() => cipher.decrypt([version, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('rejects payloads in an unknown format', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    expect(() => cipher.decrypt('not-a-payload')).toThrow(/format/);
    expect(() => cipher.decrypt('v9:a:b:c')).toThrow(/format/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/auth/credentialCipher.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/credentialCipher`.

- [ ] **Step 3: Implement the cipher**

Create `packages/core/src/auth/credentialCipher.ts`:

```ts
import crypto from 'node:crypto';

const VERSION = 'v1';

function parseKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, encoded as 64 hex characters or as base64');
}

/** AES-256-GCM. Payload: `v1:<iv>:<auth tag>:<ciphertext>`, each part base64. */
export class CredentialCipher {
  private key: Buffer;

  constructor(keyMaterial: string) {
    this.key = parseKey(keyMaterial);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unrecognized credential payload format');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
```

- [ ] **Step 4: Run the cipher test to verify it passes**

Run: `npx vitest run packages/core/test/auth/credentialCipher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing storage test**

Create `packages/core/test/storage/credentials.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-credentials-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('MappingStore connection credentials', () => {
  it('returns null before any credentials are stored', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    expect(store.getConnectionCredentials(c.id)).toBeNull();
  });

  it('stores, replaces and clears an opaque encrypted string', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    expect(store.setConnectionCredentials(c.id, 'v1:a:b:c')).toBe(true);
    expect(store.getConnectionCredentials(c.id)).toBe('v1:a:b:c');
    store.setConnectionCredentials(c.id, 'v1:d:e:f');
    expect(store.getConnectionCredentials(c.id)).toBe('v1:d:e:f');
    store.setConnectionCredentials(c.id, null);
    expect(store.getConnectionCredentials(c.id)).toBeNull();
  });

  it('returns false when the connection does not exist', () => {
    expect(store.setConnectionCredentials('nope', 'x')).toBe(false);
    expect(store.getConnectionCredentials('nope')).toBeNull();
  });

  it('never leaks credentials through ConnectionRecord', () => {
    const c = store.createConnection({ name: 'c1', adapterType: 'mock', authMode: 'managed' });
    store.setConnectionCredentials(c.id, 'v1:a:b:c');
    expect(JSON.stringify(store.getConnection(c.id))).not.toContain('v1:a:b:c');
    expect(JSON.stringify(store.listConnections())).not.toContain('v1:a:b:c');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/test/storage/credentials.test.ts`
Expected: FAIL — `store.getConnectionCredentials is not a function`.

- [ ] **Step 7: Add the store methods**

In `packages/core/src/storage/MappingStore.ts`, insert directly after the `listConnections()` method:

```ts
  /** Stores an already-encrypted credentials blob; the store never sees plaintext. Returns false if the connection does not exist. */
  setConnectionCredentials(id: string, encrypted: string | null): boolean {
    const result = this.db.prepare('UPDATE connections SET credentials_encrypted = ? WHERE id = ?').run(encrypted, id);
    return result.changes > 0;
  }

  getConnectionCredentials(id: string): string | null {
    const row = this.db.prepare('SELECT credentials_encrypted as credentials FROM connections WHERE id = ?').get(id) as
      | { credentials: string | null }
      | undefined;
    return row?.credentials ?? null;
  }
```

In `packages/core/src/index.ts`, add after the `generateApiKey…` export lines:

```ts
export { CredentialCipher } from './auth/credentialCipher';
```

- [ ] **Step 8: Run both tests, then the whole core suite**

Run: `npx vitest run packages/core`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/auth/credentialCipher.ts packages/core/src/storage/MappingStore.ts packages/core/src/index.ts packages/core/test/auth/credentialCipher.test.ts packages/core/test/storage/credentials.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add AES-256-GCM credential cipher and encrypted credential storage

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Admin users, sessions and login (core)

**Files:**
- Modify: `packages/core/src/storage/migrations.ts` (append a migration)
- Modify: `packages/core/src/storage/MappingStore.ts`
- Create: `packages/core/src/auth/adminAuth.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/auth/adminAuth.test.ts`

**Interfaces:**
- Consumes: `hashSecret`/`verifySecret` from `packages/core/src/auth/apiKeys.ts`; `GatewayError` from `packages/core/src/gateway/errors.ts`; the existing `admin_users` table.
- Produces:
  - `interface AdminUserRecord { id: string; username: string }` (exported from core).
  - `MappingStore`: `createAdminUser(input: { username: string; password: string }): AdminUserRecord` (throws `GatewayError('INVALID_INPUT', …, 400)` for an empty username or a password under 12 chars; a duplicate username propagates better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE`); `findAdminUserByUsername(username: string): (AdminUserRecord & { hashedPassword: string }) | null`; `countAdminUsers(): number`; `setAdminPassword(username: string, password: string): boolean` (also revokes that user's sessions); `createAdminSession(adminUserId: string, ttlMs: number): { token: string; expiresAt: string }`; `findAdminSession(token: string): AdminUserRecord | null` (null when unknown or expired); `deleteAdminSession(token: string): void`.
  - `loginAdmin(store: MappingStore, username: string, password: string, ttlMs?: number): { token: string; expiresAt: string } | null` and `DEFAULT_ADMIN_SESSION_TTL_MS` (8 h).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/auth/adminAuth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { loginAdmin } from '../../src/auth/adminAuth';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;

const PASSWORD = 'correct-horse-battery';

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-adminauth-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('admin users', () => {
  it('creates a user, hashes the password, and counts users', () => {
    expect(store.countAdminUsers()).toBe(0);
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(user).toEqual({ id: expect.any(String), username: 'admin' });
    expect(store.countAdminUsers()).toBe(1);
    const found = store.findAdminUserByUsername('admin');
    expect(found?.hashedPassword).toBeTruthy();
    expect(found?.hashedPassword).not.toContain(PASSWORD);
    expect(store.findAdminUserByUsername('nobody')).toBeNull();
  });

  it('rejects a short password and an empty username with a 400 GatewayError', () => {
    expect(() => store.createAdminUser({ username: 'admin', password: 'short' })).toThrow(/at least 12/);
    expect(() => store.createAdminUser({ username: '  ', password: PASSWORD })).toThrow(/username/);
    try {
      store.createAdminUser({ username: 'admin', password: 'short' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    }
  });

  it('rejects a duplicate username with a unique-constraint error', () => {
    store.createAdminUser({ username: 'admin', password: PASSWORD });
    try {
      store.createAdminUser({ username: 'admin', password: PASSWORD });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    }
  });
});

describe('loginAdmin and sessions', () => {
  it('returns a session token for valid credentials that resolves back to the user', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const session = loginAdmin(store, 'admin', PASSWORD);
    expect(session).not.toBeNull();
    expect(store.findAdminSession(session!.token)).toEqual(user);
  });

  it('returns null for a wrong password or an unknown user', () => {
    store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(loginAdmin(store, 'admin', 'wrong-password-here')).toBeNull();
    expect(loginAdmin(store, 'nobody', PASSWORD)).toBeNull();
  });

  it('stores only a hash of the session token', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, 60_000);
    const rows = db.prepare('SELECT token_hash FROM admin_sessions').all() as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(token);
  });

  it('treats an expired session as invalid', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, -1000);
    expect(store.findAdminSession(token)).toBeNull();
  });

  it('returns null for an unknown token and supports logout', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    expect(store.findAdminSession('garbage')).toBeNull();
    const { token } = store.createAdminSession(user.id, 60_000);
    store.deleteAdminSession(token);
    expect(store.findAdminSession(token)).toBeNull();
  });

  it('setAdminPassword changes the password and revokes existing sessions', () => {
    const user = store.createAdminUser({ username: 'admin', password: PASSWORD });
    const { token } = store.createAdminSession(user.id, 60_000);
    expect(store.setAdminPassword('admin', 'a-brand-new-password')).toBe(true);
    expect(store.findAdminSession(token)).toBeNull();
    expect(loginAdmin(store, 'admin', PASSWORD)).toBeNull();
    expect(loginAdmin(store, 'admin', 'a-brand-new-password')).not.toBeNull();
    expect(store.setAdminPassword('nobody', 'a-brand-new-password')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/auth/adminAuth.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/adminAuth`.

- [ ] **Step 3: Add the sessions migration**

In `packages/core/src/storage/migrations.ts`, add a second element to `MIGRATIONS` (after the existing template literal, before the closing `];`):

```ts
  `
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
```

- [ ] **Step 4: Add the store methods**

In `packages/core/src/storage/MappingStore.ts`:

Change the top imports to:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { generateApiKey, hashSecret, type GeneratedApiKey } from '../auth/apiKeys';
import { GatewayError } from '../gateway/errors';
```

Add below the `ApiKeyRecord` interface:

```ts
export interface AdminUserRecord {
  id: string;
  username: string;
}

const MIN_PASSWORD_LENGTH = 12;

function assertAcceptablePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new GatewayError('INVALID_INPUT', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
```

Add these methods at the end of the `MappingStore` class (after `touchApiKeyLastUsed`):

```ts
  createAdminUser(input: { username: string; password: string }): AdminUserRecord {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!username) throw new GatewayError('INVALID_INPUT', 'username is required', 400);
    assertAcceptablePassword(input.password);
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO admin_users (id, username, hashed_password) VALUES (?, ?, ?)')
      .run(id, username, hashSecret(input.password));
    return { id, username };
  }

  findAdminUserByUsername(username: string): (AdminUserRecord & { hashedPassword: string }) | null {
    const row = this.db
      .prepare('SELECT id, username, hashed_password as hashedPassword FROM admin_users WHERE username = ?')
      .get(username) as (AdminUserRecord & { hashedPassword: string }) | undefined;
    return row ?? null;
  }

  countAdminUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM admin_users').get() as { n: number }).n;
  }

  /** Replaces the password and revokes every session of that user. Returns false if the user does not exist. */
  setAdminPassword(username: string, password: string): boolean {
    assertAcceptablePassword(password);
    const user = this.findAdminUserByUsername(username);
    if (!user) return false;
    this.transaction(() => {
      this.db.prepare('UPDATE admin_users SET hashed_password = ? WHERE id = ?').run(hashSecret(password), user.id);
      this.db.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').run(user.id);
    });
    return true;
  }

  createAdminSession(adminUserId: string, ttlMs: number): { token: string; expiresAt: string } {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO admin_sessions (token_hash, admin_user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashSessionToken(token), adminUserId, expiresAt);
    return { token, expiresAt };
  }

  findAdminSession(token: string): AdminUserRecord | null {
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
    return { id: row.id, username: row.username };
  }

  deleteAdminSession(token: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }
```

- [ ] **Step 5: Implement `loginAdmin`**

Create `packages/core/src/auth/adminAuth.ts`:

```ts
import { hashSecret, verifySecret } from './apiKeys';
import type { MappingStore } from '../storage/MappingStore';

export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Verified against when the username is unknown so that "no such user" and "wrong password" cost the same.
const DUMMY_HASH = hashSecret('graphtorest-dummy-password');

export function loginAdmin(
  store: MappingStore,
  username: string,
  password: string,
  ttlMs: number = DEFAULT_ADMIN_SESSION_TTL_MS
): { token: string; expiresAt: string } | null {
  const user = store.findAdminUserByUsername(username);
  const passwordOk = verifySecret(password, user ? user.hashedPassword : DUMMY_HASH);
  if (!user || !passwordOk) return null;
  return store.createAdminSession(user.id, ttlMs);
}
```

- [ ] **Step 6: Export from the core barrel**

In `packages/core/src/index.ts`, change the `MappingStore` type export line to include `AdminUserRecord`, and add the auth export:

```ts
export type { ConnectionRecord, MappingRecord, ApiKeyRecord, AdminUserRecord } from './storage/MappingStore';
export { loginAdmin, DEFAULT_ADMIN_SESSION_TTL_MS } from './auth/adminAuth';
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run packages/core`
Expected: PASS, including the new `adminAuth.test.ts` (9 tests) and all pre-existing core tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/core/test/auth/adminAuth.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add admin users, hashed-token sessions and loginAdmin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Lock `/admin/*` behind login (server)

**Files:**
- Create: `apps/server/src/middleware/adminAuth.ts`
- Modify: `apps/server/src/routers/adminRouter.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/test/helpers.ts`
- Modify: `apps/server/test/integration.test.ts`, `apps/server/test/graphql.integration.test.ts`, `apps/server/test/microsoftGraph.integration.test.ts` (route their `/admin/*` calls through the authenticated helper)
- Test: `apps/server/test/adminAuth.integration.test.ts`

**Interfaces:**
- Consumes: `loginAdmin`, `MappingStore.findAdminSession/deleteAdminSession/createAdminUser/countAdminUsers` (Task 2), `GatewayError`.
- Produces:
  - `createAdminAuth(store: MappingStore): RequestHandler` — 401 `UNAUTHORIZED` unless `Authorization: Bearer <valid session token>`; sets `res.locals.adminUser` and `res.locals.adminToken`.
  - `interface AdminRouterOptions { sessionTtlMs?: number }` and `createAdminRouter(mappingStore, options?: AdminRouterOptions)`; new routes `POST /admin/login` (public), `POST /admin/logout`, `POST /admin/admin-users`; every other admin route now requires the session.
  - `AppDeps.adminSessionTtlMs?: number`.
  - Test helper `createAdminClient(app, store): { token: string; get/post/put/patch/delete(url): supertest.Test }` (already carries the admin `Authorization` header) and `TEST_ADMIN_PASSWORD`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/adminAuth.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, TEST_ADMIN_PASSWORD } from './helpers';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let store: MappingStore;

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-adminauth-int-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = createApp({
    mappingStore: store,
    gatewayEngine: new GatewayEngine(store),
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: true,
    adminEnabled: true,
  });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('admin authentication', () => {
  it('rejects admin requests with no token, a malformed header, or a garbage token', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer garbage']) {
      const req = request(app).get('/admin/connections');
      const res = header ? await req.set('Authorization', header) : await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('logs in with valid credentials and the token then works', async () => {
    store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const login = await request(app).post('/admin/login').send({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
    expect(login.body.expiresAt).toEqual(expect.any(String));

    const res = await request(app).get('/admin/connections').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with a generic 401', async () => {
    store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const wrong = await request(app).post('/admin/login').send({ username: 'admin', password: 'not-the-password' });
    const unknown = await request(app).post('/admin/login').send({ username: 'ghost', password: TEST_ADMIN_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects a login body that is missing fields', async () => {
    const res = await request(app).post('/admin/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('logout invalidates the token', async () => {
    const admin = createAdminClient(app, store);
    expect((await admin.get('/admin/connections')).status).toBe(200);
    expect((await admin.post('/admin/logout').send({})).status).toBe(204);
    expect((await admin.get('/admin/connections')).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const user = store.createAdminUser({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    const { token } = store.createAdminSession(user.id, -1000);
    const res = await request(app).get('/admin/connections').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('creates admin users through the API, with 409 for a duplicate and 400 for a weak password', async () => {
    const admin = createAdminClient(app, store);
    const created = await admin.post('/admin/admin-users').send({ username: 'second', password: 'another-long-password' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), username: 'second' });
    expect(JSON.stringify(created.body)).not.toContain('another-long-password');

    const dup = await admin.post('/admin/admin-users').send({ username: 'second', password: 'another-long-password' });
    expect(dup.status).toBe(409);

    const weak = await admin.post('/admin/admin-users').send({ username: 'third', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('INVALID_INPUT');
  });

  it('does not affect API-key auth on /api/*', async () => {
    const res = await request(app).get('/api/anything');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Missing API key');
  });
});
```

- [ ] **Step 2: Create the test helper**

Create `apps/server/test/helpers.ts`:

```ts
import request from 'supertest';
import type { Express } from 'express';
import type { MappingStore } from '@graphtorest/core';

export const TEST_ADMIN_PASSWORD = 'correct-horse-battery';

/** Seeds an admin user + session and returns a supertest wrapper that sends the admin bearer token on every call. */
export function createAdminClient(app: Express, store: MappingStore) {
  const user = store.createAdminUser({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
  const { token } = store.createAdminSession(user.id, 60 * 60 * 1000);
  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (url: string) => authed(request(app).get(url)),
    post: (url: string) => authed(request(app).post(url)),
    put: (url: string) => authed(request(app).put(url)),
    patch: (url: string) => authed(request(app).patch(url)),
    delete: (url: string) => authed(request(app).delete(url)),
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/adminAuth.integration.test.ts`
Expected: FAIL — `/admin/connections` returns 200 without a token, `/admin/login` is 404.

- [ ] **Step 4: Create the middleware**

Create `apps/server/src/middleware/adminAuth.ts`:

```ts
import type { RequestHandler } from 'express';
import type { MappingStore } from '@graphtorest/core';

export function createAdminAuth(store: MappingStore): RequestHandler {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    const user = match ? store.findAdminSession(match[1]) : null;
    if (!match || !user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } });
      return;
    }
    res.locals.adminUser = user;
    res.locals.adminToken = match[1];
    next();
  };
}
```

- [ ] **Step 5: Add login/logout/admin-user routes and the gate to `adminRouter.ts`**

In `apps/server/src/routers/adminRouter.ts`:

Replace the first two lines (imports + function header start) so the file begins:

```ts
import { Router } from 'express';
import { type MappingStore, generateAndPersistMappings, loginAdmin, toErrorResponse, GatewayError } from '@graphtorest/core';
import { createAdminAuth } from '../middleware/adminAuth';

export interface AdminRouterOptions {
  sessionTtlMs?: number;
}

export function createAdminRouter(mappingStore: MappingStore, options: AdminRouterOptions = {}): Router {
  const router = Router();
  const requireAdmin = createAdminAuth(mappingStore);

  router.post('/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'username and password required', details: {} } });
      return;
    }
    const session = loginAdmin(mappingStore, username, password, options.sessionTtlMs);
    if (!session) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } });
      return;
    }
    res.json(session);
  });

  // Everything below this line requires an admin session.
  router.use(requireAdmin);

  router.post('/logout', (_req, res) => {
    mappingStore.deleteAdminSession(res.locals.adminToken as string);
    res.status(204).end();
  });

  router.post('/admin-users', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'username and password required', details: {} } });
      return;
    }
    try {
      res.status(201).json(mappingStore.createAdminUser({ username, password }));
    } catch (err) {
      if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'An admin user with this username already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });
```

(The existing `router.post('/connections', …)` and everything after it stays exactly as is, directly below.)

- [ ] **Step 6: Make the app error handler honour `GatewayError` and pass the TTL**

In `apps/server/src/app.ts`:

Add `adminSessionTtlMs?: number;` to `AppDeps`, change the admin mount to:

```ts
    app.use('/admin', createAdminRouter(deps.mappingStore, { sessionTtlMs: deps.adminSessionTtlMs }));
```

Change the import line to also pull `GatewayError`:

```ts
import { toErrorResponse, GatewayError, type MappingStore, type GatewayEngine, type OpenApiGenerator } from '@graphtorest/core';
```

and insert at the top of the error-handling middleware body (before `const status = …`):

```ts
    if (err instanceof GatewayError) {
      const { status: gatewayStatus, body } = toErrorResponse(err);
      res.status(gatewayStatus).json(body);
      return;
    }
```

- [ ] **Step 7: Replace the startup warning in `apps/server/src/index.ts`**

Replace the `if (config.adminEnabled) { console.warn(...) }` block with:

```ts
if (config.adminEnabled && mappingStore.countAdminUsers() === 0) {
  console.warn(
    JSON.stringify({
      msg: 'no_admin_users',
      warning:
        'No admin users exist, so /admin/* cannot be used. Create one with: gtr admin-create --username <name> (password via --password or GTR_ADMIN_PASSWORD, 12+ characters)',
    })
  );
}
```

- [ ] **Step 8: Route the three existing integration suites through the admin client**

In each of `integration.test.ts`, `graphql.integration.test.ts`, `microsoftGraph.integration.test.ts`:

1. Add `import { createAdminClient, type AdminClient } from './helpers';` and a module-level `let admin: AdminClient;`.
2. Directly after the `app = createApp({...})` line inside `beforeEach`, add `admin = createAdminClient(app, mappingStore);` (in the graphql and microsoftGraph files `mappingStore` is a local `const` in that same `beforeEach`, so it is in scope).
3. Rewrite every admin call — including the multi-line `request(app)\n .post('/admin/…')` form — with:

```bash
perl -0pi -e "s/request\(app\)(\s*)\.(get|post|put|patch|delete)\((\s*)([\`'](?:\/admin))/admin\$1.\$2(\$3\$4/g" \
  apps/server/test/integration.test.ts apps/server/test/graphql.integration.test.ts apps/server/test/microsoftGraph.integration.test.ts
```

4. Verify nothing was missed and `/api/*` calls were left alone:

```bash
grep -n -A1 "request(app)" apps/server/test/*.test.ts | grep "/admin" || echo "no unauthenticated admin calls remain"
```
Expected: `no unauthenticated admin calls remain` (the new `adminAuth.integration.test.ts` deliberately still has unauthenticated `request(app)` admin calls and will show up here — that is fine; only the three migrated files must be clean).

- [ ] **Step 9: Run the server tests**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server`
Expected: PASS — the new suite (8 tests), the migrated suites, and `config.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add apps/server
git commit -m "$(cat <<'EOF'
feat(server): require an admin login for /admin/* with hashed-token sessions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: CLI `admin-create` and `admin-set-password`

**Files:**
- Create: `apps/cli/src/commands/adminCreate.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/adminCommands.test.ts`

**Interfaces:**
- Consumes: `MappingStore.createAdminUser/setAdminPassword`, `loginAdmin`, `openEmbeddedStore`.
- Produces: `adminCreate(store, args: { username: string; password: string }): AdminUserRecord`; `adminSetPassword(store, args: { username: string; password: string }): void` (throws `Error('No admin user named "<name>"')` if absent); CLI commands `admin-create --username <name> [--password <pw>]` and `admin-set-password --username <name> [--password <pw>]` where the password falls back to env `GTR_ADMIN_PASSWORD` (passing it via env keeps it out of shell history / process listings).

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/adminCommands.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginAdmin } from '@graphtorest/core';
import { openEmbeddedStore } from '../src/embeddedClient';
import { adminCreate, adminSetPassword } from '../src/commands/adminCreate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-admincli-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('admin CLI commands', () => {
  it('creates an admin user who can then log in', () => {
    const store = freshStore();
    const user = adminCreate(store, { username: 'admin', password: 'correct-horse-battery' });
    expect(user.username).toBe('admin');
    expect(loginAdmin(store, 'admin', 'correct-horse-battery')).not.toBeNull();
  });

  it('rejects a weak password', () => {
    const store = freshStore();
    expect(() => adminCreate(store, { username: 'admin', password: 'short' })).toThrow(/at least 12/);
  });

  it('resets a password and revokes old sessions', () => {
    const store = freshStore();
    const user = adminCreate(store, { username: 'admin', password: 'correct-horse-battery' });
    const { token } = store.createAdminSession(user.id, 60_000);
    adminSetPassword(store, { username: 'admin', password: 'a-brand-new-password' });
    expect(store.findAdminSession(token)).toBeNull();
    expect(loginAdmin(store, 'admin', 'a-brand-new-password')).not.toBeNull();
  });

  it('errors when resetting the password of an unknown user', () => {
    const store = freshStore();
    expect(() => adminSetPassword(store, { username: 'ghost', password: 'a-brand-new-password' })).toThrow(/No admin user named "ghost"/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/cli/test/adminCommands.test.ts`
Expected: FAIL — cannot resolve `../src/commands/adminCreate`.

- [ ] **Step 3: Implement the commands**

Create `apps/cli/src/commands/adminCreate.ts`:

```ts
import type { MappingStore, AdminUserRecord } from '@graphtorest/core';

export function adminCreate(store: MappingStore, args: { username: string; password: string }): AdminUserRecord {
  return store.createAdminUser(args);
}

export function adminSetPassword(store: MappingStore, args: { username: string; password: string }): void {
  if (!store.setAdminPassword(args.username, args.password)) {
    throw new Error(`No admin user named "${args.username}"`);
  }
}
```

- [ ] **Step 4: Register them in `apps/cli/src/index.ts`**

Add the import next to the other command imports:

```ts
import { adminCreate, adminSetPassword } from './commands/adminCreate';
```

Add above `program.parseAsync()`:

```ts
function resolvePassword(option: string | undefined): string {
  const password = option ?? process.env.GTR_ADMIN_PASSWORD;
  if (!password) throw new Error('Provide a password with --password or the GTR_ADMIN_PASSWORD environment variable');
  return password;
}

program
  .command('admin-create')
  .requiredOption('--username <name>')
  .option('--password <password>', 'defaults to $GTR_ADMIN_PASSWORD (12+ characters)')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const user = adminCreate(store, { username: opts.username, password: resolvePassword(opts.password) });
    console.log(JSON.stringify(user, null, 2));
  });

program
  .command('admin-set-password')
  .requiredOption('--username <name>')
  .option('--password <password>', 'defaults to $GTR_ADMIN_PASSWORD (12+ characters)')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    adminSetPassword(store, { username: opts.username, password: resolvePassword(opts.password) });
    console.log(JSON.stringify({ username: opts.username, passwordUpdated: true }));
  });
```

- [ ] **Step 5: Run the CLI tests**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/cli`
Expected: PASS (new 4 tests plus existing).

- [ ] **Step 6: Commit**

```bash
git add apps/cli
git commit -m "$(cat <<'EOF'
feat(cli): add admin-create and admin-set-password commands

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Generic OAuth2 client and credential parsing

**Files:**
- Create: `packages/core/src/auth/oauthClient.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/auth/oauthClient.test.ts`

**Interfaces:**
- Consumes: `GatewayError`; Node's global `fetch`.
- Produces (all exported from `oauthClient.ts`):
  - `type OAuthGrant = 'client_credentials' | 'authorization_code'`
  - `interface ManagedCredentials { grant: OAuthGrant; clientId: string; clientSecret: string; tenantId?: string; tokenUrl?: string; authorizeUrl?: string; scopes?: string[]; refreshToken?: string }`
  - `interface TokenResponse { accessToken: string; expiresInSeconds: number; refreshToken?: string }`
  - `parseManagedCredentials(adapterType: string, input: unknown): ManagedCredentials` — throws `GatewayError('INVALID_INPUT', …, 400)`. For `microsoft-graph`: `tenantId` required (`/^[A-Za-z0-9.-]+$/`); for every other adapter: `tokenUrl` required, plus `authorizeUrl` when `grant` is `authorization_code`; URLs must be `https:`. `refreshToken` is only accepted with `authorization_code`.
  - `requestClientCredentialsToken(adapterType, credentials): Promise<TokenResponse>`
  - `requestRefreshedToken(adapterType, credentials): Promise<TokenResponse>` (uses `credentials.refreshToken`)
  - `exchangeAuthorizationCode(adapterType, credentials, input: { code: string; redirectUri: string; codeVerifier: string }): Promise<TokenResponse>`
  - `buildAuthorizationUrl(adapterType, credentials, input: { redirectUri: string; state: string; codeChallenge: string }): string`
  - `generatePkcePair(): { verifier: string; challenge: string }`
  - Token-endpoint failures throw `GatewayError('VENDOR_AUTH_FAILED', <vendor error_description or generic>, 502, { vendorError?, status })`; an unreachable endpoint throws `GatewayError('VENDOR_AUTH_UNREACHABLE', …, 502)`. Neither ever includes the client secret, refresh token or access token.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/auth/oauthClient.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import nock from 'nock';
import {
  parseManagedCredentials,
  requestClientCredentialsToken,
  requestRefreshedToken,
  exchangeAuthorizationCode,
  buildAuthorizationUrl,
  generatePkcePair,
  type ManagedCredentials,
} from '../../src/auth/oauthClient';

afterEach(() => {
  nock.cleanAll();
});

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';

const msCreds: ManagedCredentials = {
  grant: 'client_credentials',
  clientId: 'cid',
  clientSecret: 'shh-secret',
  tenantId: 'tenant-1',
};

describe('parseManagedCredentials', () => {
  it('accepts valid Microsoft client-credentials input', () => {
    expect(parseManagedCredentials('microsoft-graph', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tenantId: 't-1' })).toEqual({
      grant: 'client_credentials',
      clientId: 'a',
      clientSecret: 'b',
      tenantId: 't-1',
    });
  });

  it('requires a URL-safe tenantId for microsoft-graph', () => {
    const base = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b' };
    expect(() => parseManagedCredentials('microsoft-graph', base)).toThrow(/tenantId/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...base, tenantId: '../evil' })).toThrow(/tenantId/);
  });

  it('requires an https tokenUrl (and authorizeUrl for auth-code) for other adapters', () => {
    const base = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b' };
    expect(() => parseManagedCredentials('graphql', base)).toThrow(/tokenUrl/);
    expect(() => parseManagedCredentials('graphql', { ...base, tokenUrl: 'http://insecure.example/token' })).toThrow(/https/);
    expect(() => parseManagedCredentials('graphql', { ...base, tokenUrl: 'not a url' })).toThrow(/valid URL/);
    expect(() =>
      parseManagedCredentials('graphql', { ...base, grant: 'authorization_code', tokenUrl: 'https://v.example/token' })
    ).toThrow(/authorizeUrl/);
    expect(
      parseManagedCredentials('graphql', {
        ...base,
        grant: 'authorization_code',
        tokenUrl: 'https://v.example/token',
        authorizeUrl: 'https://v.example/authorize',
        scopes: ['read'],
      })
    ).toMatchObject({ authorizeUrl: 'https://v.example/authorize', scopes: ['read'] });
  });

  it('rejects an unknown grant, missing secrets, bad scopes, and a refreshToken with client_credentials', () => {
    const ok = { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tenantId: 't' };
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, grant: 'password' })).toThrow(/grant/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, clientSecret: '' })).toThrow(/clientSecret/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, scopes: ['has space'] })).toThrow(/scopes/);
    expect(() => parseManagedCredentials('microsoft-graph', { ...ok, refreshToken: 'rt' })).toThrow(/refreshToken/);
    expect(() => parseManagedCredentials('microsoft-graph', 'nope')).toThrow(/object/);
  });

  it('accepts a pre-supplied refreshToken for authorization_code', () => {
    const parsed = parseManagedCredentials('microsoft-graph', {
      grant: 'authorization_code',
      clientId: 'a',
      clientSecret: 'b',
      tenantId: 't',
      refreshToken: 'rt-0',
    });
    expect(parsed.refreshToken).toBe('rt-0');
  });
});

describe('token requests', () => {
  it('requests a client-credentials token with the default Graph scope', async () => {
    const scope = nock(LOGIN)
      .post(TOKEN_PATH, {
        grant_type: 'client_credentials',
        client_id: 'cid',
        client_secret: 'shh-secret',
        scope: 'https://graph.microsoft.com/.default',
      })
      .reply(200, { access_token: 'at-1', expires_in: 3599, token_type: 'Bearer' });

    const token = await requestClientCredentialsToken('microsoft-graph', msCreds);

    expect(token).toEqual({ accessToken: 'at-1', expiresInSeconds: 3599, refreshToken: undefined });
    expect(scope.isDone()).toBe(true);
  });

  it('uses explicit scopes and the explicit tokenUrl for non-Microsoft adapters', async () => {
    nock('https://auth.vendor.example')
      .post('/oauth/token', { grant_type: 'client_credentials', client_id: 'cid', client_secret: 's', scope: 'read write' })
      .reply(200, { access_token: 'at-2', expires_in: 60 });

    const token = await requestClientCredentialsToken('graphql', {
      grant: 'client_credentials',
      clientId: 'cid',
      clientSecret: 's',
      tokenUrl: 'https://auth.vendor.example/oauth/token',
      scopes: ['read', 'write'],
    });
    expect(token.accessToken).toBe('at-2');
  });

  it('defaults expires_in to one hour when the vendor omits it', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at' });
    expect((await requestClientCredentialsToken('microsoft-graph', msCreds)).expiresInSeconds).toBe(3600);
  });

  it('exchanges an authorization code with the PKCE verifier', async () => {
    const scope = nock(LOGIN)
      .post(TOKEN_PATH, {
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://gtr.example/admin/oauth/callback',
        code_verifier: 'verifier-1',
        client_id: 'cid',
        client_secret: 'shh-secret',
      })
      .reply(200, { access_token: 'at-3', refresh_token: 'rt-3', expires_in: 3600 });

    const token = await exchangeAuthorizationCode(
      'microsoft-graph',
      { ...msCreds, grant: 'authorization_code' },
      { code: 'the-code', redirectUri: 'https://gtr.example/admin/oauth/callback', codeVerifier: 'verifier-1' }
    );

    expect(token).toMatchObject({ accessToken: 'at-3', refreshToken: 'rt-3' });
    expect(scope.isDone()).toBe(true);
  });

  it('refreshes with the stored refresh token and surfaces a rotated one', async () => {
    nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: 'cid', client_secret: 'shh-secret' })
      .reply(200, { access_token: 'at-4', refresh_token: 'rt-new', expires_in: 3600 });

    const token = await requestRefreshedToken('microsoft-graph', { ...msCreds, grant: 'authorization_code', refreshToken: 'rt-old' });
    expect(token).toMatchObject({ accessToken: 'at-4', refreshToken: 'rt-new' });
  });

  it('maps a vendor rejection to a 502 VENDOR_AUTH_FAILED without leaking secrets', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client', error_description: 'Client authentication failed' });

    const err = await requestClientCredentialsToken('microsoft-graph', msCreds).catch((e) => e);

    expect(err).toMatchObject({ code: 'VENDOR_AUTH_FAILED', status: 502, message: 'Client authentication failed' });
    expect(err.details).toEqual({ vendorError: 'invalid_client', status: 401 });
    expect(JSON.stringify(err.details) + err.message).not.toContain('shh-secret');
  });

  it('maps a 200 response with no access_token to VENDOR_AUTH_FAILED', async () => {
    nock(LOGIN).post(TOKEN_PATH).reply(200, { nope: true });
    await expect(requestClientCredentialsToken('microsoft-graph', msCreds)).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('maps a network failure to a 502 VENDOR_AUTH_UNREACHABLE', async () => {
    nock(LOGIN).post(TOKEN_PATH).replyWithError('boom');
    await expect(requestClientCredentialsToken('microsoft-graph', msCreds)).rejects.toMatchObject({
      code: 'VENDOR_AUTH_UNREACHABLE',
      status: 502,
    });
  });

  it('refuses to refresh when no refresh token is stored', async () => {
    await expect(requestRefreshedToken('microsoft-graph', { ...msCreds, grant: 'authorization_code' })).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
    });
  });
});

describe('authorization URL and PKCE', () => {
  it('builds a Microsoft authorization URL with state, PKCE challenge and offline_access', () => {
    const url = new URL(
      buildAuthorizationUrl('microsoft-graph', { ...msCreds, grant: 'authorization_code' }, {
        redirectUri: 'https://gtr.example/admin/oauth/callback',
        state: 'st-1',
        codeChallenge: 'chal-1',
      })
    );
    expect(url.origin + url.pathname).toBe(`${LOGIN}/tenant-1/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gtr.example/admin/oauth/callback');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('offline_access https://graph.microsoft.com/.default');
    expect(url.toString()).not.toContain('shh-secret');
  });

  it('refuses to build a URL when the adapter has no authorize endpoint', () => {
    expect(() =>
      buildAuthorizationUrl('graphql', { grant: 'client_credentials', clientId: 'a', clientSecret: 'b', tokenUrl: 'https://v.example/t' }, {
        redirectUri: 'https://x/cb',
        state: 's',
        codeChallenge: 'c',
      })
    ).toThrow(/authorize/);
  });

  it('generates a PKCE pair whose challenge is the S256 hash of the verifier', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(generatePkcePair().verifier).not.toBe(verifier);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/auth/oauthClient.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/oauthClient`.

- [ ] **Step 3: Implement the client**

Create `packages/core/src/auth/oauthClient.ts`:

```ts
import crypto from 'node:crypto';
import { GatewayError } from '../gateway/errors';

export type OAuthGrant = 'client_credentials' | 'authorization_code';

export interface ManagedCredentials {
  grant: OAuthGrant;
  clientId: string;
  clientSecret: string;
  tenantId?: string;
  tokenUrl?: string;
  authorizeUrl?: string;
  scopes?: string[];
  refreshToken?: string;
}

export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
}

interface OAuthEndpoints {
  tokenUrl: string;
  authorizeUrl: string | null;
  defaultScopes: string[];
}

const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" is required`);
  return value.trim();
}

function requireHttpsUrl(value: unknown, field: string): string {
  const text = requireString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`"${field}" must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw invalid(`"${field}" must be an https URL`);
  return text;
}

export function parseManagedCredentials(adapterType: string, input: unknown): ManagedCredentials {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('credentials must be an object');
  const raw = input as Record<string, unknown>;
  const grant = raw.grant;
  if (grant !== 'client_credentials' && grant !== 'authorization_code') {
    throw invalid('"grant" must be "client_credentials" or "authorization_code"');
  }
  const credentials: ManagedCredentials = {
    grant,
    clientId: requireString(raw.clientId, 'clientId'),
    clientSecret: requireString(raw.clientSecret, 'clientSecret'),
  };
  if (raw.scopes !== undefined) {
    const scopes = raw.scopes;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string' && s.length > 0 && !/\s/.test(s))) {
      throw invalid('"scopes" must be an array of non-empty strings without whitespace');
    }
    credentials.scopes = scopes as string[];
  }
  if (adapterType === 'microsoft-graph') {
    const tenantId = requireString(raw.tenantId, 'tenantId');
    if (!/^[A-Za-z0-9.-]+$/.test(tenantId)) throw invalid('"tenantId" may only contain letters, digits, dots and hyphens');
    credentials.tenantId = tenantId;
  } else {
    credentials.tokenUrl = requireHttpsUrl(raw.tokenUrl, 'tokenUrl');
    if (grant === 'authorization_code') credentials.authorizeUrl = requireHttpsUrl(raw.authorizeUrl, 'authorizeUrl');
  }
  if (raw.refreshToken !== undefined) {
    if (grant !== 'authorization_code') throw invalid('"refreshToken" is only valid with the authorization_code grant');
    credentials.refreshToken = requireString(raw.refreshToken, 'refreshToken');
  }
  return credentials;
}

function resolveEndpoints(adapterType: string, credentials: ManagedCredentials): OAuthEndpoints {
  if (adapterType === 'microsoft-graph') {
    const base = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0`;
    return {
      tokenUrl: `${base}/token`,
      authorizeUrl: `${base}/authorize`,
      defaultScopes: credentials.grant === 'authorization_code' ? ['offline_access', GRAPH_DEFAULT_SCOPE] : [GRAPH_DEFAULT_SCOPE],
    };
  }
  if (!credentials.tokenUrl) {
    throw new GatewayError('INVALID_CONFIGURATION', 'Stored credentials are missing a tokenUrl', 500);
  }
  return { tokenUrl: credentials.tokenUrl, authorizeUrl: credentials.authorizeUrl ?? null, defaultScopes: [] };
}

function scopeParam(credentials: ManagedCredentials, endpoints: OAuthEndpoints): string {
  return (credentials.scopes ?? endpoints.defaultScopes).join(' ');
}

async function postTokenRequest(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new GatewayError('VENDOR_AUTH_UNREACHABLE', 'Could not reach the vendor token endpoint', 502, {
      message: (err as Error).message,
    });
  }
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body — handled below
  }
  if (!response.ok || !body || typeof body.access_token !== 'string') {
    const description = typeof body?.error_description === 'string' ? body.error_description.slice(0, 300) : undefined;
    throw new GatewayError('VENDOR_AUTH_FAILED', description ?? 'The vendor token endpoint rejected the request', 502, {
      vendorError: typeof body?.error === 'string' ? body.error : undefined,
      status: response.status,
    });
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}

export async function requestClientCredentialsToken(adapterType: string, credentials: ManagedCredentials): Promise<TokenResponse> {
  const endpoints = resolveEndpoints(adapterType, credentials);
  const form: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  };
  const scope = scopeParam(credentials, endpoints);
  if (scope) form.scope = scope;
  return postTokenRequest(endpoints.tokenUrl, form);
}

export async function requestRefreshedToken(adapterType: string, credentials: ManagedCredentials): Promise<TokenResponse> {
  if (!credentials.refreshToken) {
    throw new GatewayError('AUTHORIZATION_REQUIRED', 'No refresh token is stored; complete the OAuth authorization first', 503);
  }
  const endpoints = resolveEndpoints(adapterType, credentials);
  return postTokenRequest(endpoints.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

export async function exchangeAuthorizationCode(
  adapterType: string,
  credentials: ManagedCredentials,
  input: { code: string; redirectUri: string; codeVerifier: string }
): Promise<TokenResponse> {
  const endpoints = resolveEndpoints(adapterType, credentials);
  return postTokenRequest(endpoints.tokenUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

export function buildAuthorizationUrl(
  adapterType: string,
  credentials: ManagedCredentials,
  input: { redirectUri: string; state: string; codeChallenge: string }
): string {
  const endpoints = resolveEndpoints(adapterType, credentials);
  if (!endpoints.authorizeUrl) {
    throw new GatewayError('INVALID_CONFIGURATION', 'These credentials have no authorize endpoint configured', 400);
  }
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const scope = scopeParam(credentials, endpoints);
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts` add:

```ts
export { parseManagedCredentials } from './auth/oauthClient';
export type { ManagedCredentials, OAuthGrant } from './auth/oauthClient';
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run packages/core/test/auth/oauthClient.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/auth/oauthClient.ts packages/core/src/index.ts packages/core/test/auth/oauthClient.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add generic OAuth2 client (client-credentials, auth-code + PKCE, refresh)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ManagedTokenService and `buildAuthContext`

**Files:**
- Create: `packages/core/src/auth/managedTokenService.ts`
- Create: `packages/core/src/auth/authContext.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/auth/managedTokenService.test.ts`, `packages/core/test/auth/authContext.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CredentialCipher`, `MappingStore.get/setConnectionCredentials`), Task 5 (all OAuth functions and `ManagedCredentials`), `ConnectionRecord`, `AuthContext`.
- Produces:
  - `interface AccessTokenProvider { getAccessToken(connection: ConnectionRecord): Promise<string> }`
  - `type CredentialStatus = { configured: false } | { configured: true; grant: OAuthGrant; hasRefreshToken: boolean }`
  - `class ManagedTokenService implements AccessTokenProvider` with `constructor(store: MappingStore, cipher: CredentialCipher, now?: () => number)`, `saveCredentials(connection, input: unknown): CredentialStatus`, `getCredentialStatus(connectionId): CredentialStatus`, `getAccessToken(connection): Promise<string>`, `beginAuthorization(connection, redirectUri): string` (returns the vendor authorization URL), `completeAuthorization(state: string, code: string): Promise<{ connectionId: string }>`.
  - Error codes: `MANAGED_CREDENTIALS_MISSING` (503 from `getAccessToken`, 400 from `beginAuthorization`), `AUTHORIZATION_REQUIRED` (503), `INVALID_STATE` (400), `CREDENTIAL_DECRYPTION_FAILED` (500), plus Task 5's vendor errors.
  - `buildAuthContext(connection: ConnectionRecord, incomingVendorToken: string | undefined, tokenProvider?: AccessTokenProvider): Promise<AuthContext>` — passthrough returns the incoming token untouched; `managed` returns the provider's token (ignoring the incoming header) or throws `GatewayError('MANAGED_AUTH_UNAVAILABLE', …, 503)` when no provider is configured.

- [ ] **Step 1: Write the failing service test**

Create `packages/core/test/auth/managedTokenService.test.ts`:

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
const KEY = '00'.repeat(32);
const CC_INPUT = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };
const AC_INPUT = { ...CC_INPUT, grant: 'authorization_code' };

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let connection: ConnectionRecord;
let clock: number;
let service: ManagedTokenService;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  connection = store.createConnection({ name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
  clock = 1_000_000;
  service = new ManagedTokenService(store, new CredentialCipher(KEY), () => clock);
});

afterEach(() => {
  nock.cleanAll();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

describe('credential storage', () => {
  it('encrypts credentials at rest and reports only a non-secret status', () => {
    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: false });
    const status = service.saveCredentials(connection, CC_INPUT);
    expect(status).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(service.getCredentialStatus(connection.id)).toEqual(status);
    const stored = store.getConnectionCredentials(connection.id)!;
    expect(stored).not.toContain('super-secret-value');
    expect(stored.startsWith('v1:')).toBe(true);
  });

  it('rejects invalid credentials with a 400', () => {
    expect(() => service.saveCredentials(connection, { grant: 'client_credentials' })).toThrow(/clientId/);
  });

  it('cannot read credentials encrypted under a different key', async () => {
    service.saveCredentials(connection, CC_INPUT);
    const other = new ManagedTokenService(store, new CredentialCipher('11'.repeat(32)), () => clock);
    await expect(other.getAccessToken(connection)).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED', status: 500 });
  });
});

describe('getAccessToken (client credentials)', () => {
  it('fails with a 503 when no credentials are configured', async () => {
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'MANAGED_CREDENTIALS_MISSING', status: 503 });
  });

  it('caches the token until shortly before it expires, then refetches', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-1');

    clock += 3000 * 1000; // still valid — no new HTTP call is mocked, so a refetch would fail
    expect(await service.getAccessToken(connection)).toBe('at-1');

    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-2', expires_in: 3600 });
    clock += 540 * 1000; // inside the 60s skew window before expiry
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });

  it('makes a single vendor request for concurrent callers', async () => {
    service.saveCredentials(connection, CC_INPUT);
    const scope = nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    const tokens = await Promise.all([service.getAccessToken(connection), service.getAccessToken(connection), service.getAccessToken(connection)]);
    expect(tokens).toEqual(['at-1', 'at-1', 'at-1']);
    expect(scope.isDone()).toBe(true);
  });

  it('drops the cached token when credentials are replaced', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-1', expires_in: 3600 });
    await service.getAccessToken(connection);
    service.saveCredentials(connection, { ...CC_INPUT, clientSecret: 'rotated-secret' });
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'rotated-secret', scope: 'https://graph.microsoft.com/.default' })
      .reply(200, { access_token: 'at-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });

  it('does not cache a failed request', async () => {
    service.saveCredentials(connection, CC_INPUT);
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client' });
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at-ok', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-ok');
  });
});

describe('authorization-code flow', () => {
  const REDIRECT = 'https://gtr.example/admin/oauth/callback';

  function stateFrom(url: string): string {
    return new URL(url).searchParams.get('state')!;
  }

  it('requires authorization before a token can be issued', async () => {
    service.saveCredentials(connection, AC_INPUT);
    await expect(service.getAccessToken(connection)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED', status: 503 });
  });

  it('refuses to begin authorization for a client_credentials connection or one without credentials', () => {
    expect(() => service.beginAuthorization(connection, REDIRECT)).toThrow(/credentials/);
    service.saveCredentials(connection, CC_INPUT);
    expect(() => service.beginAuthorization(connection, REDIRECT)).toThrow(/client_credentials/);
  });

  it('completes authorization, stores the refresh token, and caches the first access token', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const url = service.beginAuthorization(connection, REDIRECT);
    nock(LOGIN)
      .post(TOKEN_PATH, (body: Record<string, string>) => body.grant_type === 'authorization_code' && body.code === 'code-1' && typeof body.code_verifier === 'string')
      .reply(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });

    const result = await service.completeAuthorization(stateFrom(url), 'code-1');

    expect(result).toEqual({ connectionId: connection.id });
    expect(service.getCredentialStatus(connection.id)).toEqual({ configured: true, grant: 'authorization_code', hasRefreshToken: true });
    expect(await service.getAccessToken(connection)).toBe('at-1'); // served from cache — no further HTTP mocked
    expect(store.getConnectionCredentials(connection.id)).not.toContain('rt-1');
  });

  it('makes state single-use and rejects unknown or expired state', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const url = service.beginAuthorization(connection, REDIRECT);
    const state = stateFrom(url);
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    await service.completeAuthorization(state, 'code-1');
    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    await expect(service.completeAuthorization('made-up', 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const expiring = stateFrom(service.beginAuthorization(connection, REDIRECT));
    clock += 11 * 60 * 1000;
    await expect(service.completeAuthorization(expiring, 'code-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('fails clearly when the vendor returns no refresh token', async () => {
    service.saveCredentials(connection, AC_INPUT);
    const state = stateFrom(service.beginAuthorization(connection, REDIRECT));
    nock(LOGIN).post(TOKEN_PATH).reply(200, { access_token: 'at', expires_in: 3600 });
    await expect(service.completeAuthorization(state, 'code-1')).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('refreshes with the stored token and persists a rotated refresh token', async () => {
    service.saveCredentials(connection, { ...AC_INPUT, refreshToken: 'rt-1' });
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'cid', client_secret: 'super-secret-value' })
      .reply(200, { access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-1');

    clock += 3600 * 1000;
    nock(LOGIN).post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: 'rt-2', client_id: 'cid', client_secret: 'super-secret-value' })
      .reply(200, { access_token: 'at-2', expires_in: 3600 });
    expect(await service.getAccessToken(connection)).toBe('at-2');
  });
});
```

- [ ] **Step 2: Write the failing `buildAuthContext` test**

Create `packages/core/test/auth/authContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAuthContext } from '../../src/auth/authContext';
import type { ConnectionRecord } from '../../src/storage/MappingStore';

const base: ConnectionRecord = { id: 'c1', name: 'c', adapterType: 'mock', authMode: 'passthrough', config: { a: 1 } };
const provider = { getAccessToken: async () => 'managed-token' };

describe('buildAuthContext', () => {
  it('forwards the incoming vendor token unchanged for passthrough connections', async () => {
    expect(await buildAuthContext(base, 'dev-token')).toEqual({
      connectionId: 'c1',
      authMode: 'passthrough',
      config: { a: 1 },
      vendorToken: 'dev-token',
    });
    expect((await buildAuthContext(base, undefined, provider)).vendorToken).toBeUndefined();
  });

  it('uses the provider token for managed connections and ignores the incoming header', async () => {
    const managed = { ...base, authMode: 'managed' };
    expect((await buildAuthContext(managed, 'dev-token', provider)).vendorToken).toBe('managed-token');
  });

  it('fails with a 503 when a managed connection has no provider configured', async () => {
    await expect(buildAuthContext({ ...base, authMode: 'managed' }, undefined)).rejects.toMatchObject({
      code: 'MANAGED_AUTH_UNAVAILABLE',
      status: 503,
    });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run packages/core/test/auth/managedTokenService.test.ts packages/core/test/auth/authContext.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `authContext.ts`**

Create `packages/core/src/auth/authContext.ts`:

```ts
import type { AuthContext } from '../adapters/Adapter';
import type { ConnectionRecord } from '../storage/MappingStore';
import { GatewayError } from '../gateway/errors';
import type { AccessTokenProvider } from './managedTokenService';

/**
 * The single place that decides which vendor token an adapter call carries:
 * passthrough forwards the developer's `X-Vendor-Token`; managed ignores it and uses the proxy-held token.
 */
export async function buildAuthContext(
  connection: ConnectionRecord,
  incomingVendorToken: string | undefined,
  tokenProvider?: AccessTokenProvider
): Promise<AuthContext> {
  const context: AuthContext = { connectionId: connection.id, authMode: connection.authMode, config: connection.config };
  if (connection.authMode !== 'managed') {
    return { ...context, vendorToken: incomingVendorToken };
  }
  if (!tokenProvider) {
    throw new GatewayError('MANAGED_AUTH_UNAVAILABLE', 'Managed auth requires CREDENTIAL_ENCRYPTION_KEY to be configured on the server', 503);
  }
  return { ...context, vendorToken: await tokenProvider.getAccessToken(connection) };
}
```

- [ ] **Step 5: Implement `managedTokenService.ts`**

Create `packages/core/src/auth/managedTokenService.ts`:

```ts
import crypto from 'node:crypto';
import { GatewayError } from '../gateway/errors';
import type { ConnectionRecord, MappingStore } from '../storage/MappingStore';
import type { CredentialCipher } from './credentialCipher';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  parseManagedCredentials,
  requestClientCredentialsToken,
  requestRefreshedToken,
  type ManagedCredentials,
  type OAuthGrant,
  type TokenResponse,
} from './oauthClient';

export interface AccessTokenProvider {
  getAccessToken(connection: ConnectionRecord): Promise<string>;
}

export type CredentialStatus = { configured: false } | { configured: true; grant: OAuthGrant; hasRefreshToken: boolean };

interface PendingAuthorization {
  connectionId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

const REFRESH_SKEW_MS = 60_000;
const AUTHORIZATION_TTL_MS = 10 * 60_000;

function statusOf(credentials: ManagedCredentials): CredentialStatus {
  return { configured: true, grant: credentials.grant, hasRefreshToken: Boolean(credentials.refreshToken) };
}

/**
 * Owns managed vendor credentials: encrypted persistence, access-token caching with single-flight refresh,
 * and the in-memory state/PKCE bookkeeping for the authorization-code flow (single-process deployment, spec §2).
 */
export class ManagedTokenService implements AccessTokenProvider {
  private tokens = new Map<string, { accessToken: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();
  private pending = new Map<string, PendingAuthorization>();

  constructor(
    private store: MappingStore,
    private cipher: CredentialCipher,
    private now: () => number = Date.now
  ) {}

  saveCredentials(connection: ConnectionRecord, input: unknown): CredentialStatus {
    const credentials = parseManagedCredentials(connection.adapterType, input);
    this.writeCredentials(connection.id, credentials);
    this.tokens.delete(connection.id);
    return statusOf(credentials);
  }

  getCredentialStatus(connectionId: string): CredentialStatus {
    const credentials = this.readCredentials(connectionId);
    return credentials ? statusOf(credentials) : { configured: false };
  }

  getAccessToken(connection: ConnectionRecord): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > this.now()) return Promise.resolve(cached.accessToken);
    const existing = this.inflight.get(connection.id);
    if (existing) return existing;
    const request = this.fetchToken(connection).finally(() => this.inflight.delete(connection.id));
    this.inflight.set(connection.id, request);
    return request;
  }

  beginAuthorization(connection: ConnectionRecord, redirectUri: string): string {
    const credentials = this.readCredentials(connection.id);
    if (!credentials) {
      throw new GatewayError('MANAGED_CREDENTIALS_MISSING', 'Store credentials for this connection before starting authorization', 400);
    }
    if (credentials.grant !== 'authorization_code') {
      throw new GatewayError('INVALID_INPUT', 'This connection uses the client_credentials grant; no authorization step is needed', 400);
    }
    this.prunePending();
    const state = crypto.randomBytes(24).toString('base64url');
    const { verifier, challenge } = generatePkcePair();
    this.pending.set(state, {
      connectionId: connection.id,
      codeVerifier: verifier,
      redirectUri,
      expiresAt: this.now() + AUTHORIZATION_TTL_MS,
    });
    return buildAuthorizationUrl(connection.adapterType, credentials, { redirectUri, state, codeChallenge: challenge });
  }

  async completeAuthorization(state: string, code: string): Promise<{ connectionId: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state); // single use, even on failure
    if (!pending || pending.expiresAt <= this.now()) {
      throw new GatewayError('INVALID_STATE', 'Unknown or expired authorization state', 400);
    }
    const connection = this.store.getConnection(pending.connectionId);
    const credentials = connection ? this.readCredentials(connection.id) : null;
    if (!connection || !credentials || credentials.grant !== 'authorization_code') {
      throw new GatewayError('INVALID_STATE', 'Unknown or expired authorization state', 400);
    }
    const response = await exchangeAuthorizationCode(connection.adapterType, credentials, {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
    if (!response.refreshToken) {
      throw new GatewayError(
        'VENDOR_AUTH_FAILED',
        'The vendor did not return a refresh token; make sure offline access is granted (for Microsoft, the offline_access scope)',
        502
      );
    }
    this.writeCredentials(connection.id, { ...credentials, refreshToken: response.refreshToken });
    this.remember(connection.id, response);
    return { connectionId: connection.id };
  }

  private async fetchToken(connection: ConnectionRecord): Promise<string> {
    const credentials = this.readCredentials(connection.id);
    if (!credentials) {
      throw new GatewayError('MANAGED_CREDENTIALS_MISSING', `Connection "${connection.name}" has no managed credentials configured`, 503);
    }
    let response: TokenResponse;
    if (credentials.grant === 'client_credentials') {
      response = await requestClientCredentialsToken(connection.adapterType, credentials);
    } else {
      if (!credentials.refreshToken) {
        throw new GatewayError('AUTHORIZATION_REQUIRED', `Connection "${connection.name}" has not been authorized yet`, 503);
      }
      response = await requestRefreshedToken(connection.adapterType, credentials);
      if (response.refreshToken && response.refreshToken !== credentials.refreshToken) {
        this.writeCredentials(connection.id, { ...credentials, refreshToken: response.refreshToken });
      }
    }
    this.remember(connection.id, response);
    return response.accessToken;
  }

  private remember(connectionId: string, response: TokenResponse): void {
    this.tokens.set(connectionId, { accessToken: response.accessToken, expiresAt: this.now() + response.expiresInSeconds * 1000 });
  }

  private prunePending(): void {
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= this.now()) this.pending.delete(state);
    }
  }

  private readCredentials(connectionId: string): ManagedCredentials | null {
    const encrypted = this.store.getConnectionCredentials(connectionId);
    if (!encrypted) return null;
    try {
      return JSON.parse(this.cipher.decrypt(encrypted)) as ManagedCredentials;
    } catch {
      throw new GatewayError('CREDENTIAL_DECRYPTION_FAILED', 'Stored credentials could not be decrypted; check CREDENTIAL_ENCRYPTION_KEY', 500);
    }
  }

  private writeCredentials(connectionId: string, credentials: ManagedCredentials): void {
    this.store.setConnectionCredentials(connectionId, this.cipher.encrypt(JSON.stringify(credentials)));
  }
}
```

- [ ] **Step 6: Export from the barrel**

In `packages/core/src/index.ts` add:

```ts
export { ManagedTokenService } from './auth/managedTokenService';
export type { AccessTokenProvider, CredentialStatus } from './auth/managedTokenService';
export { buildAuthContext } from './auth/authContext';
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run packages/core`
Expected: PASS. If the cache-expiry test is off by one, re-check the arithmetic: token lifetime 3600 s, skew 60 s → the cached token is served while `elapsed < 3540 s`; the test advances 3000 s (served) and then 540 s more = 3540 s (refetch).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/auth packages/core/src/index.ts packages/core/test/auth
git commit -m "$(cat <<'EOF'
feat(core): add ManagedTokenService (encrypted credentials, cached/refreshed tokens, auth-code state) and buildAuthContext

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire managed auth into the gateway, vendor clients and admin generate route

**Files:**
- Modify: `packages/core/src/gateway/GatewayEngine.ts`
- Modify: `packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts:19-26`
- Modify: `packages/core/src/adapters/graphql/GraphQLHttpClient.ts:24-30`
- Modify: `apps/server/src/routers/adminRouter.ts` (generate route + options)
- Modify: `apps/server/src/app.ts` (`AppDeps.managedAuth`)
- Modify: `packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts`, `packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts`, `packages/core/test/gateway/GatewayEngine.test.ts` (existing assertions that encode the pre-Plan-5 behaviour)
- Test: `packages/core/test/gateway/managedAuth.test.ts`, `packages/core/test/adapters/managedAuthMode.test.ts`, plus one case appended to `apps/server/test/integration.test.ts`

**Interfaces:**
- Consumes: `buildAuthContext`, `AccessTokenProvider`, `ManagedTokenService` (Task 6).
- Produces:
  - `new GatewayEngine(mappingStore, tokenProvider?: AccessTokenProvider)`.
  - `GraphHttpClient` and `GraphQLHttpClient` accept `authMode` `"passthrough"` **or** `"managed"` (a token must be present either way); any other mode → 501 `UNSUPPORTED_AUTH_MODE`.
  - `AdminRouterOptions.managedAuth?: ManagedTokenService` and `AppDeps.managedAuth?: ManagedTokenService`; `POST /admin/connections/:id/mappings/generate` builds its auth context with `buildAuthContext`.

- [ ] **Step 1: Update the pre-existing assertions that encode the old behaviour**

The old tests use `'managed'` as the "unsupported mode" example; switch them to a mode that stays unsupported:

```bash
perl -pi -e "s/'managed'/'basic'/g" packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts
grep -n "'basic'" packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts
```
Expected: 2 matches in the Graph file (lines ~13, ~15) and 2 in the GraphQL file (lines ~15, ~17).

In `packages/core/test/gateway/GatewayEngine.test.ts`, the test `'passes the connection authMode through the auth context'` creates a `managed` connection and calls the shared `engine`, which has no token provider. Replace its final two lines:

```ts
    await engine.handle('GET', '/spy2/1');

    expect(received).toEqual(['managed']);
```
with:

```ts
    const managedEngine = new GatewayEngine(store, { getAccessToken: async () => 'stub-token' });
    await managedEngine.handle('GET', '/spy2/1');

    expect(received).toEqual(['managed']);
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/test/adapters/managedAuthMode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphHttpClient } from '../../src/adapters/microsoftGraph/GraphHttpClient';
import { GraphQLHttpClient } from '../../src/adapters/graphql/GraphQLHttpClient';

describe('vendor clients accept authMode "managed"', () => {
  it('GraphHttpClient constructs for managed with a token, and still rejects a missing token', () => {
    expect(() => new GraphHttpClient('managed', 'tok')).not.toThrow();
    expect(() => new GraphHttpClient('managed', undefined)).toThrow(/vendor access token/);
  });

  it('GraphQLHttpClient constructs for managed with a token, and still rejects a missing token', () => {
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'managed', 'tok')).not.toThrow();
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'managed', undefined)).toThrow(/vendor access token/);
  });

  it('both still reject unknown modes with 501', () => {
    expect(() => new GraphHttpClient('basic', 'tok')).toThrow(/passthrough.*managed/);
    expect(() => new GraphQLHttpClient('https://x.example/graphql', 'basic', 'tok')).toThrow(/passthrough.*managed/);
  });
});
```

Create `packages/core/test/gateway/managedAuth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db';
import { MappingStore } from '../../src/storage/MappingStore';
import { GatewayEngine } from '../../src/gateway/GatewayEngine';
import { registerAdapter, clearAdapters } from '../../src/adapters/registry';

let dbPath: string;
let db: ReturnType<typeof openDb>;
let store: MappingStore;
let seen: Array<{ authMode?: string; vendorToken?: string }>;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `graphtorest-gwmanaged-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  store = new MappingStore(db);
  seen = [];
  clearAdapters();
  registerAdapter('spy-managed', () => ({
    type: 'spy-managed',
    async introspect() {
      return {};
    },
    async generateMappings() {
      return [];
    },
    async execute(_operation, _params, authContext) {
      seen.push({ authMode: authContext.authMode, vendorToken: authContext.vendorToken });
      return { ok: true };
    },
  }));
});

afterEach(() => {
  clearAdapters();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function seed(authMode: string) {
  const connection = store.createConnection({ name: `c-${authMode}`, adapterType: 'spy-managed', authMode });
  store.createMapping({ connectionId: connection.id, route: '/thing', method: 'GET', operation: {} });
}

describe('GatewayEngine with managed auth', () => {
  it('gives managed connections the provider token and ignores the incoming X-Vendor-Token', async () => {
    seed('managed');
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' });
    await engine.handle('GET', '/thing', { vendorToken: 'developer-token' });
    expect(seen).toEqual([{ authMode: 'managed', vendorToken: 'managed-token' }]);
  });

  it('fails with a 503 MANAGED_AUTH_UNAVAILABLE when no provider is configured', async () => {
    seed('managed');
    const engine = new GatewayEngine(store);
    await expect(engine.handle('GET', '/thing')).rejects.toMatchObject({ code: 'MANAGED_AUTH_UNAVAILABLE', status: 503 });
    expect(seen).toEqual([]);
  });

  it('propagates provider errors unchanged', async () => {
    seed('managed');
    const engine = new GatewayEngine(store, {
      getAccessToken: async () => {
        throw Object.assign(new Error('vendor said no'), { code: 'VENDOR_AUTH_FAILED', status: 502 });
      },
    });
    await expect(engine.handle('GET', '/thing')).rejects.toMatchObject({ code: 'VENDOR_AUTH_FAILED' });
  });

  it('leaves passthrough connections untouched even when a provider exists', async () => {
    seed('passthrough');
    const engine = new GatewayEngine(store, { getAccessToken: async () => 'managed-token' });
    await engine.handle('GET', '/thing', { vendorToken: 'developer-token' });
    expect(seen).toEqual([{ authMode: 'passthrough', vendorToken: 'developer-token' }]);
  });
});
```

Append this case to the `'mapping generation and editing'` describe in `apps/server/test/integration.test.ts` (just before its closing `});`):

```ts
  it('returns 503 when generating for a managed connection and managed auth is not configured', async () => {
    const connectionRes = await admin
      .post('/admin/connections')
      .send({ name: 'managed-gen', adapterType: 'mock', authMode: 'managed' });
    const res = await admin.post(`/admin/connections/${connectionRes.body.id}/mappings/generate`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_AUTH_UNAVAILABLE');
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run packages/core/test/gateway packages/core/test/adapters/managedAuthMode.test.ts packages/core/test/adapters/microsoftGraph/GraphHttpClient.test.ts packages/core/test/adapters/graphql/GraphQLHttpClient.test.ts apps/server/test/integration.test.ts`
Expected: FAIL — `managedAuthMode` and `managedAuth` tests fail (clients reject `managed`, engine ignores the provider), the server case returns 200/other.

- [ ] **Step 4: Accept `managed` in the vendor clients**

In `packages/core/src/adapters/microsoftGraph/GraphHttpClient.ts` replace the `if (authMode !== 'passthrough') { … }` block with:

```ts
    if (authMode !== 'passthrough' && authMode !== 'managed') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'Microsoft Graph connections only support authMode "passthrough" or "managed"',
        501
      );
    }
```

In `packages/core/src/adapters/graphql/GraphQLHttpClient.ts` replace the equivalent block with:

```ts
    if (authMode !== 'passthrough' && authMode !== 'managed') {
      throw new GatewayError(
        'UNSUPPORTED_AUTH_MODE',
        'GraphQL connections only support authMode "passthrough" or "managed"',
        501
      );
    }
```

- [ ] **Step 5: Use `buildAuthContext` in `GatewayEngine`**

In `packages/core/src/gateway/GatewayEngine.ts`:

Add imports:

```ts
import { buildAuthContext } from '../auth/authContext';
import type { AccessTokenProvider } from '../auth/managedTokenService';
```

Change the constructor to `constructor(private mappingStore: MappingStore, private tokenProvider?: AccessTokenProvider) {}` and replace the `adapter.execute(...)` call block (the `const raw = await adapter.execute(operation, params, { … }, request);` statement) with:

```ts
    const authContext = await buildAuthContext(connection, incomingAuth.vendorToken, this.tokenProvider);
    const raw = await adapter.execute(operation, params, authContext, request);
```

- [ ] **Step 6: Thread the service through the admin router and app**

In `apps/server/src/routers/adminRouter.ts`:

Extend the import: add `buildAuthContext` and `type ManagedTokenService` to the `@graphtorest/core` import list. Extend the options interface:

```ts
export interface AdminRouterOptions {
  sessionTtlMs?: number;
  managedAuth?: ManagedTokenService;
}
```

In the generate route replace the `generateAndPersistMappings(...)` call (inside its `try`) with:

```ts
      const authContext = await buildAuthContext(connection, vendorToken, options.managedAuth);
      const result = await generateAndPersistMappings(mappingStore, connection, authContext, { force });
```

In `apps/server/src/app.ts` add `managedAuth?: ManagedTokenService;` to `AppDeps` (add `type ManagedTokenService` to the core import) and change the admin mount to:

```ts
    app.use(
      '/admin',
      createAdminRouter(deps.mappingStore, { sessionTtlMs: deps.adminSessionTtlMs, managedAuth: deps.managedAuth })
    );
```

- [ ] **Step 7: Run the affected tests, then everything**

Run: `npm run build -w @graphtorest/core && npx vitest run`
Expected: PASS across core, server and CLI.

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/server
git commit -m "$(cat <<'EOF'
feat(core,server): resolve managed vendor tokens in the gateway, vendor clients and generate route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Credential and OAuth admin endpoints, server config, end-to-end tests

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/index.ts`, `apps/server/src/app.ts`
- Modify: `apps/server/src/routers/adminRouter.ts`
- Modify: `apps/server/test/config.test.ts`
- Modify: `docker-compose.yml`
- Test: `apps/server/test/managedAuth.integration.test.ts`

**Interfaces:**
- Consumes: `ManagedTokenService`, `CredentialCipher` (Tasks 1, 5, 6), `AppDeps.managedAuth` (Task 7).
- Produces:
  - `ServerConfig.credentialEncryptionKey?: string` (env `CREDENTIAL_ENCRYPTION_KEY`) and `ServerConfig.publicBaseUrl: string` (env `PUBLIC_BASE_URL`, default `http://localhost:<port>`).
  - `AppDeps.publicBaseUrl?: string`; `AdminRouterOptions.publicBaseUrl?: string`.
  - Routes (all admin-authenticated unless noted): `PUT /admin/connections/:id/credentials` (body per `parseManagedCredentials`; 200 with a `CredentialStatus`), `GET /admin/connections/:id/credentials` (200 `CredentialStatus`), `POST /admin/connections/:id/oauth/start` (200 `{ authorizationUrl }`), `GET /admin/oauth/callback?code=&state=` (**public**, state-protected; 200 `{ status: 'authorized', connectionId }`). When `managedAuth` is not configured all four respond 503 `MANAGED_AUTH_DISABLED`. The credential routes 404 for an unknown connection and 400 when the connection's `authMode` is not `managed`.

- [ ] **Step 1: Write the failing end-to-end test**

Create `apps/server/test/managedAuth.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import request from 'supertest';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
import { createApp } from '../src/app';
import { createAdminClient, type AdminClient } from './helpers';

const LOGIN = 'https://login.microsoftonline.com';
const TOKEN_PATH = '/tenant-1/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com';
const BASE_URL = 'https://gtr.example.test';
const SECRET = 'super-secret-value';

let dbPath: string;
let app: ReturnType<typeof createApp>;
let store: MappingStore;
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
    publicBaseUrl: BASE_URL,
  });
}

beforeEach(() => {
  registerDefaultAdapters();
  dbPath = path.join(os.tmpdir(), `graphtorest-managed-int-${Date.now()}-${Math.random()}.db`);
  store = new MappingStore(openDb(dbPath));
  app = buildApp(true);
  admin = createAdminClient(app, store);
});

afterEach(() => {
  nock.cleanAll();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

async function seedManagedGraphConnection(authMode = 'managed') {
  const connectionRes = await admin.post('/admin/connections').send({ name: 'ms-managed', adapterType: 'microsoft-graph', authMode });
  const connectionId = connectionRes.body.id as string;
  await admin.post('/admin/mappings').send({
    connectionId,
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
  });
  const apiKeyRes = await admin.post('/admin/api-keys').send({});
  return { connectionId, apiKey: apiKeyRes.body.plaintext as string };
}

const CC_BODY = { grant: 'client_credentials', clientId: 'cid', clientSecret: SECRET, tenantId: 'tenant-1' };

describe('managed auth: client credentials', () => {
  it('stores credentials encrypted, then serves API calls using only a proxy API key', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();

    const put = await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(JSON.stringify(put.body)).not.toContain(SECRET);
    expect(store.getConnectionCredentials(connectionId)).not.toContain(SECRET);

    const status = await admin.get(`/admin/connections/${connectionId}/credentials`);
    expect(status.body).toEqual(put.body);
    const listed = await admin.get('/admin/connections');
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);

    const tokenScope = nock(LOGIN)
      .post(TOKEN_PATH, { grant_type: 'client_credentials', client_id: 'cid', client_secret: SECRET, scope: 'https://graph.microsoft.com/.default' })
      .reply(200, { access_token: 'managed-token', expires_in: 3600 });
    const graphScope = nock(GRAPH, { reqheaders: { authorization: 'Bearer managed-token' } })
      .get('/v1.0/users/42')
      .times(2)
      .reply(200, { id: '42', displayName: 'Ada Lovelace' });

    const first = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    // The developer's own X-Vendor-Token is ignored on a managed connection, and the cached token is reused.
    const second = await request(app)
      .get('/api/msgraph/users/42')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Vendor-Token', 'developer-token-ignored');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: '42', displayName: 'Ada Lovelace' });
    expect(second.status).toBe(200);
    expect(tokenScope.isDone()).toBe(true);
    expect(graphScope.isDone()).toBe(true);
  });

  it('surfaces a vendor token failure as a normalized 502 without leaking the secret', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    nock(LOGIN).post(TOKEN_PATH).reply(401, { error: 'invalid_client', error_description: 'Client authentication failed' });

    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('VENDOR_AUTH_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('returns 503 when a managed connection has no credentials yet', async () => {
    const { apiKey } = await seedManagedGraphConnection();
    const res = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_CREDENTIALS_MISSING');
  });
});

describe('managed auth: credential endpoint guards', () => {
  it('requires an admin session', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const res = await request(app).put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(401);
  });

  it('404s for an unknown connection and 400s for a non-managed one', async () => {
    expect((await admin.put('/admin/connections/nope/credentials').send(CC_BODY)).status).toBe(404);
    const { connectionId } = await seedManagedGraphConnection('passthrough');
    const res = await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('400s on invalid credential bodies', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const res = await admin.put(`/admin/connections/${connectionId}/credentials`).send({ grant: 'client_credentials', clientId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('503s with MANAGED_AUTH_DISABLED when no encryption key is configured', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    const bare = buildApp(false);
    const bareAdmin = createAdminClientForExistingUser(bare);
    const res = await bareAdmin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MANAGED_AUTH_DISABLED');
    const callback = await request(bare).get('/admin/oauth/callback?code=a&state=b');
    expect(callback.status).toBe(503);
  });

  function createAdminClientForExistingUser(target: ReturnType<typeof createApp>) {
    const session = store.createAdminSession(store.findAdminUserByUsername('test-admin')!.id, 60_000);
    return {
      put: (url: string) => request(target).put(url).set('Authorization', `Bearer ${session.token}`),
    };
  }
});

describe('managed auth: authorization code', () => {
  const AC_BODY = { ...CC_BODY, grant: 'authorization_code' };

  it('runs start → vendor consent → callback, then serves API calls from the stored grant', async () => {
    const { connectionId, apiKey } = await seedManagedGraphConnection();
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(AC_BODY);

    const before = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(503);
    expect(before.body.error.code).toBe('AUTHORIZATION_REQUIRED');

    const start = await admin.post(`/admin/connections/${connectionId}/oauth/start`).send({});
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${LOGIN}/tenant-1/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/admin/oauth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(start.body.authorizationUrl).not.toContain(SECRET);
    const state = url.searchParams.get('state')!;

    nock(LOGIN)
      .post(
        TOKEN_PATH,
        (body: Record<string, string>) =>
          body.grant_type === 'authorization_code' &&
          body.code === 'auth-code-1' &&
          body.redirect_uri === `${BASE_URL}/admin/oauth/callback` &&
          typeof body.code_verifier === 'string' &&
          body.client_secret === SECRET
      )
      .reply(200, { access_token: 'delegated-token', refresh_token: 'rt-1', expires_in: 3600 });

    // The vendor redirects the *browser* here — no admin bearer token is present.
    const callback = await request(app).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ status: 'authorized', connectionId });

    const status = await admin.get(`/admin/connections/${connectionId}/credentials`);
    expect(status.body).toEqual({ configured: true, grant: 'authorization_code', hasRefreshToken: true });

    const graphScope = nock(GRAPH, { reqheaders: { authorization: 'Bearer delegated-token' } })
      .get('/v1.0/users/42')
      .reply(200, { id: '42' });
    const after = await request(app).get('/api/msgraph/users/42').set('Authorization', `Bearer ${apiKey}`);
    expect(after.status).toBe(200);
    expect(graphScope.isDone()).toBe(true);

    const replay = await request(app).get(`/admin/oauth/callback?code=auth-code-1&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_STATE');
  });

  it('rejects a callback with unknown state, missing params, or a vendor error', async () => {
    const unknown = await request(app).get('/admin/oauth/callback?code=x&state=made-up');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_STATE');

    const missing = await request(app).get('/admin/oauth/callback?code=x');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const denied = await request(app).get('/admin/oauth/callback?error=access_denied&state=s');
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('requires admin auth for oauth/start and rejects it for client_credentials connections', async () => {
    const { connectionId } = await seedManagedGraphConnection();
    expect((await request(app).post(`/admin/connections/${connectionId}/oauth/start`).send({})).status).toBe(401);
    await admin.put(`/admin/connections/${connectionId}/credentials`).send(CC_BODY);
    const res = await admin.post(`/admin/connections/${connectionId}/oauth/start`).send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Update the config test first**

Replace the two `toEqual` assertions in `apps/server/test/config.test.ts` so the whole file reads:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 3000,
      dbPath: './data/graphtorest.db',
      apiEnabled: true,
      adminEnabled: true,
      publicBaseUrl: 'http://localhost:3000',
    });
    expect(config.credentialEncryptionKey).toBeUndefined();
  });

  it('reads overrides from the given env', () => {
    const config = loadConfig({
      PORT: '8080',
      DB_PATH: '/data/gtr.db',
      API_ENABLED: 'false',
      ADMIN_ENABLED: 'false',
      CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32),
      PUBLIC_BASE_URL: 'https://gtr.example.com/',
    });
    expect(config).toEqual({
      port: 8080,
      dbPath: '/data/gtr.db',
      apiEnabled: false,
      adminEnabled: false,
      credentialEncryptionKey: 'ab'.repeat(32),
      publicBaseUrl: 'https://gtr.example.com',
    });
  });

  it('defaults the public base URL from the port', () => {
    expect(loadConfig({ PORT: '4000' }).publicBaseUrl).toBe('http://localhost:4000');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/config.test.ts apps/server/test/managedAuth.integration.test.ts`
Expected: FAIL — config lacks the new fields; the credential routes 404.

- [ ] **Step 4: Implement the config**

Replace `apps/server/src/config.ts` with:

```ts
export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
  credentialEncryptionKey?: string;
  publicBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  };
}
```

- [ ] **Step 5: Add the credential/OAuth routes**

In `apps/server/src/routers/adminRouter.ts`:

Extend the import list with `type ConnectionRecord`. Extend the options:

```ts
export interface AdminRouterOptions {
  sessionTtlMs?: number;
  managedAuth?: ManagedTokenService;
  publicBaseUrl?: string;
}
```

Immediately after `const requireAdmin = createAdminAuth(mappingStore);` add the helpers:

```ts
  const requireManagedAuth = (): ManagedTokenService => {
    if (!options.managedAuth) {
      throw new GatewayError('MANAGED_AUTH_DISABLED', 'Managed auth is disabled: set CREDENTIAL_ENCRYPTION_KEY on the server', 503);
    }
    return options.managedAuth;
  };

  const findManagedConnection = (id: string): ConnectionRecord => {
    const connection = mappingStore.getConnection(id);
    if (!connection) throw new GatewayError('NOT_FOUND', 'Connection not found', 404);
    if (connection.authMode !== 'managed') {
      throw new GatewayError('INVALID_INPUT', 'The connection authMode must be "managed" to use stored credentials', 400);
    }
    return connection;
  };
```

Immediately after the `/login` route and **before** `router.use(requireAdmin)` add the public callback (the vendor redirects the browser here, so it cannot carry the admin token; it is protected by the single-use `state` issued by an authenticated `oauth/start`):

```ts
  router.get('/oauth/callback', async (req, res) => {
    try {
      const managedAuth = requireManagedAuth();
      const { code, state, error } = req.query;
      if (typeof error === 'string') {
        throw new GatewayError('AUTHORIZATION_DENIED', `The vendor reported an authorization error: ${error.slice(0, 100)}`, 400);
      }
      if (typeof code !== 'string' || typeof state !== 'string') {
        throw new GatewayError('INVALID_INPUT', '"code" and "state" query parameters are required', 400);
      }
      const { connectionId } = await managedAuth.completeAuthorization(state, code);
      res.json({ status: 'authorized', connectionId });
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });
```

Add the authenticated routes right after the `/admin-users` route (they are all sync, so a thrown `GatewayError` reaches the app error handler fixed in Task 3):

```ts
  router.put('/connections/:id/credentials', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    res.json(managedAuth.saveCredentials(connection, req.body));
  });

  router.get('/connections/:id/credentials', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    res.json(managedAuth.getCredentialStatus(connection.id));
  });

  router.post('/connections/:id/oauth/start', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    const baseUrl = (options.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    res.json({ authorizationUrl: managedAuth.beginAuthorization(connection, `${baseUrl}/admin/oauth/callback`) });
  });
```

- [ ] **Step 6: Pass `publicBaseUrl` through the app and wire the server entrypoint**

In `apps/server/src/app.ts` add `publicBaseUrl?: string;` to `AppDeps` and extend the admin mount options with `publicBaseUrl: deps.publicBaseUrl`.

Replace `apps/server/src/index.ts` from the top through the `createApp({...})` call with:

```ts
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';

registerDefaultAdapters();
const config = loadConfig();
const db = openDb(config.dbPath);
const mappingStore = new MappingStore(db);
const managedAuth = config.credentialEncryptionKey
  ? new ManagedTokenService(mappingStore, new CredentialCipher(config.credentialEncryptionKey))
  : undefined;
const gatewayEngine = new GatewayEngine(mappingStore, managedAuth);
const openApiGenerator = new OpenApiGenerator();

const app = createApp({
  mappingStore,
  gatewayEngine,
  openApiGenerator,
  apiEnabled: config.apiEnabled,
  adminEnabled: config.adminEnabled,
  managedAuth,
  publicBaseUrl: config.publicBaseUrl,
});

if (!managedAuth) {
  console.warn(
    JSON.stringify({
      msg: 'managed_auth_disabled',
      warning: 'CREDENTIAL_ENCRYPTION_KEY is not set; connections with authMode "managed" cannot be used.',
    })
  );
}
```

(The `no_admin_users` warning block from Task 3 and the `app.listen(...)` call stay as they are below it.) A malformed key makes `new CredentialCipher` throw at startup, which is the desired fail-fast behaviour.

- [ ] **Step 7: Refresh `docker-compose.yml`**

Replace the whole file with:

```yaml
services:
  graphtorest:
    build: .
    # /admin/* requires an admin login. Create the first admin (12+ character password) with:
    #   docker compose run --rm -e GTR_ADMIN_PASSWORD --entrypoint gtr graphtorest admin-create --username admin
    # The server speaks plain HTTP, so keep the loopback binding unless a TLS-terminating
    # reverse proxy sits in front of it.
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - graphtorest-data:/data
    environment:
      PORT: "3000"
      DB_PATH: /data/graphtorest.db
      # 32-byte key, 64 hex chars or base64 (e.g. `openssl rand -hex 32`). Required for authMode "managed".
      # Keep it out of the DB volume; losing it makes stored vendor credentials unreadable.
      CREDENTIAL_ENCRYPTION_KEY: ${CREDENTIAL_ENCRYPTION_KEY:-}
      # Externally reachable URL of this server; the OAuth redirect URI is <PUBLIC_BASE_URL>/admin/oauth/callback.
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://localhost:3000}

volumes:
  graphtorest-data:
```

- [ ] **Step 8: Run all tests**

Run: `npm run build -w @graphtorest/core && npx vitest run`
Expected: PASS. Then `npm run build` — expected clean (typechecks the new server code, including the `AdminRouterOptions` and `ConnectionRecord` imports).

- [ ] **Step 9: Commit**

```bash
git add apps/server docker-compose.yml
git commit -m "$(cat <<'EOF'
feat(server): add managed-credential and OAuth authorization endpoints, key/base-URL config

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: CLI managed-auth support (`connection-credentials`, token-aware `mapping-generate`)

**Files:**
- Create: `apps/cli/src/commands/connectionCredentialsSet.ts`
- Modify: `apps/cli/src/commands/mappingGenerate.ts`
- Modify: `apps/cli/src/embeddedClient.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/managedAuth.test.ts`

**Interfaces:**
- Consumes: `ManagedTokenService`, `CredentialCipher`, `AccessTokenProvider`, `CredentialStatus`, `buildAuthContext` (core).
- Produces:
  - `openManagedAuth(store: MappingStore, env?: NodeJS.ProcessEnv): ManagedTokenService | undefined` in `embeddedClient.ts` (defined only when `CREDENTIAL_ENCRYPTION_KEY` is set).
  - `connectionCredentialsSet(store, managedAuth: ManagedTokenService | undefined, args: { connectionId: string; credentials: unknown }): CredentialStatus` — throws a plain `Error` when the key is not configured, the connection is unknown, or its `authMode` is not `managed`.
  - `mappingGenerate(store, args)` gains `tokenProvider?: AccessTokenProvider` and builds its auth context with `buildAuthContext`.
  - CLI command `connection-credentials --connection-id <id> (--credentials <json> | --credentials-file <path>)`. (The interactive OAuth authorization-code consent step stays a server/admin-API operation; embedded CLI users can supply a pre-obtained `refreshToken` in the credentials JSON instead.)

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/managedAuth.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore, openManagedAuth } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { connectionCredentialsSet } from '../src/commands/connectionCredentialsSet';
import { mappingGenerate } from '../src/commands/mappingGenerate';

let dbPath: string;

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-climanaged-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

const KEY_ENV = { CREDENTIAL_ENCRYPTION_KEY: '00'.repeat(32) };
const CREDENTIALS = { grant: 'client_credentials', clientId: 'cid', clientSecret: 'super-secret-value', tenantId: 'tenant-1' };

describe('openManagedAuth', () => {
  it('is undefined without a key and defined with one', () => {
    const store = freshStore();
    expect(openManagedAuth(store, {})).toBeUndefined();
    expect(openManagedAuth(store, KEY_ENV)).toBeDefined();
  });
});

describe('connectionCredentialsSet', () => {
  it('stores encrypted credentials for a managed connection and returns a non-secret status', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
    const status = connectionCredentialsSet(store, openManagedAuth(store, KEY_ENV), { connectionId: connection.id, credentials: CREDENTIALS });
    expect(status).toEqual({ configured: true, grant: 'client_credentials', hasRefreshToken: false });
    expect(store.getConnectionCredentials(connection.id)).not.toContain('super-secret-value');
  });

  it('fails clearly when the key is missing, the connection is unknown, or it is not managed', () => {
    const store = freshStore();
    const managed = connectionCreate(store, { name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
    const passthrough = connectionCreate(store, { name: 'pt', adapterType: 'microsoft-graph', authMode: 'passthrough' });
    const service = openManagedAuth(store, KEY_ENV);
    expect(() => connectionCredentialsSet(store, undefined, { connectionId: managed.id, credentials: CREDENTIALS })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => connectionCredentialsSet(store, service, { connectionId: 'nope', credentials: CREDENTIALS })).toThrow(/No connection/);
    expect(() => connectionCredentialsSet(store, service, { connectionId: passthrough.id, credentials: CREDENTIALS })).toThrow(/managed/);
  });

  it('propagates credential validation errors', () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed' });
    expect(() =>
      connectionCredentialsSet(store, openManagedAuth(store, KEY_ENV), { connectionId: connection.id, credentials: { grant: 'client_credentials' } })
    ).toThrow(/clientId/);
  });
});

describe('mappingGenerate with managed auth', () => {
  it('fails with a clear error for a managed connection when no provider is available', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'm', adapterType: 'mock', authMode: 'managed' });
    await expect(mappingGenerate(store, { connectionId: connection.id })).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('generates when a token provider is supplied', async () => {
    const store = freshStore();
    const connection = connectionCreate(store, { name: 'm', adapterType: 'mock', authMode: 'managed' });
    const result = await mappingGenerate(store, {
      connectionId: connection.id,
      tokenProvider: { getAccessToken: async () => 'stub-token' },
    });
    expect(result.created).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/cli/test/managedAuth.test.ts`
Expected: FAIL — `openManagedAuth` / `connectionCredentialsSet` do not exist.

- [ ] **Step 3: Implement**

Replace `apps/cli/src/embeddedClient.ts` with:

```ts
import { openDb, MappingStore, ManagedTokenService, CredentialCipher, registerDefaultAdapters } from '@graphtorest/core';

export function openEmbeddedStore(dbPath: string): MappingStore {
  registerDefaultAdapters();
  return new MappingStore(openDb(dbPath));
}

export function openManagedAuth(store: MappingStore, env: NodeJS.ProcessEnv = process.env): ManagedTokenService | undefined {
  const key = env.CREDENTIAL_ENCRYPTION_KEY;
  return key ? new ManagedTokenService(store, new CredentialCipher(key)) : undefined;
}
```

Create `apps/cli/src/commands/connectionCredentialsSet.ts`:

```ts
import type { MappingStore, ManagedTokenService, CredentialStatus } from '@graphtorest/core';

export function connectionCredentialsSet(
  store: MappingStore,
  managedAuth: ManagedTokenService | undefined,
  args: { connectionId: string; credentials: unknown }
): CredentialStatus {
  if (!managedAuth) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set to store managed credentials');
  }
  const connection = store.getConnection(args.connectionId);
  if (!connection) throw new Error(`No connection with id ${args.connectionId}`);
  if (connection.authMode !== 'managed') {
    throw new Error(`Connection "${connection.name}" has authMode "${connection.authMode}"; credentials can only be stored for authMode "managed"`);
  }
  return managedAuth.saveCredentials(connection, args.credentials);
}
```

Replace `apps/cli/src/commands/mappingGenerate.ts` with:

```ts
import type { MappingStore, GenerationResult, AccessTokenProvider } from '@graphtorest/core';
import { generateAndPersistMappings, buildAuthContext } from '@graphtorest/core';

export async function mappingGenerate(
  store: MappingStore,
  args: { connectionId: string; vendorToken?: string; force?: boolean; tokenProvider?: AccessTokenProvider }
): Promise<GenerationResult> {
  const connection = store.getConnection(args.connectionId);
  if (!connection) {
    throw new Error(`No connection with id ${args.connectionId}`);
  }
  const authContext = await buildAuthContext(connection, args.vendorToken, args.tokenProvider);
  return generateAndPersistMappings(store, connection, authContext, { force: args.force });
}
```

(`buildAuthContext` throws a `GatewayError` whose message is `Managed auth requires CREDENTIAL_ENCRYPTION_KEY to be configured on the server` — it satisfies the `/CREDENTIAL_ENCRYPTION_KEY/` assertion.)

In `apps/cli/src/index.ts`: change the embedded-client import to `import { openEmbeddedStore, openManagedAuth } from './embeddedClient';`, add `import fs from 'node:fs';` and `import { connectionCredentialsSet } from './commands/connectionCredentialsSet';`, pass the provider in the existing `mapping-generate` action:

```ts
    const result = await mappingGenerate(store, {
      connectionId: opts.connectionId,
      vendorToken: opts.vendorToken,
      force: opts.force,
      tokenProvider: openManagedAuth(store),
    });
```

and register the new command above `program.parseAsync()`:

```ts
program
  .command('connection-credentials')
  .requiredOption('--connection-id <id>')
  .option('--credentials <json>', 'JSON credentials object (visible in shell history; prefer --credentials-file)')
  .option('--credentials-file <path>', 'path to a JSON file holding the credentials object')
  .action((opts) => {
    if (Boolean(opts.credentials) === Boolean(opts.credentialsFile)) {
      throw new Error('Provide exactly one of --credentials or --credentials-file');
    }
    const store = openEmbeddedStore(program.opts().db);
    const raw = opts.credentials ?? fs.readFileSync(opts.credentialsFile, 'utf8');
    const status = connectionCredentialsSet(store, openManagedAuth(store), {
      connectionId: opts.connectionId,
      credentials: JSON.parse(raw),
    });
    console.log(JSON.stringify(status, null, 2));
  });
```

- [ ] **Step 4: Run all tests**

Run: `npm run build -w @graphtorest/core && npx vitest run`
Expected: PASS. Then `npm run build` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "$(cat <<'EOF'
feat(cli): add connection-credentials and managed-token-aware mapping-generate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Admin-API validation and Plan 4 carry-overs

Closes the Plan 4 deferred findings that touch code Plan 5 already edits: unvalidated `PATCH /admin/mappings/:id` (and the presence-only `POST`), `mapping-export` not creating the output directory / writing non-atomically, the stale "Plan 5" wording in the `auth: override` error, and the listed test gaps for admin-level `conflicts`, PATCH-409 and CLI `auth: override` rejection.

**Files:**
- Create: `packages/core/src/mappingEngine/mappingFields.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/mappingEngine/yamlTransform.ts:37`
- Modify: `apps/server/src/routers/adminRouter.ts` (`POST /mappings`, `PATCH /mappings/:id`)
- Modify: `apps/cli/src/commands/mappingExport.ts`
- Test: `packages/core/test/mappingEngine/mappingFields.test.ts`; append to `apps/server/test/integration.test.ts`; create `apps/cli/test/carryOvers.test.ts`

**Interfaces:**
- Produces: `parseMappingFields(input: Record<string, unknown>): MappingFields` where `MappingFields = { route?: string; method?: string; operation?: Record<string, unknown>; responseTemplate?: Record<string, string> | null; source?: 'generated' | 'manual' }`; throws `GatewayError('INVALID_INPUT', …, 400)`. `method` is upper-cased; `route` must start with `/` and contain no whitespace; `operation` a non-array object; `responseTemplate` `null` or a string→string object; `source` `generated|manual`. Absent (`undefined`) keys are omitted from the result; an explicit `responseTemplate: null` is preserved.
- `yamlEntryToMappingInput` keeps its existing per-route error messages (its tests assert them) — it is deliberately **not** refactored onto `parseMappingFields`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/core/test/mappingEngine/mappingFields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMappingFields } from '../../src/mappingEngine/mappingFields';

describe('parseMappingFields', () => {
  it('returns only the keys that were provided and upper-cases the method', () => {
    expect(parseMappingFields({ method: 'get', operation: { a: 1 } })).toEqual({ method: 'GET', operation: { a: 1 } });
    expect(parseMappingFields({})).toEqual({});
  });

  it('preserves an explicit null responseTemplate and accepts a string map', () => {
    expect(parseMappingFields({ responseTemplate: null })).toEqual({ responseTemplate: null });
    expect(parseMappingFields({ responseTemplate: { id: '$.id' } })).toEqual({ responseTemplate: { id: '$.id' } });
  });

  it.each([
    [{ route: 'no-slash' }, /route/],
    [{ route: '/has space' }, /route/],
    [{ route: 5 }, /route/],
    [{ method: 'G3T' }, /method/],
    [{ method: 5 }, /method/],
    [{ operation: [] }, /operation/],
    [{ operation: 'x' }, /operation/],
    [{ operation: null }, /operation/],
    [{ responseTemplate: [] }, /responseTemplate/],
    [{ responseTemplate: { id: 5 } }, /responseTemplate/],
    [{ responseTemplate: 'x' }, /responseTemplate/],
    [{ source: 'other' }, /source/],
  ])('rejects %j', (input, message) => {
    expect(() => parseMappingFields(input as Record<string, unknown>)).toThrow(message);
    try {
      parseMappingFields(input as Record<string, unknown>);
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    }
  });

  it('accepts a valid source', () => {
    expect(parseMappingFields({ source: 'manual' })).toEqual({ source: 'manual' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/mappingEngine/mappingFields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseMappingFields`**

Create `packages/core/src/mappingEngine/mappingFields.ts`:

```ts
import { GatewayError } from '../gateway/errors';

export interface MappingFields {
  route?: string;
  method?: string;
  operation?: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
  source?: 'generated' | 'manual';
}

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

/** Validates the shape of mapping fields arriving over the admin API. Only keys that are present are returned. */
export function parseMappingFields(input: Record<string, unknown>): MappingFields {
  const fields: MappingFields = {};

  if (input.route !== undefined) {
    if (typeof input.route !== 'string' || !input.route.startsWith('/') || /\s/.test(input.route)) {
      throw invalid('"route" must be a path starting with "/" and containing no whitespace');
    }
    fields.route = input.route;
  }

  if (input.method !== undefined) {
    if (typeof input.method !== 'string' || !/^[A-Za-z]+$/.test(input.method)) {
      throw invalid('"method" must be an HTTP method name such as GET');
    }
    fields.method = input.method.toUpperCase();
  }

  if (input.operation !== undefined) {
    if (typeof input.operation !== 'object' || input.operation === null || Array.isArray(input.operation)) {
      throw invalid('"operation" must be an object');
    }
    fields.operation = input.operation as Record<string, unknown>;
  }

  if (input.responseTemplate !== undefined) {
    const template = input.responseTemplate;
    if (template !== null) {
      const valid =
        typeof template === 'object' && !Array.isArray(template) && Object.values(template as object).every((v) => typeof v === 'string');
      if (!valid) throw invalid('"responseTemplate" must be null or a map of strings');
    }
    fields.responseTemplate = template as Record<string, string> | null;
  }

  if (input.source !== undefined) {
    if (input.source !== 'generated' && input.source !== 'manual') throw invalid('"source" must be "generated" or "manual"');
    fields.source = input.source;
  }

  return fields;
}
```

In `packages/core/src/index.ts` add:

```ts
export { parseMappingFields } from './mappingEngine/mappingFields';
export type { MappingFields } from './mappingEngine/mappingFields';
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run packages/core/test/mappingEngine/mappingFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing server tests**

Append to `apps/server/test/integration.test.ts` (after the last `describe`, at file end):

```ts
describe('mapping admin validation and conflicts', () => {
  async function seedConnection(name: string) {
    const res = await admin.post('/admin/connections').send({ name, adapterType: 'mock', authMode: 'passthrough' });
    return res.body.id as string;
  }

  async function seedMapping(connectionId: string, route: string) {
    const res = await admin
      .post('/admin/mappings')
      .send({ connectionId, route, method: 'GET', operation: { query: 'q' }, source: 'generated' });
    return res.body.id as string;
  }

  it('rejects malformed PATCH bodies with 400 and leaves the mapping untouched', async () => {
    const connectionId = await seedConnection('patch-validate');
    const id = await seedMapping(connectionId, '/patch-me');
    for (const body of [
      { operation: [] },
      { route: 'no-leading-slash' },
      { method: 'G3T' },
      { responseTemplate: { id: 5 } },
      {},
    ]) {
      const res = await admin.patch(`/admin/mappings/${id}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
    const list = await admin.get('/admin/mappings');
    const mapping = list.body.find((m: { id: string }) => m.id === id);
    expect(mapping).toMatchObject({ route: '/patch-me', source: 'generated', operation: { query: 'q' } });
  });

  it('normalizes the method on PATCH', async () => {
    const connectionId = await seedConnection('patch-method');
    const id = await seedMapping(connectionId, '/patch-method');
    const res = await admin.patch(`/admin/mappings/${id}`).send({ method: 'post' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ method: 'POST', source: 'manual' });
  });

  it('rejects malformed POST bodies with 400', async () => {
    const connectionId = await seedConnection('post-validate');
    const res = await admin.post('/admin/mappings').send({ connectionId, route: 'no-slash', method: 'GET', operation: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    const bad = await admin.post('/admin/mappings').send({ connectionId, route: '/ok', method: 'GET', operation: 'string' });
    expect(bad.status).toBe(400);
  });

  it('returns 409 when a PATCH would collide with another mapping route+method', async () => {
    const connectionId = await seedConnection('patch-conflict');
    await seedMapping(connectionId, '/taken');
    const id = await seedMapping(connectionId, '/free');
    const res = await admin.patch(`/admin/mappings/${id}`).send({ route: '/taken' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it("reports a generated route owned by another connection under 'conflicts' and does not touch it", async () => {
    const owner = await seedConnection('owner');
    const other = await seedConnection('other');
    const ownedId = await seedMapping(owner, '/users/{id}'); // the mock adapter generates GET /users/{id}
    const res = await admin.post(`/admin/connections/${other}/mappings/generate`).send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.updated).toEqual([]);
    expect(res.body.conflicts).toHaveLength(1);
    const list = await admin.get('/admin/mappings');
    expect(list.body.find((m: { id: string }) => m.id === ownedId).connectionId).toBe(owner);
  });
});
```

- [ ] **Step 6: Write the failing CLI tests**

Create `apps/cli/test/carryOvers.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEmbeddedStore } from '../src/embeddedClient';
import { connectionCreate } from '../src/commands/connectionCreate';
import { mappingExport } from '../src/commands/mappingExport';
import { mappingImport } from '../src/commands/mappingImport';

let dbPath: string;
const cleanup: string[] = [];

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function freshStore() {
  dbPath = path.join(os.tmpdir(), `graphtorest-carry-${Date.now()}-${Math.random()}.db`);
  return openEmbeddedStore(dbPath);
}

describe('mapping-export output file', () => {
  it('creates missing parent directories and leaves no temp file behind', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const dir = path.join(os.tmpdir(), `graphtorest-export-${Date.now()}-${Math.random()}`);
    cleanup.push(dir);
    const outFile = path.join(dir, 'nested', 'deep', 'mappings.yaml');

    const text = mappingExport(store, { outFile });

    expect(fs.readFileSync(outFile, 'utf8')).toBe(text);
    expect(fs.readdirSync(path.dirname(outFile))).toEqual(['mappings.yaml']);
  });
});

describe('mapping-import auth override', () => {
  it('rejects a file containing auth: override and writes nothing', () => {
    const store = freshStore();
    connectionCreate(store, { name: 'c1', adapterType: 'mock', authMode: 'passthrough' });
    const file = path.join(os.tmpdir(), `graphtorest-override-${Date.now()}-${Math.random()}.yaml`);
    cleanup.push(file);
    fs.writeFileSync(
      file,
      [
        '- route: GET /ok',
        '  connection: c1',
        '  source: manual',
        '  operation: { query: q }',
        '  response: { shape: passthrough }',
        '  auth: inherit',
        '- route: GET /overridden',
        '  connection: c1',
        '  source: manual',
        '  operation: { query: q }',
        '  response: { shape: passthrough }',
        '  auth: override',
        '',
      ].join('\n')
    );

    expect(() => mappingImport(store, { file, warn: () => {} })).toThrow(/override/);
    expect(store.listMappings()).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npm run build -w @graphtorest/core && npx vitest run apps/server/test/integration.test.ts apps/cli/test/carryOvers.test.ts`
Expected: FAIL — PATCH/POST accept bad bodies; `mapping-export` throws `ENOENT` for the nested directory. (The `auth: override` rejection and `conflicts` tests may already pass — they close test gaps rather than bugs; that is fine.)

- [ ] **Step 8: Validate in the admin router**

In `apps/server/src/routers/adminRouter.ts`, add `parseMappingFields` to the `@graphtorest/core` import.

In `POST /mappings`, directly after the existing presence check (`if (!connectionId || …) { …return; }`) and before the `try`, add:

```ts
    const fields = parseMappingFields({ route, method, operation, responseTemplate, source });
```

and change the `createMapping` call inside the `try` to:

```ts
      res.status(201).json(
        mappingStore.createMapping({
          connectionId,
          route: fields.route as string,
          method: fields.method as string,
          operation: fields.operation as Record<string, unknown>,
          responseTemplate: fields.responseTemplate,
          source: fields.source,
        })
      );
```

In `PATCH /mappings/:id`, replace the first two lines of the handler body (`const { route, method, operation, responseTemplate } = req.body ?? {};` and the `try {` opener through the `updateMapping(...)` call) with the validated version so the handler reads:

```ts
  router.patch('/mappings/:id', (req, res) => {
    const fields = parseMappingFields(req.body ?? {});
    if (
      fields.route === undefined &&
      fields.method === undefined &&
      fields.operation === undefined &&
      fields.responseTemplate === undefined
    ) {
      throw new GatewayError('INVALID_INPUT', 'At least one of route, method, operation, responseTemplate is required', 400);
    }
    try {
      const updated = mappingStore.updateMapping(req.params.id, {
        route: fields.route,
        method: fields.method,
        operation: fields.operation,
        responseTemplate: fields.responseTemplate,
        source: 'manual', // any admin edit flips a mapping to manual (spec §5.2); a body "source" is ignored
      });
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found', details: {} } });
        return;
      }
      res.json(updated);
    } catch (err) {
```

(Everything from `const code = (err as { code?: string })?.code;` to the end of the handler is unchanged.) The two `parseMappingFields` calls throw `GatewayError`s from synchronous handlers, which the app-level error handler (Task 3) turns into normalized 400s.

- [ ] **Step 9: Reword the override error and harden `mapping-export`**

In `packages/core/src/mappingEngine/yamlTransform.ts` replace the thrown message on the `auth !== 'inherit'` line with:

```ts
    throw new Error(`Unsupported auth "${entry.auth}" on mapping "${entry.route}" — only "inherit" is supported (per-mapping auth overrides are not implemented)`);
```

Replace `apps/cli/src/commands/mappingExport.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { MappingStore } from '@graphtorest/core';
import { mappingToYamlEntry } from '@graphtorest/core';

export function mappingExport(store: MappingStore, args: { outFile?: string }): string {
  const connectionNames = new Map(store.listConnections().map((c) => [c.id, c.name]));
  const entries = store.listMappings().map((m) => mappingToYamlEntry(m, connectionNames.get(m.connectionId) ?? m.connectionId));
  const yamlText = YAML.stringify(entries);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    const tempFile = `${args.outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, yamlText, 'utf8');
    fs.renameSync(tempFile, args.outFile);
  }
  return yamlText;
}
```

- [ ] **Step 10: Run the full suite and the build**

Run: `npm run build -w @graphtorest/core && npx vitest run && npm run build`
Expected: PASS everywhere (including the still-green `yamlTransform.test.ts` `/override/` assertion), clean build.

- [ ] **Step 11: Commit**

```bash
git add packages/core apps
git commit -m "$(cat <<'EOF'
fix(server,cli,core): validate mapping fields on the admin API, harden mapping-export, close Plan 4 test gaps

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Deliberately Out of Scope

- Login throttling / brute-force protection on `POST /admin/login` and API-key rate limiting — Plan 8 (§6.3). Until then, keep the server behind the loopback binding or a reverse proxy that rate-limits.
- Certificate-based client credentials (spec §7.1 lists "client id/secret or certificate") — only client-secret auth (`client_secret_post`) is implemented; certificates need JWT client assertions and are a follow-up.
- Env-var-driven first-run admin bootstrap (spec §12, roadmap Plan 8) — Plan 5 provides `gtr admin-create` only.
- Cookie-based admin sessions, CSRF protection, SSO — the webUI (Plan 6) uses the bearer token; SSO is a spec non-goal.
- Per-mapping `auth: override` — still rejected on import; there is no defined semantics for what an override would select.
- An admin-API endpoint to delete credentials or admin users, and rotation of `CREDENTIAL_ENCRYPTION_KEY` (re-encrypting existing rows) — not called for by the roadmap; losing/changing the key requires re-entering credentials.
- Persisting cached access tokens across restarts — they are cheap to re-mint; only credentials (and refresh tokens) are persisted.
- The remaining Plan 4 deferrals: `dryRun`/route-count bounds on generation (Plan 6, for the UI preview), name-vs-id consistency of `--connection` (Plan 7), and `buildNestedResourceDrafts` guard-branch tests plus the fragile substring assertion in the list-skip test (pick up with the next change to `mappingGeneration.ts`).

## Execution Notes

- Run from an isolated worktree (superpowers:using-git-worktrees). Tasks are ordered by dependency: 1→2→3→4 (admin login), 5→6→7→8→9 (managed auth), 10 is independent of 5–9 but touches `adminRouter.ts` after them, so keep it last to avoid merge friction.
- After **every** core change, rebuild before running `apps/*` tests (`npm run build -w @graphtorest/core`), because those packages import `@graphtorest/core` from `dist/`.
- After each subagent dispatch, check `git log -1 --format=%B` for the exact `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer (haiku-tier implementers have substituted their own model name before).
- The final whole-branch review should specifically probe: no credential/token/secret in any response, log line or error `details`; the only unauthenticated admin routes are `/admin/login` and `/admin/oauth/callback`; single-use/expiring OAuth `state`; constant-shape 401 for unknown-user vs wrong-password.

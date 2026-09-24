# GraphToRest Plan 8 — Rate Limiting, Caching, Observability, Deployment & Hardening

**Date:** 2026-09-24
**Status:** Approved design, pending implementation plan
**Parent spec:** `2026-09-17-graphtorest-design.md` (§6.3, §9, §10, §12)
**Roadmap entry:** Plan 8 in `docs/superpowers/plans/2026-09-17-graphtorest-roadmap.md`

## 1. Goal

Make GraphToRest deployable as a v1: abuse controls on the developer-facing API, optional response caching, structured stdout logs, a slim non-root production image, a first-run admin bootstrap, and the security/robustness backlog routed to Plan 8 by the Plan 1, 3, 5 and 6 reviews.

Defaults must not change behaviour for existing deployments, with one deliberate exception: outbound requests to private-network destinations are blocked unless `ALLOW_PRIVATE_NETWORK_TARGETS=true` (§5.5).

## 2. Scope

**In scope**

1. Per-API-key token-bucket rate limiting with a server-wide default and per-key overrides (§3).
2. Optional per-mapping response caching (§4).
3. Structured JSON logs to stdout via a shared logger (§6).
4. Security hardening: admin login throttling, async scrypt with uniform timing, password length cap, outbound timeouts, vendor error redaction, SSRF guard, config validation, graceful shutdown, DB file permissions (§5).
5. Production Docker image slimming, `.dockerignore`, non-root user, `/healthz` + `HEALTHCHECK` (§7).
6. Env-var bootstrap of the first admin user (§8).
7. Dev-dependency security upgrade so `npm audit` is clean (§9).

**Out of scope (explicitly deferred)**

- Cosmetic web/test nits from the Plan 6/7 reviews (empty 404 body under `/admin`, UI served when `ADMIN_ENABLED=false`, malformed-JSON `/api` requests missing from `request_log`, CLI test type-checking, etc.).
- Distributed/shared rate-limit or cache state (single-process deployment model, spec §6.3).
- Metrics/tracing backends (spec §9).
- Closing the DNS-rebinding window in the SSRF guard (§5.5).
- Web UI first-run setup page; bootstrap of an initial API key.

## 3. Rate limiting

### 3.1 Semantics

- One in-memory token bucket per API key id. Bucket parameters: `requestsPerMinute` (refill rate) and `burst` (capacity). A request consumes one token; with no token available the request is rejected.
- **Effective limit** for a key, in order:
  1. The key's own `rate_limit_config` if set: either `{ "requestsPerMinute": n, "burst": b }` or `"unlimited"`.
  2. Otherwise the server default from `RATE_LIMIT_DEFAULT` (positive integer, requests per minute) and `RATE_LIMIT_DEFAULT_BURST` (positive integer; defaults to `RATE_LIMIT_DEFAULT` when unset).
  3. Otherwise unlimited.
- Rate-limit state is lost on restart (acceptable, single process). Buckets idle for longer than their full-refill time are swept on a timer (`unref`'d).
- Changing a key's limit takes effect on the next request (the bucket is re-created with the new parameters when they differ).

### 3.2 HTTP behaviour

- Middleware order on `/api`: activity logger → API-key auth → **rate limiter** → API router.
- Rejected request: `429` with body `{ "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded", "details": { "retryAfterSeconds": n } } }` and `Retry-After: n`.
- Every limited (non-unlimited) response carries `RateLimit-Limit` (burst), `RateLimit-Remaining`, `RateLimit-Reset` (seconds until a token is available / full).
- `res.locals.errorCode = 'RATE_LIMITED'` so the request log records it.

### 3.3 Configuration surfaces

- `api_keys.rate_limit_config` column (already exists, currently unused) stores the JSON above or `NULL` (= use default).
- Admin API: `POST /admin/api-keys` accepts optional `rateLimit`; new `PATCH /admin/api-keys/:id` accepts `rateLimit`. `rateLimit` is `{ requestsPerMinute, burst? }`, `"unlimited"`, or `null` (= use server default). Invalid values → `400 INVALID_INPUT`. `GET /admin/api-keys` returns each key's `rateLimit` as stored (or `null`).
- CLI: `gtr apikey create` gains `--rate-limit <n>` (per minute), `--burst <n>`, `--unlimited`; new `gtr apikey update <id>` with the same flags plus `--default` (clear override). Flags are mutually exclusive where contradictory. `gtr apikey list` shows a RATE LIMIT column (`default`, `unlimited`, or `n/min (burst b)`). Works in embedded and remote mode.
- Web UI: API Keys page shows the limit per key and lets the admin set/clear it on create and via an edit control.

### 3.4 Components

- `packages/core/src/rateLimit/TokenBucket.ts` — pure bucket with injected clock.
- `packages/core/src/rateLimit/rateLimitConfig.ts` — parse/validate/serialize config; resolve effective limit.
- `apps/server/src/middleware/rateLimit.ts` — `createRateLimiter({ defaultLimit, now? })` holding the bucket map and sweep timer, with a `stop()` for shutdown.

## 4. Response caching

### 4.1 Semantics

- New mapping field `cacheTtlSeconds` (integer ≥ 0; `0`/absent = caching off). Stored in a new `mappings.cache_ttl_seconds` column (idempotent migration, default `NULL`).
- Only `GET` mappings and only `2xx` responses are cached.
- Effective TTL = `min(cacheTtlSeconds, CACHE_MAX_TTL_SECONDS)`; `CACHE_MAX_TTL_SECONDS` defaults to `300`. `CACHE_MAX_ENTRIES` (default `1000`) bounds the LRU; `CACHE_MAX_ENTRIES=0` disables caching globally.
- **Cache key** = SHA-256 over: mapping id, resolved request path, normalized (sorted) query string, and identity, where identity is:
  - `managed` connection → `conn:<connectionId>` (all API keys share entries; they would receive the same vendor data).
  - `passthrough` connection → `tok:<SHA-256 of vendor token>` (no entry is ever shared between different vendor tokens; raw tokens are never stored).
- Cached value: status, the response body and the subset of headers the gateway itself sets (e.g. `Content-Type`). Responses carry `X-Cache: HIT` or `X-Cache: MISS` whenever the mapping has caching enabled.
- Updating, deleting, or re-importing a mapping evicts that mapping's entries. Deleting a connection evicts entries of its mappings. Managed credential changes evict entries of that connection.

### 4.2 Configuration surfaces

- Mapping YAML export/import: optional `cacheTtlSeconds`.
- Admin API: `POST /admin/mappings` and `PATCH /admin/mappings/:id` accept `cacheTtlSeconds`; mapping responses include it.
- CLI: `gtr mapping create|update --cache-ttl <seconds>`; `gtr mapping list` shows a CACHE column.
- Web UI: mapping edit form gains a "Cache TTL (seconds)" field.
- OpenAPI generation is unaffected.

### 4.3 Components

- `packages/core/src/gateway/ResponseCache.ts` — LRU + TTL with injected clock; `get`, `set`, `evictMapping`, `evictConnection`.
- `GatewayEngine` takes an optional `ResponseCache`; lookup/store happens inside `handle`, which already knows the mapping, connection auth mode and vendor token. The handle result reports `cache: 'HIT' | 'MISS' | undefined` so the router can set `X-Cache` and `res.locals.cache` for logging.

## 5. Security hardening

### 5.1 Admin login throttling

- `apps/server/src/middleware/loginThrottle.ts`: in-memory failure counters keyed separately by normalized (lower-cased, trimmed) username and by client IP (`req.ip`).
- 5 failures within a 15-minute window → lockout of 1 minute, doubling for each further failure, capped at 15 minutes. During lockout `POST /admin/login` returns `429 LOGIN_THROTTLED` with `Retry-After`, without verifying the password.
- A successful login clears that username's counter (not the IP's).
- Injected clock; sweep timer with `stop()`.

### 5.2 Password length and async scrypt

- Maximum password length 1024 characters, enforced on login (over-length → treated as a failed login), `POST /admin/admin-users`, `gtr admin create`, and `gtr admin set-password`.
- Password and API-key secret verification move from `scryptSync` to promisified `crypto.scrypt`. Hashing on create may stay sync (admin-only path) but should share the async helper where convenient.
- Unknown username and unknown API-key id each perform one dummy scrypt verification against a fixed precomputed hash so all failure paths cost the same.

### 5.3 Outbound timeouts

- `OUTBOUND_TIMEOUT_MS` (default `30000`) applied via `AbortSignal.timeout` to GraphQL and OAuth token `fetch` calls.
- In `oauthClient`, reading the response body moves inside the error handling so a stalled or aborted body read becomes `502 VENDOR_UNREACHABLE`.

### 5.4 Vendor error redaction

- `packages/core/src/gateway/redact.ts`: `redactVendorText(s)` truncates to 200 characters (with `…`) and replaces JWT-shaped strings and runs of ≥32 characters from `[A-Za-z0-9._~+/=-]` with `[redacted]`.
- Applied to OAuth `error_description`, GraphQL error messages, and any other vendor-supplied text before it enters a `GatewayError` message/details or a log line.

### 5.5 SSRF guard

`packages/core/src/net/outboundUrl.ts`:

- **Shape check** (`assertOutboundUrlShape`) at write time → `400 INVALID_INPUT`:
  - GraphQL `config.endpoint` on connection create: `http:` or `https:` only, no userinfo, parseable.
  - OAuth `tokenUrl`/`authorizeUrl` on credential save: existing https requirement kept; userinfo now rejected.
- **Destination check** (`assertOutboundTargetAllowed`) immediately before every server-side outbound fetch (GraphQL endpoint, OAuth token URL). `authorizeUrl` is a browser redirect and gets no destination check.
  - Resolve all addresses (`dns.lookup(host, { all: true })`; IP literals used directly).
  - Blocked unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`: IPv4 `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`; IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped/-compatible forms of blocked IPv4 ranges.
  - Plain `http:` is allowed only when the destination is private **and** the opt-in is on; a public destination over `http:` is rejected.
  - Rejection → `GatewayError('OUTBOUND_TARGET_BLOCKED', …, 502)` whose message names `ALLOW_PRIVATE_NETWORK_TARGETS`.
- All outbound `fetch` calls use `redirect: 'error'`.
- The resolver and the allow-private flag are injectable; tests never perform real DNS lookups.
- **Known gap (documented, not fixed):** the check runs before connect, so DNS rebinding between check and connect is not covered. Closing it needs a custom undici dispatcher with a checked `lookup`, which risks breaking nock interception in tests.
- The Microsoft Graph adapter's fixed endpoints are not subject to the guard.

### 5.6 Server basics

- `PORT` and every new numeric env var are validated at startup; invalid values fail fast with a message naming the variable.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections, wait up to 10 s for in-flight requests, stop rate-limiter/throttle sweep timers, close the DB, exit 0 (exit 1 if the drain timed out).
- `openDb` creates a missing DB directory with mode `0700` (a pre-existing directory is left untouched) and sets the DB file to `0600` on every open, whether new or pre-existing, since it holds hashed keys and encrypted credentials.

## 6. Observability

- `packages/core/src/logging/logger.ts`: `createLogger({ level, write? })` → `{ debug, info, warn, error }`, each writing one JSON line `{ ts, level, msg, ...fields }` to stdout (`error`/`warn` to stderr). `LOG_LEVEL` (`debug|info|warn|error`, default `info`) filters. `Error` values in fields serialize as `{ name, message, stack }`.
- All existing `console.*` calls in server and core route through the logger (the CLI keeps its own human output).
- Per request, when the response finishes, one `request_completed` line:
  - `/api`: `method`, `path` (no query string), `status`, `durationMs`, `apiKeyId`, `connectionId`, `mappingId`, `errorCode`, `cache`, `vendorLatencyMs`.
  - `/admin`: `method`, `path`, `status`, `durationMs`, `errorCode`, `adminUserId`.
  - Never headers, bodies, query strings, tokens or passwords.
- The existing `request_log` SQLite write for `/api` is unchanged; the stdout line is emitted from the same finish hook.
- `vendorLatencyMs` is measured in `GatewayEngine` around the adapter call and surfaced via the handle result.

## 7. Deployment

- `.dockerignore`: `node_modules`, `**/node_modules`, `.git`, `.claude`, `.worktrees`, `**/dist`, `data`, `coverage`, `*.log`.
- Dockerfile stages:
  1. `build` — unchanged in substance (full `npm ci`, build all workspaces).
  2. `prod-deps` — `npm ci --omit=dev` restricted to `@graphtorest/core`, `@graphtorest/server`, `@graphtorest/cli` (with build tools for the `better-sqlite3` native module), then relink `gtr` bin.
  3. `runtime` — `node:20-slim`; copies prod `node_modules`, each package's `package.json` + `dist`, the CLI `bin`, and `apps/web/dist`. No `src`, no tests. Runs as user `node`; `/data` created and owned by `node`.
- `GET /healthz` (unauthenticated, registered regardless of `API_ENABLED`/`ADMIN_ENABLED`): runs `SELECT 1`; `200 {"status":"ok"}` or `503 {"status":"error"}`. Not recorded in `request_log`; logged at `debug`.
- `HEALTHCHECK` uses `node -e` fetch against `http://127.0.0.1:${PORT}/healthz`.
- `docker run --entrypoint gtr <image> …` continues to work against the mounted volume.
- The plan records image size before and after.

## 8. Bootstrap admin

- At server startup, if `GTR_BOOTSTRAP_ADMIN_USERNAME` and `GTR_BOOTSTRAP_ADMIN_PASSWORD` are both set:
  - No admin users exist → create that admin with existing validation (12–1024 characters); log `bootstrap_admin_created` with `username` only.
  - Admins already exist → log `bootstrap_admin_skipped` at `info`.
- Exactly one of the two set, or an invalid password → startup fails with a clear message.
- `docker-compose.yml` shows both commented out with a note to remove them after first run. The existing `no_admin_users` warning mentions the env vars as an alternative to `gtr admin create`.

## 9. Dependency security

- Upgrade `vitest` (and transitively `vite`, `vite-node`, `esbuild`, `@vitest/*`) to the patched major; fix any test breakage.
- Target: `npm audit` clean. If an advisory has no available fix, `npm audit --omit=dev` must be clean and the remaining dev-only advisory is documented in the plan's completion notes.
- Sequenced after §7 so the runtime image no longer contains dev dependencies regardless.

## 10. Configuration reference (new env vars)

| Variable | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `RATE_LIMIT_DEFAULT` | unset (unlimited) | Default requests/minute per API key |
| `RATE_LIMIT_DEFAULT_BURST` | = `RATE_LIMIT_DEFAULT` | Default bucket capacity |
| `CACHE_MAX_TTL_SECONDS` | `300` | Upper bound on any mapping's cache TTL |
| `CACHE_MAX_ENTRIES` | `1000` | LRU capacity; `0` disables caching |
| `OUTBOUND_TIMEOUT_MS` | `30000` | Timeout for GraphQL/OAuth fetches |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false` | Permit private/loopback/link-local outbound destinations |
| `GTR_BOOTSTRAP_ADMIN_USERNAME` | unset | First-run admin username |
| `GTR_BOOTSTRAP_ADMIN_PASSWORD` | unset | First-run admin password |

All documented in `docker-compose.yml` comments and the README.

## 11. Error codes (new)

| Code | Status | Where |
|---|---|---|
| `RATE_LIMITED` | 429 | `/api/*` |
| `LOGIN_THROTTLED` | 429 | `POST /admin/login` |
| `OUTBOUND_TARGET_BLOCKED` | 502 | `/api/*`, admin generate/OAuth endpoints |

CLI maps `RATE_LIMITED`/`LOGIN_THROTTLED` to its existing non-zero error exit with the server message.

## 12. Testing

- Unit (fake clock where relevant): `TokenBucket`, rate-limit config parsing/resolution, `ResponseCache` (TTL expiry, LRU eviction, per-mapping/connection eviction, passthrough-token isolation), IP-range classifier (IPv4, IPv6, mapped/compatible forms, IP literals), `assertOutboundUrlShape`, `redactVendorText`, logger (level filtering, error serialization, no secrets), login throttle (threshold, doubling, cap, reset on success), config validation.
- Integration (supertest): 429 + `Retry-After` + `RateLimit-*` headers; per-key override beats env default; `unlimited`; `PATCH /admin/api-keys/:id`; `X-Cache` MISS→HIT; two passthrough tokens never share; mapping update evicts; POST not cached; login lockout and recovery; blocked private target and opt-in; outbound timeout → 502; redirect refused; `/healthz`; bootstrap created/skipped/misconfigured; `request_completed` log lines contain expected fields and no secrets.
- CLI tests for new flags (`apikey create/update`, `mapping create/update --cache-ttl`) in embedded and remote mode. Web UI tests for the API-key limit controls and mapping cache TTL field.
- Existing tests that hit outbound fetch use an injected resolver / allow-private flag rather than real DNS.
- Final verification: full workspace test suite and build; `docker build`; container smoke (bootstrap admin via env, login, create key with a low limit, observe 429, `/healthz` healthy, container runs as non-root, `gtr --help` via `--entrypoint`); image size before/after recorded.

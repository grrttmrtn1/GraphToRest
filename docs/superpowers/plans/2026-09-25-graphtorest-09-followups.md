# GraphToRest Plan 9: Plan 8 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out every residual and deferred finding from the Plan 8 final review (security residuals, M5–M8, T-series minors and test hygiene), then clean up leftover worktrees, branches and stashes.

**Architecture:** No new subsystems. Each task hardens code that already exists: the Graph cursor validator, the outbound guard, API-key auth, the response cache, the login throttle, config, and the Docker base image. Every new knob is an env var parsed in `apps/server/src/config.ts`. Each one fails fast when invalid and defaults to today's behaviour, except where the default is the fix itself.

**Tech Stack:** TypeScript, Express 4, better-sqlite3, vitest, supertest, nock, React/Vite, Docker.

**Spec:** `docs/superpowers/specs/2026-09-24-graphtorest-08-hardening-design.md`. The findings are recorded in the Plan 8 review ledger, and the memory `graphtorest-plan8-review-findings` summarises them. This plan implements the "parked" and "deferred (R9)" lists.

## Global Constraints

- Single-process deployment: all throttles and caches stay in memory (spec §6.3).
- New env vars are documented in README's configuration table and forwarded in `docker-compose.yml` as `${VAR:-}`.
- Error bodies keep the `{ error: { code, message, details } }` shape.
- No new runtime dependencies.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A legitimate client behind a reverse proxy with `TRUST_PROXY` unset keeps working exactly as before, even while an attacker behind the same proxy floods bad keys. The failed-auth throttle is keyed by `req.ip`, which is then the proxy's IP, so it must only short-circuit requests whose key id is malformed or unknown, never a request carrying a real key id.
2. A Graph `@odata.nextLink` whose path differs only in case from the mapping's path is followed (page 2 does not 400).
3. One cached response larger than `CACHE_MAX_BYTES` is not stored, and does not flush the whole cache trying to make room.
4. An in-flight MISS that started before an admin edit or credential change does not repopulate the cache afterwards.
5. A caller-supplied `AbortSignal` does not remove the policy timeout.

---

### Task 1: Graph cursor validator residuals

**Files:** Modify `packages/core/src/adapters/microsoftGraph/odata.ts`. Test `packages/core/test/adapters/microsoftGraph/odata.test.ts`.

- [ ] Tests:
  - `assertValidGraphCursorUrl('https://graph.microsoft.com/v1.0/users?$skiptoken=a b', '/users')` returns the normalized `url.href` (`...%20b`), not the raw input.
  - `'https://GRAPH.microsoft.com/v1.0/Users?$skiptoken=x'` with request path `/users` is accepted (the host and path comparisons are case-insensitive).
  - `/v1.0/users/abc/messages` with request path `/users/ABC/messages` is accepted.
  - `/v1.0/groups` with request path `/users` is still rejected with `INVALID_INPUT`.
- [ ] Implement: compare `resourcePath.toLowerCase()` with `expectedPath.toLowerCase()`, and `return url.href`. Update the doc comment. Case-insensitive matching is safe because Graph resource paths are case-insensitive, and the origin and version checks still pin the host.
- [ ] Run the odata and MicrosoftGraphAdapter tests, then commit.

### Task 2: Outbound guard minors (T3-b, T3-d, T3-e, T3-f)

**Files:** `packages/core/src/net/outboundUrl.ts`, `packages/core/src/net/ipRanges.ts`, and their tests.

- [ ] T3-b: `outboundFetch` passes `signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(policy.timeoutMs)]) : AbortSignal.timeout(policy.timeoutMs)`. Test: a caller signal that never aborts still times out at the policy timeout.
- [ ] T3-e: `assertOutboundTargetAllowed` wraps `new URL(url)` and throws `GatewayError('INVALID_INPUT', 'Invalid outbound URL', 400)`. Test the code.
- [ ] T3-f: `isPrivateAddress` treats NAT64 `64:ff9b::/96` (embedded IPv4 in the last 32 bits) and 6to4 `2002::/16` (embedded IPv4 in bits 16–47) as private when the embedded IPv4 is blocked. Tests: `64:ff9b::a00:1` and `2002:7f00:1::` are private, and `64:ff9b::cb00:710a` (203.0.113.10) is public.
- [ ] T3-d: the redirect test uses `nock.disableNetConnect()` for the file (re-enabled in `afterAll`), asserts `rejects.toThrow(TypeError)` (undici's `redirect: 'error'` failure), and asserts that the redirect target scope was never hit.
- [ ] Run the core net tests, then commit.

### Task 3: Reverse-proxy trust (M5)

**Files:** `apps/server/src/config.ts` (`trustProxy: boolean | number | string`), `apps/server/src/app.ts` (`AppDeps.trustProxy`, `app.set('trust proxy', …)` when defined), `apps/server/src/index.ts`, `README.md`, `docker-compose.yml`, `apps/server/test/config.test.ts`, and a new `apps/server/test/trustProxy.integration.test.ts`.

- [ ] Config parsing of `TRUST_PROXY`: unset or empty → `false`. `true`/`false` → a boolean. `^\d+$` → a hop count. Any other value → the string (a comma list of IPs, CIDRs or `loopback`/`linklocal`/`uniquelocal`), passed straight to Express, which throws at `app.set` on invalid input. That surfaces as `startup_failed`.
- [ ] Test: with `trustProxy: 1`, two logins from different `X-Forwarded-For` addresses get separate IP throttle keys. After 5 failures for `ip A` against distinct usernames, the IP-keyed lockout does not block `ip B`. With trust off, `X-Forwarded-For` is ignored.
- [ ] Document in the README: "set to your proxy hop count (usually `1`) when running behind a reverse proxy; never `true` unless every client connection comes through your proxy".
- [ ] Commit.

### Task 4: Pre-auth failure throttle on /api (M6)

**Files:** Create `apps/server/src/middleware/apiAuthThrottle.ts`. Modify `apiKeyAuth.ts`, `app.ts`, `index.ts` (stop on shutdown), `config.ts` (`API_AUTH_FAILURES_PER_MINUTE`, default 60, 0 = disabled), README, and compose. Tests: `apps/server/test/apiAuthThrottle.integration.test.ts`.

- [ ] `ApiAuthThrottle` holds a `TokenBucket` per client IP (`requestsPerMinute = burst = limit`) with the same sweep/stop pattern as `RateLimiter`. `check(ip): number` returns the retry-after ms when the bucket is empty, without taking a token. `recordFailure(ip)` takes a token.
- [ ] `createApiKeyAuth(store, throttle?)`: parse the key and look up the record, which is cheap. When the key is malformed or its id is unknown and `throttle.check(req.ip) > 0`, respond `429 AUTH_THROTTLED` with `Retry-After` and `details.retryAfterSeconds`, and do no scrypt. Otherwise behave as today: one scrypt (a dummy for an unknown id), and on any invalid key call `recordFailure(req.ip)`. A request whose key id exists is never throttled, so an attacker cannot lock legitimate clients out. The trade-off is documented: while throttled, an unknown id answers faster than a known id, which leaks id existence, and ids are random 48-bit values (6 random bytes), so at the throttled rate finding one still takes ~2^47 guesses per address. *(Amended after the final review: the check and the spend happen in one synchronous `takeFailure` call before the scrypt, because a separate check-then-record let concurrent requests all pass the check.)* A known id with a wrong secret still costs one scrypt.
- [ ] Tests: with limit 3, three random bad keys get 401 and the fourth gets 429 with `Retry-After`. After lockout, a valid key from the same IP still gets 200, and a wrong secret for an existing id gets 401, not 429. Valid requests never consume budget: 10 good requests followed by 3 bad ones all get 401. With limit 0, the throttle is disabled.
- [ ] Commit.

### Task 5: Response cache byte bound and eviction epoch (M7, T12-a, T12-b/c/d)

**Files:** `packages/core/src/gateway/ResponseCache.ts`, `GatewayEngine.ts`, `apps/server/src/config.ts` (`CACHE_MAX_BYTES`, default 52_428_800, 0 = no byte bound), `index.ts`, README, compose. Tests: `packages/core/test/gateway/ResponseCache.test.ts`, `apps/server/test/responseCache.integration.test.ts`.

- [ ] Add `maxBytes?: number` to `ResponseCacheOptions`. Track `bytes` per entry (`Buffer.byteLength(body)`) and `totalBytes`. `set` skips any body larger than `maxBytes` (so it never flushes the cache for an uncacheable entry), then evicts LRU until both bounds hold. Delete paths update `totalBytes`. Expose `get bytes()`.
- [ ] Add an epoch: `private epoch = 0`. `evictMapping`, `evictConnection` and `clear` do `epoch += 1`. Add `get epoch()`. `set(key, value, meta & { epoch?: number })` ignores the write when `meta.epoch !== undefined && meta.epoch !== this.epoch`. `GatewayEngine` captures `this.cache.epoch` before calling the adapter and passes it to `set`.
- [ ] Unit tests: byte bound eviction order, the oversized entry is skipped while existing entries survive, and a stale epoch is not written.
- [ ] Integration tests:
  - T12-b: make "does not cache failures" able to fail. The adapter first errors, then succeeds on a second call. Assert that the second call is a MISS and reaches the vendor.
  - T12-c: eviction on credential DELETE, OAuth callback, and generate.
  - T12-d: the non-GET test sends two POSTs and asserts two vendor calls.
- [ ] Commit.

### Task 6: Login throttle residuals (Retry-After, T6-a, T6-b, T7, verify-throws)

**Files:** `apps/server/src/middleware/loginThrottle.ts`, and the `loginThrottle.test.ts`, `loginThrottle.integration.test.ts` and `adminAuth.integration.test.ts` tests.

- [ ] `effectiveRetryMs` returns `1000`, not `baseLockoutMs`, when only pending reservations reach the threshold. It is a short "try again momentarily" and the real lockout follows once they settle. Update the doc comment and the unit test that asserted 60s.
- [ ] Verify-throws path: an integration test stubs `loginAdmin` to throw once (`vi.spyOn` on the core module export used by the router, or a store whose `findAdminUserByUsername` throws). It asserts a 500, and then 5 more wrong-password attempts still get 401 before the 429. That shows the reservation was released, not leaked.
- [ ] T6-a: the over-long-password unit test uses an existing user.
- [ ] T6-b: the adminAuth integration tests assert the error `code` as well as the status.
- [ ] T7: no code change. `index.ts` injects the throttle, and the fallback timer is `unref`'d. Record this in the ledger.
- [ ] Commit.

### Task 7: Small correctness and cleanup minors (T1, T4-b/c/d, T5, T8, T10, T11-a/b/c, T14, copy)

- [ ] T1: `parseRateLimitDefault` passes `min` (1) as the unused fallback instead of 0.
- [ ] T4-b: the non-object config test asserts `error.code === 'INVALID_INPUT'`. T4-c: the OAuth redirect test asserts the redirect target nock scope was not hit.
- [ ] T4-d: no change. It is stricter and harmless, as ruled in the review.
- [ ] T5: `oauthClient` uses `description || generic`, so an empty `error_description` falls back to the generic message. Add a test.
- [ ] T8: rename `unknown` → `unknownFields` in `rateLimitConfig.ts`.
- [ ] T10: replace the nested ternaries in `ApiKeysPage.tsx` `RateLimitEditor` with small `modeOf(setting)` / `settingFor(mode, rate, burst)` functions.
- [ ] T11-a: export `isValidCacheTtl(value: unknown): value is number` from `mappingFields.ts` and use it in `mappingFields.ts`, `yamlTransform.ts` and the CLI `--cache-ttl` parser. The web UI keeps its literal, because it does not import core.
- [ ] T11-b: an embedded CLI test runs `gtr mapping update <id> --cache-ttl 30` and asserts that `generated` stays true.
- [ ] T11-c: an adminEndpoints test sends PATCH `{ cacheTtlSeconds: null }` to clear the TTL and PATCH `{}` for an empty body, asserting the current behaviour.
- [ ] T14: `index.ts` cleanup runs each step in its own try/catch and rethrows the first error after all steps ran, so `db.close()` always runs.
- [ ] MappingEditForm copy: the "Saving marks this mapping as manual" note appears only when a definitional field (not the TTL) has changed. Update its test.
- [ ] Commit (it can be split per area).

### Task 8: Node 22 base image (M8) and web chunk warning (T18)

- [ ] `Dockerfile`: `node:20-slim` → `node:22-slim` in both stages. Root `engines.node` becomes `"^20.19.0 || >=22.12.0"` to match vite 8. README prerequisites say Node 22 LTS (20.19+ still works).
- [ ] T18: SwaggerPanel is already lazy-loaded, and the >500 kB chunk is swagger-ui itself. Set `build.chunkSizeWarningLimit` in `apps/web/vite.config.mts` just above that chunk's size, with a comment saying why. Verify that no other chunk exceeds 500 kB.
- [ ] Docker build, then a container smoke test: healthz, uid 1000, and `node --version` v22.
- [ ] Commit.

### Task 9: Verification, housekeeping, merge

- [ ] Full build, `npx vitest run`, `npm audit`.
- [ ] Real-browser check of `/test` (Plan 6 carry-over): run the built server with web UI, create an admin and API key, and load `/test` in headless Chromium. Assert that Swagger UI renders the spec, there are no CSP console errors, and a request runs.
- [ ] Self-review of the whole diff against this plan.
- [ ] Fast-forward `master`. Remove the worktrees `.claude/worktrees/graphtorest-06-webui` and `.claude/worktrees/graphtorest-07-cli` after confirming they are clean. Delete the merged branches `worktree-graphtorest-06-webui`, `worktree-graphtorest-07-cli` and `worktree-graphtorest-08-hardening`, and `plan-09-followups` after the merge. Drop the two stale-checkout stashes after confirming their trees equal 53c1dbb and e7bb384.
- [ ] Update memory.

# GraphToRest — Plan Roadmap

**Spec:** `docs/superpowers/specs/2026-09-17-graphtorest-design.md`

This spec spans several largely-independent subsystems, so it is implemented as a sequence of plans instead of one document. Plan 1 builds the thinnest possible end-to-end slice (a "walking skeleton") so the system is runnable in Docker early; each later plan adds one subsystem on top of that skeleton. Each plan will be written in full (writing-plans format) when work reaches it — the entries below are scope summaries, not task breakdowns.

## Plan 1 — Foundation & Walking Skeleton (this is the plan being written now)

File: `docs/superpowers/plans/2026-09-17-graphtorest-01-foundation.md`

Monorepo scaffold (`packages/core`, `apps/server`, `apps/cli`), SQLite storage with the four tables from spec §8, the `Adapter` interface plus one in-memory `MockAdapter`, a `GatewayEngine` that resolves one hardcoded-shape mapping (`GET /users/{id}`) end-to-end, developer→proxy API-key auth, a generated OpenAPI doc + Swagger UI for that one route, and a Dockerfile that runs the server and CLI against the same mounted SQLite file. Deliberately excludes: admin login, real vendor adapters, mapping generation from a real schema, managed OAuth, rate limiting/caching, and the webUI.

## Plan 2 — Microsoft Graph Adapter

Real `MicrosoftGraphAdapter` per spec §4.1: `@microsoft/microsoft-graph-client` + MSAL, curated default mappings for users/groups/mail/calendar/drive/teams, `$select`/`$filter`/`$expand` translation, `@odata.nextLink` → normalized cursor pagination (§6.2), internal batching, delta-query endpoint. Registers into the adapter registry built in Plan 1 alongside `MockAdapter`.

## Plan 3 — GraphQL Adapter

Generic `GraphQLAdapter` per spec §4.2: `__schema` introspection, schema-driven type/query/mutation discovery. No vendor-specific knowledge — proves the adapter interface generalizes beyond Microsoft Graph.

## Plan 4 — Mapping Engine (generate → customize → regenerate)

Full `generateMappings()`-driven scaffolding from a connection's introspected schema (spec §5.2), nested-type → nested-resource/`?expand=` convention, YAML import/export for hand-editing, the `source: generated|manual` flip-on-edit rule, and `--force` regeneration semantics. Extends the admin API and CLI mapping commands built in Plan 1.

## Plan 5 — Auth Completeness

`managed` OAuth mode (spec §7.1): encrypted-at-rest vendor credentials, client-credentials/auth-code flows per vendor, transparent token refresh. Admin login (§7.3: local username/password, `admin_users` table already created in Plan 1). Locks down `/admin/*` behind that login (Plan 1 leaves it open for local development only).

## Plan 6 — WebUI

SPA (framework choice made here) serving `/`: connections/mappings/api-keys management calling `/admin/*`, an embedded Swagger-based test panel calling `/api/*`, and the "Activity" view (§9). Framework selection and build-into-Docker-image approach are decided in this plan.

## Plan 7 — CLI Completeness

Remote mode (auto-detect a running server vs. embedded SQLite access, `--server` override per spec §3), full nested command UX (`gtr connection create`, etc., replacing Plan 1's flat command names), and any CLI-side mapping-generation commands introduced by Plan 4.

## Plan 8 — Rate Limiting, Caching, Observability, Deployment Polish

Per-API-key in-memory token-bucket rate limiting (§6.3), optional short-TTL per-mapping response caching (§6.3), structured JSON request logs to stdout (§9), production Docker image size optimization (Plan 1's Dockerfile intentionally keeps devDependencies in the runtime image for simplicity), and first-run bootstrap flow for the initial admin user/API key (§12).

# GraphToRest — Design Spec

Date: 2026-09-17
Status: Approved for implementation planning

## 1. Purpose

Developers integrating with vendor/application APIs that only expose a graph-style query interface (Microsoft Graph, arbitrary GraphQL APIs) often don't want to learn OData/GraphQL semantics just to call a resource. GraphToRest is a self-hosted proxy that presents a conventional REST/JSON API to developers, translates each call to the appropriate Graph/GraphQL query behind the scenes, executes it against the vendor, and returns a plain REST-shaped JSON response.

It must run easily in Docker, be usable via a webUI (testing + management) or a CLI (headless-capable), or both against the same underlying state.

## 2. Scope

**In scope (v1):**
- Two built-in vendor adapters: Microsoft Graph (deeply tailored) and generic GraphQL (schema-introspection driven)
- An adapter interface designed for adding further built-in adapters later (dynamic/plugin loading of third-party adapters is explicitly out of scope for v1)
- Declarative mapping engine: auto-generate REST mappings from a connection's schema, then hand-customize
- Auto-derived OpenAPI spec + Swagger UI as the primary developer testing surface
- Two independent auth boundaries: developer→proxy (proxy-issued API keys) and proxy→vendor (passthrough or proxy-managed OAuth), configurable per connection
- SQLite-backed storage for connections, mappings, API keys, admin users
- Single Docker image containing server (gateway + admin API + webUI) and CLI
- CLI fully usable headless (no server process required) against the same SQLite file, or as a thin client against a running server
- Normalized pagination and error shapes across vendors
- Basic per-API-key rate limiting and optional per-mapping response caching
- Structured JSON request logs to stdout + an "Activity" view in the webUI

**Out of scope (v1):**
- Multi-tenancy (multiple isolated orgs/workspaces in one deployment)
- SSO/OAuth login for the admin webUI (simple local username/password only)
- Dynamically loaded third-party adapter plugins
- Metrics/tracing backend integrations (Prometheus, OpenTelemetry, etc.)
- Horizontal scaling / split control-plane-data-plane deployment (single process is sufficient for the target self-hosted use case)
- Graph webhook/change-notification subscriptions

## 3. Architecture

**Monorepo, three packages sharing one core engine:**

- `packages/core` — vendor-agnostic library:
  - `Adapter` interface: `introspect()`, `generateMappings()`, `execute(mapping, params, authContext)`
  - `MappingStore`: CRUD over connections/mappings/credentials/api-keys in SQLite
  - `GatewayEngine`: resolves an incoming REST request to a mapping, invokes the right adapter, shapes the response
  - `OpenApiGenerator`: derives an OpenAPI 3 document from the current mapping set

- `apps/server` — single Node process, single Docker image, three mounted routers (each independently toggleable via config):
  - `/api/*` — the generated REST gateway that developers call
  - `/admin/*` — management API (connections, mappings, credentials, API keys, admin users, activity log)
  - `/` — static webUI bundle (SPA), calls `/admin/*` and proxies test calls through `/api/*`
  - `/api/docs` — Swagger UI over the generated OpenAPI spec

- `apps/cli` (bin: `gtr`) — thin client with two modes, auto-detected (explicit `--server` flag forces remote mode):
  - **Remote mode**: calls a running server's `/admin/*` API
  - **Embedded/headless mode**: when no server is reachable/configured, opens the SQLite file directly via `packages/core` — no server process required at all (e.g. CI pipelines, one-shot mapping generation)

This lets the same Docker image serve as: a long-running server with webUI (`docker run graphtorest`), a pure CLI tool against a mounted volume (`docker run --entrypoint gtr graphtorest ...`), or both simultaneously against the same SQLite file.

## 4. Vendor Adapters

All adapters implement the common `Adapter` interface so the mapping engine, auth layer, and webUI treat every connection identically regardless of vendor.

### 4.1 MicrosoftGraphAdapter
- Built on `@microsoft/microsoft-graph-client` + MSAL
- Ships curated, hand-verified default mappings for common resources out of the box (users, groups, mail, calendar, drive/files, teams) — not purely schema-derived guesses
- Translates Graph-specific mechanics into plain REST conventions:
  - `$select`/`$filter`/`$expand` OData params ↔ ordinary REST query params
  - `@odata.nextLink` pagination ↔ normalized cursor pagination (§6.2)
  - Batch requests supported internally where a mapping requires multiple Graph calls
  - Delta queries: exposed as a REST endpoint with a `cursor` representing the delta token

### 4.2 GraphQLAdapter
- Generic: works against any spec-compliant GraphQL endpoint (GitHub GraphQL, Shopify, custom vendor APIs, etc.)
- Introspects via the standard `__schema` query to discover types, queries, and mutations
- No vendor-specific knowledge; REST generation (§5) is purely schema-driven

### 4.3 Adapter Registry
- A connection's config declares `type: "microsoft-graph" | "graphql"`
- Adding a new built-in adapter means implementing the interface and registering it in `packages/core`; no other engine code changes
- Dynamic loading of third-party adapter packages at runtime is a natural later extension but is explicitly not built in v1

## 5. Mapping Engine

### 5.1 Mapping record

Stored in SQLite, editable as YAML via webUI or CLI:

```yaml
route: "GET /users/{id}"
connection: ms-graph-prod
source: generated   # generated | manual
operation:
  query: "user(id: $id) { id, displayName, mail }"
  variables: { id: "$params.id" }
response:
  shape: passthrough   # passthrough | template
  template: { id: "$.id", name: "$.displayName", email: "$.mail" }
auth: inherit   # inherit | override
```

### 5.2 Generate-then-customize flow
- `gtr mapping generate --connection <name>` (CLI) or the webUI "Generate" action introspects the connection's schema/known resource set and scaffolds a full mapping file covering discoverable types/fields as REST routes; nested types become nested resources or `?expand=` params, following standard REST convention.
- Developers hand-edit individual mappings (rename fields, drop fields, change routes, add response templates) via the webUI editor or by editing YAML and re-importing via CLI.
- Regeneration never overwrites a mapping with `source: manual` unless `--force` is passed. Mappings default to `source: generated` until edited, at which point they flip to `manual`.

### 5.3 OpenAPI generation
- The gateway derives and serves a live OpenAPI 3 document at `/api/openapi.json` from the current mapping set, with Swagger UI mounted at `/api/docs`.
- This is the primary developer-facing testing surface: a developer can browse and "try it out" against the generated REST API without any Graph/GraphQL knowledge. The webUI's test panel wraps this same spec.

## 6. Gateway Behavior

### 6.1 Error normalization
Vendor errors (Graph OData error objects, GraphQL `errors[]` arrays) are normalized to:
```json
{ "error": { "code": "string", "message": "string", "details": {} } }
```
with an appropriate HTTP status code, so developers don't need to learn each vendor's error format.

### 6.2 Pagination normalization
Regardless of vendor mechanism (`@odata.nextLink`, GraphQL `after`/`endCursor`, offset paging), the REST surface exposes:
- Request: `?limit=&cursor=`
- Response: `{ "data": [...], "nextCursor": "..." }`

The adapter is responsible for translating to/from its vendor's native pagination mechanism.

### 6.3 Rate limiting & caching
- Per-API-key rate limiting via in-memory token bucket (appropriate given the single-process deployment model), configurable per key, off by default.
- Optional short-TTL response caching per mapping, configurable, off by default — primarily to reduce cost/latency of expensive vendor calls.

## 7. Auth Model

Two independent boundaries, both configured per connection:

### 7.1 Proxy → Vendor (`connection.authMode`)
- **`passthrough`**: developer supplies their own vendor access token; the proxy forwards it unchanged and never stores it.
- **`managed`**: the connection stores vendor app credentials (client id/secret or certificate, tenant id, stored refresh token) encrypted at rest in SQLite using a key supplied via env var/mounted secret (the key itself is never persisted in the DB). The proxy performs the full OAuth flow (client-credentials or auth-code, per vendor) and handles token refresh transparently; developers never see a vendor token.

### 7.2 Developer → Proxy
- Independent of §7.1. Every `/api/*` call requires a proxy-issued API key (created via CLI/webUI, stored hashed).
- For `managed` connections, the API key is the developer's entire auth contract — a plain `Authorization: Bearer <proxy-api-key>` header.
- For `passthrough` connections, the developer supplies both the proxy API key (identifies them for rate limiting/logging) and their vendor token (forwarded to the vendor).

### 7.3 Admin access
`/admin/*` and the webUI require a separate login — local username/password, single-tenant, no SSO in v1.

## 8. Storage

SQLite, single file, intended to be mounted as a Docker volume for persistence.

Tables:
- `connections` — id, name, adapter type, auth mode, encrypted credentials, schema cache
- `mappings` — id, connection id, route, method, operation definition, response template, source (generated/manual)
- `api_keys` — id, hashed key, label, rate limit config, created/last-used timestamps
- `admin_users` — id, username, hashed password

## 9. Observability

- Structured JSON request logs to stdout (REST route → vendor call → latency/status) for container log aggregation.
- "Activity" view in the webUI reading the same log data (short retention window in SQLite or an in-memory ring buffer — implementation detail for the plan phase).
- No metrics/tracing backend integration in v1.

## 10. Deployment

- Single multi-stage Dockerfile: builds webUI bundle + server + CLI, runs on a slim Node base image.
- `docker-compose.yml` example: one service, a volume for the SQLite file, env vars for the credential-encryption key and initial admin password/bootstrap.
- CLI usable via `docker run --entrypoint gtr <image> <command>` against the same mounted volume, independent of whether the server is running.

## 11. Tech Stack

- Node.js + TypeScript throughout (server, core engine, CLI, webUI)
- Microsoft Graph: `@microsoft/microsoft-graph-client` + MSAL
- SQLite via a lightweight driver/ORM (choice deferred to implementation plan — e.g. better-sqlite3 or Prisma)
- WebUI: SPA framework (choice deferred to implementation plan)

## 12. Open Items For Implementation Planning
- Exact SQLite access layer (better-sqlite3 vs. Prisma vs. Drizzle)
- WebUI framework choice
- Exact shape of nested-resource REST generation for deeply nested GraphQL types
- Bootstrap flow for first admin user / initial API key on first run

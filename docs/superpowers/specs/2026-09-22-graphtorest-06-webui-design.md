# GraphToRest Plan 6 — WebUI Design

Date: 2026-09-22. Parent spec: `2026-09-17-graphtorest-design.md` (§3 routing, §5 mapping engine, §7.3 admin access, §9 Activity view, §10 deployment). Roadmap entry: `plans/2026-09-17-graphtorest-roadmap.md` "Plan 6 — WebUI".

This resolves the parent spec's §12 open item "WebUI framework choice" and the §9 "Activity" retention detail.

## 1. Decisions

| Topic | Decision |
|---|---|
| Framework | React + Vite + React Router, TypeScript, new workspace `apps/web` |
| Server state | TanStack Query (only runtime library beyond React, React Router, swagger-ui-react) |
| Styling | One plain CSS stylesheet; no component library |
| Admin session in browser | HttpOnly `SameSite=Strict` cookie; token never exposed to page scripts |
| Activity data | SQLite `request_log` table, capped to the newest `ACTIVITY_RETENTION` rows (default 1000) |
| Test panel | Embedded `swagger-ui-react` over `/api/openapi.json`; user supplies an API key (no admin-session bypass of API-key auth) |
| Mapping editing | Per-connection table + per-mapping form (existing PATCH validation) + YAML export/import |

## 2. Out of scope

- **First-run admin creation in the UI** — belongs to Plan 8's bootstrap flow. The login page shows a hint to run `gtr admin-create` instead.
- **Creating additional admin users from the UI** — `gtr admin-create` covers it; the existing `POST /admin/admin-users` endpoint remains, unused by the UI.
- Browser end-to-end test suite (Playwright etc.) — manual smoke run of the built app instead.
- Structured JSON stdout request logs, rate limiting, caching, Docker image slimming (Plan 8).
- CLI access to the activity log (Plan 7 may add it; the table is readable by any process).

## 3. Serving

- `apps/web` builds (`vite build`) to `apps/web/dist`.
- `createApp` gains an optional `webRoot: string`. When set, Express serves static files from it, and any `GET` whose path is not under `/api` or `/admin` and matches no file falls back to `index.html`. The fallback must never answer `/api/*` or `/admin/*`.
- Every response served from `webRoot` (static files and the fallback) carries `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'`. `unsafe-inline` for styles is needed by Swagger UI; scripts stay `'self'` only.
- `apps/server/src/index.ts` passes `webRoot` when `apps/web/dist/index.html` exists and `WEB_ENABLED` is not `false` (config default `true`). Missing assets are not an error — the server runs API/admin-only, as today.
- Dev: `npm run dev -w @graphtorest/web` runs Vite with a proxy for `/admin` and `/api` to `http://localhost:3000`.

## 4. Admin session (cookie)

### 4.1 Login
`POST /admin/login` accepts an optional body field `"session": "cookie"`.

- Absent: unchanged — `200 { token, expiresAt }` (CLI and existing tests).
- `"cookie"`: sets `gtr_admin_session=<token>; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=<ttl seconds>`, plus `Secure` when `PUBLIC_BASE_URL` starts with `https://`. Response is `200 { username, expiresAt }` — the token is **not** in the body.
- Any other value of `session`: `400 INVALID_INPUT`.

### 4.2 Middleware
`createAdminAuth` resolves the session token from `Authorization: Bearer <token>` first; if that header is absent, from the `gtr_admin_session` cookie. Cookie parsing is a small local helper (no new dependency).

For **cookie-authenticated** requests whose method is not `GET`/`HEAD`/`OPTIONS`, CSRF checks apply; failure is `403 CSRF_REJECTED`:

1. If an `Origin` header is present, it passes when `new URL(origin).host === req.get('host')` **or** `new URL(origin).origin === new URL(PUBLIC_BASE_URL).origin`. An unparseable `Origin` fails.
2. If `Origin` is absent, it passes only when `Sec-Fetch-Site: same-origin`.
3. If the request has a body (`Content-Length > 0` or `Transfer-Encoding` present), `Content-Type` must be `application/json` (parameters like `; charset=utf-8` allowed). There are no exceptions — YAML import is sent as JSON (§5).

Bearer-authenticated requests skip CSRF checks (browsers never attach a Bearer header automatically). Comparing Origin to Host is sound for CSRF: a browser always reports the attacking page's real origin, which cannot equal this server's host.

### 4.3 Session routes
- `GET /admin/session` → `200 { username, expiresAt }` for a valid session, else `401`. The UI calls this at boot.
- `POST /admin/logout` → deletes the session (either transport) and, when a cookie was present, clears it (`Max-Age=0`, same attributes). `204`.

## 5. Admin API additions

All require an admin session (§4). Errors use the existing `{ error: { code, message, details } }` envelope.

| Endpoint | Behavior |
|---|---|
| `GET /admin/adapters` | `200 ["mock", "microsoft-graph", "graphql"]` — adapter registry names, in registry order |
| `GET /admin/api-keys` | `200 [{ id, label, createdAt, lastUsedAt }]`, never hashes |
| `DELETE /admin/api-keys/:id` | `204`; `404 NOT_FOUND` if unknown |
| `DELETE /admin/connections/:id` | Deletes the connection, its mappings, its stored credentials and any cached managed tokens in one transaction. `204`; `404` if unknown |
| `DELETE /admin/connections/:id/credentials` | Clears stored credentials and invalidates cached/in-flight managed tokens. `204`; `404` if unknown connection; `503 MANAGED_AUTH_UNAVAILABLE` if managed auth is not configured (matches the existing PUT) |
| `DELETE /admin/mappings/:id` | `204`; `404` if unknown |
| `GET /admin/mappings/export?connectionId=` | `200`, `Content-Type: text/yaml`, body built with core's `mappingToYamlEntry` (same format as `gtr mapping-export`); optional `connectionId` limits it to that connection's mappings (`404` if unknown) |
| `POST /admin/mappings/import` | JSON body `{ "yaml": "<text>" }` (1 MB limit). Same validate-then-write atomic import as `gtr mapping-import` — entries name their connection, may carry an `id` to update, and nothing is written if any entry is invalid. `200 { imported: <n>, warnings: [<string>] }`; `400 INVALID_INPUT` on invalid YAML or entries. The import logic (currently `apps/cli/src/commands/mappingImport.ts`) moves into `@graphtorest/core` as a function taking YAML text and returning `{ records, warnings }`; the CLI's `mapping-import` becomes a thin wrapper over it, keeping its current behavior and messages. |
| `GET /admin/activity?limit=&before=` | Newest-first rows (§6). `limit` 1–200, default 50. `before` is a row `id`; returns rows with smaller ids. `200 { items: [...], nextBefore: <id or null> }` |

### 5.1 OAuth callback
When `webRoot` is set, `GET /admin/oauth/callback` responds `302` to `/connections/<connectionId>?oauth=success`, or on failure `/connections/<connectionId>?oauth=error&code=<error code>` (or `/connections?oauth=error&code=<code>` when the connection cannot be determined from state). Without `webRoot`, it keeps the current JSON responses. No secrets or vendor error text appear in the redirect URL — only the gateway error code.

## 6. Activity log

### 6.1 Storage
New migration adds:

```
request_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,            -- ISO 8601
  method TEXT NOT NULL,
  path TEXT NOT NULL,          -- request path only, never the query string
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,             -- gateway error code when status >= 400
  api_key_id TEXT,
  connection_id TEXT,
  mapping_id TEXT
)
```

No query strings, headers, or bodies are stored. `MappingStore` gains `recordRequest(entry, retention)` (insert, then delete rows with `id <= max(id) - retention`) and `listRequests({ limit, before })`, which left-joins API-key label and connection name.

### 6.2 Writing
- One row per `/api/*` request, including `401` rejections from the API-key middleware (`api_key_id` null in that case). `/api/openapi.json` and `/api/docs` are not logged.
- The API-key middleware records the matched key id in `res.locals`.
- `GatewayEngine.handle`'s request context gains an optional `onMatch?: (mapping: MappingRecord) => void`, called once a mapping is resolved, so the server can record `connection_id`/`mapping_id` without re-matching routes.
- The row is written on the response's `finish` event. A failure to write is logged with `console.error` and never affects the API response.
- `ACTIVITY_RETENTION` env var (positive integer, default 1000) sets the cap.

## 7. UI

### 7.1 Routes
- `/login` — username/password; posts `{ username, password, session: "cookie" }`. When login fails, shows the error message; the page always shows a note that the first admin is created with `gtr admin-create`.
- `/connections` — list + create form: name, adapter (from `GET /admin/adapters`), auth mode (`passthrough` | `managed`), adapter config (GraphQL: endpoint URL).
- `/connections/:id` — tabs:
  - **Overview** — settings; delete connection (confirm dialog).
  - **Credentials** (managed connections only) — credential status; set-credentials form; "Authorize" (calls `oauth/start`, then `window.location.assign(authorizationUrl)`); "Clear credentials" (confirm). Shows a success/error banner from `?oauth=`.
  - **Mappings** — table (method, route, source, operation summary); "Generate" (prompts for a vendor token when the connection is passthrough); row click opens an edit form backed by `PATCH /admin/mappings/:id`, showing server validation errors inline; delete (confirm); "Export YAML" (downloads this connection's mappings). A global "Import YAML" action on `/connections` (file picker → import endpoint) shows validation errors and warnings.
- `/api-keys` — list; create (the full key is shown once with "Copy" and "Use in test panel"); revoke (confirm).
- `/test` — `swagger-ui-react` with `url: '/api/openapi.json'`; the API key is pre-authorized from `sessionStorage` key `gtr_test_api_key` when present (set by "Use in test panel"), otherwise the user pastes it into Swagger's Authorize dialog.
- `/activity` — table (time, method, path, status, duration, API key label, connection name, error code); optional 5-second auto-refresh; "Load older" via `nextBefore`.

All routes except `/login` require a session; an unauthenticated visit redirects to `/login`, and a successful login returns to the originally requested route.

### 7.2 Data layer
- `api.ts`: one fetch wrapper — `credentials: 'same-origin'`, JSON by default, parses the error envelope into `ApiError { status, code, message, details }`. On `401` it clears the cached session query and navigates to `/login`.
- TanStack Query for reads; mutations invalidate the affected queries.

### 7.3 Error handling
- Mutation errors render the envelope `message` inline at the form; query errors render an error panel with Retry.
- `403 CSRF_REJECTED` shows a hint to check that `PUBLIC_BASE_URL` matches the browsed URL.
- Destructive actions require a confirm dialog.

## 8. Build and deployment

- Root `build` script includes `apps/web` (after core; web does not depend on core at build time).
- Dockerfile build stage: copy `apps/web/package.json` before `npm ci`, copy `apps/web` source, build. Runtime stage copies only `apps/web/dist` (no web `node_modules`).
- `docker-compose.yml`: comment that `PUBLIC_BASE_URL` should match the URL used in the browser.

## 9. Testing

**Server (vitest + supertest):**
- Cookie login: `Set-Cookie` attributes (HttpOnly, SameSite=Strict, Path=/admin, Max-Age, Secure only for https base URL), token absent from body; invalid `session` value → 400.
- Cookie authenticates admin routes; Bearer path unchanged; Bearer takes precedence.
- CSRF: cross-origin `Origin` rejected; matching Host accepted; matching `PUBLIC_BASE_URL` accepted; missing Origin with/without `Sec-Fetch-Site: same-origin`; non-JSON body rejected; Bearer requests exempt; GET exempt.
- `GET /admin/session`, logout clears cookie and session.
- Each new endpoint: success, 404, and auth required; connection delete cascades mappings and credentials; YAML export→import round trip; invalid YAML import writes nothing.
- Activity: rows for success, gateway error, and API-key 401; query string never stored; `connection_id`/`mapping_id` populated via `onMatch`; retention pruning; pagination via `before`; a failing write does not change the API response.
- OAuth callback: redirect when `webRoot` set (success and error), JSON when not.
- Static: file served, SPA fallback for unknown GET, `/api/*` and `/admin/*` unknown paths never return `index.html`, CSP header present; no `webRoot` → `/` is 404.

**Web (vitest + jsdom + Testing Library):** `api.ts` envelope parsing and 401 handling; login flow and redirect-back; connection create form; mapping edit form showing server validation errors; API key shown once; activity "Load older".

**Manual:** build the app and the Docker image, log in, create a connection, generate mappings, create a key, call a route from the test panel, and see it in Activity.

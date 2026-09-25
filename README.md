# GraphToRest

GraphToRest is a gateway that exposes GraphQL APIs (including Microsoft Graph)
as plain REST endpoints. Mappings translate REST routes to GraphQL queries and
shape the responses; an admin web UI and the `gtr` CLI manage connections,
mappings and API keys.

## Quick start

```bash
git clone <this repo> && cd GraphToRest
export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
export GTR_BOOTSTRAP_ADMIN_USERNAME=admin
export GTR_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)
docker compose up -d
```

Then open `http://localhost:3000` and sign in with the bootstrap admin
credentials. `CREDENTIAL_ENCRYPTION_KEY` is only required for connections
using `authMode: managed`; the bootstrap admin vars only take effect on the
first run, while no admin user exists yet — unset them (or create further
admins with `gtr admin create`) afterwards.

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the server listens on. |
| `DB_PATH` | `./data/graphtorest.db` (`/data/graphtorest.db` in the Docker image) | Path to the SQLite database file. |
| `API_ENABLED` | `true` | Set to `false` to disable the `/api/*` REST gateway. |
| `ADMIN_ENABLED` | `true` | Set to `false` to disable the `/admin/*` admin API and web UI. |
| `WEB_ENABLED` | `true` | Set to `false` to disable serving the built admin web UI (the admin API stays available). |
| `CREDENTIAL_ENCRYPTION_KEY` | unset | 32-byte key (64 hex chars or base64) used to encrypt stored vendor credentials. Required for connections with `authMode: managed`; losing it makes those credentials unreadable. |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Externally reachable URL of this server. Determines the OAuth redirect URI (`<PUBLIC_BASE_URL>/admin/oauth/callback`), whether the admin session cookie is marked `Secure`, and which origin the web UI's CSRF check accepts. |
| `ACTIVITY_RETENTION` | `1000` | Number of most-recent request-log rows kept for the web UI's Activity view. |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `RATE_LIMIT_DEFAULT` | unset (unlimited) | Default per-API-key limit in requests/minute; individual keys can override it. |
| `RATE_LIMIT_DEFAULT_BURST` | value of `RATE_LIMIT_DEFAULT` | Default token-bucket burst size. |
| `CACHE_MAX_TTL_SECONDS` | `300` | Upper bound on any mapping's response-cache TTL. |
| `CACHE_MAX_ENTRIES` | `1000` | Response-cache capacity; `0` disables caching entirely. |
| `OUTBOUND_TIMEOUT_MS` | `30000` | Timeout for outbound GraphQL and OAuth token requests. |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false` | Set to `true` to allow outbound requests to private/loopback/link-local destinations (needed when the GraphQL endpoint runs on the same Docker network or LAN). |
| `GTR_BOOTSTRAP_ADMIN_USERNAME` | unset | Together with `GTR_BOOTSTRAP_ADMIN_PASSWORD`, creates this admin user on startup if no admin exists yet. Remove after first start. |
| `GTR_BOOTSTRAP_ADMIN_PASSWORD` | unset | See above. Passwords must be 12–1024 characters. |

**Known limitation:** the default outbound timeout (`OUTBOUND_TIMEOUT_MS`,
30s) now governs OAuth token requests as well as GraphQL calls; earlier
releases used a fixed 10s timeout for OAuth token requests.

## Rate limiting

API keys are rate-limited with a per-key token bucket. `RATE_LIMIT_DEFAULT`
sets the default requests-per-minute rate for keys that don't have their own
override (`RATE_LIMIT_DEFAULT_BURST` sets the default bucket size, defaulting
to the rate itself). Override a specific key's limit with:

```bash
gtr apikey update <id> --rate-limit 60 --burst 10   # a specific limit
gtr apikey update <id> --unlimited                  # exempt this key
gtr apikey update <id> --default                     # fall back to RATE_LIMIT_DEFAULT
```

The same overrides are available from the web UI. A request over the limit
gets `429` with a `Retry-After` header and `RateLimit-Limit` /
`RateLimit-Remaining` / `RateLimit-Reset` headers.

## Response caching

Each mapping has its own `cacheTtlSeconds` (`0` disables caching for that
mapping), settable from the web UI, `gtr mapping update <id> --cache-ttl 60`,
or in the mapping YAML. Only successful (`2xx`) `GET` responses are cached.
Cache entries are keyed per vendor token for passthrough connections, and
shared per connection for managed connections (since all API keys call the
vendor as the same managed identity). A response carries an `X-Cache: HIT` or
`X-Cache: MISS` header.

**Known limitations:**
- Edits made with the embedded CLI (`gtr --db ...`) directly against a
  running server's database file are not seen by that server's in-memory
  cache until the affected entries expire.
- A request that is a cache `MISS` in flight when an admin change (e.g. a
  credential update) evicts entries can still re-cache the pre-change
  response afterwards. This window is bounded by the mapping's TTL — lower
  `cacheTtlSeconds` if this matters, for example around credential
  revocation.

## Outbound network safety

Outbound GraphQL and OAuth requests to private, loopback or link-local
destinations are blocked unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`. Even
when allowed, plain `http://` is only permitted for opted-in private
destinations (public destinations require `https://`). Redirects are not
followed. Known gap: the destination is validated and then connected to as
two separate steps, so DNS rebinding between the check and the connection is
not defended against.

## Operations

- `GET /healthz` reports server health for container orchestration.
- All logs are structured JSON on stdout (info/debug) and stderr (warn/error).
  Request logs use the event `request_completed` and never include headers,
  bodies, query strings, tokens, API-key secrets or passwords.
- The server shuts down gracefully on `SIGTERM`, finishing in-flight requests
  before exiting.
- The Docker image runs as the unprivileged `node` user (uid 1000), not root.
  Upgrading a volume created by an image from before this hardening (which
  ran as root)? Fix ownership once with:

  ```bash
  docker compose run --rm --user root --entrypoint chown graphtorest -R node:node /data
  ```

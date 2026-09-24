# GraphToRest Plan 7 — CLI Completeness Design

Date: 2026-09-23. Parent spec: `2026-09-17-graphtorest-design.md` (§3 CLI modes, §7.3 admin access, §10 deployment). Roadmap entry: `plans/2026-09-17-graphtorest-roadmap.md` "Plan 7 — CLI Completeness".

## 1. Decisions

| Topic | Decision |
|---|---|
| Mode selection | Remote **only when configured** (`--server`, `GTR_SERVER`, or a saved login profile); otherwise embedded. No network probing. A configured-but-unreachable server is an error, never a fallback to a local DB file. This narrows parent spec §3's "no server is reachable/configured" to "configured". |
| Remote auth | `gtr login` stores `{server, username, token, expiresAt}` in a profile file (mode `0600`); `gtr logout` revokes the session and deletes the file. `GTR_SERVER` + `GTR_TOKEN` env vars override the file (CI). Single profile — no named profiles. |
| Command surface | Full parity with `/admin/*`, nested `gtr <noun> <verb>`. The Plan 1–5 flat names (`connection-create`, …) are **removed**, not aliased. |
| Output | Human tables / summary lines by default; global `--json` prints raw JSON records. Errors: one line on stderr, non-zero exit code. |
| Internal structure | One `GtrClient` interface, two implementations (`EmbeddedClient`, `RemoteClient`); commands depend only on the interface. Parity enforced by a shared contract test suite. |
| Server changes | None required. The admin middleware already accepts `Authorization: Bearer` sessions. |

## 2. Out of scope

- Named/multiple server profiles.
- A remote endpoint for setting an admin password (`admin set-password` stays embedded-only, see §5).
- Shell completion scripts, interactive wizards, colored output.
- First-run bootstrap automation (Plan 8).
- Keeping the flat command names as deprecated aliases.

## 3. Mode resolution

`resolveMode(globalOpts, env, profile)` returns `{ kind: 'embedded', dbPath }` or `{ kind: 'remote', server, token | null, source }`, first match wins:

1. `--server URL` → remote. Token: `GTR_TOKEN` if set, else the profile's token **only if** the profile's `server` equals this URL, else `null`.
2. `GTR_SERVER` env → remote. Token: `GTR_TOKEN`, else matching profile token, else `null`.
3. A profile file exists → remote with its server and token.
4. Otherwise → embedded, `dbPath = --db ?? DB_PATH ?? ./data/graphtorest.db`.

Rules:
- `--db` together with a remote resolution (any of 1–3) is a usage error (exit 2): `--db cannot be combined with remote mode (server configured via <source>); run "gtr logout" or drop --db`.
- Server URLs are normalized (trailing slashes stripped) and must be `http:` or `https:`.
- `source` (`--server` / `GTR_SERVER` / `profile`) appears in connection and auth error messages so the user can see why remote mode was chosen.
- Remote with `token === null` fails on the first authenticated call with `Not logged in to <server>; run "gtr login --server <server>"` (exit 3).
- `gtr login` itself resolves the server from `--server`, then `GTR_SERVER`, then the existing profile; with none it is a usage error.

## 4. Profile file

- Path: `$XDG_CONFIG_HOME/graphtorest/cli.json`, falling back to `~/.config/graphtorest/cli.json`. `GTR_PROFILE_PATH` overrides the full path (used by tests).
- Content: `{ "server": string, "username": string, "token": string, "expiresAt": string }`.
- Written atomically (temp file + rename), directory created `0700`, file `0600`.
- Unreadable or malformed file → error naming the path and suggesting `gtr logout` (which deletes it even when malformed).
- An expired `expiresAt` is not checked client-side; the server's 401 is authoritative (§7).

## 5. Command tree

Modes: **B** = both, **E** = embedded only, **R** = remote only. A command run in the wrong mode fails with exit 2 and a message stating which mode it needs and why.

Global options: `--server <url>`, `--db <path>`, `--json`.

```
gtr login [--server URL] [--username U]                    R
gtr logout                                                 R
gtr status                                                 B

gtr connection create --name N --adapter-type T --auth-mode M [--config JSON]   B
gtr connection list                                                              B
gtr connection show <conn>                                                       B
gtr connection delete <conn> [--yes]                                             B
gtr connection credentials set <conn> (--credentials-file PATH | --credentials JSON)   B
gtr connection credentials status <conn>                                         B
gtr connection credentials clear <conn> [--yes]                                  B
gtr connection authorize <conn>                                                  R

gtr mapping create --connection <conn> --route "GET /x" --operation JSON [--response-template JSON]   B
gtr mapping list [--connection <conn>]                                           B
gtr mapping update <id> [--route R] [--operation JSON] [--response-template JSON]   B
gtr mapping delete <id> [--yes]                                                  B
gtr mapping generate --connection <conn> [--force] [--vendor-token TOKEN]        B
gtr mapping export [--connection <conn>] [--out FILE]                            B
gtr mapping import <file>                                                        B

gtr apikey create [--label L]                              B
gtr apikey list                                            B
gtr apikey revoke <id> [--yes]                             B

gtr admin create --username U [--password P]               B
gtr admin set-password --username U [--password P]         E

gtr adapters                                               B
gtr activity [--limit N] [--before ID]                     B
```

Command notes:
- **`<conn>`** accepts a connection id or its unique name, resolved client-side from `listConnections()` (id match first, then name). No match → not found (exit 4).
- **`login`**: username from `--username` or an interactive prompt; password from `GTR_ADMIN_PASSWORD`, else a hidden TTY prompt; with neither available (non-TTY, no env) it is a usage error. Calls `POST /admin/login` (bearer mode) and writes the profile. Prints `Logged in to <server> as <user> (session expires <expiresAt>)`.
- **`logout`**: best-effort `POST /admin/logout` (a 401 or network failure is ignored), then deletes the profile file. Succeeds when no profile exists.
- **`status`**: embedded → `mode: embedded`, db path, whether the file exists, admin user count. Remote → `mode: remote`, server, `source`, and the result of `GET /admin/session` (username, expiry), or `not logged in` / `session expired`. `status` exits 0 even when not logged in; it is diagnostic.
- **`connection show`**: the connection record, plus credential status when `authMode === 'managed'` and credential status is obtainable (remote: server has managed auth; embedded: `CREDENTIAL_ENCRYPTION_KEY` set locally). Otherwise the credential line reads `unavailable (<reason>)`.
- **Destructive commands** (`connection delete`, `connection credentials clear`, `mapping delete`, `apikey revoke`) prompt `Delete connection "<name>" (<id>)? [y/N]` on a TTY. `--yes` skips the prompt. Non-TTY without `--yes` is a usage error.
- **Secrets**: `--credentials` and `--password` remain available but their help text warns about shell history. `--credentials-file`, `GTR_ADMIN_PASSWORD` and hidden prompts are the recommended paths. A credentials JSON parse failure keeps the existing deliberately generic message.
- **`apikey create`** prints the plaintext key once, followed by `Store this key now; it cannot be shown again.` on stderr (so `--json` stdout stays clean).
- **`mapping export`** without `--out` writes YAML to stdout in both output modes (`--json` does not wrap it). With `--out` it writes atomically (existing behavior) and prints a one-line summary.
- **`mapping import`** result is `{ imported: number, warnings: string[] }` in both modes; warnings go to stderr in table mode.
- **`mapping generate`** in embedded mode needs `CREDENTIAL_ENCRYPTION_KEY` locally for managed connections (existing behavior). In remote mode `--vendor-token` is sent as the `X-Vendor-Token` header.
- **`connection authorize`** calls `POST /admin/connections/:id/oauth/start` and prints the authorization URL with an instruction to open it in a browser. It is remote-only because the vendor redirects to the server's `/admin/oauth/callback`.
- **`admin set-password`** is embedded-only: it is the lockout-recovery path, and no remote endpoint exists.

## 6. Architecture

```
apps/cli/src/
  index.ts              builds the commander tree, parses, runs, maps errors → exit codes
  program.ts            buildProgram(deps) — testable without process.argv / process.exit
  mode.ts               resolveMode()
  profile.ts            read/write/delete the profile file
  prompt.ts             TTY detection, hidden password prompt, y/N confirm (injectable)
  errors.ts             CliError { code, message, exitCode }
  output.ts             Output { print(result, renderer) } — table vs --json
  client/types.ts       GtrClient interface + result types
  client/embedded.ts    EmbeddedClient(store, managedAuth?)
  client/remote.ts      RemoteClient(server, token, fetchImpl?)
  client/resolve.ts     resolveConnection(client, idOrName)
  commands/auth.ts      login, logout, status
  commands/connection.ts
  commands/mapping.ts
  commands/apikey.ts
  commands/admin.ts
  commands/misc.ts      adapters, activity
```

The existing `commands/*.ts` functions and `embeddedClient.ts` are folded into `client/embedded.ts`; the old flat registrations in `index.ts` are deleted.

### 6.1 GtrClient

```ts
interface GtrClient {
  readonly mode: 'embedded' | 'remote';
  createConnection(input): Promise<ConnectionRecord>;
  listConnections(): Promise<ConnectionRecord[]>;
  deleteConnection(id): Promise<void>;
  setCredentials(id, credentials: unknown): Promise<CredentialStatus>;
  getCredentialStatus(id): Promise<CredentialStatus>;
  clearCredentials(id): Promise<void>;
  startAuthorization(id): Promise<{ authorizationUrl: string }>;   // embedded: throws mode error
  createMapping(input): Promise<MappingRecord>;
  listMappings(): Promise<MappingRecord[]>;
  updateMapping(id, patch): Promise<MappingRecord>;
  deleteMapping(id): Promise<void>;
  generateMappings(connectionId, { force, vendorToken }): Promise<GenerationResult>;
  exportMappings({ connectionId? }): Promise<string>;
  importMappings(yaml: string): Promise<{ imported: number; warnings: string[] }>;
  createApiKey({ label? }): Promise<{ id: string; plaintext: string; label: string | null }>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id): Promise<void>;
  createAdminUser({ username, password }): Promise<AdminUserRecord>;
  setAdminPassword({ username, password }): Promise<void>;         // remote: throws mode error
  listAdapters(): Promise<string[]>;
  listActivity({ limit?, before? }): Promise<{ items: RequestLogRecord[]; nextBefore: number | null }>;
}
```

All methods are async so both implementations share one signature. `mapping list --connection` filters client-side. `createMapping` takes the combined `"GET /x"` route string at the command layer, which is parsed with core's `parseRouteString` before the client call, so both implementations receive `{ method, route }`.

Embedded-side validation must match the server's: `EmbeddedClient.updateMapping` runs input through core's `parseMappingFields`, as the PATCH route does, and forces `source: 'manual'`. `EmbeddedClient.listActivity` applies the same limit bounds (1–200, default 50) as `GET /admin/activity`.

### 6.2 RemoteClient

- Uses Node's built-in `fetch` (injectable for tests). Base URL `<server>/admin`. Sends `Authorization: Bearer <token>` and `Content-Type: application/json` on bodies.
- 204 → `undefined`. JSON response → parsed body. `text/yaml` (export) → text.
- Non-2xx with an `{ error: { code, message } }` body → `CliError` from the server's code and message (§7). A non-JSON error body → `CliError('SERVER_ERROR', 'Server returned HTTP <status>')`.
- A network failure (`fetch` rejects) → `CliError('UNREACHABLE', 'Cannot reach server at <server> (configured via <source>): <cause>')`, exit 1.
- A 30-second request timeout via `AbortSignal.timeout`; `mapping generate` uses 120 seconds.

### 6.3 Output

Each command supplies a renderer `(result) => string` for table mode. `--json` prints `JSON.stringify(result, null, 2)`. Tables are plain aligned columns with no dependency added (for example `connection list`: `ID  NAME  ADAPTER  AUTH MODE`; `mapping list`: `ID  METHOD  ROUTE  CONNECTION  SOURCE`; `activity`: `TIME  STATUS  METHOD  ROUTE  LATENCY`). Empty lists print `No connections.` etc. Commands that return nothing print a one-line confirmation (`Deleted mapping <id>.`); with `--json` they print `{ "ok": true }`.

## 7. Errors and exit codes

All failures surface as `CliError`. `index.ts` prints `error: <message>` to stderr, and the stack trace only when `GTR_DEBUG=1`.

| Exit | Meaning | Sources |
|---|---|---|
| 0 | success | |
| 1 | general failure | server `INTERNAL_ERROR`/5xx, `UNREACHABLE`, vendor/adapter errors, `MANAGED_AUTH_DISABLED` |
| 2 | usage | commander errors, invalid JSON flags, mode mismatch, `--db` with remote, non-TTY confirm without `--yes`, server `INVALID_INPUT` |
| 3 | auth | server `UNAUTHORIZED`, no token |
| 4 | not found | server `NOT_FOUND`, unresolved `<conn>` |
| 5 | conflict | server `CONFLICT` |

Embedded mode maps local failures to the same codes: `SQLITE_CONSTRAINT_UNIQUE` → `CONFLICT`, `SQLITE_CONSTRAINT_FOREIGNKEY` → `INVALID_INPUT`, a missing record → `NOT_FOUND`, `GatewayError` → its own code. An unknown `code` falls back to exit 1.

A remote 401 whose request carried a token produces `Session expired or revoked; run "gtr login --server <server>"`.

## 8. Testing

- **`mode.test.ts`**: the full §3 precedence table, including profile-token reuse only for a matching server, `--db` + remote conflict, and URL validation.
- **`profile.test.ts`**: round trip, `0600`/`0700` permissions, `XDG_CONFIG_HOME` and `GTR_PROFILE_PATH`, a malformed file error, and deleting a malformed file.
- **`client.contract.test.ts`**: one `describe.each` over `[embedded, remote]`. Embedded uses a temp SQLite file; remote uses `createApp()` imported by relative path from `apps/server/src/app.ts` (not the package entry, whose `index.ts` starts a server as a side effect), listening on port 0 with a logged-in bearer token. It covers every `GtrClient` method, including the error cases: duplicate connection name → `CONFLICT`, unknown id → `NOT_FOUND`, bad mapping patch → `INVALID_INPUT`, non-managed credentials → `INVALID_INPUT`, and the mode-restricted methods. Managed-credential and generate cases reuse the existing nock/mock-adapter fixtures.
- **`remote.test.ts`**: fetch-stubbed specifics: unreachable server, non-JSON error body, timeout, 401 message wording.
- **`commands.test.ts`**: `buildProgram` with a fake `GtrClient`, fake prompt, and captured stdout/stderr. It covers argv → client call → table output and `--json` output for each command, `<conn>` name resolution, confirm and `--yes` behavior, and exit codes.
- **`bin.smoke.test.ts`**: spawns the built `bin/gtr.js` for `gtr status` (embedded) and one unknown command (exit 2).
- The existing CLI tests (`commands`, `adminCommands`, `managedAuth`, `mappingLifecycle`, `carryOvers`) are ported to the new commands or client, not deleted.

## 9. Documentation touch-ups

The flat names are referenced outside the CLI and must be updated to the nested form:
- `docker-compose.yml` bootstrap comment → `gtr admin create`.
- `apps/server/src/index.ts` no-admin-users warning → `gtr admin create`.
- `apps/web/src/pages/LoginPage.tsx` hint and `apps/web/test/login.test.tsx` → `gtr admin create`.
- `apps/web/src/pages/ConnectionsPage.tsx` and the `mappingYaml.ts` doc comment → `gtr mapping export`.
- `apps/cli` gets a short `README.md` covering the two modes, login, and the command tree.

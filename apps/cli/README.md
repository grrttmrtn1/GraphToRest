# gtr — GraphToRest CLI

`gtr` manages connections, mappings, API keys and admin users. It runs in one of two modes.

## Modes

| Mode | When | Talks to |
|---|---|---|
| **remote** | `--server URL`, `GTR_SERVER`, or a saved `gtr login` profile | a running server's `/admin/*` API |
| **embedded** | none of the above | the SQLite file directly (`--db`, else `$DB_PATH`, else `./data/graphtorest.db`) |

`gtr status` shows which mode applies and why. A configured server that can't be reached is an error; `gtr` never silently falls back to a local file. `--db` together with remote mode is rejected.

## Remote mode

```sh
gtr login --server https://gtr.example.com --username admin   # prompts for the password
gtr connection list
gtr logout
```

The session is saved to `~/.config/graphtorest/cli.json` (mode 0600; `$XDG_CONFIG_HOME` and `GTR_PROFILE_PATH` are honored). For CI, set `GTR_SERVER` and `GTR_TOKEN` instead of logging in. `GTR_ADMIN_PASSWORD` supplies the login password without a prompt.

## Embedded mode (no server needed)

```sh
docker compose run --rm -e GTR_ADMIN_PASSWORD --entrypoint gtr graphtorest admin create --username admin
gtr --db ./data/graphtorest.db mapping export --out mappings.yaml
```

Managed-connection commands need `CREDENTIAL_ENCRYPTION_KEY` in the environment, the same key the server uses.

## Commands

```
gtr login | logout | status
gtr connection create | list | show <conn> | delete <conn>
gtr connection credentials set | status | clear <conn>
gtr connection authorize <conn>                (remote only)
gtr mapping create | list | update <id> | delete <id> | generate | export | import <file>
gtr apikey create | list | revoke <id>
gtr admin create | set-password                (set-password: embedded only)
gtr adapters
gtr activity [--limit N] [--before ID]
```

`<conn>` is a connection id or name. Add `--json` to any command for machine-readable output. Destructive commands ask for confirmation on a terminal; pass `--yes` in scripts.

Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 not found, 5 conflict. Set `GTR_DEBUG=1` for stack traces.

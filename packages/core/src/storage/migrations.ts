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

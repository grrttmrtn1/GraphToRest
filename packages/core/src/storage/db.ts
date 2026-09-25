import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export function openDb(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The file holds hashed API keys and encrypted vendor credentials: owner-only, whether new or pre-existing.
  if (filePath !== ':memory:') {
    for (const file of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
  }
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  ensureColumn(db, 'connections', 'config', 'TEXT');
  ensureColumn(db, 'mappings', 'cache_ttl_seconds', 'INTEGER');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

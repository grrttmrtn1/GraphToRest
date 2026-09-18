import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

export function openDb(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  ensureConnectionsConfigColumn(db);
  return db;
}

function ensureConnectionsConfigColumn(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'config')) {
    db.exec('ALTER TABLE connections ADD COLUMN config TEXT');
  }
}

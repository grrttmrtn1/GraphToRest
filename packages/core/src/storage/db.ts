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
  return db;
}

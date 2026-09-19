import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { generateApiKey, type GeneratedApiKey } from '../auth/apiKeys';

export interface ConnectionRecord {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: Record<string, unknown> | null;
}

export interface MappingRecord {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
  source: 'generated' | 'manual';
}

export interface ApiKeyRecord {
  id: string;
  label: string | null;
}

interface ConnectionRow {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: string | null;
}

interface MappingRow {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: string;
  responseTemplate: string | null;
  source: 'generated' | 'manual';
}

const MAPPING_COLUMNS =
  'id, connection_id as connectionId, route, method, operation, response_template as responseTemplate, source';

function mapConnectionRow(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    authMode: row.authMode,
    config: row.config ? JSON.parse(row.config) : null,
  };
}

function mapMappingRow(row: MappingRow): MappingRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    route: row.route,
    method: row.method,
    operation: JSON.parse(row.operation),
    responseTemplate: row.responseTemplate ? JSON.parse(row.responseTemplate) : null,
    source: row.source,
  };
}

export class MappingStore {
  constructor(private db: Database.Database) {}

  /** Runs `fn` inside a single SQLite transaction: any throw rolls back every write made within it. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createConnection(input: {
    name: string;
    adapterType: string;
    authMode: string;
    config?: Record<string, unknown> | null;
  }): ConnectionRecord {
    const id = crypto.randomUUID();
    const config = input.config ?? null;
    this.db
      .prepare('INSERT INTO connections (id, name, adapter_type, auth_mode, config) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.adapterType, input.authMode, config ? JSON.stringify(config) : null);
    return { id, name: input.name, adapterType: input.adapterType, authMode: input.authMode, config };
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode, config FROM connections WHERE id = ?')
      .get(id) as ConnectionRow | undefined;
    return row ? mapConnectionRow(row) : null;
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode, config FROM connections')
      .all() as ConnectionRow[];
    return rows.map(mapConnectionRow);
  }

  /** Stores an already-encrypted credentials blob; the store never sees plaintext. Returns false if the connection does not exist. */
  setConnectionCredentials(id: string, encrypted: string | null): boolean {
    const result = this.db.prepare('UPDATE connections SET credentials_encrypted = ? WHERE id = ?').run(encrypted, id);
    return result.changes > 0;
  }

  getConnectionCredentials(id: string): string | null {
    const row = this.db.prepare('SELECT credentials_encrypted as credentials FROM connections WHERE id = ?').get(id) as
      | { credentials: string | null }
      | undefined;
    return row?.credentials ?? null;
  }

  createMapping(input: {
    connectionId: string;
    route: string;
    method: string;
    operation: Record<string, unknown>;
    responseTemplate?: Record<string, string> | null;
    source?: 'generated' | 'manual';
  }): MappingRecord {
    const id = crypto.randomUUID();
    const source = input.source ?? 'generated';
    const responseTemplate = input.responseTemplate ?? null;
    this.db
      .prepare(
        'INSERT INTO mappings (id, connection_id, route, method, operation, response_template, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.connectionId,
        input.route,
        input.method,
        JSON.stringify(input.operation),
        responseTemplate ? JSON.stringify(responseTemplate) : null,
        source
      );
    return {
      id,
      connectionId: input.connectionId,
      route: input.route,
      method: input.method,
      operation: input.operation,
      responseTemplate,
      source,
    };
  }

  getMapping(id: string): MappingRecord | null {
    const row = this.db.prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings WHERE id = ?`).get(id) as MappingRow | undefined;
    return row ? mapMappingRow(row) : null;
  }

  getMappingByRouteAndMethod(method: string, route: string): MappingRecord | null {
    const row = this.db
      .prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings WHERE method = ? AND route = ?`)
      .get(method, route) as MappingRow | undefined;
    return row ? mapMappingRow(row) : null;
  }

  listMappings(): MappingRecord[] {
    const rows = this.db.prepare(`SELECT ${MAPPING_COLUMNS} FROM mappings`).all() as MappingRow[];
    return rows.map(mapMappingRow);
  }

  updateMapping(
    id: string,
    patch: {
      route?: string;
      method?: string;
      operation?: Record<string, unknown>;
      responseTemplate?: Record<string, string> | null;
      source: 'generated' | 'manual';
    }
  ): MappingRecord | null {
    const existing = this.getMapping(id);
    if (!existing) return null;
    const next: MappingRecord = {
      id: existing.id,
      connectionId: existing.connectionId,
      route: patch.route ?? existing.route,
      method: patch.method ?? existing.method,
      operation: patch.operation ?? existing.operation,
      responseTemplate: patch.responseTemplate !== undefined ? patch.responseTemplate : existing.responseTemplate,
      source: patch.source,
    };
    this.db
      .prepare('UPDATE mappings SET route = ?, method = ?, operation = ?, response_template = ?, source = ? WHERE id = ?')
      .run(
        next.route,
        next.method,
        JSON.stringify(next.operation),
        next.responseTemplate ? JSON.stringify(next.responseTemplate) : null,
        next.source,
        id
      );
    return next;
  }

  createApiKey(input: { label?: string }): GeneratedApiKey & ApiKeyRecord {
    const generated = generateApiKey();
    const label = input.label ?? null;
    this.db
      .prepare('INSERT INTO api_keys (id, hashed_key, label) VALUES (?, ?, ?)')
      .run(generated.id, generated.hashedSecret, label);
    return { ...generated, label };
  }

  findApiKeyById(id: string): { id: string; hashedKey: string } | null {
    const row = this.db
      .prepare('SELECT id, hashed_key as hashedKey FROM api_keys WHERE id = ?')
      .get(id) as { id: string; hashedKey: string } | undefined;
    return row ?? null;
  }

  touchApiKeyLastUsed(id: string): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }
}

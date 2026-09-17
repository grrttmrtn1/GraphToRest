import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { generateApiKey, type GeneratedApiKey } from '../auth/apiKeys';

export interface ConnectionRecord {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
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

interface MappingRow {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: string;
  responseTemplate: string | null;
  source: 'generated' | 'manual';
}

export class MappingStore {
  constructor(private db: Database.Database) {}

  createConnection(input: { name: string; adapterType: string; authMode: string }): ConnectionRecord {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO connections (id, name, adapter_type, auth_mode) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.adapterType, input.authMode);
    return { id, name: input.name, adapterType: input.adapterType, authMode: input.authMode };
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode FROM connections WHERE id = ?')
      .get(id) as ConnectionRecord | undefined;
    return row ?? null;
  }

  listConnections(): ConnectionRecord[] {
    return this.db
      .prepare('SELECT id, name, adapter_type as adapterType, auth_mode as authMode FROM connections')
      .all() as ConnectionRecord[];
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

  listMappings(): MappingRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, connection_id as connectionId, route, method, operation, response_template as responseTemplate, source FROM mappings'
      )
      .all() as MappingRow[];
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      route: row.route,
      method: row.method,
      operation: JSON.parse(row.operation),
      responseTemplate: row.responseTemplate ? JSON.parse(row.responseTemplate) : null,
      source: row.source,
    }));
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

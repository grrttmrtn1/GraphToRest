import YAML from 'yaml';
import type { MappingRecord, MappingStore } from '../storage/MappingStore';
import { GatewayError } from '../gateway/errors';
import { mappingToYamlEntry, yamlEntryToMappingInput, type MappingInput, type MappingYamlEntry } from './yamlTransform';

export interface MappingImportResult {
  records: MappingRecord[];
  warnings: string[];
}

type ResolvedWrite = { kind: 'update'; id: string; input: MappingInput } | { kind: 'create'; connectionId: string; input: MappingInput };

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

/** Serializes mappings to the YAML format shared by `gtr mapping-export` and the admin API. */
export function exportMappingsYaml(store: MappingStore, options: { connectionId?: string } = {}): string {
  const connections = store.listConnections();
  if (options.connectionId !== undefined && !connections.some((c) => c.id === options.connectionId)) {
    throw new GatewayError('NOT_FOUND', 'Connection not found', 404);
  }
  const connectionNames = new Map(connections.map((c) => [c.id, c.name]));
  const mappings = store
    .listMappings()
    .filter((m) => options.connectionId === undefined || m.connectionId === options.connectionId);
  return YAML.stringify(mappings.map((m) => mappingToYamlEntry(m, connectionNames.get(m.connectionId) ?? m.connectionId)));
}

/**
 * Validates every entry first, then applies all writes in one transaction — nothing is written if anything is
 * invalid or a write fails. Imported mappings become source=manual. Warnings are returned, not printed.
 */
export function importMappingsYaml(store: MappingStore, yamlText: string): MappingImportResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw invalid(`Invalid YAML: ${(err as Error).message}`);
  }
  const entries = parsed ?? [];
  if (!Array.isArray(entries)) throw invalid('The YAML document must be a list of mapping entries');

  const warnings: string[] = [];
  const connections = store.listConnections();
  const connectionIdsByName = new Map(connections.map((c) => [c.name, c.id]));
  const connectionNamesById = new Map(connections.map((c) => [c.id, c.name]));
  let flippedToManual = 0;

  // Pass 1: validate and resolve every entry without writing anything.
  const resolved: ResolvedWrite[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalid('Each YAML entry must be a mapping object');
    }
    const entry = raw as MappingYamlEntry;
    if (entry.id) {
      const existing = store.getMapping(entry.id);
      if (!existing) throw invalid(`No mapping with id ${entry.id} to update (from YAML import)`);
      if (existing.source === 'generated') flippedToManual += 1;
      if (entry.connection !== connectionNamesById.get(existing.connectionId)) {
        warnings.push(`Ignoring "connection" on mapping ${entry.id}: an existing mapping's connection cannot be changed by import`);
      }
      resolved.push({ kind: 'update', id: entry.id, input: toInput(entry, '') });
      continue;
    }
    const connectionId = connectionIdsByName.get(entry.connection);
    if (!connectionId) throw invalid(`No connection named "${entry.connection}" (from YAML import)`);
    resolved.push({ kind: 'create', connectionId, input: toInput(entry, connectionId) });
  }

  // Pass 2: one transaction, so a failure pass 1 cannot anticipate (a UNIQUE(method, route) collision) rolls everything back.
  let records: MappingRecord[];
  try {
    records = store.transaction(() => applyWrites(store, resolved));
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new GatewayError('CONFLICT', `Import conflicts with an existing mapping: ${(err as Error).message}`, 409);
    }
    throw err;
  }
  if (flippedToManual > 0) {
    warnings.push(`${flippedToManual} generated mapping(s) are now source=manual and will be skipped by regeneration unless forced`);
  }
  return { records, warnings };
}

function toInput(entry: MappingYamlEntry, connectionId: string): MappingInput {
  try {
    return yamlEntryToMappingInput(entry, connectionId);
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw invalid((err as Error).message);
  }
}

function applyWrites(store: MappingStore, resolved: ResolvedWrite[]): MappingRecord[] {
  const results: MappingRecord[] = [];
  for (const item of resolved) {
    if (item.kind === 'update') {
      const updated = store.updateMapping(item.id, {
        route: item.input.route,
        method: item.input.method,
        operation: item.input.operation,
        responseTemplate: item.input.responseTemplate,
        source: 'manual',
      });
      if (!updated) throw invalid(`No mapping with id ${item.id} to update (from YAML import)`);
      results.push(updated);
      continue;
    }
    results.push(
      store.createMapping({
        connectionId: item.connectionId,
        route: item.input.route,
        method: item.input.method,
        operation: item.input.operation,
        responseTemplate: item.input.responseTemplate,
        source: 'manual',
      })
    );
  }
  return results;
}

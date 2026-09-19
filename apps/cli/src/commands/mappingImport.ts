import fs from 'node:fs';
import YAML from 'yaml';
import type { MappingStore, MappingRecord, MappingYamlEntry, MappingInput } from '@graphtorest/core';
import { yamlEntryToMappingInput } from '@graphtorest/core';

type ResolvedWrite = { kind: 'update'; id: string; input: MappingInput } | { kind: 'create'; connectionId: string; input: MappingInput };

export function mappingImport(store: MappingStore, args: { file: string; warn?: (message: string) => void }): MappingRecord[] {
  const warn = args.warn ?? ((message: string) => console.warn(message));
  const text = fs.readFileSync(args.file, 'utf8');
  const entries = (YAML.parse(text) ?? []) as MappingYamlEntry[];
  const connections = store.listConnections();
  const connectionIdsByName = new Map(connections.map((c) => [c.name, c.id]));
  const connectionNamesById = new Map(connections.map((c) => [c.id, c.name]));
  let flippedToManual = 0;

  // Pass 1: validate and resolve every entry without writing anything to the store.
  // If any entry is invalid, we throw here and nothing has been persisted yet.
  const resolved: ResolvedWrite[] = [];
  for (const entry of entries) {
    if (entry.id) {
      const existing = store.getMapping(entry.id);
      if (!existing) {
        throw new Error(`No mapping with id ${entry.id} to update (from YAML import)`);
      }
      if (existing.source === 'generated') flippedToManual += 1;
      if (entry.connection !== connectionNamesById.get(existing.connectionId)) {
        warn(`Ignoring "connection" on mapping ${entry.id}: an existing mapping's connection cannot be changed by import`);
      }
      const input = yamlEntryToMappingInput(entry, '');
      resolved.push({ kind: 'update', id: entry.id, input });
      continue;
    }

    const connectionId = connectionIdsByName.get(entry.connection);
    if (!connectionId) {
      throw new Error(`No connection named "${entry.connection}" (from YAML import)`);
    }
    const input = yamlEntryToMappingInput(entry, connectionId);
    resolved.push({ kind: 'create', connectionId, input });
  }

  // Pass 2: all entries validated successfully — now perform the writes in one transaction, so a
  // failure pass 1 can't anticipate (e.g. a UNIQUE(method, route) collision) rolls everything back.
  const results = store.transaction(() => applyWrites(store, resolved));
  if (flippedToManual > 0) {
    warn(`${flippedToManual} generated mapping(s) are now source=manual and will be skipped by regeneration unless forced`);
  }
  return results;
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
      if (!updated) {
        throw new Error(`No mapping with id ${item.id} to update (from YAML import)`);
      }
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

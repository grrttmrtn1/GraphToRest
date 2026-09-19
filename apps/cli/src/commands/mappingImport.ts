import fs from 'node:fs';
import YAML from 'yaml';
import type { MappingStore, MappingRecord, MappingYamlEntry, MappingInput } from '@graphtorest/core';
import { yamlEntryToMappingInput } from '@graphtorest/core';

type ResolvedWrite = { kind: 'update'; id: string; input: MappingInput } | { kind: 'create'; connectionId: string; input: MappingInput };

export function mappingImport(store: MappingStore, args: { file: string }): MappingRecord[] {
  const text = fs.readFileSync(args.file, 'utf8');
  const entries = (YAML.parse(text) ?? []) as MappingYamlEntry[];
  const connectionIdsByName = new Map(store.listConnections().map((c) => [c.name, c.id]));

  // Pass 1: validate and resolve every entry without writing anything to the store.
  // If any entry is invalid, we throw here and nothing has been persisted yet.
  const resolved: ResolvedWrite[] = [];
  for (const entry of entries) {
    if (entry.id) {
      if (!store.getMapping(entry.id)) {
        throw new Error(`No mapping with id ${entry.id} to update (from YAML import)`);
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

  // Pass 2: all entries validated successfully — now perform the writes.
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

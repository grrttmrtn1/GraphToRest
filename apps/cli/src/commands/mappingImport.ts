import fs from 'node:fs';
import YAML from 'yaml';
import type { MappingStore, MappingRecord, MappingYamlEntry } from '@graphtorest/core';
import { yamlEntryToMappingInput } from '@graphtorest/core';

export function mappingImport(store: MappingStore, args: { file: string }): MappingRecord[] {
  const text = fs.readFileSync(args.file, 'utf8');
  const entries = (YAML.parse(text) ?? []) as MappingYamlEntry[];
  const connectionIdsByName = new Map(store.listConnections().map((c) => [c.name, c.id]));

  const results: MappingRecord[] = [];
  for (const entry of entries) {
    if (entry.id) {
      const input = yamlEntryToMappingInput(entry, '');
      const updated = store.updateMapping(entry.id, {
        route: input.route,
        method: input.method,
        operation: input.operation,
        responseTemplate: input.responseTemplate,
        source: 'manual',
      });
      if (!updated) {
        throw new Error(`No mapping with id ${entry.id} to update (from YAML import)`);
      }
      results.push(updated);
      continue;
    }

    const connectionId = connectionIdsByName.get(entry.connection);
    if (!connectionId) {
      throw new Error(`No connection named "${entry.connection}" (from YAML import)`);
    }
    const input = yamlEntryToMappingInput(entry, connectionId);
    results.push(
      store.createMapping({
        connectionId,
        route: input.route,
        method: input.method,
        operation: input.operation,
        responseTemplate: input.responseTemplate,
        source: 'manual',
      })
    );
  }
  return results;
}

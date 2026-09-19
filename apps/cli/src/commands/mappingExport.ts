import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { MappingStore } from '@graphtorest/core';
import { mappingToYamlEntry } from '@graphtorest/core';

export function mappingExport(store: MappingStore, args: { outFile?: string }): string {
  const connectionNames = new Map(store.listConnections().map((c) => [c.id, c.name]));
  const entries = store.listMappings().map((m) => mappingToYamlEntry(m, connectionNames.get(m.connectionId) ?? m.connectionId));
  const yamlText = YAML.stringify(entries);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    const tempFile = `${args.outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, yamlText, 'utf8');
    fs.renameSync(tempFile, args.outFile);
  }
  return yamlText;
}

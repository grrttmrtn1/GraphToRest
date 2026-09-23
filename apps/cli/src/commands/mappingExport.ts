import fs from 'node:fs';
import path from 'node:path';
import { exportMappingsYaml, type MappingStore } from '@graphtorest/core';

export function mappingExport(store: MappingStore, args: { outFile?: string }): string {
  const yamlText = exportMappingsYaml(store);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    const tempFile = `${args.outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, yamlText, 'utf8');
    fs.renameSync(tempFile, args.outFile);
  }
  return yamlText;
}

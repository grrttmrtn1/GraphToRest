import fs from 'node:fs';
import { importMappingsYaml, type MappingRecord, type MappingStore } from '@graphtorest/core';

export function mappingImport(store: MappingStore, args: { file: string; warn?: (message: string) => void }): MappingRecord[] {
  const warn = args.warn ?? ((message: string) => console.warn(message));
  const { records, warnings } = importMappingsYaml(store, fs.readFileSync(args.file, 'utf8'));
  for (const warning of warnings) warn(warning);
  return records;
}

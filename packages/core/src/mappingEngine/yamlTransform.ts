import type { MappingRecord } from '../storage/MappingStore';
import { parseRouteString } from './routeString';

export interface MappingYamlEntry {
  id?: string;
  route: string;
  connection: string;
  source: 'generated' | 'manual';
  operation: Record<string, unknown>;
  response: { shape: 'passthrough' | 'template'; template?: Record<string, string> };
  auth: string;
}

export interface MappingInput {
  id?: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
}

export function mappingToYamlEntry(mapping: MappingRecord, connectionName: string): MappingYamlEntry {
  return {
    id: mapping.id,
    route: `${mapping.method} ${mapping.route}`,
    connection: connectionName,
    source: mapping.source,
    operation: mapping.operation,
    response: mapping.responseTemplate ? { shape: 'template', template: mapping.responseTemplate } : { shape: 'passthrough' },
    auth: 'inherit',
  };
}

export function yamlEntryToMappingInput(entry: MappingYamlEntry, connectionId: string): MappingInput {
  if (entry.auth !== 'inherit') {
    throw new Error(`Unsupported auth mode "${entry.auth}" on mapping "${entry.route}" — auth overrides require managed-auth support (Plan 5)`);
  }
  const { method, route } = parseRouteString(entry.route);
  const { operation, response } = entry;
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    throw new Error(`Mapping "${entry.route}" is missing an "operation" object`);
  }
  if (typeof response !== 'object' || response === null || (response.shape !== 'passthrough' && response.shape !== 'template')) {
    throw new Error(`Mapping "${entry.route}" needs a "response" with shape "passthrough" or "template"`);
  }
  if (response.shape === 'template') {
    const template = response.template;
    const valid =
      typeof template === 'object' && template !== null && !Array.isArray(template) && Object.values(template).every((v) => typeof v === 'string');
    if (!valid) {
      throw new Error(`Mapping "${entry.route}" has response shape "template" but no valid string-to-string "template" map`);
    }
  }
  return {
    id: entry.id,
    connectionId,
    route,
    method,
    operation,
    responseTemplate: response.shape === 'template' ? (response.template ?? null) : null,
  };
}

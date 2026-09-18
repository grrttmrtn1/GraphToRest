import type { MappingRecord } from '../storage/MappingStore';

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
  return {
    id: entry.id,
    connectionId,
    route,
    method,
    operation: entry.operation,
    responseTemplate: entry.response.shape === 'template' ? (entry.response.template ?? null) : null,
  };
}

function parseRouteString(combined: string): { method: string; route: string } {
  const [method, ...rest] = combined.trim().split(/\s+/);
  return { method: method.toUpperCase(), route: rest.join(' ') };
}

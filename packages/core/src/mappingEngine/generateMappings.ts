import type { AuthContext, MappingDraft } from '../adapters/Adapter';
import { createAdapter } from '../adapters/registry';
import type { ConnectionRecord, MappingRecord, MappingStore } from '../storage/MappingStore';

export interface GenerationResult {
  created: MappingRecord[];
  updated: MappingRecord[];
  skipped: MappingDraft[];
  conflicts: MappingDraft[];
}

export async function generateAndPersistMappings(
  store: MappingStore,
  connection: ConnectionRecord,
  authContext: AuthContext,
  options: { force?: boolean } = {}
): Promise<GenerationResult> {
  const adapter = createAdapter(connection.adapterType);
  const introspection = await adapter.introspect(authContext);
  const drafts = await adapter.generateMappings(introspection);

  const created: MappingRecord[] = [];
  const updated: MappingRecord[] = [];
  const skipped: MappingDraft[] = [];
  const conflicts: MappingDraft[] = [];

  for (const draft of drafts) {
    const existing = store.getMappingByRouteAndMethod(draft.method, draft.route);

    if (existing && existing.connectionId !== connection.id) {
      conflicts.push(draft);
      continue;
    }

    if (!existing) {
      created.push(
        store.createMapping({
          connectionId: connection.id,
          route: draft.route,
          method: draft.method,
          operation: draft.operation,
          responseTemplate: draft.responseTemplate ?? null,
          source: 'generated',
        })
      );
      continue;
    }

    if (existing.source === 'manual' && !options.force) {
      skipped.push(draft);
      continue;
    }

    const result = store.updateMapping(existing.id, {
      route: draft.route,
      method: draft.method,
      operation: draft.operation,
      responseTemplate: draft.responseTemplate ?? null,
      source: 'generated',
    });
    if (result) updated.push(result);
  }

  return { created, updated, skipped, conflicts };
}

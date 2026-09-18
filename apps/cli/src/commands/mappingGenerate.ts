import type { MappingStore, GenerationResult } from '@graphtorest/core';
import { generateAndPersistMappings } from '@graphtorest/core';

export async function mappingGenerate(
  store: MappingStore,
  args: { connectionId: string; vendorToken?: string; force?: boolean }
): Promise<GenerationResult> {
  const connection = store.getConnection(args.connectionId);
  if (!connection) {
    throw new Error(`No connection with id ${args.connectionId}`);
  }
  return generateAndPersistMappings(
    store,
    connection,
    { connectionId: connection.id, authMode: connection.authMode, config: connection.config, vendorToken: args.vendorToken },
    { force: args.force }
  );
}

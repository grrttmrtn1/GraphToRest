import type { MappingStore, GenerationResult, AccessTokenProvider } from '@graphtorest/core';
import { generateAndPersistMappings, buildAuthContext } from '@graphtorest/core';

export async function mappingGenerate(
  store: MappingStore,
  args: { connectionId: string; vendorToken?: string; force?: boolean; tokenProvider?: AccessTokenProvider }
): Promise<GenerationResult> {
  const connection = store.getConnection(args.connectionId);
  if (!connection) {
    throw new Error(`No connection with id ${args.connectionId}`);
  }
  const authContext = await buildAuthContext(connection, args.vendorToken, args.tokenProvider);
  return generateAndPersistMappings(store, connection, authContext, { force: args.force });
}

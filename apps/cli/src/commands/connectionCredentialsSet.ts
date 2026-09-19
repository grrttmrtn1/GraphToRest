import type { MappingStore, ManagedTokenService, CredentialStatus } from '@graphtorest/core';

export function connectionCredentialsSet(
  store: MappingStore,
  managedAuth: ManagedTokenService | undefined,
  args: { connectionId: string; credentials: unknown }
): CredentialStatus {
  if (!managedAuth) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set to store managed credentials');
  }
  const connection = store.getConnection(args.connectionId);
  if (!connection) throw new Error(`No connection with id ${args.connectionId}`);
  if (connection.authMode !== 'managed') {
    throw new Error(`Connection "${connection.name}" has authMode "${connection.authMode}"; credentials can only be stored for authMode "managed"`);
  }
  return managedAuth.saveCredentials(connection, args.credentials);
}

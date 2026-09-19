import type { AuthContext } from '../adapters/Adapter';
import type { ConnectionRecord } from '../storage/MappingStore';
import { GatewayError } from '../gateway/errors';
import type { AccessTokenProvider } from './managedTokenService';

/**
 * The single place that decides which vendor token an adapter call carries:
 * passthrough forwards the developer's `X-Vendor-Token`; managed ignores it and uses the proxy-held token.
 */
export async function buildAuthContext(
  connection: ConnectionRecord,
  incomingVendorToken: string | undefined,
  tokenProvider?: AccessTokenProvider
): Promise<AuthContext> {
  const context: AuthContext = { connectionId: connection.id, authMode: connection.authMode, config: connection.config };
  if (connection.authMode !== 'managed') {
    return { ...context, vendorToken: incomingVendorToken };
  }
  if (!tokenProvider) {
    throw new GatewayError('MANAGED_AUTH_UNAVAILABLE', 'Managed auth requires CREDENTIAL_ENCRYPTION_KEY to be configured on the server', 503);
  }
  return { ...context, vendorToken: await tokenProvider.getAccessToken(connection) };
}

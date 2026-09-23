import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
} from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';

registerDefaultAdapters();
const config = loadConfig();
const db = openDb(config.dbPath);
const mappingStore = new MappingStore(db);
const managedAuth = config.credentialEncryptionKey
  ? new ManagedTokenService(mappingStore, new CredentialCipher(config.credentialEncryptionKey))
  : undefined;
const gatewayEngine = new GatewayEngine(mappingStore, managedAuth);
const openApiGenerator = new OpenApiGenerator();

const app = createApp({
  mappingStore,
  gatewayEngine,
  openApiGenerator,
  apiEnabled: config.apiEnabled,
  adminEnabled: config.adminEnabled,
  managedAuth,
  publicBaseUrl: config.publicBaseUrl,
  activityRetention: config.activityRetention,
});

if (!managedAuth) {
  console.warn(
    JSON.stringify({
      msg: 'managed_auth_disabled',
      warning: 'CREDENTIAL_ENCRYPTION_KEY is not set; connections with authMode "managed" cannot be used.',
    })
  );
}

if (config.adminEnabled && mappingStore.countAdminUsers() === 0) {
  console.warn(
    JSON.stringify({
      msg: 'no_admin_users',
      warning:
        'No admin users exist, so /admin/* cannot be used. Create one with: gtr admin-create --username <name> (password via --password or GTR_ADMIN_PASSWORD, 12+ characters)',
    })
  );
}

app.listen(config.port, () => {
  console.log(JSON.stringify({ msg: 'server_started', port: config.port, dbPath: config.dbPath }));
});

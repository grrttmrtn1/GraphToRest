import fs from 'node:fs';
import path from 'node:path';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
  createLogger,
} from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';

registerDefaultAdapters();
const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const db = openDb(config.dbPath);
const mappingStore = new MappingStore(db);
const managedAuth = config.credentialEncryptionKey
  ? new ManagedTokenService(mappingStore, new CredentialCipher(config.credentialEncryptionKey))
  : undefined;
const gatewayEngine = new GatewayEngine(mappingStore, managedAuth);
const openApiGenerator = new OpenApiGenerator();

// apps/server/dist/index.js → apps/web/dist (same layout in the Docker image).
const webDist = path.resolve(__dirname, '../../web/dist');
const webRoot = config.webEnabled && fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;

const app = createApp({
  mappingStore,
  gatewayEngine,
  openApiGenerator,
  apiEnabled: config.apiEnabled,
  adminEnabled: config.adminEnabled,
  managedAuth,
  publicBaseUrl: config.publicBaseUrl,
  activityRetention: config.activityRetention,
  webRoot,
  logger,
});

if (!managedAuth) {
  logger.warn('managed_auth_disabled', {
    warning: 'CREDENTIAL_ENCRYPTION_KEY is not set; connections with authMode "managed" cannot be used.',
  });
}

if (config.adminEnabled && mappingStore.countAdminUsers() === 0) {
  logger.warn('no_admin_users', {
    warning:
      'No admin users exist, so /admin/* cannot be used. Create one with: gtr admin create --username <name> (password via --password or GTR_ADMIN_PASSWORD, 12+ characters)',
  });
}

if (config.webEnabled && !webRoot) {
  logger.warn('web_ui_unavailable', { warning: `No built web UI found at ${webDist}; serving the API and admin API only.` });
}

app.listen(config.port, () => {
  logger.info('server_started', { port: config.port, dbPath: config.dbPath });
});

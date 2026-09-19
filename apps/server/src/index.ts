import { openDb, MappingStore, GatewayEngine, OpenApiGenerator, registerDefaultAdapters } from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';

registerDefaultAdapters();
const config = loadConfig();
const db = openDb(config.dbPath);
const mappingStore = new MappingStore(db);
const gatewayEngine = new GatewayEngine(mappingStore);
const openApiGenerator = new OpenApiGenerator();

const app = createApp({
  mappingStore,
  gatewayEngine,
  openApiGenerator,
  apiEnabled: config.apiEnabled,
  adminEnabled: config.adminEnabled,
});

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

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

app.listen(config.port, () => {
  console.log(JSON.stringify({ msg: 'server_started', port: config.port, dbPath: config.dbPath }));
});

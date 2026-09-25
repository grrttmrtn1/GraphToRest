import fs from 'node:fs';
import path from 'node:path';
import {
  openDb,
  MappingStore,
  GatewayEngine,
  OpenApiGenerator,
  ManagedTokenService,
  CredentialCipher,
  ResponseCache,
  registerDefaultAdapters,
  createLogger,
  setOutboundPolicy,
  type Logger,
} from '@graphtorest/core';
import { loadConfig } from './config';
import { createApp } from './app';
import { RateLimiter } from './middleware/rateLimit';
import { LoginThrottle } from './middleware/loginThrottle';
import { ApiAuthThrottle } from './middleware/apiAuthThrottle';
import { createShutdown, installShutdownHandlers } from './shutdown';
import { bootstrapAdmin, wrapBootstrapError } from './bootstrap';

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'SQLITE_CANTOPEN', 'SQLITE_READONLY']);

function main(): void {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  setOutboundPolicy({ timeoutMs: config.outboundTimeoutMs, allowPrivateNetworkTargets: config.allowPrivateNetworkTargets });
  registerDefaultAdapters();

  const db = openDb(config.dbPath);
  const mappingStore = new MappingStore(db);
  try {
    bootstrapAdmin(mappingStore, config.bootstrapAdmin, logger);
  } catch (err) {
    throw wrapBootstrapError(err);
  }
  const managedAuth = config.credentialEncryptionKey
    ? new ManagedTokenService(mappingStore, new CredentialCipher(config.credentialEncryptionKey))
    : undefined;
  const responseCache = new ResponseCache({ maxEntries: config.cacheMaxEntries, maxTtlSeconds: config.cacheMaxTtlSeconds });
  const gatewayEngine = new GatewayEngine(mappingStore, managedAuth, responseCache);
  const rateLimiter = new RateLimiter({ defaultLimit: config.rateLimitDefault });
  const loginThrottle = new LoginThrottle();
  const apiAuthThrottle = new ApiAuthThrottle({ failuresPerMinute: config.apiAuthFailuresPerMinute });

  // apps/server/dist/index.js → apps/web/dist (same layout in the Docker image).
  const webDist = path.resolve(__dirname, '../../web/dist');
  const webRoot = config.webEnabled && fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined;

  const app = createApp({
    mappingStore,
    gatewayEngine,
    openApiGenerator: new OpenApiGenerator(),
    apiEnabled: config.apiEnabled,
    adminEnabled: config.adminEnabled,
    managedAuth,
    publicBaseUrl: config.publicBaseUrl,
    activityRetention: config.activityRetention,
    webRoot,
    logger,
    rateLimiter,
    loginThrottle,
    responseCache,
    trustProxy: config.trustProxy,
    apiAuthThrottle,
  });

  warnAboutConfiguration(config, mappingStore, logger, Boolean(managedAuth), webRoot, webDist);

  const server = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, dbPath: config.dbPath });
  });
  installShutdownHandlers(
    createShutdown({
      server,
      logger,
      cleanup: () => {
        rateLimiter.stop();
        loginThrottle.stop();
        apiAuthThrottle.stop();
        db.close();
      },
    })
  );
}

function warnAboutConfiguration(
  config: ReturnType<typeof loadConfig>,
  store: MappingStore,
  logger: Logger,
  managedAuthEnabled: boolean,
  webRoot: string | undefined,
  webDist: string
): void {
  if (!managedAuthEnabled) {
    logger.warn('managed_auth_disabled', {
      warning: 'CREDENTIAL_ENCRYPTION_KEY is not set; connections with authMode "managed" cannot be used.',
    });
  }
  if (config.adminEnabled && store.countAdminUsers() === 0) {
    logger.warn('no_admin_users', {
      warning:
        'No admin users exist, so /admin/* cannot be used. Set GTR_BOOTSTRAP_ADMIN_USERNAME and GTR_BOOTSTRAP_ADMIN_PASSWORD and restart, or run: gtr admin create --username <name> (password via --password or GTR_ADMIN_PASSWORD, 12+ characters)',
    });
  }
  if (config.webEnabled && !webRoot) {
    logger.warn('web_ui_unavailable', { warning: `No built web UI found at ${webDist}; serving the API and admin API only.` });
  }
}

try {
  main();
} catch (err) {
  // Config may be what failed, so report with a default logger.
  const code = (err as { code?: unknown })?.code;
  createLogger().error('startup_failed', {
    message: err instanceof Error ? err.message : String(err),
    ...(typeof code === 'string' && PERMISSION_CODES.has(code)
      ? {
          hint:
            'The database path is not writable by this user. The image runs as the unprivileged "node" user; if the volume was created by an older image that ran as root, fix ownership once with: docker compose run --rm --user root --entrypoint chown graphtorest -R node:node /data',
        }
      : {}),
  });
  process.exit(1);
}

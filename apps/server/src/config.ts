export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
  credentialEncryptionKey?: string;
  publicBaseUrl: string;
  activityRetention: number;
  webEnabled: boolean;
}

function parseActivityRetention(value: string | undefined): number {
  if (value === undefined || value === '') return 1000;
  const retention = Number(value);
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error(`ACTIVITY_RETENTION must be a positive integer, got "${value}"`);
  }
  return retention;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    activityRetention: parseActivityRetention(env.ACTIVITY_RETENTION),
    webEnabled: env.WEB_ENABLED !== 'false',
  };
}

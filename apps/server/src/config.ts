export interface ServerConfig {
  port: number;
  dbPath: string;
  apiEnabled: boolean;
  adminEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/graphtorest.db',
    apiEnabled: env.API_ENABLED !== 'false',
    adminEnabled: env.ADMIN_ENABLED !== 'false',
  };
}

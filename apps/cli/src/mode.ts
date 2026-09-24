import type { Profile } from './profile';
import { usageError } from './errors';

export interface GlobalOptions {
  server?: string;
  db?: string;
  json?: boolean;
}

export type ModeSource = '--server' | 'GTR_SERVER' | 'profile';

export type Mode =
  | { kind: 'embedded'; dbPath: string }
  | { kind: 'remote'; server: string; token: string | null; source: ModeSource };

export const DEFAULT_DB_PATH = './data/graphtorest.db';

export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`Invalid server URL "${raw}" (expected e.g. http://localhost:3000)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError(`Server URL must start with http:// or https://, got "${raw}"`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Remote only when configured (spec §3): --server > GTR_SERVER > saved profile > embedded. Never probes the network. */
export function resolveMode(globals: GlobalOptions, env: NodeJS.ProcessEnv, loadProfile: () => Profile | null): Mode {
  let remote: Extract<Mode, { kind: 'remote' }> | null = null;
  const explicit =
    globals.server !== undefined
      ? { raw: globals.server, source: '--server' as const }
      : env.GTR_SERVER
        ? { raw: env.GTR_SERVER, source: 'GTR_SERVER' as const }
        : null;

  if (explicit) {
    const server = normalizeServerUrl(explicit.raw);
    let token = env.GTR_TOKEN || null;
    if (!token) {
      const profile = loadProfile();
      if (profile && normalizeServerUrl(profile.server) === server) token = profile.token;
    }
    remote = { kind: 'remote', server, token, source: explicit.source };
  } else {
    const profile = loadProfile();
    if (profile) remote = { kind: 'remote', server: normalizeServerUrl(profile.server), token: profile.token, source: 'profile' };
  }

  if (remote) {
    if (globals.db !== undefined) {
      throw usageError(
        `--db cannot be combined with remote mode (server configured via ${remote.source}); run "gtr logout" or drop --db`
      );
    }
    return remote;
  }
  return { kind: 'embedded', dbPath: globals.db ?? (env.DB_PATH || DEFAULT_DB_PATH) };
}

import { GatewayError, type Logger, type MappingStore } from '@graphtorest/core';

/** Creates the first admin from GTR_BOOTSTRAP_ADMIN_* when no admin exists yet; a no-op afterwards. */
export function bootstrapAdmin(
  store: MappingStore,
  bootstrap: { username: string; password: string } | null,
  logger: Logger
): 'created' | 'skipped' | 'not-configured' {
  if (!bootstrap) return 'not-configured';
  if (store.countAdminUsers() > 0) {
    logger.info('bootstrap_admin_skipped', { reason: 'admin users already exist; GTR_BOOTSTRAP_ADMIN_* can be removed' });
    return 'skipped';
  }
  const user = store.createAdminUser(bootstrap); // validates username and password (12–1024 characters)
  logger.info('bootstrap_admin_created', { username: user.username });
  return 'created';
}

/**
 * `bootstrapAdmin` failures are surfaced at startup with a message naming the env vars, but only when the failure
 * is actually a rejected username/password: an unrelated failure (a SQLite error such as SQLITE_READONLY, for
 * example) must not be mislabeled as "the password was rejected", and must keep its `.code` so the startup
 * handler's permission hint still fires.
 */
export function wrapBootstrapError(err: unknown): unknown {
  if (err instanceof GatewayError && err.code === 'INVALID_INPUT') {
    return new GatewayError(
      err.code,
      `GTR_BOOTSTRAP_ADMIN_USERNAME or GTR_BOOTSTRAP_ADMIN_PASSWORD was rejected: ${err.message}`,
      err.status,
      err.details
    );
  }
  return err;
}

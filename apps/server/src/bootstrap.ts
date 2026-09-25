import type { Logger, MappingStore } from '@graphtorest/core';

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

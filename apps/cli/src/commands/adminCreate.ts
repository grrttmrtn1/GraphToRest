import type { MappingStore, AdminUserRecord } from '@graphtorest/core';

export function adminCreate(store: MappingStore, args: { username: string; password: string }): AdminUserRecord {
  return store.createAdminUser(args);
}

export function adminSetPassword(store: MappingStore, args: { username: string; password: string }): void {
  if (!store.setAdminPassword(args.username, args.password)) {
    throw new Error(`No admin user named "${args.username}"`);
  }
}

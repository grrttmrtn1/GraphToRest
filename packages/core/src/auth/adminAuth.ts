import { DUMMY_SECRET_HASH, verifySecret } from './apiKeys';
import type { MappingStore } from '../storage/MappingStore';

export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_PASSWORD_LENGTH = 1024;

export async function loginAdmin(
  store: MappingStore,
  username: string,
  password: string,
  ttlMs: number = DEFAULT_ADMIN_SESSION_TTL_MS
): Promise<{ token: string; expiresAt: string } | null> {
  if (password.length > MAX_PASSWORD_LENGTH) return null; // never hash attacker-sized input
  const user = store.findAdminUserByUsername(username);
  // Unknown usernames verify against a dummy hash so "no such user" and "wrong password" cost the same.
  const passwordOk = await verifySecret(password, user ? user.hashedPassword : DUMMY_SECRET_HASH);
  if (!user || !passwordOk) return null;
  return store.createAdminSession(user.id, ttlMs);
}

import { hashSecret, verifySecret } from './apiKeys';
import type { MappingStore } from '../storage/MappingStore';

export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Verified against when the username is unknown so that "no such user" and "wrong password" cost the same.
const DUMMY_HASH = hashSecret('graphtorest-dummy-password');

export function loginAdmin(
  store: MappingStore,
  username: string,
  password: string,
  ttlMs: number = DEFAULT_ADMIN_SESSION_TTL_MS
): { token: string; expiresAt: string } | null {
  const user = store.findAdminUserByUsername(username);
  const passwordOk = verifySecret(password, user ? user.hashedPassword : DUMMY_HASH);
  if (!user || !passwordOk) return null;
  return store.createAdminSession(user.id, ttlMs);
}

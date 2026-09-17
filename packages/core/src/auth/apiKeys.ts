import crypto from 'node:crypto';

export interface GeneratedApiKey {
  id: string;
  plaintext: string;
  hashedSecret: string;
}

export function generateApiKey(): GeneratedApiKey {
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const hashedSecret = hashSecret(secret);
  return { id, plaintext: `${id}.${secret}`, hashedSecret };
}

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(secret: string, hashedSecret: string): boolean {
  const [salt, storedHex] = hashedSecret.split(':');
  if (!salt || !storedHex) return false;
  const derived = crypto.scryptSync(secret, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

export function parsePresentedKey(presented: string): { id: string; secret: string } | null {
  const idx = presented.indexOf('.');
  if (idx === -1) return null;
  return { id: presented.slice(0, idx), secret: presented.slice(idx + 1) };
}

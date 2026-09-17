import { describe, it, expect } from 'vitest';
import { generateApiKey, verifySecret, parsePresentedKey } from '../../src/auth/apiKeys';

describe('apiKeys', () => {
  it('generates a plaintext key in the form "<id>.<secret>"', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^[0-9a-f]{12}\.[A-Za-z0-9_-]+$/);
    expect(key.plaintext.startsWith(key.id + '.')).toBe(true);
  });

  it('verifies the correct secret against the stored hash', () => {
    const key = generateApiKey();
    const parsed = parsePresentedKey(key.plaintext);
    expect(parsed).not.toBeNull();
    expect(verifySecret(parsed!.secret, key.hashedSecret)).toBe(true);
  });

  it('rejects an incorrect secret', () => {
    const key = generateApiKey();
    expect(verifySecret('wrong-secret', key.hashedSecret)).toBe(false);
  });

  it('returns null for a presented key with no separator', () => {
    expect(parsePresentedKey('not-a-valid-key')).toBeNull();
  });
});

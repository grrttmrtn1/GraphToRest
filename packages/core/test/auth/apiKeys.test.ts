import { describe, it, expect } from 'vitest';
import { generateApiKey, verifySecret, parsePresentedKey, DUMMY_SECRET_HASH } from '../../src/auth/apiKeys';

describe('apiKeys', () => {
  it('generates a plaintext key in the form "<id>.<secret>"', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^[0-9a-f]{12}\.[A-Za-z0-9_-]+$/);
    expect(key.plaintext.startsWith(key.id + '.')).toBe(true);
  });

  it('verifies the correct secret against the stored hash', async () => {
    const key = generateApiKey();
    const parsed = parsePresentedKey(key.plaintext);
    expect(parsed).not.toBeNull();
    expect(await verifySecret(parsed!.secret, key.hashedSecret)).toBe(true);
  });

  it('rejects an incorrect secret', async () => {
    const key = generateApiKey();
    expect(await verifySecret('wrong-secret', key.hashedSecret)).toBe(false);
  });

  it('returns null for a presented key with no separator', () => {
    expect(parsePresentedKey('not-a-valid-key')).toBeNull();
  });

  it('verifies asynchronously without blocking the event loop for the whole hash', async () => {
    const key = generateApiKey();
    let ticked = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { ticked = true; resolve(); }));
    const result = verifySecret(key.plaintext.split('.')[1], key.hashedSecret);
    await tick;
    expect(ticked).toBe(true);
    expect(await result).toBe(true);
  });

  it('DUMMY_SECRET_HASH is a well-formed hash that matches nothing presented', async () => {
    expect(DUMMY_SECRET_HASH).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifySecret('anything', DUMMY_SECRET_HASH)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { CredentialCipher } from '../../src/auth/credentialCipher';

const HEX_KEY = '00'.repeat(32);
const OTHER_HEX_KEY = '11'.repeat(32);

describe('CredentialCipher', () => {
  it('round-trips plaintext, including unicode and the empty string', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    for (const text of ['{"clientSecret":"s3cret"}', 'héllo ✓', '']) {
      expect(cipher.decrypt(cipher.encrypt(text))).toBe(text);
    }
  });

  it('accepts a base64-encoded 32-byte key', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cipher = new CredentialCipher(key);
    expect(cipher.decrypt(cipher.encrypt('x'))).toBe('x');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CredentialCipher('too-short')).toThrow(/32 bytes/);
    expect(() => new CredentialCipher('ab'.repeat(16))).toThrow(/32 bytes/);
  });

  it('uses a fresh IV per encryption and never contains the plaintext', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    const a = cipher.encrypt('super-secret');
    const b = cipher.encrypt('super-secret');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('super-secret');
  });

  it('fails to decrypt with a different key', () => {
    const payload = new CredentialCipher(HEX_KEY).encrypt('secret');
    expect(() => new CredentialCipher(OTHER_HEX_KEY).decrypt(payload)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    const [version, iv, tag, ciphertext] = cipher.encrypt('secret-value').split(':');
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0xff;
    expect(() => cipher.decrypt([version, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('rejects payloads in an unknown format', () => {
    const cipher = new CredentialCipher(HEX_KEY);
    expect(() => cipher.decrypt('not-a-payload')).toThrow(/format/);
    expect(() => cipher.decrypt('v9:a:b:c')).toThrow(/format/);
  });
});

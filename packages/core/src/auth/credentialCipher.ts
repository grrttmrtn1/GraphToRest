import crypto from 'node:crypto';

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function parseKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, encoded as 64 hex characters or as base64');
}

/** AES-256-GCM. Payload: `v1:<iv>:<auth tag>:<ciphertext>`, each part base64. */
export class CredentialCipher {
  private key: Buffer;

  constructor(keyMaterial: string) {
    this.key = parseKey(keyMaterial);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivPart, tagPart, ciphertext] = payload.split(':');
    if (version !== VERSION || !ivPart || !tagPart || ciphertext === undefined) {
      throw new Error('Unrecognized credential payload format');
    }
    const iv = Buffer.from(ivPart, 'base64');
    const tag = Buffer.from(tagPart, 'base64');
    // GCM accepts truncated tags unless the length is pinned; a short tag weakens forgery resistance.
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error('Unrecognized credential payload format');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}

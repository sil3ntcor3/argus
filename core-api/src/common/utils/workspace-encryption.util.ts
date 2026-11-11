import { randomBytes } from 'crypto';
import {
  cbcOpen,
  decrypt,
  decryptBytesWithKek,
  encryptBytesWithKek,
  gcmOpen,
  gcmSeal,
  isEncryptedWithActiveKek,
  isUtf8,
  parseCiphertext,
} from './encryption.util';

const DEK_LENGTH = 32;
const DEK_KEY_ID = 'dek';

/** Reject invalid DEKs before wrapping or using them as AES-256 keys. */
function assertDEK(dek: Buffer): void {
  if (dek.length !== DEK_LENGTH) throw new Error('A workspace DEK must be 32 bytes');
}

/** Generate a random 256-bit Data Encryption Key for one workspace. */
export function generateDEK(): Buffer {
  return randomBytes(DEK_LENGTH);
}

/** Wrap a valid DEK under the active KEK using authenticated v2 encryption. */
export function wrapDEK(dek: Buffer): string {
  assertDEK(dek);
  return encryptBytesWithKek(dek);
}

/**
 * Unwrap every stored format and require exactly 32 plaintext bytes.
 * This shape check also filters wrong-key padding successes in legacy CBC.
 */
export function unwrapDEK(wrappedDEK: string): Buffer {
  return decryptBytesWithKek(wrappedDEK, (dek) => dek.length === DEK_LENGTH);
}

/** Encrypt workspace text as `v2:dek:<iv>:<tag>:<data>` with AES-256-GCM. */
export function encryptWithDEK(text: string, dek: Buffer): string {
  assertDEK(dek);
  return `v2:${DEK_KEY_ID}:${gcmSeal(dek, Buffer.from(text, 'utf8'))}`;
}

/**
 * Read authenticated DEK data, historical unprefixed CBC, or pre-envelope KEK
 * data. An authenticated DEK failure never falls back to another key or format.
 */
export function decryptWithDEK(encryptedText: string, dek: Buffer | null): string {
  const parsed = parseCiphertext(encryptedText);
  if (!parsed) throw new Error('Invalid encrypted data format');

  if (parsed.kind === 'v2' && parsed.keyId === DEK_KEY_ID) {
    if (dek === null) throw new Error('Workspace has no DEK to decrypt with');
    assertDEK(dek);
    const plain = gcmOpen(dek, parsed);
    if (!isUtf8(plain)) throw new Error('Invalid decrypted text');
    return plain.toString('utf8');
  }

  // Unprefixed CBC may belong to the DEK or to a pre-envelope KEK.
  if (parsed.kind === 'legacy' && dek !== null) {
    assertDEK(dek);
    const plain = cbcOpen(dek, parsed.iv, parsed.data);
    if (plain !== null && isUtf8(plain)) return plain.toString('utf8');
  }
  return decrypt(encryptedText);
}

/** Flag stored ciphertext that needs the current workspace format and key. */
export function needsReencryption(value: string, dek: Buffer | null): boolean {
  const parsed = parseCiphertext(value);
  if (!parsed) return false;
  return dek !== null
    ? parsed.kind !== 'v2' || parsed.keyId !== DEK_KEY_ID
    : !isEncryptedWithActiveKek(value);
}

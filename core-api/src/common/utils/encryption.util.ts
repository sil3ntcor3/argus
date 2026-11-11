import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { isLocalEnv } from '../config/runtime-env';
import { DEFAULT_ENCRYPTION_KEY } from '../constants/app.constants';

const GCM_IV_LENGTH = 12;
const MIN_ACTIVE_KEY_LENGTH = 32;
const KNOWN_WEAK_KEYS = new Set([
  DEFAULT_ENCRYPTION_KEY,
  'super_secret_key',
  'your-encryption-key-change-in-production',
  'change_me',
]);

export interface Kek {
  id: string;
  key: Buffer;
}

export type Ciphertext =
  | { kind: 'v2'; keyId: string; iv: string; tag: string; data: string }
  | { kind: 'v1'; index: number; iv: string; data: string }
  | { kind: 'legacy'; iv: string; data: string };

/** Parse the configured order; only its last key is used for new writes. */
const configuredKeys = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

/** Derive the historical AES key and a stable id independent of list order. */
const toKek = (raw: string): Kek => {
  const key = createHash('sha256').update(raw).digest();
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { id, key };
};

/**
 * Keep the original default decryptable after an operator configures keys.
 * It is only active when no key is configured, for local compatibility.
 */
function keyRing(): { keys: Kek[]; ring: Kek[] } {
  const configured = configuredKeys(process.env.ENCRYPTION_KEYS);
  const keys = (configured.length ? configured : [DEFAULT_ENCRYPTION_KEY]).map(
    toKek,
  );
  const fallback = toKek(DEFAULT_ENCRYPTION_KEY);
  const ring = keys.some((candidate) => candidate.id === fallback.id)
    ? keys
    : [...keys, fallback];
  return { keys, ring };
}

/** Configured SHA-256 keys in their historical order, with local fallback. */
export function parseEncryptionKeys(): Buffer[] {
  return keyRing().keys.map(({ key }) => key);
}

/** The last configured KEK encrypts new data; its id survives reordering. */
export function getActiveKek(): Kek {
  const { keys } = keyRing();
  return keys[keys.length - 1];
}

/** Retained for callers that need the raw active AES key. */
export function getActiveEncryptionKey(): Buffer {
  return getActiveKek().key;
}

/**
 * Refuse deployed startup without a sufficiently long, non-example active key.
 * Earlier keys remain usable for decrypting historical data, even if weak.
 */
export function assertEncryptionKeys(env: NodeJS.ProcessEnv = process.env): void {
  if (isLocalEnv(env)) return;
  const active = configuredKeys(env.ENCRYPTION_KEYS).at(-1);
  if (
    !active ||
    active.length < MIN_ACTIVE_KEY_LENGTH ||
    KNOWN_WEAK_KEYS.has(active)
  ) {
    throw new Error(
      `ENCRYPTION_KEYS must end with a random key of at least ${MIN_ACTIVE_KEY_LENGTH} characters (e.g. \`openssl rand -base64 32\`); it encrypts stored credentials. Append the new key after the current ones to retain access to stored data.`,
    );
  }
}

/** Validate complete bytes before Buffer.from can truncate malformed hex. */
const isHex = (value: string, length?: number): boolean =>
  /^[0-9a-f]*$/i.test(value) &&
  value.length % 2 === 0 &&
  (length === undefined || value.length === length);

/** Legacy CBC ciphertext always contains at least one complete padded block. */
const isCbcData = (value: string): boolean =>
  value.length > 0 && isHex(value) && value.length % 32 === 0;

/** Validate the byte fields shared by parsed values and direct GCM callers. */
const isGcmPayload = ({
  iv,
  tag,
  data,
}: {
  iv: string;
  tag: string;
  data: string;
}): boolean =>
  isHex(iv, GCM_IV_LENGTH * 2) && isHex(tag, 32) && isHex(data);

/**
 * Recognize v2 GCM, indexed CBC and unprefixed CBC storage formats.
 * Empty GCM data is valid: the tag authenticates an empty plaintext too.
 */
export function parseCiphertext(value: string): Ciphertext | null {
  const parts = value.split(':');
  if (parts.length === 5 && parts[0] === 'v2') {
    const [, keyId, iv, tag, data] = parts;
    if (
      (keyId === 'dek' || isHex(keyId, 16)) &&
      isGcmPayload({ iv, tag, data })
    ) {
      return { kind: 'v2', keyId: keyId.toLowerCase(), iv, tag, data };
    }
    return null;
  }
  if (parts.length === 3 && /^\d+$/.test(parts[0])) {
    const [index, iv, data] = parts;
    if (Number.isSafeInteger(Number(index)) && isHex(iv, 32) && isCbcData(data)) {
      return { kind: 'v1', index: Number(index), iv, data };
    }
    return null;
  }
  if (parts.length === 2 && isHex(parts[0], 32) && isCbcData(parts[1])) {
    return { kind: 'legacy', iv: parts[0], data: parts[1] };
  }
  return null;
}

/** Seal bytes with AES-256-GCM as `<iv>:<tag>:<data>`. */
export function gcmSeal(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

/** Authenticate before returning plaintext; malformed fields and wrong keys fail. */
export function gcmOpen(
  key: Buffer,
  payload: { iv: string; tag: string; data: string },
): Buffer {
  if (!isGcmPayload(payload)) throw new Error('Invalid AES-GCM data format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'hex')),
    decipher.final(),
  ]);
}

/**
 * Read historical CBC bytes; null on malformed data or padding failure.
 * CBC has no authentication: successful padding alone cannot identify a key.
 */
export function cbcOpen(key: Buffer, iv: string, data: string): Buffer | null {
  if (!isHex(iv, 32) || !isCbcData(data)) return null;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'hex')),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Reject malformed UTF-8 instead of silently replacing bytes in text secrets. */
export const isUtf8 = (bytes: Buffer): boolean => {
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** Encrypt bytes with the active KEK as `v2:<keyId>:<iv>:<tag>:<data>`. */
export function encryptBytesWithKek(plain: Buffer): string {
  const { id, key } = getActiveKek();
  return `v2:${id}:${gcmSeal(key, plain)}`;
}

/**
 * Read every stored KEK format. CBC prefers its historical index, then falls
 * back across remaining keys and the original default, checking plaintext
 * shape. Those checks reduce legacy ambiguity but cannot authenticate CBC.
 */
export function decryptBytesWithKek(
  value: string,
  accept: (plain: Buffer) => boolean,
): Buffer {
  const parsed = parseCiphertext(value);
  if (!parsed) throw new Error('Not an encrypted value');
  const { keys, ring } = keyRing();

  if (parsed.kind === 'v2') {
    const kek = ring.find((candidate) => candidate.id === parsed.keyId);
    if (!kek) {
      throw new Error(`No key in ENCRYPTION_KEYS matches key id ${parsed.keyId}`);
    }
    const plain = gcmOpen(kek.key, parsed);
    if (!accept(plain)) throw new Error('Invalid decrypted value');
    return plain;
  }

  const indexed = parsed.kind === 'v1' ? keys[parsed.index] : undefined;
  const candidates = indexed
    ? [indexed, ...ring.filter((candidate) => candidate !== indexed)]
    : ring;
  for (const { key } of candidates) {
    const plain = cbcOpen(key, parsed.iv, parsed.data);
    if (plain !== null && accept(plain)) return plain;
  }
  throw new Error(
    `Decryption failed with every key in ENCRYPTION_KEYS (${ring.length} tried)`,
  );
}

/** Whether a well-formed KEK ciphertext uses the active v2 key. */
export function isEncryptedWithActiveKek(value: string): boolean {
  const parsed = parseCiphertext(value);
  return parsed?.kind === 'v2' && parsed.keyId === getActiveKek().id;
}

/** Encrypt text with the active KEK; prefer encryptWithDEK for workspace data. */
export function encrypt(text: string): string {
  return encryptBytesWithKek(Buffer.from(text, 'utf8'));
}

/** Read text under a KEK in any stored format, preserving valid empty strings. */
export function decrypt(encryptedText: string): string {
  return decryptBytesWithKek(encryptedText, isUtf8).toString('utf8');
}

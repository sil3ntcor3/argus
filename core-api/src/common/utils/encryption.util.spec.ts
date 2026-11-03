import { createCipheriv, createHash } from 'crypto';
import { isLocalEnv } from '../config/runtime-env';
import {
  assertEncryptionKeys,
  cbcOpen,
  decrypt,
  encrypt,
  gcmOpen,
  gcmSeal,
  isEncryptedWithActiveKek,
  parseCiphertext,
} from './encryption.util';

const KEY_A = 'test-key-a-0123456789abcdef0123456789';
const KEY_B = 'test-key-b-0123456789abcdef0123456789';
const KEY_C = 'test-key-c-0123456789abcdef0123456789';

// Persisted by the original CBC writer, including its literal OASM default.
const LEGACY = {
  indexed:
    '1:aaca6092cfd8916b32838c345b375afc:9e1901b632e937e49552bf2b9da5bfcf',
  unprefixed:
    '83ac55cb24549a68b889017f50d7329d:b5f6c5b760db8624c7a77f8b427581c1',
  defaultKey:
    '0:7472865cf19da57693b332ad6a405837:bb2430d2c5e4bc780f4215272c57d68c',
};

/** Produce a deterministic fixture using the pre-upgrade storage format. */
function legacyEncrypt(text: string, rawKey = KEY_A): string {
  const key = createHash('sha256').update(rawKey).digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `0:${iv.toString('hex')}:${data.toString('hex')}`;
}

describe('encryption compatibility and authentication', () => {
  const original = process.env.ENCRYPTION_KEYS;

  beforeEach(() => {
    process.env.ENCRYPTION_KEYS = `${KEY_A},${KEY_B}`;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = original;
  });

  it('reads persisted CBC text after preceding keys are removed', () => {
    process.env.ENCRYPTION_KEYS = KEY_B;
    expect(decrypt(LEGACY.indexed)).toBe('beta-secret');
  });

  it('recovers text written with the shipped default after a real key is set', () => {
    process.env.ENCRYPTION_KEYS = KEY_C;
    expect(decrypt(LEGACY.defaultKey)).toBe('gamma-secret');
  });

  it('reads unprefixed legacy ciphertext after keys move', () => {
    process.env.ENCRYPTION_KEYS = `${KEY_C},${KEY_A}`;
    expect(decrypt(LEGACY.unprefixed)).toBe('alpha-secret');
  });

  it.each(['', 'token', '密钥 🔑', '\u0000secret'])('preserves legacy text %p', (text) => {
    expect(decrypt(legacyEncrypt(text))).toBe(text);
  });

  it('writes authenticated ciphertext identified by a stable key id', () => {
    expect(encrypt('secret')).toMatch(/^v2:[0-9a-f]{16}:[0-9a-f]{24}:[0-9a-f]{32}:/);
  });

  it.each(['', 'token', '密钥 🔑'])('round-trips new text %p across key reordering', (text) => {
    const value = encrypt(text);
    process.env.ENCRYPTION_KEYS = `${KEY_B},${KEY_A},${KEY_C}`;
    expect(decrypt(value)).toBe(text);
  });

  it('rejects ciphertext once its encryption key is removed', () => {
    const value = encrypt('secret');
    process.env.ENCRYPTION_KEYS = KEY_C;
    expect(() => decrypt(value)).toThrow();
  });

  it('rejects a changed CBC IV instead of returning malformed UTF-8', () => {
    const parts = legacyEncrypt('secret').split(':');
    parts[1] = 'ff' + parts[1].slice(2);
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it.each(['z', '0'])('rejects a trailing non-byte suffix %p instead of truncating it', (suffix) => {
    expect(() => decrypt(legacyEncrypt('secret') + suffix)).toThrow();
  });

  it.each([1, 2, 3, 4])('rejects altered v2 field %i', (field) => {
    const parts = encrypt('secret').split(':');
    parts[field] = (parts[field].startsWith('00') ? 'ff' : '00') + parts[field].slice(2);
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it('rejects malformed v2 hex before crypto can silently truncate it', () => {
    const value = encrypt('secret');
    for (const malformed of [value + '0', value + 'zz', value + ':extra']) {
      expect(parseCiphertext(malformed)).toBeNull();
      expect(() => decrypt(malformed)).toThrow();
      expect(isEncryptedWithActiveKek(malformed)).toBe(false);
    }
  });

  it('requires a known v2 key-id shape and safe legacy index', () => {
    const value = encrypt('secret').split(':');
    value[1] = 'unknown';
    expect(parseCiphertext(value.join(':'))).toBeNull();
    const indexed = legacyEncrypt('secret').split(':');
    indexed[0] = '999999999999999999999999';
    expect(parseCiphertext(indexed.join(':'))).toBeNull();
  });

  it('checks exported crypto helpers against malformed byte representations', () => {
    const key = createHash('sha256').update(KEY_A).digest();
    const [iv, tag, data] = gcmSeal(key, Buffer.from('secret')).split(':');
    expect(gcmOpen(key, { iv, tag, data }).toString()).toBe('secret');
    expect(() => gcmOpen(key, { iv, tag, data: data + '0' })).toThrow();
    const [, legacyIv, legacyData] = legacyEncrypt('secret').split(':');
    expect(cbcOpen(key, legacyIv, legacyData + 'z')).toBeNull();
  });

  it('recognizes only development and test as local environments', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(isLocalEnv({ NODE_ENV })).toBe(true);
    }
    for (const NODE_ENV of [undefined, '', 'production', 'staging']) {
      expect(isLocalEnv({ NODE_ENV })).toBe(false);
    }
  });

  it('requires a non-example 32-character active key when deployed', () => {
    for (const ENCRYPTION_KEYS of [undefined, '', 'short', 'your-encryption-key-change-in-production']) {
      expect(() => assertEncryptionKeys({ ENCRYPTION_KEYS })).toThrow(/ENCRYPTION_KEYS/);
    }
    expect(() => assertEncryptionKeys({ ENCRYPTION_KEYS: `${KEY_A},short` })).toThrow();
    expect(() => assertEncryptionKeys({ ENCRYPTION_KEYS: `short,${KEY_A}` })).not.toThrow();
    expect(() => assertEncryptionKeys({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertEncryptionKeys({ NODE_ENV: 'development' })).not.toThrow();
  });
});

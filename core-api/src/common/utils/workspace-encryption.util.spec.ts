import { createCipheriv, createHash } from 'crypto';
import { encrypt, encryptBytesWithKek } from './encryption.util';
import {
  decryptWithDEK,
  encryptWithDEK,
  generateDEK,
  needsReencryption,
  unwrapDEK,
  wrapDEK,
} from './workspace-encryption.util';

const KEY_A = 'test-key-a-0123456789abcdef0123456789';
const KEY_B = 'test-key-b-0123456789abcdef0123456789';
const KEY_C = 'test-key-c-0123456789abcdef0123456789';
const DEK = Buffer.from(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  'hex',
);

// Persisted by the original CBC writer, with DEK above.
const LEGACY = {
  wrappedDek:
    '1:98a79a91505dd9bcb2b85dad560269df:c3afd692b4c64bdecff5c19adae9298f236ebaa50875b932ba591d7989c30075b1de06a0c771f06eca458f6e70b718ba',
  wrappedDefault:
    '0:bfcea2b5738109bf4c4bed606437580e:3d21bf876123177e9f78dff4c2d529e082e9a96901c8890d2091840a01d84942c3d07563dcda7bb452648f1eb1fc1b9b',
  data: '4c0a02b431f34b628b187cda30c6cc4d:00ad8a37d9fa3f546062738101964c2f',
};

/** Wrap arbitrary bytes using the legacy format to exercise DEK validation. */
function legacyWrap(bytes: Buffer): string {
  const key = createHash('sha256').update(KEY_A).digest();
  const iv = Buffer.alloc(16, 9);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return `0:${iv.toString('hex')}:${data.toString('hex')}`;
}

describe('workspace encryption compatibility and authentication', () => {
  const original = process.env.ENCRYPTION_KEYS;

  beforeEach(() => {
    process.env.ENCRYPTION_KEYS = `${KEY_A},${KEY_B}`;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEYS;
    else process.env.ENCRYPTION_KEYS = original;
  });

  it('generates a 32-byte DEK', () => {
    expect(generateDEK()).toHaveLength(32);
  });

  it('unwraps persisted CBC DEKs after preceding keys are removed', () => {
    process.env.ENCRYPTION_KEYS = KEY_B;
    expect(unwrapDEK(LEGACY.wrappedDek)).toEqual(DEK);
  });

  it('recovers DEKs wrapped with the shipped default after a real key is set', () => {
    process.env.ENCRYPTION_KEYS = KEY_C;
    expect(unwrapDEK(LEGACY.wrappedDefault)).toEqual(DEK);
  });

  it('reads persisted workspace CBC data', () => {
    expect(decryptWithDEK(LEGACY.data, DEK)).toBe('workspace-token');
  });

  it('writes authenticated wrapped DEKs', () => {
    const value = wrapDEK(DEK);
    expect(value).toMatch(/^v2:[0-9a-f]{16}:/);
    process.env.ENCRYPTION_KEYS = `${KEY_B},${KEY_C}`;
    expect(unwrapDEK(value)).toEqual(DEK);
  });

  it('writes authenticated workspace data', () => {
    const value = encryptWithDEK('token', DEK);
    expect(value).toMatch(/^v2:dek:/);
    expect(decryptWithDEK(value, DEK)).toBe('token');
    expect(() => decryptWithDEK(value, Buffer.alloc(32, 1))).toThrow();
    expect(() => decryptWithDEK(value, null)).toThrow();
  });

  it.each(['', '密钥 🔑'])('round-trips workspace text %p', (text) => {
    expect(decryptWithDEK(encryptWithDEK(text, DEK), DEK)).toBe(text);
  });

  it('reads KEK data for workspaces that gained a DEK', () => {
    const value = encrypt('pre-envelope');
    expect(decryptWithDEK(value, DEK)).toBe('pre-envelope');
    expect(decryptWithDEK(value, null)).toBe('pre-envelope');
  });

  it.each([0, 16, 31, 33, 48])('rejects a %i-byte wrapped DEK', (length) => {
    expect(() => unwrapDEK(legacyWrap(Buffer.alloc(length, 3)))).toThrow();
  });

  it.each([0, 16, 31, 33])('rejects wrapping a %i-byte DEK', (length) => {
    expect(() => wrapDEK(Buffer.alloc(length))).toThrow();
  });

  it.each([0, 16, 31, 33])('rejects an authenticated %i-byte wrapped DEK', (length) => {
    expect(() => unwrapDEK(encryptBytesWithKek(Buffer.alloc(length)))).toThrow();
  });

  it('does not retry a corrupt authenticated workspace value under a KEK', () => {
    const parts = encryptWithDEK('token', DEK).split(':');
    parts[3] = (parts[3].startsWith('00') ? 'ff' : '00') + parts[3].slice(2);
    expect(() => decryptWithDEK(parts.join(':'), DEK)).toThrow();
  });

  it('flags older formats and keys for reencryption while retaining plain values', () => {
    expect(needsReencryption(LEGACY.data, DEK)).toBe(true);
    expect(needsReencryption(encrypt('kek'), DEK)).toBe(true);
    expect(needsReencryption(encryptWithDEK('token', DEK), DEK)).toBe(false);
    expect(needsReencryption('plain-value', DEK)).toBe(false);
    const kekValue = encrypt('token');
    expect(needsReencryption(kekValue, null)).toBe(false);
    process.env.ENCRYPTION_KEYS = `${KEY_A},${KEY_B},${KEY_C}`;
    expect(needsReencryption(kekValue, null)).toBe(true);
  });
});

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { KeyVaultDecryptionError, KeyVaultService } from './key-vault.service.js';

/**
 * Vault unit tests. The two that matter most are the AAD-binding failure and
 * the tampered-tag failure, because both are silent-success bugs if the vault
 * is built wrong: a ciphertext copied between rows would just work, and a
 * flipped byte would yield garbage instead of an error.
 */

const masterKey = randomBytes(32).toString('base64');
const configFor = (key: string) =>
  ({ get: () => key }) as unknown as ConfigService<never, true>;

const PROVIDER_A = 'clprovider0000000000000a';
const PROVIDER_B = 'clprovider0000000000000b';
const API_KEY = 'AIzaSyExampleGeminiKey1234567890abcdef';

describe('KeyVaultService', () => {
  let vault: KeyVaultService;

  beforeEach(() => {
    vault = new KeyVaultService(configFor(masterKey));
  });

  describe('construction', () => {
    it('rejects a master key that is not 32 bytes', () => {
      expect(() => new KeyVaultService(configFor(randomBytes(16).toString('base64'))))
        .toThrow(/must decode to 32 bytes/);
      expect(() => new KeyVaultService(configFor(randomBytes(31).toString('base64'))))
        .toThrow(/got 31/);
    });

    it('accepts exactly 32 bytes', () => {
      expect(() => new KeyVaultService(configFor(randomBytes(32).toString('base64'))))
        .not.toThrow();
    });
  });

  describe('round trip', () => {
    it('encrypts and decrypts back to the original key', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(vault.open(sealed, PROVIDER_A)).toBe(API_KEY);
    });

    it('never stores the plaintext in the ciphertext', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(sealed.keyCiphertext.toString('utf8')).not.toContain(API_KEY);
      expect(sealed.keyCiphertext.toString('base64')).not.toContain(API_KEY);
    });

    it('stores keyLast4 as the last four characters, separately from the ciphertext', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(sealed.keyLast4).toBe('cdef');
      expect(sealed.keyLast4).toHaveLength(4);
    });

    it('uses a 12-byte IV and a 16-byte tag', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(sealed.keyIv).toHaveLength(12);
      expect(sealed.keyTag).toHaveLength(16);
    });

    it('generates a FRESH IV per record — nonce reuse breaks GCM catastrophically', () => {
      const ivs = new Set<string>();
      for (let i = 0; i < 200; i++) {
        ivs.add(vault.seal(API_KEY, PROVIDER_A).keyIv.toString('hex'));
      }
      expect(ivs.size).toBe(200);
    });

    it('produces different ciphertext for the same key each time', () => {
      const first = vault.seal(API_KEY, PROVIDER_A);
      const second = vault.seal(API_KEY, PROVIDER_A);
      expect(first.keyCiphertext.toString('hex')).not.toBe(second.keyCiphertext.toString('hex'));
      // Both still decrypt.
      expect(vault.open(first, PROVIDER_A)).toBe(API_KEY);
      expect(vault.open(second, PROVIDER_A)).toBe(API_KEY);
    });

    it('round-trips keys with unicode and unusual lengths', () => {
      for (const key of ['a', 'x'.repeat(512), 'sk-ünïcodé-Ⓚ-1234']) {
        const sealed = vault.seal(key, PROVIDER_A);
        expect(vault.open(sealed, PROVIDER_A)).toBe(key);
      }
    });
  });

  describe('AAD binding — a ciphertext moved between provider rows must FAIL', () => {
    it('refuses to decrypt under a different provider id', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      // Exactly the attack the AAD exists to stop: the row's ciphertext, IV and
      // tag are copied wholesale onto another provider row.
      expect(() => vault.open(sealed, PROVIDER_B)).toThrow(KeyVaultDecryptionError);
      expect(() => vault.open(sealed, PROVIDER_B)).toThrow(/failed authentication/);
    });

    it('refuses even a one-character difference in the provider id', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open(sealed, `${PROVIDER_A.slice(0, -1)}z`))
        .toThrow(KeyVaultDecryptionError);
    });

    it('refuses an empty provider id at open time', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open(sealed, '')).toThrow(KeyVaultDecryptionError);
    });

    it('refuses to seal without a provider id, so an unbound record cannot exist', () => {
      expect(() => vault.seal(API_KEY, '')).toThrow(/provider id for AAD binding/);
    });

    it('does not leak which check failed — same message for bad AAD and bad tag', () => {
      // Both failures are opened under the SAME provider id, so the only thing
      // that could differ between the messages is the reason. The message
      // legitimately names the provider the caller asked for, so comparing
      // across different ids would prove nothing.
      const sealedElsewhere = vault.seal(API_KEY, PROVIDER_B);
      const sealedHere = vault.seal(API_KEY, PROVIDER_A);
      const tampered = { ...sealedHere, keyTag: flipByte(sealedHere.keyTag, 0) };

      const aadFailure = captureMessage(() => vault.open(sealedElsewhere, PROVIDER_A));
      const tagFailure = captureMessage(() => vault.open(tampered, PROVIDER_A));

      expect(aadFailure).toBe(tagFailure);
      // And neither says which check tripped.
      expect(aadFailure).not.toMatch(/tag|aad|additional authenticated/i);
    });
  });

  describe('tamper detection', () => {
    it('rejects a tampered auth tag', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open({ ...sealed, keyTag: flipByte(sealed.keyTag, 0) }, PROVIDER_A))
        .toThrow(KeyVaultDecryptionError);
      expect(() => vault.open({ ...sealed, keyTag: flipByte(sealed.keyTag, 15) }, PROVIDER_A))
        .toThrow(KeyVaultDecryptionError);
    });

    it('rejects a tampered ciphertext', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() =>
        vault.open({ ...sealed, keyCiphertext: flipByte(sealed.keyCiphertext, 0) }, PROVIDER_A),
      ).toThrow(KeyVaultDecryptionError);
    });

    it('rejects a tampered IV', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open({ ...sealed, keyIv: flipByte(sealed.keyIv, 5) }, PROVIDER_A))
        .toThrow(KeyVaultDecryptionError);
    });

    it('rejects an IV or tag of the wrong length before attempting to decrypt', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open({ ...sealed, keyIv: randomBytes(16) }, PROVIDER_A))
        .toThrow(/16-byte IV; expected 12/);
      expect(() => vault.open({ ...sealed, keyTag: randomBytes(8) }, PROVIDER_A))
        .toThrow(/8-byte auth tag; expected 16/);
    });

    it('rejects a record whose keyLast4 disagrees with the decrypted key', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      expect(() => vault.open({ ...sealed, keyLast4: 'ffff' }, PROVIDER_A))
        .toThrow(/keyLast4 does not match/);
    });
  });

  describe('master key rotation', () => {
    it('cannot decrypt a record sealed under a different master key', () => {
      const sealed = vault.seal(API_KEY, PROVIDER_A);
      const otherVault = new KeyVaultService(configFor(randomBytes(32).toString('base64')));
      expect(() => otherVault.open(sealed, PROVIDER_A)).toThrow(KeyVaultDecryptionError);
      // The error tells the operator what to do, since this is recoverable by
      // re-entering the key.
      expect(() => otherVault.open(sealed, PROVIDER_A)).toThrow(/Re-enter the key/);
    });
  });

  describe('missing credential', () => {
    it('reports a provider with no stored credential distinctly from a failure', () => {
      expect(() => vault.open(null, PROVIDER_A)).toThrow(/no stored credential/);
      expect(() => vault.open({}, PROVIDER_A)).toThrow(/no stored credential/);
      expect(() => vault.open({ keyCiphertext: Buffer.from('x') }, PROVIDER_A))
        .toThrow(/no stored credential/);
    });

    it('refuses to seal an empty key', () => {
      expect(() => vault.seal('', PROVIDER_A)).toThrow(/empty API key/);
    });
  });
});

function flipByte(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index]! ^ 0xff) & 0xff;
  return copy;
}

function captureMessage(fn: () => unknown): string {
  try {
    fn();
    return '(no error thrown)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

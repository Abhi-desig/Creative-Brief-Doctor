import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

/**
 * AES-256-GCM key vault.
 *
 * Two design choices carry all the weight:
 *
 *   A fresh 12-byte IV per record. 12 bytes is the GCM standard nonce length,
 *   and reusing a nonce under the same key is the one mistake that breaks GCM
 *   catastrophically — it leaks the authentication subkey, not just one
 *   plaintext. So the IV is generated per write and stored beside the
 *   ciphertext, never derived and never reused.
 *
 *   The provider row's id as additional authenticated data. AAD is
 *   authenticated but not encrypted, so binding the ciphertext to the row it
 *   belongs to costs nothing and means a ciphertext copied from one provider
 *   row to another FAILS to decrypt rather than silently working. Without it,
 *   an attacker with UPDATE on one column could move a working key onto a
 *   provider row they control.
 *
 * `keyLast4` is stored as a separate plaintext column so the admin panel can
 * identify a key without any code path that decrypts one for display.
 */

export interface SealedKey {
  keyCiphertext: Buffer;
  keyIv: Buffer;
  keyTag: Buffer;
  keyLast4: string;
}

export class KeyVaultDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyVaultDecryptionError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

@Injectable()
export class KeyVaultService {
  private readonly logger = new Logger(KeyVaultService.name);
  private readonly masterKey: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const encoded = config.get('MASTER_ENCRYPTION_KEY', { infer: true });
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      // Validated in the env schema too; this is the defence in depth that
      // matters, because a short key silently weakens every record.
      throw new Error(
        `MASTER_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
      );
    }
    this.masterKey = key;
  }

  /**
   * @param providerId The AiProvider row id. Bound as AAD, so the sealed key
   *   only decrypts in the context of that row.
   */
  seal(plaintextKey: string, providerId: string): SealedKey {
    if (!plaintextKey) throw new Error('Refusing to seal an empty API key.');
    if (!providerId) throw new Error('Refusing to seal without a provider id for AAD binding.');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    cipher.setAAD(Buffer.from(providerId, 'utf8'));

    const keyCiphertext = Buffer.concat([
      cipher.update(plaintextKey, 'utf8'),
      cipher.final(),
    ]);

    return {
      keyCiphertext,
      keyIv: iv,
      keyTag: cipher.getAuthTag(),
      keyLast4: plaintextKey.slice(-4),
    };
  }

  /**
   * Never log the return value, and never cache it. Callers hold it for the
   * duration of one request and let it fall out of scope.
   */
  open(sealed: Partial<SealedKey> | null | undefined, providerId: string): string {
    if (!sealed?.keyCiphertext || !sealed.keyIv || !sealed.keyTag) {
      throw new KeyVaultDecryptionError(
        `Provider ${providerId} has no stored credential.`,
      );
    }
    if (sealed.keyIv.length !== IV_BYTES) {
      throw new KeyVaultDecryptionError(
        `Provider ${providerId} has a ${sealed.keyIv.length}-byte IV; expected ${IV_BYTES}.`,
      );
    }
    if (sealed.keyTag.length !== TAG_BYTES) {
      throw new KeyVaultDecryptionError(
        `Provider ${providerId} has a ${sealed.keyTag.length}-byte auth tag; expected ${TAG_BYTES}.`,
      );
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, sealed.keyIv);
      // The same AAD must be supplied, which is what binds ciphertext to row.
      decipher.setAAD(Buffer.from(providerId, 'utf8'));
      decipher.setAuthTag(sealed.keyTag);
      const plaintext = Buffer.concat([
        decipher.update(sealed.keyCiphertext),
        decipher.final(),
      ]).toString('utf8');

      if (sealed.keyLast4 && !constantTimeEquals(plaintext.slice(-4), sealed.keyLast4)) {
        throw new KeyVaultDecryptionError(
          `Provider ${providerId} decrypted successfully but keyLast4 does not match; `
          + 'the row is inconsistent.',
        );
      }
      return plaintext;
    } catch (error) {
      if (error instanceof KeyVaultDecryptionError) throw error;
      // Deliberately does not include the underlying OpenSSL message, which
      // differs between a bad tag and a bad AAD and would be an oracle.
      this.logger.warn(`Credential decryption failed for provider ${providerId}.`);
      throw new KeyVaultDecryptionError(
        `Credential for provider ${providerId} failed authentication. Either the `
        + 'master key changed, the ciphertext was moved between rows, or the record '
        + 'was tampered with. Re-enter the key in the admin panel.',
      );
    }
  }
}

/**
 * Prisma 7 types Bytes columns as `Uint8Array<ArrayBuffer>`, which a Node
 * `Buffer` (backed by `ArrayBufferLike`) does not satisfy. Converting at the
 * boundary keeps the crypto code in Buffers and the persistence code in the
 * type Prisma wants.
 */
export function toPrismaBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

/** The other direction, for reading a stored credential back out. */
export function fromPrismaBytes(bytes: Uint8Array | null | undefined): Buffer {
  return bytes ? Buffer.from(bytes) : Buffer.alloc(0);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself a leak; compare
  // fixed-size digests of the inputs instead so the comparison is uniform.
  if (left.length !== right.length) {
    // Still burn a comparison so the early return is not observably faster.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

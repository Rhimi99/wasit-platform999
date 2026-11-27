import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

/**
 * Sealing for provider credentials that must live in the database.
 *
 * AES-256-GCM with a random 96-bit IV per write and an associated-data string
 * that binds the envelope to one provider in one environment. The master key is
 * read from the environment only — it is never persisted, logged or returned,
 * so a database dump alone cannot reveal a provider key.
 *
 * Envelope: `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
 */
const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretStorageReason = 'OK' | 'MISSING_MASTER_KEY' | 'INVALID_MASTER_KEY';

export interface SecretStorageStatus {
  available: boolean;
  reason: SecretStorageReason;
}

export class SecretStorageUnavailableError extends Error {
  constructor(readonly reason: SecretStorageReason) {
    super(
      reason === 'MISSING_MASTER_KEY'
        ? 'Storing provider keys requires AI_SECRET_ENCRYPTION_KEY on the server'
        : 'AI_SECRET_ENCRYPTION_KEY is not a valid 32-byte base64 key',
    );
    this.name = 'SecretStorageUnavailableError';
  }
}

function masterKey(): Buffer | null {
  const raw = env.AI_SECRET_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) return null;
  return buf;
}

export function secretStorageStatus(): SecretStorageStatus {
  const raw = env.AI_SECRET_ENCRYPTION_KEY?.trim();
  if (!raw) return { available: false, reason: 'MISSING_MASTER_KEY' };
  if (!masterKey()) return { available: false, reason: 'INVALID_MASTER_KEY' };
  return { available: true, reason: 'OK' };
}

function requireKey(): Buffer {
  const status = secretStorageStatus();
  const key = masterKey();
  if (!key) throw new SecretStorageUnavailableError(status.reason);
  return key;
}

/** Binds a ciphertext to one provider in one environment. */
export function secretAad(environment: string, providerKey: string): string {
  return `${environment}:${providerKey}:${VERSION}`;
}

export function sealSecret(plaintext: string, aad: string): string {
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Throws when the envelope was tampered with, moved across environments or the key changed. */
export function openSecret(envelope: string, aad: string): string {
  const key = requireKey();
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported secret envelope');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Short, non-reversible digest of a secret. Used to show "the key changed since
 * you saved it" without exposing any part of the key itself.
 */
export function fingerprintSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16);
}

/** True when the value looks like a plausible credential, never echoes it. */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 16 || value.length > 512) return false;
  return !/[\s\u0000-\u001f\u007f]/.test(value);
}

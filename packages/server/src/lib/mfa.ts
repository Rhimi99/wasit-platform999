import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { authenticatorApp, users } from '../db/schema/auth';
import { newId } from './ids';
import { ApiError } from '@wasit/shared';

/**
 * MFA helpers — RFC 6238 TOTP compatible with Google Authenticator & Authy.
 * No external dependencies: uses node:crypto only.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const WINDOW = 1; // ±1 step tolerance

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateMfaSecret(): { secret: string; secretBase32: string } {
  const raw = randomBytes(20); // 160-bit secret
  return {
    secret: raw.toString('base64url'),
    secretBase32: base32Encode(raw),
  };
}

export function generateMfaQrUri(account: string, secretBase32: string, issuer = 'WASIT'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
}

function totpAt(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

export function generateTotp(secretBase32: string, timestamp = Date.now(), stepSeconds = STEP_SECONDS): string {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  return totpAt(secret, counter);
}

/** Verify a TOTP code with a time-window tolerance of ±1 step. */
export function verifyTotp(secretBase32: string, code: string, timestamp = Date.now(), stepSeconds = STEP_SECONDS): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    if (totpAt(secret, counter + w) === code) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const buf = randomBytes(6);
    codes.push(buf.toString('base64url').slice(0, 10));
  }
  return codes;
}

/**
 * Recovery codes are stored as salted SHA-256 digests in the format `salt:hash`
 * where salt is 16 random bytes (hex) and hash is the SHA-256 of `salt + code`.
 * The stored value never contains the raw code; each code gets a unique salt.
 */
const RECOVERY_SALT_BYTES = 16;

export function hashRecoveryCode(code: string): string {
  const salt = randomBytes(RECOVERY_SALT_BYTES).toString('hex');
  return `${salt}:${createHash('sha256').update(salt).update(code).digest('hex')}`;
}

/**
 * Constant-time comparison of two hex digests. Lengths are compared first via
 * timingSafeEqual on equal-length buffers.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface RecoveryCodeCheck {
  valid: boolean;
  /** True for legacy (unsalted, pre-salt) digests so callers can re-hash on use. */
  legacy: boolean;
}

/**
 * Verify a recovery code against a stored digest. Supports both the legacy
 * unsalted digest (SHA-256 of the raw code) for backward compatibility and the
 * current salted `salt:hash` format. Never logs codes or digests.
 */
export function verifyRecoveryCode(code: string, stored: string): RecoveryCodeCheck {
  const idx = stored.indexOf(':');
  if (idx > 0) {
    const salt = stored.slice(0, idx);
    const expectedHash = stored.slice(idx + 1);
    const actualHash = createHash('sha256').update(salt).update(code).digest('hex');
    return { valid: constantTimeHexEqual(expectedHash, actualHash), legacy: false };
  }
  // Legacy format (no colon): SHA-256 of the raw code.
  return { valid: constantTimeHexEqual(stored, createHash('sha256').update(code).digest('hex')), legacy: true };
}

// ---------------------------------------------------------------------------
// DB-backed MFA operations
// ---------------------------------------------------------------------------

export interface MfaEnrollResult {
  secretBase32: string;
  qrUri: string;
  recoveryCodes: string[];
}

/** Begin enrollment: create a pending authenticator record with a fresh secret. */
export async function enrollMfa(db: DB, userId: string, account: string): Promise<MfaEnrollResult> {
  const { secret, secretBase32 } = generateMfaSecret();
  const recoveryCodes = generateRecoveryCodes(10);
  const recoveryJson = JSON.stringify(recoveryCodes.map(hashRecoveryCode));

  const existing = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(authenticatorApp)
      .set({ secret: secretBase32, enabled: false, recoveryCodesHash: recoveryJson, confirmedAt: null })
      .where(eq(authenticatorApp.userId, userId));
  } else {
    await db.insert(authenticatorApp).values({
      id: newId(),
      userId,
      secret: secretBase32,
      enabled: false,
      recoveryCodesHash: recoveryJson,
    });
  }

  const qrUri = generateMfaQrUri(account, secretBase32);
  return { secretBase32, qrUri, recoveryCodes };
}

/** Complete enrollment after the user confirms a valid TOTP code. */
export async function confirmMfa(db: DB, userId: string, code: string): Promise<void> {
  const rows = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  if (rows.length === 0)
    throw ApiError.validation([{ field: 'mfa', message: 'MFA not enrolled', code: 'VALIDATION_FAILED' }]);
  const row = rows[0];
  if (!verifyTotp(row.secret, code)) throw ApiError.unauthorized('Invalid TOTP code');
  await db
    .update(authenticatorApp)
    .set({ enabled: true, confirmedAt: new Date() })
    .where(eq(authenticatorApp.id, row.id));
  await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));
}

/** Verify a code against the user's enrolled authenticator (for login challenge). */
export async function verifyMfaChallenge(db: DB, userId: string, code: string): Promise<{ valid: boolean; recoveryCodeUsed?: boolean }> {
  const rows = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  if (rows.length === 0 || !rows[0].enabled) {
    throw ApiError.validation([{ field: 'mfa', message: 'MFA not enabled', code: 'VALIDATION_FAILED' }]);
  }
  const row = rows[0];

  // TOTP path
  if (verifyTotp(row.secret, code)) {
    return { valid: true };
  }

  // Recovery code path — salted digest (or legacy unsalted), one-time use.
  const recoveryHashes: string[] = Array.isArray(row.recoveryCodesHash)
    ? row.recoveryCodesHash
    : JSON.parse((row.recoveryCodesHash as unknown as string) ?? '[]');
  let matchedIndex = -1;
  let usedLegacy = false;
  for (let i = 0; i < recoveryHashes.length; i++) {
    const check = verifyRecoveryCode(code, recoveryHashes[i]);
    if (check.valid) {
      matchedIndex = i;
      usedLegacy = check.legacy;
      break;
    }
  }
  if (matchedIndex === -1) return { valid: false };

  const remaining = recoveryHashes.filter((_, i) => i !== matchedIndex);
  if (usedLegacy) {
    // Upgrade legacy (unsalted) digest to salted format once it is used and
    // consumed. This never weakens the stored set and never reappears as raw.
    remaining.push(hashRecoveryCode(code));
  }
  await db
    .update(authenticatorApp)
    .set({ recoveryCodesHash: JSON.stringify(remaining) })
    .where(eq(authenticatorApp.id, row.id));
  return { valid: true, recoveryCodeUsed: true };
}

/** Disable MFA after verifying the current TOTP code. */
export async function disableMfa(db: DB, userId: string, code: string): Promise<void> {
  const rows = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  if (rows.length === 0)
    throw ApiError.validation([{ field: 'mfa', message: 'MFA not enrolled', code: 'VALIDATION_FAILED' }]);
  const row = rows[0];
  if (!verifyTotp(row.secret, code)) throw ApiError.unauthorized('Invalid TOTP code');
  await db
    .update(authenticatorApp)
    .set({ enabled: false })
    .where(eq(authenticatorApp.id, row.id));
  await db.update(users).set({ mfaEnabled: false }).where(eq(users.id, userId));
}

/** Regenerate recovery codes (requires a valid TOTP code). */
export async function regenerateRecoveryCodes(
  db: DB,
  userId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const rows = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  if (rows.length === 0)
    throw ApiError.validation([{ field: 'mfa', message: 'MFA not enrolled', code: 'VALIDATION_FAILED' }]);
  const row = rows[0];
  if (!verifyTotp(row.secret, code)) throw ApiError.unauthorized('Invalid TOTP code');
  const recoveryCodes = generateRecoveryCodes(10);
  await db
    .update(authenticatorApp)
    .set({ recoveryCodesHash: JSON.stringify(recoveryCodes.map(hashRecoveryCode)) })
    .where(eq(authenticatorApp.id, row.id));
  return { recoveryCodes };
}

/** Returns whether MFA is enabled and whether enrollment is pending. */
export async function getMfaStatus(db: DB, userId: string) {
  const rows = await db
    .select()
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  const user = await db.select({ mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, userId)).limit(1);
  const mfaEnabledInUser = user[0]?.mfaEnabled ?? false;
  return {
    mfaEnabled: rows.length > 0 ? rows[0].enabled && mfaEnabledInUser : mfaEnabledInUser,
    pendingEnrollment: rows.length > 0 && !rows[0].enabled,
  };
}
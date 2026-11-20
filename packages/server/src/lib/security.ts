import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify } from 'argon2';
import { env } from './env';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    type: 2, // argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, hashValue: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

/**
 * A fixed argon2id hash whose parameters match {@link hashPassword} exactly
 * (`m=19456,t=2,p=1`). Verifying a candidate against it burns the same work as a
 * real check, so the "no such account" and "account locked" paths cannot be told
 * apart from a wrong-password path by response time. It is not a credential for
 * any account — its pre-image is unknown and never used — and it is never stored
 * on a user row.
 *
 * `security-timing.test.ts` pins the parameters against `hashPassword`, so a
 * future change to the hashing cost that is not mirrored here fails the suite
 * instead of silently reopening the oracle.
 */
export const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$LKoVUWP67O0CHO21wGjCXg$UGulVdL6meTv9UnO3QVizCSDfvmZzpzF83wK0+Zz8TY';

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateOtpCode(): string {
  // Uniform 6-digit code. A single draw with zero-padding is required: drawing
  // separately for the range check and the value can emit a 5-digit code.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function newSessionId(): string {
  return randomUUID();
}

export function parseBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

const secret = env.JWT_SECRET;

export function signToken(payload: Record<string, unknown>, expiresInSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }),
  ).toString('base64url');
  const sig = createHash('sha256')
    .update(`${header}.${body}.${secret}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHash('sha256').update(`${header}.${body}.${secret}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
      exp?: number;
    };
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
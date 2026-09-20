import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/**
 * Signed, short-lived download tokens for private media assets.
 *
 * The public storage key is never enough to read an asset: a token binds the
 * asset id to its owner and expires quickly. This lets the browser open a
 * preview/download URL directly (native video element, download link) without
 * any unauthenticated static file exposure.
 */
export interface DownloadClaims {
  assetId: string;
  userId: string;
  exp: number;
}

function sign(payload: string): string {
  return createHash('sha256').update(`${payload}.${env.JWT_SECRET}`).digest('base64url');
}

export function signDownloadToken(assetId: string, userId: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ assetId, userId, exp })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyDownloadToken(token: string): DownloadClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DownloadClaims;
    if (!claims.assetId || !claims.userId) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Lifetime (seconds) of a signed media link. */
export function downloadTtlSeconds(): number {
  return env.MEDIA_DOWNLOAD_TTL_SECONDS;
}
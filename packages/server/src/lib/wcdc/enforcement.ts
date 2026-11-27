/**
 * What the request path actually enforces.
 *
 * Two controls, both bounded in time and both reversible without a deploy: a
 * tightened limit for one address, and an IP block read from the database. They
 * are separate from the rule engine on purpose — detection never changes
 * behaviour by itself, and an operator can always see and lift a control.
 */

const tightened = new Map<string, number>();

/** Limits applied while an address is under a tightened limit. */
export const TIGHTENED_LIMIT = { windowSeconds: 10, max: 5 } as const;

export function tightenIp(ip: string, ttlMinutes: number): number {
  const until = Date.now() + ttlMinutes * 60_000;
  tightened.set(ip, until);
  return until;
}

export function isTightened(ip: string, now = Date.now()): boolean {
  const until = tightened.get(ip);
  if (!until) return false;
  if (until <= now) {
    tightened.delete(ip);
    return false;
  }
  return true;
}

export function liftedIp(ip: string): void {
  tightened.delete(ip);
}

/**
 * Cached view of active IP blocks. The table is the source of truth; the cache
 * exists so a flood does not become a database flood, and it is invalidated the
 * moment WCDC writes a block.
 */
let blockedCache: { loadedAt: number; ips: Set<string> } | null = null;

export const BLOCK_CACHE_TTL_MS = 2_000;

export function cachedBlockedIps(
  maxAgeMs = BLOCK_CACHE_TTL_MS,
  now = Date.now(),
): Set<string> | null {
  if (!blockedCache) return null;
  if (now - blockedCache.loadedAt > maxAgeMs) return null;
  return blockedCache.ips;
}

export function rememberBlockedIps(ips: Iterable<string>, now = Date.now()): void {
  blockedCache = { loadedAt: now, ips: new Set(ips) };
}

export function invalidateBlockedIps(): void {
  blockedCache = null;
}

/** Test seam: forget every in-process control. */
export function resetWcdcEnforcement(): void {
  tightened.clear();
  blockedCache = null;
}

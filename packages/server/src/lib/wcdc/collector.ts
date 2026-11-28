import { logger } from '../observability/logger';
import { ingestEvent, type IngestResult } from './detector';
import type { DB } from '../../db/client';
import type { SecuritySeverity, SecuritySource } from './types';

/**
 * Security Event Collector.
 *
 * Two jobs: keep bounded in-process counters so a pattern can be recognised
 * without a database round-trip per request, and write the events that actually
 * matter. Nothing here throws into the request path — a security tool that
 * breaks the platform it protects is worse than the attack.
 *
 * The counters are per instance and deliberately in memory: they answer "is one
 * source hammering *this* node right now". Cross-instance correlation is done
 * from the persisted `security_events` rows (see `service.ts`), which is also
 * what the GM screen reads.
 */

const MAX_COUNTER_KEYS = 20_000;

interface CounterEntry {
  windowStart: number;
  hits: number;
}

interface SetEntry {
  windowStart: number;
  values: Set<string>;
}

const counters = new Map<string, CounterEntry>();
const sets = new Map<string, SetEntry>();

/** Test seam: forget every in-process counter. */
export function resetWcdcCounters(): void {
  counters.clear();
  sets.clear();
}

function prune(map: Map<string, { windowStart: number }>, windowMs: number, now: number): void {
  if (map.size < MAX_COUNTER_KEYS) return;
  for (const [key, entry] of map) {
    if (now - entry.windowStart > windowMs) map.delete(key);
  }
  // Still large: drop the oldest insertion order entries (Map preserves it).
  while (map.size > MAX_COUNTER_KEYS) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

/** Counts one hit inside a sliding fixed window. */
export function hitCounter(
  key: string,
  windowSeconds: number,
  now = Date.now(),
): { hits: number; windowStart: number } {
  const windowMs = windowSeconds * 1000;
  prune(counters, windowMs, now);
  const existing = counters.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    counters.set(key, { windowStart: now, hits: 1 });
    return { hits: 1, windowStart: now };
  }
  existing.hits += 1;
  return { hits: existing.hits, windowStart: existing.windowStart };
}

/** Adds a value to a windowed set and reports how many distinct values it holds. */
export function distinctCounter(
  key: string,
  value: string,
  windowSeconds: number,
  now = Date.now(),
): { size: number; windowStart: number } {
  const windowMs = windowSeconds * 1000;
  prune(sets, windowMs, now);
  const existing = sets.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    sets.set(key, { windowStart: now, values: new Set([value]) });
    return { size: 1, windowStart: now };
  }
  existing.values.add(value);
  return { size: existing.values.size, windowStart: existing.windowStart };
}

export interface SecurityEventInput {
  ruleId: string;
  source?: SecuritySource;
  severity?: SecuritySeverity;
  actorId?: string | null;
  actorRoles?: string[] | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  method?: string | null;
  route?: string | null;
  statusCode?: number | null;
  tenantId?: string | null;
  sessionHash?: string | null;
  traceId?: string | null;
  fingerprintParts?: ReadonlyArray<string | null | undefined>;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persists one observation and folds it into an incident.
 *
 * Returns `null` when the write failed. The caller keeps going: refusing the
 * request because the recorder is down would turn a database blip into an
 * outage, and the failure is logged loudly instead.
 */
export async function recordSecurityEvent(
  db: DB,
  input: SecurityEventInput,
): Promise<IngestResult | null> {
  try {
    return await ingestEvent(db, input);
  } catch (error) {
    logger.error('wcdc: failed to record security event', {
      ruleId: input.ruleId,
      route: input.route ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

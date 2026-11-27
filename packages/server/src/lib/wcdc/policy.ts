import type { DB } from '../../db/client';
import { env } from '../env';
import { resolveMergedPolicy } from '../policy-engine';

/**
 * WCDC policy bridge.
 *
 * Containment thresholds are a business decision, so they are read from the
 * Policy Engine (`SECURITY` / `WCDC_RESPONSE`) exactly like commission and
 * retention — not hard-coded per call site. When no row exists the safe defaults
 * below apply and are reported as `source: 'default'`, so the GM screen never
 * claims a policy that was never approved.
 *
 * DB values are validated, never trusted: a typo in `rules` must not widen an
 * automatic action or turn a TTL into `NaN`.
 */

export const WCDC_POLICY_SCOPE = 'SECURITY' as const;
export const WCDC_POLICY_CODE = 'WCDC_RESPONSE';

export type AutoContainmentMode = 'off' | 'limited';

export interface WcdcPolicy {
  autoContainment: AutoContainmentMode;
  blockTtlMinutes: number;
  tightenTtlMinutes: number;
  burstMax: number;
  burstWindowSeconds: number;
  source: 'default' | 'policy';
  policyId: string | null;
  policyVersion: number | null;
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.trunc(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

export function defaultWcdcPolicy(): WcdcPolicy {
  return {
    autoContainment: env.WCDC_AUTO_CONTAINMENT,
    blockTtlMinutes: env.WCDC_BLOCK_TTL_MINUTES,
    tightenTtlMinutes: env.WCDC_TIGHTEN_TTL_MINUTES,
    burstMax: env.WCDC_BURST_MAX,
    burstWindowSeconds: env.WCDC_BURST_WINDOW_SECONDS,
    source: 'default',
    policyId: null,
    policyVersion: null,
  };
}

export async function resolveWcdcPolicy(db: DB, countryId?: string | null): Promise<WcdcPolicy> {
  const fallback = defaultWcdcPolicy();
  try {
    const resolved = await resolveMergedPolicy(db, {
      scope: WCDC_POLICY_SCOPE,
      code: WCDC_POLICY_CODE,
      countryId: countryId ?? null,
    });
    if (!resolved.policyId) return fallback;
    const rules = resolved.rules ?? {};
    const mode = rules.autoContainment === 'limited' ? 'limited' : rules.autoContainment === 'off' ? 'off' : fallback.autoContainment;
    return {
      autoContainment: mode,
      blockTtlMinutes: intIn(rules.blockTtlMinutes, 1, 1440) ?? fallback.blockTtlMinutes,
      tightenTtlMinutes: intIn(rules.tightenTtlMinutes, 1, 240) ?? fallback.tightenTtlMinutes,
      burstMax: intIn(rules.burstMax, 5, 10_000) ?? fallback.burstMax,
      burstWindowSeconds: intIn(rules.burstWindowSeconds, 1, 300) ?? fallback.burstWindowSeconds,
      source: 'policy',
      policyId: resolved.policyId,
      policyVersion: resolved.version,
    };
  } catch {
    // A missing table or a malformed row must not break the request path.
    return fallback;
  }
}

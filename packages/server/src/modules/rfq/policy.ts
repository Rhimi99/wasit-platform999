import type { DB } from '../../db/client';
import { resolvePolicy } from '../../lib/policy-engine';

/**
 * B2B-01 — negotiation terms come from the Policy Engine, never from constants
 * spread across the code. The defaults below are the safe floor used when no
 * `B2B/RFQ_TERMS` row exists; they are intentionally conservative (a short
 * validity window, few rounds, a small recipient list) so a missing policy can
 * never widen an exposure.
 */
export const RFQ_POLICY_SCOPE = 'B2B' as const;
export const RFQ_POLICY_CODE = 'RFQ_TERMS';

export const RFQ_POLICY_DEFAULTS = {
  /** How long a submitted quote stays acceptable. */
  quoteValidityDays: 14,
  /** Maximum revisions a single seller may submit. */
  maxRounds: 5,
  /** Maximum sellers invited on one RFQ. */
  maxRecipientsPerRfq: 20,
  /** Maximum lines in one RFQ. */
  maxItemsPerRfq: 50,
  /** How long the RFQ stays open to quotes. */
  responseWindowDays: 30,
} as const;

export interface RfqPolicyTerms {
  quoteValidityDays: number;
  maxRounds: number;
  maxRecipientsPerRfq: number;
  maxItemsPerRfq: number;
  responseWindowDays: number;
  policyId: string | null;
  policySource: 'COUNTRY' | 'GLOBAL' | 'DEFAULT';
}

interface Bounds {
  min: number;
  max: number;
}

/**
 * A policy row is editable data; a typo in it must not disable a safety limit.
 * Each value is clamped to a sane window, and a non-integer/absent value falls
 * back to the default instead of propagating NaN into a date or a loop bound.
 */
const BOUNDS: Record<keyof typeof RFQ_POLICY_DEFAULTS, Bounds> = {
  quoteValidityDays: { min: 1, max: 365 },
  maxRounds: { min: 1, max: 20 },
  maxRecipientsPerRfq: { min: 1, max: 50 },
  maxItemsPerRfq: { min: 1, max: 200 },
  responseWindowDays: { min: 1, max: 180 },
};

function readInt(rules: Record<string, unknown>, key: keyof typeof RFQ_POLICY_DEFAULTS): number {
  const raw = rules[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return RFQ_POLICY_DEFAULTS[key];
  }
  const { min, max } = BOUNDS[key];
  return Math.min(Math.max(value, min), max);
}

export async function resolveRfqPolicy(db: DB, countryId?: string | null): Promise<RfqPolicyTerms> {
  const resolved = await resolvePolicy(db, {
    scope: RFQ_POLICY_SCOPE,
    code: RFQ_POLICY_CODE,
    countryId: countryId ?? null,
  });
  const rules = resolved.rules ?? {};
  return {
    quoteValidityDays: readInt(rules, 'quoteValidityDays'),
    maxRounds: readInt(rules, 'maxRounds'),
    maxRecipientsPerRfq: readInt(rules, 'maxRecipientsPerRfq'),
    maxItemsPerRfq: readInt(rules, 'maxItemsPerRfq'),
    responseWindowDays: readInt(rules, 'responseWindowDays'),
    policyId: resolved.policyId,
    policySource: resolved.policyId ? resolved.source : 'DEFAULT',
  };
}

import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { countries } from '../../db/schema/geo';
import { resolveMergedPolicy } from '../../lib/policy-engine';
import { parseDeadlineRules } from '../../lib/disputes/deadlines';

/**
 * The public, client-safe view of a dispute/refund policy.
 *
 * This is a *disclosure* surface, not an operational one. It exposes only the
 * consumer-facing facts a buyer or seller is entitled to know — the windows that
 * govern a case and whether a buyer-favourable decision returns the money — and
 * deliberately omits internal configuration (`decisionEffects` ratios, internal
 * policy ids beyond a version, admin notes). Nothing here is a legal statement:
 * the binding wording of a refund policy is a human-owned document, and this
 * endpoint says so, so the platform never presents its operational defaults as a
 * legal commitment.
 */

export interface PublicDisputeWindows {
  /** Days after an order in which a dispute may be opened. */
  openWindowDays: number | null;
  /** Days the respondent has to answer once a case is open. */
  responseWindowDays: number | null;
  /** Days parties have to file evidence. */
  evidenceDeadlineDays: number | null;
  /** Staff target for reaching a decision. */
  decisionDeadlineDays: number | null;
  /** Days after a decision in which an appeal may be filed. */
  appealWindowDays: number | null;
  /** Maximum number of appeals per dispute. */
  maxAppeals: number | null;
}

export interface PublicDisputePolicy {
  /** The country the policy applies to, or null for the global default. */
  countryCode: string | null;
  /** Which layer supplied the rules. */
  source: 'COUNTRY' | 'GLOBAL';
  /** Policy version for traceability; never an internal id. */
  version: number | null;
  windows: PublicDisputeWindows;
  /** Whether a decision in the buyer's favour returns the paid amount. */
  refundsBuyerOnBuyerFavourableDecision: boolean;
  /**
   * Explicit statement that this is an operational summary, not the binding
   * legal text. Always true; carried in the payload so a client cannot present
   * it as a legal commitment by omission.
   */
  operationalSummaryOnly: true;
}

/** Reads whether the policy maps a buyer-favourable decision to a refund. */
function refundsBuyer(rules: Record<string, unknown>): boolean {
  const effects = rules.decisionEffects as Record<string, { effect?: string }> | undefined;
  return effects?.IN_FAVOR_OF_BUYER?.effect === 'REFUND_BUYER';
}

/**
 * Resolves the public dispute policy. With no `countryCode` the global default is
 * returned; with one, the country override is merged over the global default.
 * An unknown country code is treated as "no country context" rather than an
 * error, so a public page never 500s on a stale link.
 */
export async function getPublicDisputePolicy(db: DB, countryCode?: string | null): Promise<PublicDisputePolicy> {
  let countryId: string | null = null;
  let resolvedCode: string | null = null;
  if (countryCode) {
    const [country] = await db.select({ id: countries.id, code: countries.code }).from(countries).where(eq(countries.code, countryCode)).limit(1);
    if (country) {
      countryId = country.id;
      resolvedCode = country.code;
    }
  }

  const resolved = await resolveMergedPolicy(db, { scope: 'DISPUTE', code: 'DISPUTE_RESOLUTION', countryId });
  const rules = parseDeadlineRules(resolved.rules);
  return {
    countryCode: resolvedCode,
    source: resolved.source,
    version: resolved.version,
    windows: {
      openWindowDays: rules.openWindowDays,
      responseWindowDays: rules.responseWindowDays,
      evidenceDeadlineDays: rules.evidenceDeadlineDays,
      decisionDeadlineDays: rules.decisionDeadlineDays,
      appealWindowDays: rules.appealWindowDays,
      maxAppeals: rules.maxAppeals,
    },
    refundsBuyerOnBuyerFavourableDecision: refundsBuyer(resolved.rules),
    operationalSummaryOnly: true,
  };
}

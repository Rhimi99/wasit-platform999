import { and, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../db/client';
import { taxJurisdictions, orderTaxDecisions } from '../db/schema/tax';
import { countryByCode } from './country';
import { recordCountryPolicyGap } from './country-policy-gaps';
import { newId } from './ids';
import { roundMoney, toDecimal } from './money';

/**
 * Tax Engine (P1) — abstraction only.
 *
 * This module answers one question: *what tax obligation applies to this trade,
 * and has that obligation actually been decided?* It deliberately does not answer
 * "what is the VAT rate in country X", because that is a legal/fiscal fact WASIT
 * cannot invent. When no rule is configured for a jurisdiction the engine returns
 * `DECISION_REQUIRED` and records the gap, so the platform can be honest about
 * the unknown instead of applying a guessed percentage.
 *
 * Layering (mirrors the rest of the money stack):
 *
 *   caller (service/route)
 *     → resolveTaxForOrder   (this file: policy + jurisdiction resolution)
 *       → TaxRuleProvider    (optional external authority, see port below)
 *         → tax_jurisdictions / policies (configured data)
 *
 * Nothing here reads payment, settlement or payout state, and no rate is ever
 * defaulted: a NULL rate stays NULL, and `amount` is NULL (not 0) when undecided.
 */

/** The obligation's decision state, as reported to callers. */
export type TaxDecisionStatus = 'DECISION_REQUIRED' | 'CONFIGURED' | 'PROVIDER_MANAGED';

/**
 * A tax rule as supplied by an authority/provider or by configuration.
 * `rate` is a decimal fraction (0.19 = 19%) supplied by the authority — never
 * produced by this engine.
 */
export interface TaxRule {
  taxType: string;
  rate: string;
  priceIncludesTax: boolean;
  appliesTo: 'BUYER' | 'SELLER';
  providerRef?: string | null;
}

/**
 * External tax authority port. A licensed tax provider (or an internal
 * configuration reader) implements this. The engine never fabricates a rule: an
 * implementation that has nothing to say returns `null`.
 */
export interface TaxRuleProvider {
  readonly id: string;
  /** Whether the provider is configured and callable. */
  isAvailable(): boolean;
  /**
   * Resolves the rule for a jurisdiction, or `null` when this provider cannot
   * determine it. Returning `null` is the correct answer for "unknown" — the
   * engine turns that into DECISION_REQUIRED rather than a zero rate.
   */
  resolveRule(input: {
    countryCode: string;
    regionCode?: string | null;
    taxType: string;
  }): Promise<TaxRule | null>;
}

/**
 * Provider backed by the configured `tax_jurisdictions` rows. This is the
 * default: whatever Admin/legal has explicitly configured, and nothing more.
 */
export class ConfiguredTaxRuleProvider implements TaxRuleProvider {
  readonly id = 'configured';
  constructor(private readonly db: DB) {}
  isAvailable(): boolean {
    return true;
  }
  async resolveRule(input: {
    countryCode: string;
    regionCode?: string | null;
    taxType: string;
  }): Promise<TaxRule | null> {
    const country = await countryByCode(this.db, input.countryCode);
    if (!country) return null;
    const rows = await this.db
      .select()
      .from(taxJurisdictions)
      .where(
        and(
          eq(taxJurisdictions.countryId, country.id),
          eq(taxJurisdictions.taxType, input.taxType),
          eq(taxJurisdictions.status, 'CONFIGURED'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.rate == null) return null;
    // A region-scoped row only answers for that region; otherwise it is a
    // country-wide rule and applies to every region within it.
    if (row.regionCode && row.regionCode !== (input.regionCode ?? null)) return null;
    return {
      taxType: row.taxType,
      rate: row.rate,
      priceIncludesTax: row.priceIncludesTax,
      appliesTo: (row.appliesTo as 'BUYER' | 'SELLER') ?? 'BUYER',
      providerRef: row.providerRef,
    };
  }
}

/** Port for a jurisdiction the platform has not decided on yet. */
export class UnavailableTaxRuleProvider implements TaxRuleProvider {
  readonly id = 'unavailable';
  isAvailable(): boolean {
    return false;
  }
  async resolveRule(): Promise<TaxRule | null> {
    return null;
  }
}

export interface TaxResolution {
  status: TaxDecisionStatus;
  /** Jurisdiction the decision applies to. */
  countryId: string | null;
  countryCode: string;
  regionCode: string | null;
  taxType: string;
  /** Configured rate, or null when undecided. Never defaulted to 0. */
  rate: string | null;
  /** Resolved tax amount, or null when undecided. Never defaulted to 0. */
  amount: string | null;
  currencyCode: string;
  appliesTo: 'BUYER' | 'SELLER' | null;
  /** Id of the jurisdiction row, when one exists. */
  jurisdictionId: string | null;
  /** Id of the recorded configuration gap, when the rule is undecided. */
  policyGapId: string | null;
  /** Which provider (if any) supplied the rule. */
  providerId: string | null;
}

/**
 * Resolves the tax decision for an amount in a jurisdiction.
 *
 * `taxType` is required because the set of taxes is jurisdiction-defined: the
 * engine cannot know whether a country levies VAT, GST or a sales tax, so it
 * must be told which obligation is being resolved. Passing a tax type the
 * jurisdiction has not configured yields DECISION_REQUIRED — the honest answer.
 *
 * The default tax type is intentionally NOT set here; callers name the
 * obligation they need (see `DEFAULT_TAX_TYPE` in the service layer, which is
 * itself configuration-driven).
 */
export async function resolveTax(
  db: DB,
  input: {
    countryCode: string;
    regionCode?: string | null;
    taxType: string;
    /** Amount the tax is computed against (the taxable base). */
    amount: string;
    currencyCode: string;
    /** Register the configuration gap when the rule is undecided (default true). */
    recordGap?: boolean;
    provider?: TaxRuleProvider;
  },
): Promise<TaxResolution> {
  if (!input.countryCode?.trim()) {
    throw ApiError.validation([
      { field: 'countryCode', message: 'A tax jurisdiction requires a country', code: 'VALIDATION_FAILED' },
    ]);
  }
  if (!input.taxType?.trim()) {
    throw ApiError.validation([
      { field: 'taxType', message: 'A tax obligation must name its tax type', code: 'VALIDATION_FAILED' },
    ]);
  }
  const base = toDecimal(input.amount);
  if (base.isNegative()) {
    throw ApiError.validation([
      { field: 'amount', message: 'Taxable amount must not be negative', code: 'VALIDATION_FAILED' },
    ]);
  }

  const country = await countryByCode(db, input.countryCode);
  const provider = input.provider ?? new ConfiguredTaxRuleProvider(db);
  const rule = provider.isAvailable()
    ? await provider.resolveRule({
        countryCode: input.countryCode,
        regionCode: input.regionCode ?? null,
        taxType: input.taxType,
      })
    : null;

  if (!rule) {
    // Undecided. Record the gap (DECISION_REQUIRED) and report nulls — never 0,
    // because "no tax configured" and "no tax applies" are different facts.
    let policyGapId: string | null = null;
    if (country && input.recordGap !== false) {
      const gap = await recordCountryPolicyGap(db, {
        countryId: country.id,
        scope: 'TAX',
        code: input.taxType,
        reason:
          `Tax rule for '${input.taxType}' is not configured for this jurisdiction. ` +
          'A legal/fiscal decision is required before tax can be applied; the platform will not assume a rate.',
        metadata: { countryCode: country.code, regionCode: input.regionCode ?? null, currencyCode: input.currencyCode },
      });
      policyGapId = gap.id;
    }
    return {
      status: 'DECISION_REQUIRED',
      countryId: country?.id ?? null,
      countryCode: input.countryCode,
      regionCode: input.regionCode ?? null,
      taxType: input.taxType,
      rate: null,
      amount: null,
      currencyCode: input.currencyCode,
      appliesTo: null,
      jurisdictionId: null,
      policyGapId,
      providerId: provider.isAvailable() ? provider.id : null,
    };
  }

  const jurisdiction = country
    ? await db
        .select({ id: taxJurisdictions.id })
        .from(taxJurisdictions)
        .where(and(eq(taxJurisdictions.countryId, country.id), eq(taxJurisdictions.taxType, input.taxType)))
        .limit(1)
    : [];

  const amount = computeTaxAmount(base, rule);

  return {
    status: provider.id === 'configured' ? 'CONFIGURED' : 'PROVIDER_MANAGED',
    countryId: country?.id ?? null,
    countryCode: input.countryCode,
    regionCode: input.regionCode ?? null,
    taxType: rule.taxType,
    rate: rule.rate,
    amount,
    currencyCode: input.currencyCode,
    appliesTo: rule.appliesTo,
    jurisdictionId: jurisdiction[0]?.id ?? null,
    policyGapId: null,
    providerId: provider.id,
  };
}

/**
 * Computes the tax amount for a taxable base. Pure so it can be proven without
 * a database. `priceIncludesTax` distinguishes the two real-world conventions:
 * an inclusive price already contains the tax (extract it), an exclusive price
 * does not (add it). No rounding mode is invented here beyond the project's
 * existing money rounding.
 */
export function computeTaxAmount(
  base: ReturnType<typeof toDecimal>,
  rule: { rate: string; priceIncludesTax: boolean },
): string {
  const rate = toDecimal(rule.rate);
  if (rate.isNegative()) {
    throw ApiError.validation([
      { field: 'rate', message: 'Tax rate must not be negative', code: 'VALIDATION_FAILED' },
    ]);
  }
  if (rule.priceIncludesTax) {
    // Inclusive: tax = base − base / (1 + rate).
    const extracted = base.minus(base.dividedBy(toDecimal(1).plus(rate)));
    return roundMoney(extracted).toFixed(4);
  }
  return roundMoney(base.mul(rate)).toFixed(4);
}

/**
 * Persists the tax decision against an order so the historical record is stable:
 * a later rule change never rewrites what was actually applied, and an order
 * processed while undecided keeps its DECISION_REQUIRED marker.
 */
export async function recordOrderTaxDecision(
  db: DB,
  input: { orderId: string; resolution: TaxResolution },
): Promise<{ id: string }> {
  const id = newId();
  await db
    .insert(orderTaxDecisions)
    .values({
      id,
      orderId: input.orderId,
      countryId: input.resolution.countryId,
      regionCode: input.resolution.regionCode,
      taxType: input.resolution.taxType,
      status: input.resolution.status,
      rate: input.resolution.rate,
      amount: input.resolution.amount,
      currencyCode: input.resolution.currencyCode,
      jurisdictionId: input.resolution.jurisdictionId,
      policyGapId: input.resolution.policyGapId,
    })
    .onConflictDoNothing();
  return { id };
}

/** Reads the recorded tax decision for an order, if any. */
export async function getOrderTaxDecision(db: DB, orderId: string) {
  const rows = await db.select().from(orderTaxDecisions).where(eq(orderTaxDecisions.orderId, orderId)).limit(1);
  return rows[0] ?? null;
}

/** Lists the configured/undecided jurisdictions, for the admin tax desk. */
export async function listTaxJurisdictions(db: DB, countryId?: string | null) {
  const q = db.select().from(taxJurisdictions);
  return countryId
    ? q.where(eq(taxJurisdictions.countryId, countryId))
    : q;
}

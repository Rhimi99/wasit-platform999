import { and, desc, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { taxJurisdictions } from '../../db/schema/tax';
import { countries } from '../../db/schema/geo';
import { newId } from '../../lib/ids';
import { toDecimal } from '../../lib/money';
import { writeAudit } from '../../lib/audit';
import { resolveTax, listTaxJurisdictions, type TaxResolution } from '../../lib/tax';
import { resolveCountryPolicyGap } from '../../lib/country-policy-gaps';

/**
 * Tax service (P1) — the only layer that reads/writes tax configuration.
 *
 * It carries no rates of its own: every percentage comes from a configured
 * `tax_jurisdictions` row, and an unconfigured jurisdiction resolves to
 * `DECISION_REQUIRED`. Admin writes are audited and validated; a rate is stored
 * exactly as the operator supplied it, never defaulted.
 */

/** The tax obligation a market is expected to levy, when configured. */
export interface TaxTypeDescriptor {
  taxType: string;
  status: 'DECISION_REQUIRED' | 'CONFIGURED' | 'PROVIDER_MANAGED';
  rate: string | null;
  priceIncludesTax: boolean;
  appliesTo: string;
  providerRef: string | null;
}

/** Every tax type configured (or flagged undecided) for one country. */
export async function listCountryTaxRules(db: DB, countryId: string): Promise<TaxTypeDescriptor[]> {
  const rows = await db
    .select()
    .from(taxJurisdictions)
    .where(eq(taxJurisdictions.countryId, countryId))
    .orderBy(desc(taxJurisdictions.updatedAt));
  return rows.map((r) => ({
    taxType: r.taxType,
    status: r.status,
    rate: r.rate,
    priceIncludesTax: r.priceIncludesTax,
    appliesTo: r.appliesTo,
    providerRef: r.providerRef,
  }));
}

/**
 * Resolves the tax decision for an order-like amount. Thin pass-through so the
 * route layer never touches the engine directly, and so the country lookup stays
 * in one place.
 */
export async function resolveTaxForMarket(
  db: DB,
  input: {
    countryCode: string;
    regionCode?: string | null;
    taxType: string;
    amount: string;
    currencyCode: string;
    recordGap?: boolean;
  },
): Promise<TaxResolution> {
  return resolveTax(db, input);
}

/**
 * Configures a tax rule for a jurisdiction. This is the ONLY writer of a
 * `CONFIGURED` rule, and it demands an explicit rate: the platform will not
 * supply one. Supplying a rate closes (resolves) any open DECISION_REQUIRED gap
 * for that jurisdiction+type.
 */
export async function configureTaxRule(
  db: DB,
  input: {
    countryId: string;
    regionCode?: string | null;
    taxType: string;
    rate: string;
    priceIncludesTax?: boolean;
    appliesTo?: 'BUYER' | 'SELLER';
    providerRef?: string | null;
    notes?: string | null;
    actorId: string;
    ipAddress?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const [country] = await db.select().from(countries).where(eq(countries.id, input.countryId)).limit(1);
  if (!country) throw ApiError.notFound('Country');

  const rate = toDecimal(input.rate);
  if (rate.isNegative() || rate.gte(1)) {
    throw ApiError.validation([
      {
        field: 'rate',
        message: 'Tax rate must be a decimal fraction in [0, 1) (e.g. 0.19 for 19%)',
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  const [existing] = await db
    .select()
    .from(taxJurisdictions)
    .where(and(eq(taxJurisdictions.countryId, input.countryId), eq(taxJurisdictions.taxType, input.taxType)))
    .limit(1);

  const before = existing ?? null;
  const id = existing?.id ?? newId();
  let created = false;

  if (existing) {
    await db
      .update(taxJurisdictions)
      .set({
        regionCode: input.regionCode ?? existing.regionCode,
        status: 'CONFIGURED',
        rate: input.rate,
        priceIncludesTax: input.priceIncludesTax ?? existing.priceIncludesTax,
        appliesTo: input.appliesTo ?? existing.appliesTo,
        providerRef: input.providerRef ?? existing.providerRef,
        notes: input.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(taxJurisdictions.id, existing.id));
  } else {
    created = true;
    await db.insert(taxJurisdictions).values({
      id,
      countryId: input.countryId,
      regionCode: input.regionCode ?? null,
      taxType: input.taxType,
      status: 'CONFIGURED',
      rate: input.rate,
      priceIncludesTax: input.priceIncludesTax ?? false,
      appliesTo: input.appliesTo ?? 'BUYER',
      providerRef: input.providerRef ?? null,
      notes: input.notes ?? null,
      createdById: input.actorId,
    });
  }

  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'TAX.RULE_CONFIGURED',
    entityType: 'COUNTRY',
    entityId: input.countryId,
    before: before
      ? { status: before.status, rate: before.rate, priceIncludesTax: before.priceIncludesTax, appliesTo: before.appliesTo }
      : null,
    after: {
      jurisdictionId: id,
      taxType: input.taxType,
      status: 'CONFIGURED',
      rate: input.rate,
      priceIncludesTax: input.priceIncludesTax ?? false,
      appliesTo: input.appliesTo ?? 'BUYER',
    },
  });

  // A configured rule closes the configuration gap it answers.
  await resolveCountryPolicyGap(db, { countryId: input.countryId, scope: 'TAX', code: input.taxType });

  return { id, created };
}

/**
 * Marks a jurisdiction as deliberately undecided. Used when a market is opened
 * before its tax position is settled: the platform records the open question
 * instead of silently applying nothing (or guessing).
 */
export async function markTaxRuleDecisionRequired(
  db: DB,
  input: {
    countryId: string;
    taxType: string;
    notes?: string | null;
    actorId: string;
    ipAddress?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const [country] = await db.select().from(countries).where(eq(countries.id, input.countryId)).limit(1);
  if (!country) throw ApiError.notFound('Country');

  const [existing] = await db
    .select()
    .from(taxJurisdictions)
    .where(and(eq(taxJurisdictions.countryId, input.countryId), eq(taxJurisdictions.taxType, input.taxType)))
    .limit(1);

  const before = existing ?? null;
  const id = existing?.id ?? newId();
  let created = false;

  if (existing) {
    await db
      .update(taxJurisdictions)
      .set({ status: 'DECISION_REQUIRED', rate: null, notes: input.notes ?? existing.notes, updatedAt: new Date() })
      .where(eq(taxJurisdictions.id, existing.id));
  } else {
    created = true;
    await db.insert(taxJurisdictions).values({
      id,
      countryId: input.countryId,
      taxType: input.taxType,
      status: 'DECISION_REQUIRED',
      rate: null,
      notes: input.notes ?? null,
      createdById: input.actorId,
    });
  }

  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'TAX.DECISION_REQUIRED_RECORDED',
    entityType: 'COUNTRY',
    entityId: input.countryId,
    before: before ? { status: before.status, rate: before.rate } : null,
    after: { jurisdictionId: id, taxType: input.taxType, status: 'DECISION_REQUIRED' },
  });

  return { id, created };
}

export { listTaxJurisdictions };

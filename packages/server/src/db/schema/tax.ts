import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Tax Engine persistence (P1).
 *
 * This layer exists so WASIT can *represent* a tax rule and, just as
 * importantly, represent that no rule has been decided yet. It deliberately
 * ships with no rates: inventing a VAT/GST/sales-tax percentage, a jurisdiction
 * or a filing rule would be fabricating law. Until a jurisdiction is configured
 * (by Admin, or by a licensed tax provider), the engine reports
 * `DECISION_REQUIRED` and records the gap rather than guessing.
 *
 * Nothing here is derived from a payment, settlement or payout state, and no
 * column stores a rate that was not explicitly configured.
 */

/** How a jurisdiction's tax obligation was decided. */
export const taxRuleStatusEnum = pgEnum('tax_rule_status', [
  /** A human/legal decision is still outstanding — the engine must not guess. */
  'DECISION_REQUIRED',
  /** An Admin configured the rule explicitly. */
  'CONFIGURED',
  /** A licensed external tax provider supplies the rule at request time. */
  'PROVIDER_MANAGED',
]);

/**
 * A tax jurisdiction: the unit a tax rule applies to. `countryId` is the
 * primary key of scope; `regionCode` narrows it (a state/province/VAT region),
 * and `taxType` distinguishes the kind of obligation (VAT/GST/SALES_TAX/…).
 *
 * `taxType` is free-form on purpose: the set of taxes is jurisdiction-specific
 * and must not be closed by an enum the platform invents.
 */
export const taxJurisdictions = pgTable(
  'tax_jurisdictions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    countryId: varchar('country_id', { length: 36 }).notNull(),
    /** Optional sub-country scope (state/province/VAT region). */
    regionCode: varchar('region_code', { length: 50 }),
    /** VAT | GST | SALES_TAX | … — jurisdiction-defined, never enumerated here. */
    taxType: varchar('tax_type', { length: 50 }).notNull(),
    status: taxRuleStatusEnum('status').notNull().default('DECISION_REQUIRED'),
    /**
     * Configured rate as a decimal fraction (e.g. 0.19 = 19%). NULL while the
     * rule is undecided — a NULL rate is the honest representation, never 0,
     * because "no tax" and "tax not yet decided" are different facts.
     */
    rate: varchar('rate', { length: 20 }),
    /** Whether the configured rate is already inclusive of the listed price. */
    priceIncludesTax: boolean('price_includes_tax').notNull().default(false),
    /** Which side bears the tax (buyer-paid is the common case, not assumed). */
    appliesTo: varchar('applies_to', { length: 20 }).notNull().default('BUYER'),
    /** Reference to the authority/provider that supplied the rule, if any. */
    providerRef: varchar('provider_ref', { length: 200 }),
    /** Free-form notes captured at decision time (never contains secrets). */
    notes: text('notes'),
    metadata: jsonb('metadata'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    createdById: varchar('created_by_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One rule per (country, region, tax type): a jurisdiction is configured once.
    scopeIdx: uniqueIndex('tax_jurisdictions_scope_idx').on(t.countryId, t.regionCode, t.taxType),
    countryIdx: index('tax_jurisdictions_country_idx').on(t.countryId),
    statusIdx: index('tax_jurisdictions_status_idx').on(t.status),
  }),
);

/**
 * The tax decision recorded against one order.
 *
 * Storing the resolved decision on the order (rather than recomputing it) keeps
 * the historical record honest: if the jurisdiction's rule changes later, past
 * orders still show the tax that was actually applied — and orders processed
 * while the rule was undecided keep their `DECISION_REQUIRED` marker instead of
 * silently acquiring a rate after the fact.
 */
export const orderTaxDecisions = pgTable(
  'order_tax_decisions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    countryId: varchar('country_id', { length: 36 }),
    regionCode: varchar('region_code', { length: 50 }),
    taxType: varchar('tax_type', { length: 50 }),
    status: taxRuleStatusEnum('status').notNull(),
    /** Rate applied at decision time; NULL when the rule was undecided. */
    rate: varchar('rate', { length: 20 }),
    /** Resolved tax amount; NULL (not 0) when undecided. */
    amount: varchar('amount', { length: 20 }),
    currencyCode: varchar('currency_code', { length: 3 }),
    /** Id of the jurisdiction row used, when one existed. */
    jurisdictionId: varchar('jurisdiction_id', { length: 36 }),
    /** Id of the `country_policy_gaps` row opened for an undecided rule. */
    policyGapId: varchar('policy_gap_id', { length: 36 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: uniqueIndex('order_tax_decisions_order_idx').on(t.orderId),
    statusIdx: index('order_tax_decisions_status_idx').on(t.status),
  }),
);

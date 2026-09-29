import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DB } from '../db/client';

/**
 * Currency scoping for financial aggregates.
 *
 * A money KPI is only meaningful in one currency. Without an Exchange Rate
 * Engine there is no rate to convert with, and inventing one would present a
 * fabricated figure as a fact. So every aggregate is scoped to a single
 * currency and the currencies it left out are published alongside it, rather
 * than silently summed into the same number.
 *
 * `fxApplied` is always false: nothing here converts. When a caller genuinely
 * needs a cross-currency total, that is a DECISION_REQUIRED (a rate source must
 * be contracted and configured) — not a calculation to guess.
 */
export interface CurrencyScope {
  /** The one currency the financial KPIs are expressed in. */
  currencyCode: string;
  /** Currencies present in the source data that were excluded from the totals. */
  excludedCurrencies: string[];
  /** True when money rows in more than one currency exist. */
  multiCurrency: boolean;
  /** Always false — no conversion is performed anywhere in this module. */
  fxApplied: false;
  /** Human-readable explanation, suitable for surfacing in an API response. */
  note: string;
}

export interface CurrencySource {
  table: PgTable;
  column: PgColumn;
}

/**
 * Resolves the currency scope for an aggregate: which currency the totals are
 * in, and which currencies were therefore excluded. Reads only `distinct`
 * currency codes — it never converts and never needs a rate.
 */
export async function resolveCurrencyScope(
  db: DB,
  currencyCode: string,
  sources: CurrencySource[],
): Promise<CurrencyScope> {
  const present = new Set<string>();
  await Promise.all(
    sources.map(async ({ table, column }) => {
      const rows = await db.selectDistinct({ c: column }).from(table);
      for (const r of rows) {
        const code = (r as { c: unknown }).c;
        if (code != null && String(code).trim() !== '') present.add(String(code));
      }
    }),
  );

  const excludedCurrencies = [...present].filter((c) => c !== currencyCode).sort();
  return {
    currencyCode,
    excludedCurrencies,
    multiCurrency: excludedCurrencies.length > 0,
    fxApplied: false,
    note:
      excludedCurrencies.length > 0
        ? `Scoped to ${currencyCode}; rows in ${excludedCurrencies.join(', ')} are excluded, not converted ` +
          '(no exchange rate is configured, so no conversion is applied).'
        : `Scoped to ${currencyCode}; no other currency is present in the source data.`,
  };
}

/**
 * DECISION_REQUIRED for a cross-currency total. Returned instead of a guessed
 * number whenever a caller asks for something that can only be answered with an
 * exchange rate the platform does not have.
 */
export interface DecisionRequired {
  status: 'DECISION_REQUIRED';
  reason: string;
  excludedCurrencies: string[];
}

export function crossCurrencyDecisionRequired(
  targetCurrency: string,
  excludedCurrencies: string[],
): DecisionRequired {
  return {
    status: 'DECISION_REQUIRED',
    reason:
      `A total in ${targetCurrency} cannot be produced because rows in ` +
      `${excludedCurrencies.join(', ')} exist and no trusted exchange rate is configured. ` +
      'Provide rates via the exchange_rates source (or a contracted FX provider) before this figure is reported.',
    excludedCurrencies,
  };
}

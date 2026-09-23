import { and, eq, sql } from 'drizzle-orm';
import type { Decimal } from 'decimal.js';
import type { DB } from '../db/client';
import { transactionLedger } from '../db/schema/commerce';
import { roundMoney, toDecimal } from './money';

/**
 * Ledger flow totals for the money WASIT takes and gives back, per currency.
 *
 * Sign convention (single source of truth for every revenue surface):
 *   - COMMISSION and PAYMENT_FEE are reported as the POSITIVE magnitude of the
 *     net flow WASIT earns on transactions. `direction` in the ledger encodes
 *     payer → beneficiary, not P&L sign, so a seller/buyer commission debit to
 *     WASIT must not surface as negative revenue elsewhere.
 *   - REFUNDS are reported as the POSITIVE magnitude that REDUCES net revenue.
 *   - Refund reversals are written as CREDIT entries on COMMISSION/PAYMENT_FEE
 *     (see payments.createRefund), which correctly lower these magnitudes.
 *
 * Amounts are rounded to the project's money precision (4 dp, ROUND_HALF_UP)
 * so every endpoint publishes the same, reconciled figure.
 */
export interface LedgerFlowTotals {
  commission: Decimal;
  paymentFees: Decimal;
  refunds: Decimal;
  settlement: Decimal;
}

/** Net (CREDIT − DEBIT) magnitude for one entry type and currency. */
async function flowMagnitude(db: DB, entryType: string, currencyCode: string): Promise<Decimal> {
  const rows = await db
    .select({
      credit: sql<string>`coalesce(sum(case when direction='CREDIT' then amount else 0 end),0)::text`,
      debit: sql<string>`coalesce(sum(case when direction='DEBIT' then amount else 0 end),0)::text`,
    })
    .from(transactionLedger)
    .where(and(eq(transactionLedger.entryType, entryType as never), eq(transactionLedger.currencyCode, currencyCode)));
  const net = toDecimal(rows[0]?.credit ?? 0).minus(toDecimal(rows[0]?.debit ?? 0));
  return roundMoney(net.abs());
}

export async function ledgerFlowTotals(db: DB, currencyCode: string): Promise<LedgerFlowTotals> {
  const [commission, paymentFees, refunds, settlement] = await Promise.all([
    flowMagnitude(db, 'COMMISSION', currencyCode),
    flowMagnitude(db, 'PAYMENT_FEE', currencyCode),
    flowMagnitude(db, 'REFUND', currencyCode),
    flowMagnitude(db, 'SETTLEMENT', currencyCode),
  ]);
  return { commission, paymentFees, refunds, settlement };
}

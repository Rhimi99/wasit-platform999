import { and, desc, eq, sql } from 'drizzle-orm';
import type { Decimal } from 'decimal.js';
import type { DB } from '../../db/client';
import { transactions } from '../../db/schema/commerce';
import { invoices } from '../../db/schema/subscriptions';
import { aiUsage } from '../../db/schema/ai';
import { revenueAccounts, scenarioReports } from '../../db/schema/revenue';
import { roundMoney, toDecimal } from '../../lib/money';
import { ledgerFlowTotals } from '../../lib/ledger-flows';
import { newId } from '../../lib/ids';
import type { RevenueProfitabilityReport, ScenarioInput, ScenarioResult } from './types';

// ---------------------------------------------------------------------------
// Revenue & Profitability — real-data aggregates.
//
// No Wallet / No User Funds: this module only READS the transactional tables
// (transactions, transaction_ledger, invoices, ai_usage, revenue_accounts).
// It never executes INSERT/UPDATE/DELETE against order/ledger/payment data.
//
// Currency-scoping: without an Exchange Rate Engine, we never mix currencies.
// Every aggregate is filtered to a SINGLE currency (default 'TND'). Rows in
// other currencies are excluded, never converted, and the limitation is echoed
// in `basedOn`.
//
// Advertising: the current `ledger_entry_type` enum has no advertising value,
// so WASIT advertising revenue cannot be proven from the ledger today. We
// therefore report advertisingRevenue = 0 (campaigns.spent is advertiser cost,
// not WASIT revenue) until a real advertising ledger/revenue source exists.
//
// revenue_accounts / scenario_reports: these tables are NOT yet created by any
// migration. The code only reaches them once the matching migration exists;
// until then the queries would target tables absent from the database.
// ---------------------------------------------------------------------------

const NUM_TO_DEC = (v: string | number | Decimal): string => roundMoney(v).toFixed(4);

/** GMV for one currency, from transactions.total_value. */
async function gmvTotal(db: DB, currencyCode: string): Promise<string> {
  const rows = await db
    .select({ v: sql<string>`coalesce(sum(${transactions.totalValue}),0)::text` })
    .from(transactions)
    .where(eq(transactions.currencyCode, currencyCode));
  return NUM_TO_DEC(rows[0]?.v ?? 0);
}

/** Sum of paid invoices for one currency (subscription revenue). */
async function subscriptionRevenue(db: DB, currencyCode: string): Promise<string> {
  const rows = await db
    .select({ v: sql<string>`coalesce(sum(${invoices.amount}),0)::text` })
    .from(invoices)
    .where(and(eq(invoices.status, 'PAID'), eq(invoices.currencyCode, currencyCode)));
  return NUM_TO_DEC(rows[0]?.v ?? 0);
}

/** AI model cost for one currency (ai_usage.cost). */
async function aiModelCostTotal(db: DB, currencyCode: string): Promise<string> {
  const rows = await db
    .select({ v: sql<string>`coalesce(sum(${aiUsage.cost}),0)::text` })
    .from(aiUsage)
    .where(eq(aiUsage.currencyCode, currencyCode));
  return NUM_TO_DEC(rows[0]?.v ?? 0);
}

/**
 * Operational revenue/cost from revenue_accounts (one currency).
 * NOTE: table does not exist until the matching migration is applied.
 */
async function operationalTotals(db: DB, currencyCode: string): Promise<{ revenue: string; cost: string }> {
  const rows = await db
    .select({
      lineType: revenueAccounts.lineType,
      v: sql<string>`coalesce(sum(${revenueAccounts.amount}),0)::text`,
    })
    .from(revenueAccounts)
    .where(eq(revenueAccounts.currencyCode, currencyCode))
    .groupBy(revenueAccounts.lineType);
  let revenue = toDecimal(0);
  let cost = toDecimal(0);
  for (const r of rows) {
    const amt = toDecimal(r.v ?? 0);
    if (r.lineType === 'REVENUE') revenue = revenue.plus(amt);
    else cost = cost.plus(amt);
  }
  return { revenue: NUM_TO_DEC(revenue), cost: NUM_TO_DEC(cost) };
}

export async function getRevenueProfitability(db: DB, currencyCode = 'TND'): Promise<RevenueProfitabilityReport> {
  const [flows, aiModelCosts, operational] = await Promise.all([
    ledgerFlowTotals(db, currencyCode),
    aiModelCostTotal(db, currencyCode),
    operationalTotals(db, currencyCode),
  ]);
  const subscriptionRev = await subscriptionRevenue(db, currencyCode);

  // No advertising ledger entry type exists today, so this is provably 0.
  const advertisingRevenue = '0.0000';

  // Amounts already come back as positive magnitudes under the shared ledger
  // sign convention (lib/ledger-flows), so no per-field sign patching is needed
  // here — that patching is what made this endpoint disagree with the admin
  // revenue breakdown.
  const commissionD = flows.commission;
  const paymentFeesD = flows.paymentFees;
  const refundsD = flows.refunds;
  const subscriptionD = toDecimal(subscriptionRev);
  const advertisingD = toDecimal(advertisingRevenue);
  const otherRevenueD = toDecimal(operational.revenue);
  const aiCostsD = toDecimal(aiModelCosts);
  const operationalD = toDecimal(operational.cost);
  const otherCostsD = toDecimal(0); // no other real cost source; we don't invent.

  const grossRevenue = commissionD.plus(subscriptionD).plus(advertisingD).plus(otherRevenueD);
  const totalCosts = paymentFeesD.plus(refundsD).plus(aiCostsD).plus(operationalD).plus(otherCostsD);
  const netRevenue = grossRevenue.minus(totalCosts);

  const basedOn = [
    `transaction_ledger COMMISSION (currency=${currencyCode})`,
    `transaction_ledger PAYMENT_FEE (currency=${currencyCode})`,
    `transaction_ledger REFUND (currency=${currencyCode})`,
    `invoices PAID (currency=${currencyCode})`,
    `ai_usage.cost (currency=${currencyCode})`,
    'revenue_accounts (table not migrated yet; returns empty until migration is applied)',
  ];

  const limitations: string[] = [
    `Currency-scoped to ${currencyCode}; rows in other currencies are excluded (no Exchange Rate Engine yet).`,
    'advertisingRevenue=0: ledger_entry_type has no advertising value, so advertising revenue cannot be proven from existing data. campaigns.spent (advertiser cost) is intentionally NOT counted as WASIT revenue.',
    'revenue_accounts / scenario_reports tables do not exist until their migration is applied; operational totals and scenario persistence are unavailable until then.',
    'invoices.status varchar(30) compared with string "PAID" per existing invoices schema.',
  ];

  return {
    currencyCode,
    grossRevenue: NUM_TO_DEC(grossRevenue),
    commission: NUM_TO_DEC(commissionD),
    subscriptionRevenue: NUM_TO_DEC(subscriptionD),
    advertisingRevenue: NUM_TO_DEC(advertisingD),
    otherRevenue: NUM_TO_DEC(otherRevenueD),
    totalCosts: NUM_TO_DEC(totalCosts),
    paymentFees: NUM_TO_DEC(paymentFeesD),
    aiModelCosts: NUM_TO_DEC(aiCostsD),
    refunds: NUM_TO_DEC(refundsD),
    operationalExpenses: NUM_TO_DEC(operationalD),
    otherCosts: NUM_TO_DEC(otherCostsD),
    netRevenue: NUM_TO_DEC(netRevenue),
    contributionMargin: grossRevenue.isZero()
      ? '0.0000'
      : NUM_TO_DEC(grossRevenue.minus(totalCosts).dividedBy(grossRevenue).mul(100)),
    basedOn: [...basedOn, ...limitations],
  };
}

// ---------------------------------------------------------------------------
// Scenario simulation — pure calculation, NO writes to any transactional table.
// Optional persistence lives in `scenario_reports` (NOT yet migrated); it will
// only ever touch that table, never orders/ledger/payments/subscriptions.
// ---------------------------------------------------------------------------

export function calculateScenario(input: ScenarioInput): ScenarioResult {
  const volume = toDecimal(input.transactionVolume || 0);
  const rate = toDecimal(input.commissionRate || '0').dividedBy(100);
  const feeRate = toDecimal(input.paymentFeeRate || '0').dividedBy(100);
  const refundRate = toDecimal(input.refundRate || '0').dividedBy(100);

  const gross = volume.mul(rate);
  const paymentFees = volume.mul(feeRate);
  const refunds = volume.mul(refundRate);
  const ai = toDecimal(input.aiCosts || 0);
  const opEx = toDecimal(input.operationalExpenses || 0);
  const subscription = toDecimal(input.subscriptionRevenue || 0);
  const advertising = toDecimal(input.advertisingRevenue || 0);

  const totalRevenue = gross.plus(subscription).plus(advertising);
  const totalCosts = paymentFees.plus(refunds).plus(ai).plus(opEx);
  const net = totalRevenue.minus(totalCosts);
  const margin = totalRevenue.isZero() ? toDecimal(0) : net.dividedBy(totalRevenue).mul(100);

  return {
    outputId: newId(),
    grossRevenue: NUM_TO_DEC(totalRevenue),
    totalCosts: NUM_TO_DEC(totalCosts),
    netRevenue: NUM_TO_DEC(net),
    contributionMargin: NUM_TO_DEC(margin),
    comment: `Scenario simulation only — does not modify any live data. Base currency: ${input.currencyCode || 'TND'}.`,
  };
}

// ---------------------------------------------------------------------------
// Saved scenario reports (scenario_reports). Read-only listing, owner-scoped.
// NOTE: table does not exist until the matching migration is applied.
// ---------------------------------------------------------------------------

export async function listScenarioReports(
  db: DB,
  createdById: string,
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  const rows = await db
    .select({
      id: scenarioReports.id,
      name: scenarioReports.name,
      createdAt: scenarioReports.createdAt,
    })
    .from(scenarioReports)
    .where(eq(scenarioReports.createdById, createdById))
    .orderBy(desc(scenarioReports.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
  }));
}
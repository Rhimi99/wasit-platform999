import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { roundMoney, toDecimal } from '../../lib/money';

// ---------------------------------------------------------------------------
// Unit economics — CAC / LTV / contribution margin, computed from real tables.
//
// No invented numbers. Every input is either an aggregate of real transactional
// data or a real accounting line in `revenue_accounts`:
//   - gross margin contribution per order = commission + payment_fee (WASIT's
//     take-rate on an order; read from `orders`, not the ledger, so a pending
//     refund does not silently rewrite historical margin).
//   - new customers in window = distinct buyers whose FIRST order falls in the
//     window (a real cohort, not a guess).
//   - marketing spend = SUM(revenue_accounts.amount) WHERE line_type='COST'
//     AND category='MARKETING' in the same currency and window.
//
// LTV is deliberately reported twice: a REALIZED average (actual gross margin
// per customer to date) and a PROJECTED value from an explicit, echoed model.
// The realized figure is the auditable one; the projected one never masquerades
// as fact (`assumptions` are returned with it).
//
// Currency-scoped: without an Exchange Rate Engine we never mix currencies.
// Rows in other currencies are excluded, never converted, and that limitation
// is reported in `basedOn`.
// ---------------------------------------------------------------------------

const NUM_TO_DEC = (v: string | number | ReturnType<typeof toDecimal>): string => roundMoney(v).toFixed(4);

function sinceDays(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface ProjectionAssumptions {
  /** Assumed additional months an acquired customer keeps buying. */
  assumedRetentionMonths: number;
  /** Assumed orders per active month (repeat frequency). */
  assumedOrdersPerMonth: number;
}

export interface UnitEconomics {
  currencyCode: string;
  windowDays: number;

  // --- Acquisition ---
  newCustomers: number; // distinct buyers whose first order is in the window
  marketingSpend: string; // revenue_accounts COST/MARKETING in window
  cac: string | null; // marketingSpend / newCustomers (null when no new customers)

  // --- Realized value (auditable) ---
  customersWithOrders: number; // distinct buyers ever, in this currency
  paidOrders: number;
  grossMarginTotal: string; // sum(commission + payment_fee) across orders
  grossMarginPerOrder: string;
  arpu: string; // grossMarginTotal / customersWithOrders
  ltvRealized: string; // realized margin per customer, no projection

  // --- Projected value (explicit model, not fact) ---
  ltvProjected: string;
  ltvCacRatio: string | null; // ltvRealized / cac, null when cac is null or 0
  assumptions: ProjectionAssumptions;

  // --- Perspective ---
  contributionMarginPct: string; // gross margin as a % of GMV
  gmv: string;

  basedOn: string[];
}

export interface RawUnitEconomicsInput {
  currencyCode: string;
  windowDays: number;
  newCustomers: number;
  marketingSpend: string;
  customersWithOrders: number;
  paidOrders: number;
  grossMarginTotal: string;
  gmv: string;
}

/**
 * Pure derivation of the reported metrics from raw aggregates. Extracted so the
 * arithmetic (division-by-zero, ratio, margin %) is unit-testable exactly and
 * without a database.
 */
export function deriveUnitEconomics(
  raw: RawUnitEconomicsInput,
  assumptions: ProjectionAssumptions,
): UnitEconomics {
  const marketingSpend = toDecimal(raw.marketingSpend);
  const grossMarginTotal = toDecimal(raw.grossMarginTotal);
  const gmv = toDecimal(raw.gmv);

  const cac = raw.newCustomers > 0 ? marketingSpend.dividedBy(raw.newCustomers) : null;
  const arpu = raw.customersWithOrders > 0
    ? grossMarginTotal.dividedBy(raw.customersWithOrders)
    : toDecimal(0);
  const grossMarginPerOrder = raw.paidOrders > 0
    ? grossMarginTotal.dividedBy(raw.paidOrders)
    : toDecimal(0);

  const ltvProjected = grossMarginPerOrder
    .mul(assumptions.assumedOrdersPerMonth)
    .mul(assumptions.assumedRetentionMonths);

  const ltvCacRatio = cac && !cac.isZero() && !cac.isNegative() ? arpu.dividedBy(cac) : null;

  const contributionMarginPct = gmv.isZero()
    ? toDecimal(0)
    : grossMarginTotal.dividedBy(gmv).mul(100);

  return {
    currencyCode: raw.currencyCode,
    windowDays: raw.windowDays,
    newCustomers: raw.newCustomers,
    marketingSpend: NUM_TO_DEC(marketingSpend),
    cac: cac ? NUM_TO_DEC(cac) : null,
    customersWithOrders: raw.customersWithOrders,
    paidOrders: raw.paidOrders,
    grossMarginTotal: NUM_TO_DEC(grossMarginTotal),
    grossMarginPerOrder: NUM_TO_DEC(grossMarginPerOrder),
    arpu: NUM_TO_DEC(arpu),
    ltvRealized: NUM_TO_DEC(arpu),
    ltvProjected: NUM_TO_DEC(ltvProjected),
    ltvCacRatio: ltvCacRatio ? NUM_TO_DEC(ltvCacRatio) : null,
    assumptions,
    contributionMarginPct: NUM_TO_DEC(contributionMarginPct),
    gmv: NUM_TO_DEC(gmv),
    basedOn: unitEconomicsSources(raw.currencyCode),
  };
}

function unitEconomicsSources(currencyCode: string): string[] {
  return [
    `orders (buyer cohort, currency=${currencyCode})`,
    `orders.commission + orders.buyer_commission + orders.payment_fee (currency=${currencyCode})`,
    `orders.items_total (GMV, currency=${currencyCode})`,
    `revenue_accounts COST/MARKETING (currency=${currencyCode})`,
    `Currency-scoped to ${currencyCode}; rows in other currencies are excluded (no Exchange Rate Engine yet).`,
    'ltvRealized is actual gross margin per customer to date; ltvProjected uses the explicit assumptions below and is NOT a fact.',
    'marketingSpend only counts WASIT-own MARKETING cost lines; advertiser campaign budgets (campaigns.spent) are advertising revenue, not acquisition cost.',
  ];
}

export async function getUnitEconomics(
  db: DB,
  currencyCode = 'TND',
  windowDays = 30,
  assumptions: ProjectionAssumptions = { assumedRetentionMonths: 12, assumedOrdersPerMonth: 1 },
): Promise<UnitEconomics> {
  const since = sinceDays(windowDays);

  const stats = (await db.execute<{
    gmv: string;
    margin: string;
    customers: number;
    paid_orders: number;
  }>(sql`
    select
      coalesce(sum(items_total), 0)::text as gmv,
      coalesce(sum(commission + payment_fee), 0)::text as margin,
      count(distinct buyer_id)::int as customers,
      count(*) filter (where payment_status = 'PAID')::int as paid_orders
    from orders
    where currency_code = ${currencyCode}
  `)) as unknown as { rows: { gmv: string; margin: string; customers: number; paid_orders: number }[] };

  const newCustomersRes = (await db.execute<{ v: number }>(sql`
    select count(*)::int as v
    from (
      select buyer_id, min(created_at) as first_order_at
      from orders
      where currency_code = ${currencyCode}
      group by buyer_id
    ) first_orders
    where first_orders.first_order_at >= ${since}
  `)) as unknown as { rows: { v: number }[] };

  const marketingRes = (await db.execute<{ v: string }>(sql`
    select coalesce(sum(amount), 0)::text as v
    from revenue_accounts
    where currency_code = ${currencyCode}
      and line_type = 'COST'
      and category = 'MARKETING'
      and occurred_at >= ${since}
  `)) as unknown as { rows: { v: string }[] };

  const row = stats.rows?.[0] ?? { gmv: '0', margin: '0', customers: 0, paid_orders: 0 };

  return deriveUnitEconomics(
    {
      currencyCode,
      windowDays,
      newCustomers: Number(newCustomersRes.rows?.[0]?.v ?? 0),
      marketingSpend: marketingRes.rows?.[0]?.v ?? '0',
      customersWithOrders: Number(row.customers),
      paidOrders: Number(row.paid_orders),
      grossMarginTotal: row.margin,
      gmv: row.gmv,
    },
    assumptions,
  );
}

export interface CohortRow {
  month: string; // YYYY-MM
  customers: number;
  gmv: string;
  grossMargin: string;
}

/** Monthly acquisition cohorts with the GMV/margin each cohort generated. */
export async function getCustomerCohorts(db: DB, currencyCode = 'TND', months = 6): Promise<CohortRow[]> {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);

  const rows = (await db.execute<{
    month: string;
    customers: number;
    gmv: string;
    gross_margin: string;
  }>(sql`
    with first_orders as (
      select buyer_id, min(created_at) as first_order_at
      from orders
      where currency_code = ${currencyCode}
      group by buyer_id
    )
    select
      to_char(date_trunc('month', f.first_order_at), 'YYYY-MM') as month,
      count(distinct f.buyer_id)::int as customers,
      coalesce(sum(o.items_total), 0)::text as gmv,
      coalesce(sum(o.commission + o.buyer_commission + o.payment_fee), 0)::text as gross_margin
    from first_orders f
    left join orders o
      on o.buyer_id = f.buyer_id and o.currency_code = ${currencyCode}
    where f.first_order_at >= ${since}
    group by date_trunc('month', f.first_order_at)
    order by date_trunc('month', f.first_order_at) desc
  `)) as unknown as { rows: { month: string; customers: number; gmv: string; gross_margin: string }[] };

  return (rows.rows ?? []).map((r) => ({
    month: r.month,
    customers: Number(r.customers),
    gmv: NUM_TO_DEC(r.gmv),
    grossMargin: NUM_TO_DEC(r.gross_margin),
  }));
}
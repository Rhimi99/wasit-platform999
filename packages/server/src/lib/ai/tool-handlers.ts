import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { products, categories } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems, transactions, transactionLedger } from '../../db/schema/commerce';
import { agentTasks } from '../../db/schema/agents';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages } from '../../db/schema/disputes';
import { users } from '../../db/schema/auth';
import { commissionPolicies } from '../../db/schema/engine';
import { dailyKpis } from '../../db/schema/analytics';
import { ledgerFlowTotals } from '../../lib/ledger-flows';
import { resolveOwnedSellerIds } from '../../lib/seller-ownership';
import { getAgentRunContext } from './agent-run-context';
import {
  COMPLIANCE_READ_PLATFORM,
  DISPUTES_READ_SUMMARY,
  FINANCE_READ_LEDGER,
  MARKET_READ_OVERVIEW,
  MARKET_READ_OWN,
  OPERATIONS_READ_HEALTH,
  PAYMENTS_READ_SETTLEMENTS,
  PLATFORM_METRICS,
  PLATFORM_READ_ORDERS,
  RISK_READ_OVERVIEW,
  registeredToolIds,
} from './tool-registry';

/**
 * Tool Gateway handlers (AI-02.1).
 *
 * Each registered tool has exactly one real, DB-backed, read-only handler here.
 * Handlers receive only the ALREADY-VALIDATED args (the gateway validates the
 * schema first) and return a plain data payload. They never take a user id or
 * scope from the args: the gateway has already established, server-side, that
 * the requester is an admin for a platform-scoped tool, so there is no
 * caller-supplied scope to widen.
 *
 * The module asserts at load that every registered tool has a handler, so a tool
 * can never be advertised without a linked implementation.
 */

export type ToolHandler = (db: DB, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Safely parses a numeric DB field (numeric/text/number) to a plain number. */
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** Ledger flow totals for one currency, or a cross-currency magnitude when none. */
async function ledgerFlows(db: DB, currencyCode?: string): Promise<Record<string, string>> {
  if (currencyCode) {
    const t = await ledgerFlowTotals(db, currencyCode);
    return {
      commission: t.commission.toString(),
      paymentFees: t.paymentFees.toString(),
      refunds: t.refunds.toString(),
      settlement: t.settlement.toString(),
    };
  }
  const rows = await db
    .select({
      entryType: transactionLedger.entryType,
      credit: sql<string>`coalesce(sum(case when direction='CREDIT' then amount else 0 end),0)::text`,
      debit: sql<string>`coalesce(sum(case when direction='DEBIT' then amount else 0 end),0)::text`,
    })
    .from(transactionLedger)
    .groupBy(transactionLedger.entryType);
  const magnitude = (type: string): string => {
    const r = rows.find((x) => x.entryType === type);
    const net = toNum(r?.credit) - toNum(r?.debit);
    return Math.abs(net).toFixed(4);
  };
  return {
    commission: magnitude('COMMISSION'),
    paymentFees: magnitude('PAYMENT_FEE'),
    refunds: magnitude('REFUND'),
    settlement: magnitude('SETTLEMENT'),
  };
}

/** Platform KPIs — cross-owner aggregates (admin-only). */
const platformMetrics: ToolHandler = async (db, args) => {
  const limit = Number(args.limit ?? 5);
  const [usersCount, productsCount, suppliersCount, merchantsCount, companiesCount, ordersCount, gmv, revenue, avgBasket, topProducts, kpis] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants),
    db.select({ v: sql<number>`count(*)::int` }).from(companies),
    db.select({ v: sql<number>`count(*)::int` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(commission),0)::text` }).from(orders),
    db.select({ v: sql<string>`round(coalesce(avg(items_total),0),2)::text` }).from(orders),
    db
      .select({ name: products.name, qty: sql<number>`sum(${orderItems.quantity})::int`, revenue: sql<string>`sum(${orderItems.lineTotal})::text` })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .groupBy(products.name)
      .orderBy(sql`sum(${orderItems.quantity}) desc`)
      .limit(limit),
    db
      .select({ date: dailyKpis.date, metricName: dailyKpis.metricName, metricValue: dailyKpis.metricValue, dimensions: dailyKpis.dimensions })
      .from(dailyKpis)
      .orderBy(desc(dailyKpis.date))
      .limit(7),
  ]);

  return {
    scope: 'platform',
    snapshot: {
      users: toNum(usersCount[0]?.v),
      products: toNum(productsCount[0]?.v),
      suppliers: toNum(suppliersCount[0]?.v),
      merchants: toNum(merchantsCount[0]?.v),
      companies: toNum(companiesCount[0]?.v),
      orders: toNum(ordersCount[0]?.v),
      gmv: gmv[0]?.v ?? '0',
      commission: revenue[0]?.v ?? '0',
      avgBasket: avgBasket[0]?.v ?? '0',
      topProducts: topProducts.filter((p) => p.name !== null).map((p) => ({ name: p.name ?? '', qty: toNum(p.qty), revenue: String(p.revenue ?? '0') })),
      dailyKpis: kpis.map((k) => ({ date: k.date.toISOString(), metric: k.metricName, value: String(k.metricValue), dimensions: k.dimensions ?? null })),
    },
  };
};

/** Platform order summary — pipeline counts and totals (admin-only). */
const platformReadOrders: ToolHandler = async (db) => {
  const [pipeline, totals, gmv, commission] = await Promise.all([
    db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status),
    db.select({ v: sql<number>`count(*)::int` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(commission),0)::text` }).from(orders),
  ]);
  return {
    orderPipeline: pipeline.map((o) => ({ status: o.status, count: Number(o.count) })),
    totals: {
      orders: toNum(totals[0]?.v),
      gmv: gmv[0]?.v ?? '0',
      commission: commission[0]?.v ?? '0',
    },
  };
};

/** Operational health — failed tasks, open disputes, low stock (admin-only). */
const operationsReadHealth: ToolHandler = async (db) => {
  const [orderPipeline, failedTasks, openDisputes, lowStock] = await Promise.all([
    db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status),
    db.select({ v: sql<number>`count(*)::int` }).from(agentTasks).where(eq(agentTasks.status, 'failed')),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(inArray(disputes.status, ['OPEN', 'UNDER_REVIEW'])),
    db.execute<{ count: number }>(sql`select count(*)::int as count from inventory_items where (quantity - reserved_quantity) <= low_stock_threshold`),
  ]);
  const lowStockRows = (lowStock as { rows?: { count: number }[] }).rows ?? [];
  return {
    orderPipeline: orderPipeline.map((o) => ({ status: o.status, count: Number(o.count) })),
    failedAgentTasks: toNum(failedTasks[0]?.v),
    openDisputes: toNum(openDisputes[0]?.v),
    lowStockItems: Number(lowStockRows[0]?.count ?? 0),
  };
};

/** Risk overview — top profiles and recent events (admin-only). */
const riskReadOverview: ToolHandler = async (db, args) => {
  const limit = Number(args.limit ?? 10);
  const [profiles, events, totalEvents] = await Promise.all([
    db.select().from(riskProfiles).orderBy(desc(riskProfiles.currentScore)).limit(limit),
    db.select().from(riskEvents).orderBy(desc(riskEvents.createdAt)).limit(30),
    db.select({ v: sql<number>`count(*)::int` }).from(riskEvents),
  ]);
  const facts = {
    topProfiles: profiles.map((p) => ({ userId: p.userId, score: p.currentScore, level: p.level, flags: p.flags })),
    recentEvents: events.map((e) => ({
      userId: e.userId,
      type: e.eventType,
      severity: e.severity,
      score: e.riskScore,
      reasonCode: e.reasonCode,
      recommendedAction: e.recommendedAction,
      createdAt: e.createdAt.toISOString(),
    })),
    totalRiskEvents: toNum(totalEvents[0]?.v),
  };
  const severeEvents = events.filter((e) => e.severity === 'SEVERE' || e.severity === 'HIGH').length;
  return {
    snapshot: facts,
    riskPosture: {
      severeEvents,
      note:
        severeEvents > 0
          ? `${severeEvents} severe/high-risk event(s) recorded. Recommend review and mitigation.`
          : 'No severe risk events at the moment.',
    },
  };
};

/** Dispute summary — open disputes and recent messages (admin-only). */
const disputesReadSummary: ToolHandler = async (db, args) => {
  const limit = Number(args.limit ?? 5);
  const [openDisputes, allDisputes, recentMessages, openCount] = await Promise.all([
    db
      .select({
        id: disputes.id,
        disputeNumber: disputes.disputeNumber,
        status: disputes.status,
        reasonCode: disputes.reasonCode,
        assignedToId: disputes.assignedToId,
        createdAt: disputes.createdAt,
      })
      .from(disputes)
      .where(eq(disputes.status, 'OPEN')),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes),
    db
      .select({ id: disputeMessages.id, senderId: disputeMessages.senderId, body: disputeMessages.body })
      .from(disputeMessages)
      .orderBy(desc(disputeMessages.createdAt))
      .limit(limit),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(eq(disputes.status, 'OPEN')),
  ]);
  const openN = toNum(openCount[0]?.v);
  return {
    snapshot: {
      totalDisputes: toNum(allDisputes[0]?.v),
      openDisputes: openDisputes.map((d) => ({
        id: d.id,
        disputeNumber: d.disputeNumber,
        reasonCode: d.reasonCode,
        status: d.status,
        assignedToId: d.assignedToId,
        createdAt: d.createdAt.toISOString(),
      })),
      openCount: openN,
      recentMessages: recentMessages.map((m) => ({ senderId: m.senderId, body: m.body.slice(0, 140) })),
    },
    recommendation:
      openN > 0
        ? `There are ${openN} open dispute(s). Prioritise responses and keep evidence organised per dispute.`
        : 'No open disputes — recommend ongoing mediation protocol.',
  };
};

/** Payment/settlement status — intents, webhooks, payouts (admin-only). */
const paymentsReadSettlements: ToolHandler = async (db) => {
  const [intentStatus, webhookStatus, payoutStatus] = await Promise.all([
    db.select({ status: transactions.status, count: sql<number>`count(*)::int` }).from(transactions).groupBy(transactions.status),
    db.execute<{ status: string; count: number }>(sql`select status, count(*)::int as count from payment_webhook_events group by status`),
    db.execute<{ status: string; count: number }>(sql`select status, count(*)::int as count from payouts group by status`),
  ]);
  const rowsOf = (r: unknown): { status: string; count: number }[] => ((r as { rows?: { status: string; count: number }[] }).rows ?? []);
  const webhooks = rowsOf(webhookStatus);
  const payoutsRows = rowsOf(payoutStatus);
  return {
    paymentIntentStatus: intentStatus.map((s) => ({ status: s.status, count: Number(s.count) })),
    webhookStatus: webhooks,
    payoutStatus: payoutsRows,
    anomalies: {
      deadLetteredWebhooks: webhooks.find((w) => w.status === 'DEAD_LETTERED')?.count ?? 0,
      failedPayouts: payoutsRows.find((p) => p.status === 'FAILED')?.count ?? 0,
    },
    note: 'Settlement and payout execution is an approved action; this tool only reports.',
  };
};

/** Financial ledger summary — flows, commission policies, recent entries (admin-only). */
const financeReadLedger: ToolHandler = async (db, args) => {
  const currency = typeof args.currencyCode === 'string' ? (args.currencyCode as string) : undefined;
  const limit = Number(args.limit ?? 15);
  const flows = await ledgerFlows(db, currency);
  const [policies, recentLedger] = await Promise.all([
    db.select().from(commissionPolicies).where(eq(commissionPolicies.isActive, true)).limit(20),
    db
      .select({ entryType: transactionLedger.entryType, direction: transactionLedger.direction, amount: transactionLedger.amount, currencyCode: transactionLedger.currencyCode, createdAt: transactionLedger.createdAt })
      .from(transactionLedger)
      .orderBy(desc(transactionLedger.createdAt))
      .limit(limit),
  ]);
  return {
    currencyCode: currency ?? 'ALL',
    flows,
    activeCommissionPolicies: policies.map((p) => ({
      id: p.id,
      name: p.name,
      policyType: p.policyType,
      rate: p.rate,
      sellerRate: p.sellerRate,
      buyerRate: p.buyerRate,
    })),
    recentLedger: recentLedger.map((l) => ({
      entryType: l.entryType,
      direction: l.direction,
      amount: String(l.amount),
      currencyCode: l.currencyCode,
      createdAt: l.createdAt.toISOString(),
    })),
    note: 'Commission and payment fees are separate flows; funds movement requires an approved payout/settlement.',
  };
};

/** Platform compliance scan — unverified entities and open disputes (admin-only). */
const complianceReadPlatform: ToolHandler = async (db) => {
  const [unverifiedSuppliers, unverifiedMerchants, unverifiedCompanies, openDisputes] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(inArray(disputes.status, ['OPEN', 'UNDER_REVIEW'])),
  ]);
  return {
    scope: 'platform',
    unverified: {
      suppliers: toNum(unverifiedSuppliers[0]?.v),
      merchants: toNum(unverifiedMerchants[0]?.v),
      companies: toNum(unverifiedCompanies[0]?.v),
    },
    openDisputes: toNum(openDisputes[0]?.v),
  };
};

/** Platform market overview — cross-owner product/category/price aggregates (admin-only). */
const marketReadOverview: ToolHandler = async (db, args) => {
  const limit = Number(args.limit ?? 5);
  const [productsCount, categoriesByProducts, avgPrice, suppliersCount, merchantsCount, orderValue] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db
      .select({ category: categories.name, products: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(limit),
    db.select({ v: sql<string>`round(coalesce(avg(base_price),0),2)::text` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
  ]);
  return {
    scope: 'platform',
    snapshot: {
      products: toNum(productsCount[0]?.v),
      categories: categoriesByProducts.map((c) => ({ name: c.category ?? 'Uncategorised', products: toNum(c.products) })),
      avgPrice: avgPrice[0]?.v ?? '0',
      suppliers: toNum(suppliersCount[0]?.v),
      merchants: toNum(merchantsCount[0]?.v),
      totalOrderValue: orderValue[0]?.v ?? '0',
    },
  };
};

/**
 * The caller's own market slice — owned-catalogue product count and own-sales
 * order value. The owner is resolved from the TRUSTED run context
 * (`getAgentRunContext().requestedBy`), never from the tool args, so a caller
 * cannot name another tenant. A caller with no resolvable owner sees an empty
 * slice (zeros) rather than a widened read.
 */
const marketReadOwn: ToolHandler = async (db) => {
  const owner = getAgentRunContext()?.requestedBy ?? null;
  const ownedIds = owner ? await resolveOwnedSellerIds(db, owner) : [];
  if (ownedIds.length === 0) {
    return { scope: 'own', products: 0, orderValue: '0' };
  }
  const [ownProducts, ownOrderValue] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(inArray(products.sellerId, ownedIds)),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders).where(inArray(orders.sellerId, ownedIds)),
  ]);
  return { scope: 'own', products: toNum(ownProducts[0]?.v), orderValue: ownOrderValue[0]?.v ?? '0' };
};

const HANDLERS: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  [PLATFORM_METRICS, platformMetrics],
  [PLATFORM_READ_ORDERS, platformReadOrders],
  [OPERATIONS_READ_HEALTH, operationsReadHealth],
  [RISK_READ_OVERVIEW, riskReadOverview],
  [DISPUTES_READ_SUMMARY, disputesReadSummary],
  [PAYMENTS_READ_SETTLEMENTS, paymentsReadSettlements],
  [FINANCE_READ_LEDGER, financeReadLedger],
  [COMPLIANCE_READ_PLATFORM, complianceReadPlatform],
  [MARKET_READ_OVERVIEW, marketReadOverview],
  [MARKET_READ_OWN, marketReadOwn],
]);

/** Looks up the handler bound to a registered tool. */
export function getToolHandler(id: string): ToolHandler | undefined {
  return HANDLERS.get(id);
}

// Fail fast at load: a registered tool with no handler would be advertised but
// unrunnable, and a handler for an unregistered id would be dead code. Both are
// structural errors, so surface them immediately rather than at call time.
for (const id of registeredToolIds()) {
  if (!HANDLERS.has(id)) throw new Error(`Tool Gateway: registered tool "${id}" has no handler`);
}
for (const id of HANDLERS.keys()) {
  if (!registeredToolIds().includes(id)) throw new Error(`Tool Gateway: handler for unregistered tool "${id}"`);
}

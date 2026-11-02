import { and, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
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
import { campaigns, adEvents } from '../../db/schema/ads';
import { trustScores } from '../../db/schema/trust';
import { ledgerFlowTotals } from '../../lib/ledger-flows';
import { listOwnedSellerEntities, resolveOwnedSellerIds } from '../../lib/seller-ownership';
import { getAgentRunContext } from './agent-run-context';
import { SYSTEM_PRINCIPAL } from '../../modules/ai/scope';
import {
  ADS_READ_CAMPAIGNS,
  COMPLIANCE_READ_PLATFORM,
  DEVELOPMENT_READ_PLATFORM,
  DISPUTES_READ_SUMMARY,
  FINANCE_READ_LEDGER,
  MARKET_READ_OVERVIEW,
  MARKET_READ_OWN,
  MERCHANT_READ_OWN,
  OPERATIONS_READ_HEALTH,
  PAYMENTS_READ_SETTLEMENTS,
  PLATFORM_METRICS,
  PLATFORM_READ_ORDERS,
  RISK_READ_OVERVIEW,
  SALES_READ_MARKET_TOTALS,
  SALES_READ_ORDERS_OWN,
  SALES_READ_ORDERS_PLATFORM,
  SUPPLIER_READ_OWN,
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

/**
 * The caller's own supplier entities — id, name, country, verification and active
 * flag. The owner is resolved from the TRUSTED run context
 * (`getAgentRunContext().requestedBy`), never from the tool args, so a caller
 * cannot name another tenant. An explicit `supplierId` is honoured only when the
 * caller owns it; otherwise the result is an empty scope (`found: false`), never
 * another tenant's record. Read-only and bounded by `limit`.
 */
const supplierReadOwn: ToolHandler = async (db, args) => {
  const owner = getAgentRunContext()?.requestedBy ?? null;
  const owned = owner ? await listOwnedSellerEntities(db, owner) : [];
  const ownedSupplierIds = owned.filter((e) => e.sellerType === 'SUPPLIER').map((e) => e.id);
  const requestedId = typeof args.supplierId === 'string' ? (args.supplierId as string) : undefined;
  const limit = Number(args.limit ?? 10);

  const baseQuery = db
    .select({
      id: suppliers.id,
      companyName: suppliers.companyName,
      countryId: suppliers.countryId,
      verified: suppliers.verified,
      isActive: suppliers.isActive,
    })
    .from(suppliers);

  // Isolation: an explicit id is honoured only when the caller owns it. A
  // requested id the caller does not own yields an empty scope, never another
  // tenant's record. Mirrors `execSupplierAgent`'s former direct read exactly.
  const ownsRequested = requestedId ? ownedSupplierIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await baseQuery.where(eq(suppliers.id, requestedId)).limit(1)
      : []
    : ownedSupplierIds.length > 0
      ? await baseQuery.where(inArray(suppliers.id, ownedSupplierIds)).limit(limit)
      : [];

  return {
    scope: 'own',
    scopedToOwned: !requestedId,
    found: requestedId ? rows.length > 0 : undefined,
    suppliers: rows.map((s) => ({
      id: s.id,
      name: s.companyName,
      countryId: s.countryId,
      verified: s.verified,
      isActive: s.isActive,
    })),
  };
};

/**
 * The caller's own merchant entities — id, name, country, verification and active
 * flag. The owner is resolved from the TRUSTED run context
 * (`getAgentRunContext().requestedBy`), never from the tool args, so a caller
 * cannot name another tenant. An explicit `merchantId` is honoured only when the
 * caller owns it; otherwise the result is an empty scope (`found: false`), never
 * another tenant's record. Read-only and bounded by `limit`.
 */
const merchantReadOwn: ToolHandler = async (db, args) => {
  const owner = getAgentRunContext()?.requestedBy ?? null;
  const owned = owner ? await listOwnedSellerEntities(db, owner) : [];
  const ownedMerchantIds = owned.filter((e) => e.sellerType === 'MERCHANT').map((e) => e.id);
  const requestedId = typeof args.merchantId === 'string' ? (args.merchantId as string) : undefined;
  const limit = Number(args.limit ?? 10);

  const baseQuery = db
    .select({
      id: merchants.id,
      storeName: merchants.storeName,
      countryId: merchants.countryId,
      verified: merchants.verified,
      isActive: merchants.isActive,
    })
    .from(merchants);

  // Isolation: an explicit id is honoured only when the caller owns it. A
  // requested id the caller does not own yields an empty scope, never another
  // tenant's record. Mirrors `execMerchantAgent`'s former direct read exactly.
  const ownsRequested = requestedId ? ownedMerchantIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await baseQuery.where(eq(merchants.id, requestedId)).limit(1)
      : []
    : ownedMerchantIds.length > 0
      ? await baseQuery.where(inArray(merchants.id, ownedMerchantIds)).limit(limit)
      : [];

  return {
    scope: 'own',
    scopedToOwned: !requestedId,
    found: requestedId ? rows.length > 0 : undefined,
    merchants: rows.map((m) => ({
      id: m.id,
      name: m.storeName,
      countryId: m.countryId,
      verified: m.verified,
      isActive: m.isActive,
    })),
  };
};

/** The zeroed order-KPI half for a caller with no readable scope. */
function emptySalesKpi(): Record<string, unknown> {
  return { orders: 0, gmv: '0', commission: '0', paymentFees: '0', net: '0' };
}

/**
 * Reads the sales order book — the KPI totals and the most recent orders — for
 * the given window and (optional) owner predicate. `orderScope` is omitted for
 * the platform-wide read. Mirrors `execSalesAgent`'s former two direct reads
 * exactly so the routed result is byte-for-byte identical.
 */
async function readSalesOrderBook(
  db: DB,
  opts: { since: Date; limit: number; orderScope?: SQL },
): Promise<Record<string, unknown>> {
  const [orderKpi, recentOrders] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*)::int`,
        gmv: sql<string>`coalesce(sum(items_total),0)::text`,
        commission: sql<string>`coalesce(sum(commission),0)::text`,
        paymentFees: sql<string>`coalesce(sum(payment_fee),0)::text`,
        net: sql<string>`coalesce(sum(items_total) - sum(commission) - sum(payment_fee),0)::text`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, opts.since), ...(opts.orderScope ? [opts.orderScope] : []))),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, itemsTotal: orders.itemsTotal, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(opts.orderScope)
      .orderBy(desc(orders.createdAt))
      .limit(opts.limit),
  ]);
  const kpi = orderKpi[0];
  return {
    kpi: {
      orders: toNum(kpi?.orders),
      gmv: kpi?.gmv ?? '0',
      commission: kpi?.commission ?? '0',
      paymentFees: kpi?.paymentFees ?? '0',
      net: kpi?.net ?? '0',
    },
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      itemsTotal: String(o.itemsTotal),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
  };
}

/**
 * Sales Agent (G5 Phase 2 / A3) — the owner-scoped half of the sales read.
 *
 * Resolves the owner from the trusted run context, never the args, then reads
 * only the orders tied to that owner (as buyer, or as the owner of the seller
 * entity). A caller with no trustworthy owner returns `noScope` WITHOUT running
 * any query, so the executor can refuse exactly as before.
 */
const salesReadOrdersOwn: ToolHandler = async (db, args) => {
  const owner = getAgentRunContext()?.requestedBy ?? null;
  const periodDays = Number(args.periodDays ?? 30);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const limit = Number(args.limit ?? 5);
  const ownedSellerIds = owner && owner !== SYSTEM_PRINCIPAL ? await resolveOwnedSellerIds(db, owner) : [];
  // A caller with no trustworthy owner (absent, or the scheduler principal) is
  // refused with `noScope` BEFORE any query — matching `execSalesAgent` exactly.
  if (!owner || owner === SYSTEM_PRINCIPAL) {
    return { scope: 'own', noScope: true, kpi: emptySalesKpi(), recentOrders: [] };
  }
  const ownerConds: SQL[] = [eq(orders.buyerId, owner)];
  if (ownedSellerIds.length > 0) ownerConds.push(inArray(orders.sellerId, ownedSellerIds));
  const orderScope = ownerConds.length === 1 ? ownerConds[0] : or(...ownerConds);
  return { scope: 'own', noScope: false, ...(await readSalesOrderBook(db, { since, limit, orderScope })) };
};

/**
 * Sales Agent (G5 Phase 2 / A3) — the platform-wide half of the sales read.
 *
 * Mirrors `execSalesAgent`'s platform branch: every order, no owner predicate.
 * Admin-only by registration (`platformScoped: true`); the gateway refuses a
 * non-admin with `PLATFORM_SCOPE_DENIED` before this handler runs.
 */
const salesReadOrdersPlatform: ToolHandler = async (db, args) => {
  const periodDays = Number(args.periodDays ?? 30);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const limit = Number(args.limit ?? 5);
  return { scope: 'platform', ...(await readSalesOrderBook(db, { since, limit })) };
};

/**
 * Sales Agent (G5 Phase 2 / A3) — the public totals the agent always surfaced.
 *
 * Active product/supplier/merchant/company counts and the average trust score.
 * Aggregates only: no rows, ids or per-tenant detail, so it is not
 * platform-scoped and stays available to every caller (unchanged behaviour).
 */
const salesReadMarketTotals: ToolHandler = async (db) => {
  const [activeProducts, suppliersCount, merchantsCount, companiesCount, avgTrust] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(eq(products.isPublished, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.isActive, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.isActive, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.isActive, true)),
    db.select({ v: sql<number>`round(avg(score))::int` }).from(trustScores),
  ]);
  return {
    activeProducts: toNum(activeProducts[0]?.v),
    suppliers: toNum(suppliersCount[0]?.v),
    merchants: toNum(merchantsCount[0]?.v),
    companies: toNum(companiesCount[0]?.v),
    avgTrust: toNum(avgTrust[0]?.v),
  };
};

/**
 * Platform ad book — campaign budget/spend rows plus impression/click/conversion
 * counts. Cross-owner advertising data, so the gateway admits admins only
 * (`platformScoped: true`). The payload mirrors `execAdsAgent`'s former direct
 * read exactly; no advertiser identity beyond the campaign's own title is added.
 */
const adsReadCampaigns: ToolHandler = async (db) => {
  const [campaignsAll, impressions, clicks, conversions] = await Promise.all([
    db
      .select({
        id: campaigns.id,
        title: campaigns.title,
        objective: campaigns.objective,
        status: campaigns.status,
        budget: campaigns.budget,
        spent: campaigns.spent,
        isActive: campaigns.isActive,
        startsAt: campaigns.startsAt,
        endsAt: campaigns.endsAt,
      })
      .from(campaigns)
      .orderBy(desc(campaigns.createdAt)),
    db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'IMPRESSION')),
    db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'CLICK')),
    db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'CONVERSION')),
  ]);
  const imp = toNum(impressions[0]?.v);
  const clk = toNum(clicks[0]?.v);
  const conv = toNum(conversions[0]?.v);
  return {
    scope: 'platform',
    snapshot: {
      campaigns: campaignsAll.length,
      activeCampaigns: campaignsAll.filter((c) => c.status === 'ACTIVE' && c.isActive).length,
      impressions: imp,
      clicks: clk,
      conversions: conv,
      ctr: imp > 0 ? ((clk / imp) * 100).toFixed(2) : '0',
      conversionRate: clk > 0 ? ((conv / clk) * 100).toFixed(2) : '0',
      budgetVsSpend: campaignsAll.slice(0, 5).map((c) => ({
        id: c.id,
        title: c.title,
        objective: c.objective,
        status: c.status,
        budget: String(c.budget),
        spent: String(c.spent),
      })),
    },
  };
};

/**
 * Platform build context — user/product/order/campaign counts and the latest
 * daily KPI row. Cross-owner platform data, so the gateway admits admins only.
 * Mirrors `execDevelopmentAgent`'s former direct read exactly.
 */
const developmentReadPlatform: ToolHandler = async (db) => {
  const [usersCount, productsCount, ordersCount, campaignsCount, kpiDays, lastMonthlyKpi] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(orders),
    db.select({ v: sql<number>`count(*)::int` }).from(campaigns),
    db.select({ v: sql<number>`count(*)::int` }).from(dailyKpis),
    db
      .select({ date: dailyKpis.date, metricName: dailyKpis.metricName, metricValue: dailyKpis.metricValue })
      .from(dailyKpis)
      .orderBy(desc(dailyKpis.date))
      .limit(1),
  ]);
  return {
    scope: 'platform',
    snapshot: {
      users: toNum(usersCount[0]?.v),
      products: toNum(productsCount[0]?.v),
      orders: toNum(ordersCount[0]?.v),
      campaigns: toNum(campaignsCount[0]?.v),
      kpiDays: toNum(kpiDays[0]?.v),
      lastDaily: lastMonthlyKpi[0]
        ? { date: lastMonthlyKpi[0].date.toISOString(), metric: lastMonthlyKpi[0].metricName, value: String(lastMonthlyKpi[0].metricValue) }
        : null,
    },
  };
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
  [ADS_READ_CAMPAIGNS, adsReadCampaigns],
  [DEVELOPMENT_READ_PLATFORM, developmentReadPlatform],
  [SUPPLIER_READ_OWN, supplierReadOwn],
  [MERCHANT_READ_OWN, merchantReadOwn],
  [SALES_READ_ORDERS_OWN, salesReadOrdersOwn],
  [SALES_READ_ORDERS_PLATFORM, salesReadOrdersPlatform],
  [SALES_READ_MARKET_TOTALS, salesReadMarketTotals],
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

import { and, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { products, categories, productVariants, productImages } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems } from '../../db/schema/commerce';
import { inventoryItems } from '../../db/schema/commerce_extras';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages } from '../../db/schema/disputes';
import { users } from '../../db/schema/auth';
import { dailyKpis } from '../../db/schema/analytics';
import { campaigns, adEvents } from '../../db/schema/ads';
import { trustScores } from '../../db/schema/trust';
import { getAgentRunContext } from './agent-run-context';
import { SYSTEM_PRINCIPAL } from '../../modules/ai/scope';

import { listRecentMarketingVideos } from '../../modules/media/service';
import {
  ADS_READ_CAMPAIGNS,
  COMPLIANCE_READ_PLATFORM,
  DEVELOPMENT_READ_PLATFORM,
  DISPUTES_READ_SUMMARY,
  MARKET_READ_OVERVIEW,
  MARKET_READ_OWN,
  MARKETING_READ_CATALOGUE_OWNED,
  MARKETING_READ_CATALOGUE_PLATFORM,
  MARKETING_READ_VIDEOS_OWNED,
  MERCHANT_READ_OWN,
  PLATFORM_METRICS,
  PLATFORM_READ_ORDERS,
  PRODUCT_READ_OWNED,
  PRODUCT_READ_PLATFORM,
  PRODUCT_READ_PUBLIC,
  RISK_READ_OVERVIEW,
  SALES_READ_MARKET_TOTALS,
  SALES_READ_ORDERS_OWN,
  SALES_READ_ORDERS_PLATFORM,
  SUPPLIER_READ_OWN,
  registeredToolIds,
  type ToolDefinition,
} from './tool-registry';

/**
 * Bound implementations for the registered gateway tools.
 *
 * Every handler here is a READ: no insert, update, delete, transaction or raw
 * SQL exists in this file, and none is reachable — the registry refuses to load
 * a tool whose declared `tables` include a hard-denied or platform-infra table,
 * and the gateway executes each handler against the agent's A2-scoped handle.
 *
 * The unbound tools (`finance.read_ledger`, `payments.read_settlements`,
 * `operations.read_health`, the outreach surface) deliberately have NO handler
 * here, so the gateway refuses them with `TOOL_NOT_REGISTERED`.
 */

export type ToolHandler = (
  db: DB,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** Resolves the trusted caller, or `null` when the run has no human principal. */
function trustedOwner(): string | null {
  const owner = getAgentRunContext()?.requestedBy ?? null;
  return owner && owner !== SYSTEM_PRINCIPAL ? owner : null;
}

/**
 * The seller entities a user owns, resolved with Drizzle only.
 *
 * This mirrors `resolveOwnedSellerIds` from `lib/seller-ownership`, but that
 * helper issues a raw `UNION ALL` through `db.execute`. A gateway handler must
 * not take a raw-SQL path, so the same ownership set is assembled here from three
 * ordinary, table-scoped selects.
 */
async function ownedEntityIds(db: DB, userId: string): Promise<string[]> {
  const [s, m, c] = await Promise.all([
    db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.userId, userId)),
    db.select({ id: merchants.id }).from(merchants).where(eq(merchants.userId, userId)),
    db.select({ id: companies.id }).from(companies).where(eq(companies.userId, userId)),
  ]);
  return [...s, ...m, ...c].map((r) => r.id);
}

/** The supplier entity ids a user owns, via Drizzle only. */
async function ownedSupplierEntityIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.userId, userId));
  return rows.map((r) => r.id);
}

/** The merchant entity ids a user owns, via Drizzle only. */
async function ownedMerchantEntityIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.userId, userId));
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ platform
/** Platform KPIs — cross-owner aggregates (admin-only). */
const platformMetrics: ToolHandler = async (db, args) => {
  const cap = Number(args.limit ?? 5);
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
      .select({
        name: products.name,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
        revenue: sql<string>`sum(${orderItems.lineTotal})::text`,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .groupBy(products.name)
      .orderBy(sql`sum(${orderItems.quantity}) desc`)
      .limit(cap),
    db
      .select({
        date: dailyKpis.date,
        metricName: dailyKpis.metricName,
        metricValue: dailyKpis.metricValue,
        dimensions: dailyKpis.dimensions,
      })
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
      topProducts: topProducts
        .filter((p) => p.name !== null)
        .map((p) => ({ name: p.name ?? '', qty: toNum(p.qty), revenue: String(p.revenue ?? '0') })),
      dailyKpis: kpis.map((k) => ({
        date: k.date.toISOString(),
        metric: k.metricName,
        value: String(k.metricValue),
        dimensions: k.dimensions ?? null,
      })),
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

/** Risk overview — top profiles and recent events (admin-only). */
const riskReadOverview: ToolHandler = async (db, args) => {
  const cap = Number(args.limit ?? 10);
  const [profiles, events, totalEvents] = await Promise.all([
    db.select().from(riskProfiles).orderBy(desc(riskProfiles.currentScore)).limit(cap),
    db.select().from(riskEvents).orderBy(desc(riskEvents.createdAt)).limit(30),
    db.select({ v: sql<number>`count(*)::int` }).from(riskEvents),
  ]);
  return {
    snapshot: {
      totalEvents: toNum(totalEvents[0]?.v),
      topProfiles: profiles.map((p) => ({
        userId: p.userId,
        score: p.currentScore,
        level: p.level,
        flags: p.flags,
      })),
      recentEvents: events.map((e) => ({
        userId: e.userId,
        type: e.eventType,
        severity: e.severity,
        score: e.riskScore,
        reasonCode: e.reasonCode,
        recommendedAction: e.recommendedAction,
        createdAt: e.createdAt.toISOString(),
      })),
    },
  };
};

/** Dispute summary — open disputes and recent messages (admin-only, read-only). */
const disputesReadSummary: ToolHandler = async (db, args) => {
  const cap = Number(args.limit ?? 5);
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
      .limit(cap),
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

/** Platform compliance scan — unverified entities and open disputes (admin-only). */
const complianceReadPlatform: ToolHandler = async (db) => {
  const [unverifiedSuppliers, unverifiedMerchants, unverifiedCompanies, openDisputes] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.verified, false)),
    db
      .select({ v: sql<number>`count(*)::int` })
      .from(disputes)
      .where(inArray(disputes.status, ['OPEN', 'UNDER_REVIEW'])),
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

/** Platform market overview — catalogue and order aggregates (admin-only). */
const marketReadOverview: ToolHandler = async (db, args) => {
  const cap = Number(args.limit ?? 5);
  const [productCount, categoryCount, priceStats, supplierCount, merchantCount, orderValue] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(categories),
    db
      .select({
        avg: sql<string>`round(coalesce(avg(${products.basePrice}),0),2)::text`,
        min: sql<string>`coalesce(min(${products.basePrice}),0)::text`,
        max: sql<string>`coalesce(max(${products.basePrice}),0)::text`,
      })
      .from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
  ]);
  const topCategories = await db
    .select({ name: categories.name, products: sql<number>`count(*)::int` })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .groupBy(categories.name)
    .orderBy(sql`count(*) desc`)
    .limit(cap);
  return {
    scope: 'platform',
    snapshot: {
      products: toNum(productCount[0]?.v),
      categories: toNum(categoryCount[0]?.v),
      suppliers: toNum(supplierCount[0]?.v),
      merchants: toNum(merchantCount[0]?.v),
      totalOrderValue: orderValue[0]?.v ?? '0',
      price: {
        avg: priceStats[0]?.avg ?? '0',
        min: priceStats[0]?.min ?? '0',
        max: priceStats[0]?.max ?? '0',
      },
      topCategories: topCategories.map((c) => ({
        name: c.name ?? 'Uncategorised',
        products: toNum(c.products),
      })),
    },
  };
};

/** Ad book — campaigns and funnel counts (admin-only). */
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

/** Platform build context — counts and the latest daily KPI (admin-only). */
const developmentReadPlatform: ToolHandler = async (db) => {
  const [usersCount, productsCount, ordersCount, campaignsCount, kpiDays, lastDaily] = await Promise.all([
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
      lastDaily: lastDaily[0]
        ? {
            date: lastDaily[0].date.toISOString(),
            metric: lastDaily[0].metricName,
            value: String(lastDaily[0].metricValue),
          }
        : null,
    },
  };
};

// ----------------------------------------------------------------- own scope
/** The caller's own market slice — owned catalogue count and own order value. */
const marketReadOwn: ToolHandler = async (db) => {
  const owner = trustedOwner();
  const ownedIds = owner ? await ownedEntityIds(db, owner) : [];
  if (ownedIds.length === 0) {
    return { scope: 'own', noScope: true, products: 0, orderValue: '0' };
  }
  const [ownProducts, ownOrderValue] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(inArray(products.sellerId, ownedIds)),
    db
      .select({ v: sql<string>`coalesce(sum(items_total),0)::text` })
      .from(orders)
      .where(inArray(orders.sellerId, ownedIds)),
  ]);
  return {
    scope: 'own',
    noScope: false,
    products: toNum(ownProducts[0]?.v),
    orderValue: ownOrderValue[0]?.v ?? '0',
  };
};

/**
 * The caller's own supplier entities.
 *
 * The owner is resolved from the trusted run context via the ownership graph,
 * never from the args. An explicit `supplierId` is honoured only when the caller
 * owns it; otherwise the result is an empty scope, never another tenant's record.
 */
const supplierReadOwn: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  const ownedIds = owner ? await ownedSupplierEntityIds(db, owner) : [];
  const requestedId = typeof args.supplierId === 'string' ? (args.supplierId as string) : undefined;
  const cap = Number(args.limit ?? 10);

  const base = db
    .select({
      id: suppliers.id,
      companyName: suppliers.companyName,
      countryId: suppliers.countryId,
      verified: suppliers.verified,
      isActive: suppliers.isActive,
    })
    .from(suppliers);

  const ownsRequested = requestedId ? ownedIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await base.where(eq(suppliers.id, requestedId)).limit(1)
      : []
    : ownedIds.length > 0
      ? await base.where(inArray(suppliers.id, ownedIds)).limit(cap)
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
 * The caller's own merchant entities.
 *
 * The owner is resolved from the trusted run context via the ownership graph,
 * never from the args. An explicit `merchantId` is honoured only when the caller
 * owns it; otherwise the result is an empty scope, never another tenant's record.
 */
const merchantReadOwn: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  const ownedIds = owner ? await ownedMerchantEntityIds(db, owner) : [];
  const requestedId = typeof args.merchantId === 'string' ? (args.merchantId as string) : undefined;
  const cap = Number(args.limit ?? 10);

  const base = db
    .select({
      id: merchants.id,
      storeName: merchants.storeName,
      countryId: merchants.countryId,
      verified: merchants.verified,
      isActive: merchants.isActive,
    })
    .from(merchants);

  const ownsRequested = requestedId ? ownedIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await base.where(eq(merchants.id, requestedId)).limit(1)
      : []
    : ownedIds.length > 0
      ? await base.where(inArray(merchants.id, ownedIds)).limit(cap)
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

/**
 * The shared order-book read. `orderScope` is the tier's WHERE predicate; it is
 * `undefined` for the platform tier (every order) and an owner predicate for the
 * own tier.
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
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        itemsTotal: orders.itemsTotal,
        status: orders.status,
        createdAt: orders.createdAt,
      })
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

function emptySalesKpi(): Record<string, string | number> {
  return { orders: 0, gmv: '0', commission: '0', paymentFees: '0', net: '0' };
}

/** The caller's own order book. */
const salesReadOrdersOwn: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  if (!owner) {
    return { scope: 'own', noScope: true, kpi: emptySalesKpi(), recentOrders: [] };
  }
  const days = Number(args.periodDays ?? 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cap = Number(args.limit ?? 5);
  const ownedSellerIds = await ownedEntityIds(db, owner);
  const ownerConds: SQL[] = [eq(orders.buyerId, owner)];
  if (ownedSellerIds.length > 0) ownerConds.push(inArray(orders.sellerId, ownedSellerIds));
  const orderScope = ownerConds.length === 1 ? ownerConds[0] : or(...ownerConds);
  return {
    scope: 'own',
    noScope: false,
    ...(await readSalesOrderBook(db, { since, limit: cap, orderScope })),
  };
};

/** The platform-wide order book (admin-only, enforced by the gateway). */
const salesReadOrdersPlatform: ToolHandler = async (db, args) => {
  const days = Number(args.periodDays ?? 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cap = Number(args.limit ?? 5);
  return { scope: 'platform', ...(await readSalesOrderBook(db, { since, limit: cap })) };
};

/** Public market totals — aggregate counts only, no rows or ids. */
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

// ------------------------------------------------------------------- product
/** Shared catalogue aggregate behind both marketing catalogue tools. */
async function readPublishedCatalogue(
  db: DB,
  limitArg: unknown,
  ownedSellerIds?: string[],
): Promise<{
  published: number;
  topCategories: { name: string; products: number }[];
  topBrands: { name: string; products: number }[];
}> {
  const cap = Math.min(Number(limitArg ?? 5), 10);
  const scope = ownedSellerIds ? inArray(products.sellerId, ownedSellerIds) : undefined;
  const productWhere = scope ? and(eq(products.isPublished, true), scope) : eq(products.isPublished, true);
  const [published, topCategories, brands] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(productWhere),
    db
      .select({ category: categories.name, p: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(productWhere)
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(cap),
    db
      .select({ brand: products.brand, p: sql<number>`count(*)::int` })
      .from(products)
      .where(and(sql`${products.brand} is not null`, productWhere))
      .groupBy(products.brand)
      .orderBy(sql`count(*) desc`)
      .limit(cap),
  ]);
  return {
    published: toNum(published[0]?.v),
    topCategories: topCategories.map((c) => ({ name: c.category ?? 'Uncategorised', products: toNum(c.p) })),
    topBrands: brands
      .filter((b) => b.brand !== null)
      .map((b) => ({ name: b.brand ?? '', products: toNum(b.p) })),
  };
}

/**
 * The shared product read behind all three product tools. `visibility` is the
 * tier's WHERE predicate, or `undefined` for the platform tier (every row).
 */
async function readProductFacts(
  db: DB,
  productId: unknown,
  visibility: SQL | undefined,
): Promise<Record<string, unknown> | null> {
  const hasId = typeof productId === 'string' && productId.length > 0;
  const where = hasId
    ? visibility
      ? and(eq(products.id, productId as string), visibility)
      : eq(products.id, productId as string)
    : visibility ?? sql`true`;
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      basePrice: products.basePrice,
      currencyCode: products.currencyCode,
      categoryName: categories.name,
      sellerType: products.sellerType,
      isPublished: products.isPublished,
      brand: products.brand,
      moq: products.moq,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(where);
  if (rows.length === 0) return null;
  const row = hasId ? rows[0] : rows.find((r) => r.isPublished) ?? rows[0];

  const [variants, images, inventorySum] = await Promise.all([
    db
      .select({
        name: productVariants.name,
        sku: productVariants.sku,
        price: productVariants.price,
        attributes: productVariants.attributes,
      })
      .from(productVariants)
      .where(eq(productVariants.productId, row.id)),
    db
      .select({ url: productImages.url, isPrimary: productImages.isPrimary })
      .from(productImages)
      .where(eq(productImages.productId, row.id)),
    db
      .select({ v: sql<number>`coalesce(sum(quantity),0)::int` })
      .from(inventoryItems)
      .where(eq(inventoryItems.productId, row.id)),
  ]);

  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    price: row.basePrice === null ? '0' : String(row.basePrice),
    currency: row.currencyCode,
    category: row.categoryName,
    sellerType: row.sellerType,
    brand: row.brand,
    moq: row.moq,
    isPublished: row.isPublished,
    variants: variants.length,
    images: images.length,
    inventoryQty: toNum(inventorySum[0]?.v),
  };
}

/** Public tier — a published/ACTIVE listing only. */
const productReadPublic: ToolHandler = async (db, args) => {
  const product = await readProductFacts(
    db,
    args.productId,
    and(eq(products.isPublished, true), eq(products.status, 'ACTIVE')),
  );
  return { scope: 'public', found: product !== null, product };
};

/** Own tier — a listing tied to a seller entity the caller owns. */
const productReadOwned: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  const ownedSellerIds = owner ? await ownedEntityIds(db, owner) : [];
  if (ownedSellerIds.length === 0) {
    return { scope: 'own', found: false, noScope: true, product: null };
  }
  const product = await readProductFacts(db, args.productId, inArray(products.sellerId, ownedSellerIds));
  return { scope: 'own', found: product !== null, noScope: false, product };
};

/** Platform tier — any owner, any status (admin-only, enforced by the gateway). */
const productReadPlatform: ToolHandler = async (db, args) => {
  const product = await readProductFacts(db, args.productId, undefined);
  return { scope: 'platform', found: product !== null, product };
};

/** Own catalogue snapshot. */
const marketingReadCatalogueOwned: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  const ownedSellerIds = owner ? await ownedEntityIds(db, owner) : [];
  if (ownedSellerIds.length === 0) {
    return {
      scope: 'own',
      noScope: true,
      snapshot: { published: 0, topCategories: [], topBrands: [] },
    };
  }
  return {
    scope: 'own',
    noScope: false,
    snapshot: await readPublishedCatalogue(db, args.limit, ownedSellerIds),
  };
};

/** Platform catalogue snapshot (admin-only, enforced by the gateway). */
const marketingReadCataloguePlatform: ToolHandler = async (db, args) => {
  return { scope: 'platform', snapshot: await readPublishedCatalogue(db, args.limit) };
};

/** Own marketing videos. */
const marketingReadVideosOwned: ToolHandler = async (db, args) => {
  const owner = trustedOwner();
  if (!owner) return { scope: 'own', noScope: true, videos: [] };
  const videos = await listRecentMarketingVideos(db, owner, Number(args.limit ?? 5));
  return { scope: 'own', noScope: false, videos };
};

const HANDLERS: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  [PLATFORM_METRICS, platformMetrics],
  [PLATFORM_READ_ORDERS, platformReadOrders],
  [RISK_READ_OVERVIEW, riskReadOverview],
  [DISPUTES_READ_SUMMARY, disputesReadSummary],
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
  [PRODUCT_READ_PUBLIC, productReadPublic],
  [PRODUCT_READ_OWNED, productReadOwned],
  [PRODUCT_READ_PLATFORM, productReadPlatform],
  [MARKETING_READ_CATALOGUE_OWNED, marketingReadCatalogueOwned],
  [MARKETING_READ_CATALOGUE_PLATFORM, marketingReadCataloguePlatform],
  [MARKETING_READ_VIDEOS_OWNED, marketingReadVideosOwned],
]);

/** Looks up the handler bound to a registered tool. */
export function getToolHandler(id: string): ToolHandler | undefined {
  return HANDLERS.get(id);
}

/** The tool ids that have a bound handler. */
export function boundHandlerIds(): string[] {
  return [...HANDLERS.keys()];
}

/** The tool definitions that have a bound handler — for tests and docs. */
export function boundTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => HANDLERS.has(t.id));
}

// Fail fast at load: a registered tool with no handler would be advertised but
// unrunnable, and a handler for an unregistered id would be dead code. Both are
// structural errors, so surface them immediately rather than at call time.
for (const id of registeredToolIds()) {
  if (!HANDLERS.has(id)) throw new Error(`Tool Gateway: registered tool "${id}" has no handler`);
}
for (const id of HANDLERS.keys()) {
  if (!registeredToolIds().includes(id)) {
    throw new Error(`Tool Gateway: handler for unregistered tool "${id}"`);
  }
}

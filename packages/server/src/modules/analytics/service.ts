import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { auditLogs } from '../../db/schema/audit';
import { users, sessions } from '../../db/schema/auth';
import { analyticsEvents, dailyKpis, dashboardReports } from '../../db/schema/analytics';
import { orders, transactions, transactionLedger } from '../../db/schema/commerce';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { products } from '../../db/schema/products';
import { inventoryItems } from '../../db/schema/commerce_extras';
import { subscriptions } from '../../db/schema/subscriptions';
import { campaigns } from '../../db/schema/ads';
import { aiRequests } from '../../db/schema/ai';
import { newId } from '../../lib/ids';
import { resolveOwnedSellerIds } from '../../lib/seller-ownership';

const DECIMAL_TO_NUM = (v: unknown, fallback = 0): number => {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
};

/** Rolling window helper — inclusive now back `days` (default 30). */
function sinceDays(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Platform-wide analytics (admin / staff)
// ---------------------------------------------------------------------------

export interface PlatformOverview {
  users: number;
  activeUsers30d: number;
  productOwners: number; // distinct seller entities with products
  suppliers: number;
  merchants: number;
  companies: number;
  products: number;
  publishedProducts: number;
  orders: number;
  paidOrders: number;
  gmv: number;
  commission: number;
  paymentFees: number;
  avgOrderValue: number;
  inventoryItems: number;
  lowStock: number;
  outOfStock: number;
  activeCampaigns: number;
  subscriptionsActive: number;
  aiRequests: number;
  dailyKpiCount: number;
  currencyCode: string;
}

export async function getPlatformOverview(db: DB): Promise<PlatformOverview> {
  const since = sinceDays(30);
  const [
    usersRow, activeUsersRow,
    suppliersRow, merchantsRow, companiesRow,
    productsRow, publishedRow,
    ordersRow, paidRow, gmvRow, commRow, feeRow,
    inventoryRow, lowRow, outRow,
    campaignRow, subRow, aiRow, dailyKpiRow, productOwnersRow,
  ] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(gte(users.lastLoginAt, since)),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants),
    db.select({ v: sql<number>`count(*)::int` }).from(companies),
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(eq(products.isPublished, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(orders),
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(eq(orders.paymentStatus, 'PAID')),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(commission),0)::text` }).from(orders),
    db.select({ v: sql<string>`coalesce(sum(payment_fee),0)::text` }).from(orders),
    db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems),
    db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems).where(sql`quantity <= low_stock_threshold and quantity > 0`),
    db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems).where(sql`quantity <= 0`),
    db.select({ v: sql<number>`count(*)::int` }).from(campaigns).where(eq(campaigns.status, 'ACTIVE')),
    db.select({ v: sql<number>`count(*)::int` }).from(subscriptions).where(eq(subscriptions.status, 'ACTIVE')),
    db.select({ v: sql<number>`count(*)::int` }).from(aiRequests),
    db.select({ v: sql<number>`count(*)::int` }).from(dailyKpis),
    db
      .select({ v: sql<number>`count(distinct seller_id)::int` })
      .from(products)
      .where(eq(products.isPublished, true)),
  ]);

  const ordersCount = Number(ordersRow[0].v);
  const gmv = DECIMAL_TO_NUM(gmvRow[0].v);
  return {
    users: Number(usersRow[0].v),
    activeUsers30d: Number(activeUsersRow[0].v),
    productOwners: Number(productOwnersRow[0].v),
    suppliers: Number(suppliersRow[0].v),
    merchants: Number(merchantsRow[0].v),
    companies: Number(companiesRow[0].v),
    products: Number(productsRow[0].v),
    publishedProducts: Number(publishedRow[0].v),
    orders: ordersCount,
    paidOrders: Number(paidRow[0].v),
    gmv,
    commission: DECIMAL_TO_NUM(commRow[0].v),
    paymentFees: DECIMAL_TO_NUM(feeRow[0].v),
    avgOrderValue: ordersCount > 0 ? gmv / ordersCount : 0,
    inventoryItems: Number(inventoryRow[0].v),
    lowStock: Number(lowRow[0].v),
    outOfStock: Number(outRow[0].v),
    activeCampaigns: Number(campaignRow[0].v),
    subscriptionsActive: Number(subRow[0].v),
    aiRequests: Number(aiRow[0].v),
    dailyKpiCount: Number(dailyKpiRow[0].v),
    currencyCode: 'TND',
  };
}

export interface RetentionSnapshot {
  totalUsers: number;
  usersCreated30d: number;
  activeUsers30d: number;
  activeUsers90d: number;
  retentionRate30d: number; // active30d / total
  newUserRetention: number; // users created in 30d who logged in within window / usersCreated30d
  sessionsLast30d: number;
}

export async function getRetentionSnapshot(db: DB): Promise<RetentionSnapshot> {
  const since30 = sinceDays(30);
  const since90 = sinceDays(90);
  const [totalRow, created30Row, active30Row, active90Row, sessions30Row, newActive30Row] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(gte(users.createdAt, since30)),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(gte(users.lastLoginAt, since30)),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(gte(users.lastLoginAt, since90)),
    db.select({ v: sql<number>`count(*)::int` }).from(sessions).where(gte(sessions.createdAt, since30)),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(and(gte(users.createdAt, since30), gte(users.lastLoginAt, since30))),
  ]);
  const totalUsers = Number(totalRow?.[0]?.v ?? 0);
  const usersCreated30d = Number(created30Row?.[0]?.v ?? 0);
  const active30 = Number(active30Row?.[0]?.v ?? 0);
  return {
    totalUsers,
    usersCreated30d,
    activeUsers30d: active30,
    activeUsers90d: Number(active90Row?.[0]?.v ?? 0),
    retentionRate30d: totalUsers > 0 ? active30 / totalUsers : 0,
    newUserRetention: usersCreated30d > 0 ? Number(newActive30Row?.[0]?.v ?? 0) / usersCreated30d : 0,
    sessionsLast30d: Number(sessions30Row?.[0]?.v ?? 0),
  };
}

export interface ConversionSnapshot {
  orders: number;
  paidOrders: number;
  orders30d: number;
  paidOrders30d: number;
  conversionRate: number; // paid/orders
  conversionRate30d: number;
  avgOrderValue: number;
  abandonedOrders: number; // orders with status DRAFT/CANCELLED never paid
  users: number;
  ordersPerUser: number;
}

export async function getConversionSnapshot(db: DB): Promise<ConversionSnapshot> {
  const since = sinceDays(30);
  const [ordersRow, paidRow, orders30Row, paid30Row, abandonedRow, usersRow, gmvRow] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(orders),
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(eq(orders.paymentStatus, 'PAID')),
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(gte(orders.createdAt, since)),
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.paymentStatus, 'PAID'), gte(orders.createdAt, since))),
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(sql`status in ('DRAFT','CANCELLED','REFUNDED','DISPUTED')`),
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
  ]);
  const ordersCount = Number(ordersRow?.[0]?.v ?? 0);
  const paid = Number(paidRow?.[0]?.v ?? 0);
  const orders30 = Number(orders30Row?.[0]?.v ?? 0);
  const paid30 = Number(paid30Row?.[0]?.v ?? 0);
  const usersCount = Number(usersRow?.[0]?.v ?? 0);
  return {
    orders: ordersCount,
    paidOrders: paid,
    orders30d: orders30,
    paidOrders30d: paid30,
    conversionRate: ordersCount > 0 ? paid / ordersCount : 0,
    conversionRate30d: orders30 > 0 ? paid30 / orders30 : 0,
    avgOrderValue: ordersCount > 0 ? DECIMAL_TO_NUM(gmvRow?.[0]?.v) / ordersCount : 0,
    abandonedOrders: Number(abandonedRow?.[0]?.v ?? 0),
    users: usersCount,
    ordersPerUser: usersCount > 0 ? ordersCount / usersCount : 0,
  };
}

export interface RevenueBreakdown {
  transactionValue: number;
  commission: number;
  paymentFees: number;
  refunds: number;
  settlement: number;
  netRevenue: number;
  currencyCode: string;
}

/** Aggregates ledger amounts by entry type, respecting CREDIT/DEBIT direction. */
async function ledgerTotal(db: DB, entryType: string): Promise<number> {
  const rows = await db
    .select({
      credit: sql<string>`coalesce(sum(case when direction='CREDIT' then amount else 0 end),0)::text`,
      debit: sql<string>`coalesce(sum(case when direction='DEBIT' then amount else 0 end),0)::text`,
    })
    .from(transactionLedger)
    .where(eq(transactionLedger.entryType, entryType as never));
  const credit = DECIMAL_TO_NUM(rows[0]?.credit);
  const debit = DECIMAL_TO_NUM(rows[0]?.debit);
  return credit - debit;
}

export async function getRevenueBreakdown(db: DB): Promise<RevenueBreakdown> {
  const [txValRow, commission, paymentFees, refunds, settlement] = await Promise.all([
    db.select({ v: sql<string>`coalesce(sum(total_value),0)::text` }).from(transactions),
    ledgerTotal(db, 'COMMISSION'),
    ledgerTotal(db, 'PAYMENT_FEE'),
    ledgerTotal(db, 'REFUND'),
    ledgerTotal(db, 'SETTLEMENT'),
  ]);
  return {
    transactionValue: DECIMAL_TO_NUM(txValRow?.[0]?.v),
    commission: Math.abs(commission),
    paymentFees: Math.abs(paymentFees),
    refunds: Math.abs(refunds),
    settlement: Math.abs(settlement),
    netRevenue: Math.abs(commission) + Math.abs(paymentFees) - Math.abs(refunds),
    currencyCode: 'TND',
  };
}

export interface DailyKpiRow {
  id: string;
  date: string;
  metricName: string;
  metricValue: number;
  dimensions: Record<string, unknown> | null;
}

export async function listDailyKpis(db: DB, days = 14): Promise<DailyKpiRow[]> {
  const since = sinceDays(days);
  const rows = await db
    .select()
    .from(dailyKpis)
    .where(gte(dailyKpis.date, since))
    .orderBy(desc(dailyKpis.date));
  return rows.map((r) => ({
    id: r.id,
    date: r.date.toISOString(),
    metricName: r.metricName,
    metricValue: DECIMAL_TO_NUM(r.metricValue),
    dimensions: (r.dimensions ?? null) as Record<string, unknown> | null,
  }));
}

/** Persist a computed daily snapshot into `daily_kpis` (rollup — real data, not mock). */
export async function rollupDailyKpis(db: DB): Promise<number> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1); // end of today

  const [ordersRow, gmvRow, commRow, usersRow, productsRow] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(orders).where(and(gte(orders.createdAt, start), sql`${orders.createdAt} <= ${end}`)),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders).where(and(gte(orders.createdAt, start), sql`${orders.createdAt} <= ${end}`)),
    db.select({ v: sql<string>`coalesce(sum(commission),0)::text` }).from(orders).where(and(gte(orders.createdAt, start), sql`${orders.createdAt} <= ${end}`)),
    db.select({ v: sql<number>`count(*)::int` }).from(users),
    db.select({ v: sql<number>`count(*)::int` }).from(products),
  ]);

  const metrics: Array<{ metricName: string; value: string }> = [
    { metricName: 'orders', value: String(Number(ordersRow?.[0]?.v ?? 0)) },
    { metricName: 'gmv', value: String(DECIMAL_TO_NUM(gmvRow?.[0]?.v)) },
    { metricName: 'commission', value: String(DECIMAL_TO_NUM(commRow?.[0]?.v)) },
    { metricName: 'users', value: String(Number(usersRow?.[0]?.v ?? 0)) },
    { metricName: 'products', value: String(Number(productsRow?.[0]?.v ?? 0)) },
  ];

  let inserted = 0;
  for (const m of metrics) {
    await db.insert(dailyKpis).values({
      id: newId(),
      date: start,
      metricName: m.metricName,
      metricValue: m.value,
      dimensions: { source: 'rollup' },
    });
    inserted += 1;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Own analytics (seller entity scope) — for business dashboards
// ---------------------------------------------------------------------------

export interface MyAnalyticsOverview {
  hasBusinessEntity: boolean;
  sellerName: string | null;
  products: number;
  publishedProducts: number;
  inventoryItems: number;
  lowStock: number;
  outOfStock: number;
  ordersAsSeller: number;
  gmvAsSeller: number;
  commissionAsSeller: number;
  customers: number;
  disputesAsSeller: number;
  avgOrderValue: number;
  campaigns: number;
  activeCampaigns: number;
}

/** Resolve the first owned business entity (supplier > merchant > company). */
async function resolveOwnedEntity(db: DB, userId: string) {
  const [sup, mer, com] = await Promise.all([
    db.select().from(suppliers).where(eq(suppliers.userId, userId)).limit(1),
    db.select().from(merchants).where(eq(merchants.userId, userId)).limit(1),
    db.select().from(companies).where(eq(companies.userId, userId)).limit(1),
  ]);
  if (sup[0]) return { type: 'SUPPLIER', name: sup[0].companyName, id: sup[0].id };
  if (mer[0]) return { type: 'MERCHANT', name: mer[0].storeName, id: mer[0].id };
  if (com[0]) return { type: 'COMPANY', name: com[0].legalName, id: com[0].id };
  return null;
}

export async function getMyAnalyticsOverview(db: DB, userId: string): Promise<MyAnalyticsOverview> {
  const owned = await resolveOwnedSellerIds(db, userId);
  const entity = await resolveOwnedEntity(db, userId);

  if (owned.length === 0 && !entity) {
    return {
      hasBusinessEntity: false,
      sellerName: null,
      products: 0,
      publishedProducts: 0,
      inventoryItems: 0,
      lowStock: 0,
      outOfStock: 0,
      ordersAsSeller: 0,
      gmvAsSeller: 0,
      commissionAsSeller: 0,
      customers: 0,
      disputesAsSeller: 0,
      avgOrderValue: 0,
      campaigns: 0,
      activeCampaigns: 0,
    };
  }

  const sellerIds = [...owned, ...(entity ? [entity.id] : [])];
  const idsSet = new Set(sellerIds);
  const ids = Array.from(idsSet);

  const sellerCond = sql`${orders.sellerId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;

  const [productsRow, publishedRow, inventoryRow, lowRow, outRow, ordersRow, gmvRow, commRow, customersRow, disputesRow, campaignRow, activeCampaignRow] =
    await Promise.all([
      db.select({ v: sql<number>`count(*)::int` }).from(products).where(sql`seller_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
      db.select({ v: sql<number>`count(*)::int` }).from(products).where(and(sql`seller_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`, eq(products.isPublished, true))),
      db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems).where(sql`merchant_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
      db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems).where(sql`(merchant_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})) and quantity <= low_stock_threshold and quantity > 0`),
      db.select({ v: sql<number>`count(*)::int` }).from(inventoryItems).where(sql`(merchant_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})) and quantity <= 0`),
      db.select({ v: sql<number>`count(*)::int` }).from(orders).where(sellerCond),
      db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders).where(sellerCond),
      db.select({ v: sql<string>`coalesce(sum(commission - buyer_commission),0)::text` }).from(orders).where(sellerCond),
      db.select({ v: sql<number>`count(distinct buyer_id)::int` }).from(orders).where(sellerCond),
      db.select({ v: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.entityType, 'ORDER'), sql`${auditLogs.entityId} in (select id from orders where ${sellerCond})`)),
      db.select({ v: sql<number>`count(*)::int` }).from(campaigns).where(sql`advertiser_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
      db.select({ v: sql<number>`count(*)::int` }).from(campaigns).where(and(sql`advertiser_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`, eq(campaigns.status, 'ACTIVE'))),
    ]);

  const ordersCount = Number(ordersRow?.[0]?.v ?? 0);
  const gmv = DECIMAL_TO_NUM(gmvRow?.[0]?.v);
  return {
    hasBusinessEntity: true,
    sellerName: entity?.name ?? null,
    products: Number(productsRow?.[0]?.v ?? 0),
    publishedProducts: Number(publishedRow?.[0]?.v ?? 0),
    inventoryItems: Number(inventoryRow?.[0]?.v ?? 0),
    lowStock: Number(lowRow?.[0]?.v ?? 0),
    outOfStock: Number(outRow?.[0]?.v ?? 0),
    ordersAsSeller: ordersCount,
    gmvAsSeller: gmv,
    commissionAsSeller: DECIMAL_TO_NUM(commRow?.[0]?.v),
    customers: Number(customersRow?.[0]?.v ?? 0),
    disputesAsSeller: Number(disputesRow?.[0]?.v ?? 0),
    avgOrderValue: ordersCount > 0 ? gmv / ordersCount : 0,
    campaigns: Number(campaignRow?.[0]?.v ?? 0),
    activeCampaigns: Number(activeCampaignRow?.[0]?.v ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Analytics events (real capture + read)
// ---------------------------------------------------------------------------

export interface AnalyticsEventInput {
  eventName: string;
  properties?: Record<string, unknown>;
}

export async function recordAnalyticsEvent(
  db: DB,
  userId: string | null,
  sessionId: string | null,
  input: AnalyticsEventInput,
  ipHash?: string | null,
): Promise<{ id: string }> {
  const id = newId();
  await db.insert(analyticsEvents).values({
    id,
    eventName: input.eventName,
    userId,
    sessionId,
    properties: (input.properties ?? {}) as never,
    ipHash: ipHash ?? null,
  });
  return { id };
}

export async function listAnalyticsEvents(
  db: DB,
  userId: string,
  opts: { limit?: number; eventName?: string } = {},
): Promise<Array<{ id: string; eventName: string; properties: Record<string, unknown> | null; createdAt: string }>> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const where = opts.eventName
    ? and(eq(analyticsEvents.userId, userId), eq(analyticsEvents.eventName, opts.eventName))
    : eq(analyticsEvents.userId, userId);
  const rows = await db
    .select()
    .from(analyticsEvents)
    .where(where)
    .orderBy(desc(analyticsEvents.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    eventName: r.eventName,
    properties: (r.properties ?? null) as Record<string, unknown> | null,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Dashboard reports (saved snapshots for the web)
// ---------------------------------------------------------------------------

export interface DashboardReportInput {
  reportCode: string;
  title: string;
  reportData?: Record<string, unknown>;
}

export async function createDashboardReport(
  db: DB,
  generatedById: string,
  input: DashboardReportInput,
): Promise<{ id: string }> {
  const id = newId();
  await db.insert(dashboardReports).values({
    id,
    reportCode: input.reportCode,
    title: input.title,
    reportData: (input.reportData ?? {}) as never,
    generatedById,
  });
  return { id };
}

export async function listDashboardReports(db: DB, limit = 20): Promise<Array<{ id: string; reportCode: string; title: string; createdAt: string }>> {
  const rows = await db
    .select()
    .from(dashboardReports)
    .orderBy(desc(dashboardReports.createdAt))
    .limit(Math.min(limit, 100));
  return rows.map((r) => ({ id: r.id, reportCode: r.reportCode, title: r.title, createdAt: r.createdAt.toISOString() }));
}
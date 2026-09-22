import { Hono } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getContext } from '../../lib/request-context.js';
import { orders, transactions, transactionLedger } from '../../db/schema/commerce.js';
import { products } from '../../db/schema/products.js';
import { campaigns, adEvents } from '../../db/schema/ads.js';
import { suppliers, merchants, companies } from '../../db/schema/trade.js';
import { users } from '../../db/schema/auth.js';
import { auditLogs } from '../../db/schema/audit.js';
import { writeAudit } from '../../lib/audit.js';

/** Admin-only sub-app. Every route requires ADMIN or SUPER_ADMIN role. */
export const adminRoutes = new Hono();

adminRoutes.use('*', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

// ----- KPIs ---------------------------------------------------------------
adminRoutes.get('/stats', async (c) => {
  const ctx = getContext(c);
  const [userCount, productCount, orderCount, txValue] = await Promise.all([
    ctx.db.select({ v: sql<number>`count(*)` }).from(users),
    ctx.db.select({ v: sql<number>`count(*)` }).from(products),
    ctx.db.select({ v: sql<number>`count(*)` }).from(orders),
    ctx.db.select({ v: sql<string>`coalesce(sum(total_value),0)` }).from(transactions),
  ]);
  return c.json({
    success: true,
    data: {
      users: Number(userCount[0].v),
      products: Number(productCount[0].v),
      orders: Number(orderCount[0].v),
      gmv: Number(txValue[0].v),
    },
  });
});

// ----- Advertising Summary (Admin) -----------------------------------------
adminRoutes.get('/ads/summary', async (c) => {
  const ctx = getContext(c);
  const [campaignCount, activeCount, spentResult, budgetResult, impressionsResult, clicksResult, conversionsResult] =
    await Promise.all([
      ctx.db.select({ v: sql<number>`count(*)::int` }).from(campaigns),
      ctx.db.select({ v: sql<number>`count(*)::int` }).from(campaigns).where(eq(campaigns.status, 'ACTIVE')),
      ctx.db.select({ v: sql<string>`coalesce(sum(spent),0)` }).from(campaigns),
      ctx.db.select({ v: sql<string>`coalesce(sum(budget),0)` }).from(campaigns),
      ctx.db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'IMPRESSION')),
      ctx.db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'CLICK')),
      ctx.db.select({ v: sql<number>`count(*)::int` }).from(adEvents).where(eq(adEvents.eventType, 'CONVERSION')),
    ]);

  const impressions = Number(impressionsResult[0].v);
  const clicks = Number(clicksResult[0].v);
  const conversions = Number(conversionsResult[0].v);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const convRate = impressions > 0 ? conversions / impressions : 0;

  return c.json({
    success: true,
    data: {
      campaigns: Number(campaignCount[0].v),
      activeCampaigns: Number(activeCount[0].v),
      totalSpent: String(spentResult[0].v),
      totalBudget: String(budgetResult[0].v),
      impressions,
      clicks,
      conversions,
      ctr,
      conversionRate: convRate,
    },
  });
});

// ----- Advertising campaigns (Admin) ---------------------------------------
// Full cross-advertiser list for the moderation desk. advertiser_id is polymorphic
// (supplier/merchant/company), so the owner name/email is resolved with a union join.
adminRoutes.get('/ads/campaigns', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db.execute<{
    id: string;
    advertiser_id: string;
    advertiser_type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
    title: string;
    objective: string;
    status: string;
    budget: string;
    spent: string;
    currency_code: string;
    starts_at: string;
    ends_at: string | null;
    is_active: boolean;
    created_at: string;
    advertiser_name: string | null;
    owner_email: string | null;
  }>(sql`
    select c.id, c.advertiser_id, c.advertiser_type, c.title, c.objective, c.status,
           c.budget, c.spent, c.currency_code, c.starts_at, c.ends_at, c.is_active, c.created_at,
           a.name as advertiser_name, u.email as owner_email
    from campaigns c
    left join (
      select id, user_id, company_name as name from suppliers
      union all
      select id, user_id, store_name as name from merchants
      union all
      select id, user_id, legal_name as name from companies
    ) a on a.id = c.advertiser_id
    left join users u on u.id = a.user_id
    order by c.created_at desc
    limit 500
  `);
  const result = rows as unknown as { rows: Record<string, unknown>[] };
  const items = result.rows.map((r) => ({
    id: r.id,
    advertiserId: r.advertiser_id,
    advertiserType: r.advertiser_type,
    advertiserName: r.advertiser_name,
    ownerEmail: r.owner_email,
    title: r.title,
    objective: r.objective,
    status: r.status,
    budget: String(r.budget),
    spent: String(r.spent),
    currencyCode: r.currency_code,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    isActive: r.is_active,
    createdAt: r.created_at,
  }));
  return c.json({ success: true, data: { items } });
});

// ----- Users ---------------------------------------------------------------
adminRoutes.get('/users', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});

adminRoutes.patch('/users/:id/status', async (c) => {
  const ctx = getContext(c);
  const id = c.req.param('id')!;
  const body = await c.req.json().catch(() => null);
  const isActive = body?.isActive;
  if (typeof isActive !== 'boolean') {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'isActive boolean required' } },
      422 as never,
    );
  }
  const before = await ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
  if (before.length === 0) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } }, 404 as never);
  }
  await ctx.db.update(users).set({ isActive, updatedAt: new Date() }).where(eq(users.id, id));
  await writeAudit(ctx.db, { actorId: ctx.user!.id }, {
    action: 'ADMIN.USER_STATUS',
    entityType: 'USER',
    entityId: id,
    before: { isActive: before[0].isActive },
    after: { isActive },
    metadata: { reason: 'Admin status change' },
  });
  return c.json({ success: true });
});

// ----- Orders ---------------------------------------------------------------
adminRoutes.get('/orders', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      buyerId: orders.buyerId,
      sellerId: orders.sellerId,
      itemsTotal: orders.itemsTotal,
      commission: orders.commission,
      buyerCommission: orders.buyerCommission,
      grandTotal: orders.grandTotal,
      currencyCode: orders.currencyCode,
      status: orders.status,
      // Refund state is needed by the admin UI to decide whether an order can be
      // refunded (only PAID / PARTIALLY_REFUNDED) and to show what already went back.
      paymentStatus: orders.paymentStatus,
      refundStatus: orders.refundStatus,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .orderBy(desc(orders.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});

// ----- Transactions -----------------------------------------------------------
adminRoutes.get('/transactions', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: transactions.id,
      transactionNumber: transactions.transactionNumber,
      totalValue: transactions.totalValue,
      commission: transactions.commission,
      buyerCommission: transactions.buyerCommission,
      paymentFee: transactions.paymentFee,
      status: transactions.status,
    })
    .from(transactions)
    .orderBy(desc(transactions.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});

// ----- Ledger -------------------------------------------------------------
adminRoutes.get('/ledger', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select()
    .from(transactionLedger)
    .orderBy(desc(transactionLedger.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});

// ----- Products ---------------------------------------------------------------
adminRoutes.get('/products', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      status: products.status,
      sellerId: products.sellerId,
      basePrice: products.basePrice,
    })
    .from(products)
    .orderBy(desc(products.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});

// ----- Audit logs -------------------------------------------------------------
adminRoutes.get('/audit-logs', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
  return c.json({ success: true, data: { items: rows } });
});
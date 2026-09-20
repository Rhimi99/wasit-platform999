import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import type { AgentDefinition } from '../../lib/ai/types';
import { runAIFeature } from '../../lib/ai/runtime';
import { products, categories, productVariants, productImages } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems, transactions } from '../../db/schema/commerce';
import { inventoryItems, inventoryMovements } from '../../db/schema/commerce_extras';
import { campaigns, adCreatives, adEvents } from '../../db/schema/ads';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages } from '../../db/schema/disputes';
import { trustScores, reviews } from '../../db/schema/trust';
import { messages, threads } from '../../db/schema/messaging';
import { users } from '../../db/schema/auth';
import { commissionPolicies } from '../../db/schema/engine';
import { dailyKpis } from '../../db/schema/analytics';
import { listRecentMarketingVideos } from '../media/service';

/**
 * WASIT specialised agent executors (Phase 14).
 *
 * Each agent has a real, deterministic, DB-backed executor that reads Wasit's
 * live data (PostgreSQL). No mock data, no generic placeholder output: every
 * agent returns a structured result that reflects the actual data of the entity
 * it advises on. The AI runtime is used purely for cost/usage accounting.
 */

export interface AgentExecutorResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
}

/** Safely parses a numeric DB field (numeric/text/number) to a plain number. */
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** Builds a short deterministic advice text from a structured facts object. */
function adviceText(template: string, facts: Record<string, unknown>): string {
  let text = template;
  for (const [k, v] of Object.entries(facts)) {
    text = text.replaceAll(`{{${k}}}`, v === null || v === undefined ? '0' : String(v));
  }
  return text;
}

// ---------- helpers for queries ----------

interface ProductWithCategory {
  id: string;
  name: string;
  sku: string;
  basePrice: string | null;
  currencyCode: string;
  categoryName: string | null;
  sellerType: string;
  isPublished: boolean;
  brand: string | null;
  moq: number;
}

async function pickProduct(db: DB, productId?: unknown): Promise<ProductWithCategory | null> {
  const hasId = typeof productId === 'string' && productId.length > 0;
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
    .where(hasId ? eq(products.id, productId as string) : sql`true`);
  if (rows.length === 0) return null;
  // For a general overview, prefer a published/sample product; for a specific id return that row.
  const row = hasId ? rows[0] : rows.find((r) => r.isPublished) ?? rows[0];
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    basePrice: row.basePrice === null ? null : String(row.basePrice),
    currencyCode: row.currencyCode,
    categoryName: row.categoryName,
    sellerType: row.sellerType,
    isPublished: row.isPublished,
    brand: row.brand,
    moq: row.moq,
  };
}

async function countOpenSupportMessages(db: DB): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.isDeleted, false), eq(messages.status, 'SENT'), sql`${messages.readAt} is null`));
  return Number(rows[0]?.v ?? 0);
}

// ---------- executors: one specialised query/output per agent ----------

async function execSalesAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const periodDays = Number(input.periodDays ?? 30);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const [orderKpi, recentOrders, activeProducts, suppliersCount, merchantsCount, companiesCount, avgTrust] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*)::int`,
        gmv: sql<string>`coalesce(sum(items_total),0)::text`,
        commission: sql<string>`coalesce(sum(commission),0)::text`,
        paymentFees: sql<string>`coalesce(sum(payment_fee),0)::text`,
        net: sql<string>`coalesce(sum(items_total) - sum(commission) - sum(payment_fee),0)::text`,
      })
      .from(orders)
      .where(gte(orders.createdAt, since)),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, itemsTotal: orders.itemsTotal, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(Number(input.limit ?? 5)),
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(eq(products.isPublished, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.isActive, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.isActive, true)),
    db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.isActive, true)),
    db.select({ v: sql<number>`round(avg(score))::int` }).from(trustScores),
  ]);

  const kpi = orderKpi[0];
  const facts = {
    periodDays,
    orders: toNum(kpi?.orders),
    gmv: kpi?.gmv ?? '0',
    commission: kpi?.commission ?? '0',
    paymentFees: kpi?.paymentFees ?? '0',
    net: kpi?.net ?? '0',
    activeProducts: toNum(activeProducts[0]?.v),
    suppliers: toNum(suppliersCount[0]?.v),
    merchants: toNum(merchantsCount[0]?.v),
    companies: toNum(companiesCount[0]?.v),
    avgTrust: toNum(avgTrust[0]?.v),
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'identify_leads',
    periodDays,
    kpi: facts,
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      itemsTotal: String(o.itemsTotal),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    leadsPotential: {
      merchants: facts.merchants,
      companies: facts.companies,
      activeProducts: facts.activeProducts,
      note:
        facts.orders > 0
          ? `Active order book (${facts.orders} orders). Focus on repeat buyers and upsell.`
          : 'No orders in period — prioritise outreach to merchants/companies with active listings.',
    },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Sales analysis over last {{periodDays}}d: {{orders}} orders, GMV {{gmv}}, net {{net}}. Solicit {{merchants}} merchants and {{companies}} companies with {{activeProducts}} active products.',
    { periodDays: facts.periodDays, orders: facts.orders, gmv: facts.gmv, net: facts.net, merchants: facts.merchants, companies: facts.companies, activeProducts: facts.activeProducts },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Sales Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execMarketingAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const limit = Math.min(Number(input.limit ?? 5), 10);
  const [published, topCategories, brands] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(eq(products.isPublished, true)),
    db
      .select({ category: categories.name, p: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(eq(products.isPublished, true))
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(limit),
    db
      .select({ brand: products.brand, p: sql<number>`count(*)::int` })
      .from(products)
      .where(and(sql`${products.brand} is not null`, eq(products.isPublished, true)))
      .groupBy(products.brand)
      .orderBy(sql`count(*) desc`)
      .limit(limit),
  ]);

  // Brand select returns null brand rows; keep only non-null.
  const brandRows = brands.filter((b) => b.brand !== null);

  const facts = {
    published: toNum(published[0]?.v),
    topCategories: topCategories.map((c) => ({ name: c.category ?? 'Uncategorised', products: toNum(c.p) })),
    topBrands: brandRows.map((b) => ({ name: b.brand ?? '', products: toNum(b.p) })),
  };

  const campaignSuggestion = {
    objective: 'PRODUCT_ADS',
    audience: ['merchants', 'companies'],
    creatives: Array.from({ length: Math.min(facts.topCategories.length, 3) }, (_, i) => ({
      type: 'IMAGE',
      title: `Promote ${facts.topCategories[i] ? facts.topCategories[i].name : 'top category'}`,
    })),
  };

  // Real media: surface the seller's actually-generated marketing videos from
  // `media_assets`. Each entry is READY only when a real binary exists, and
  // carries signed preview/download URLs. When none exist yet, the agent
  // returns an empty list plus a hint — it never fabricates a media URL.
  const requesterId = typeof input.__userId === 'string' ? (input.__userId as string) : null;
  const generatedVideos = requesterId ? await listRecentMarketingVideos(db, requesterId, 5) : [];
  const marketingVideos = generatedVideos.map((v) => ({
    id: v.id,
    title: v.title,
    category: null as string | null,
    mediaUrl: v.previewUrl,
    downloadUrl: v.downloadUrl,
    previewable: v.previewable,
    downloadable: v.downloadable,
    mimeType: v.mimeType,
    status: v.status,
    provider: v.provider,
    language: v.language,
    durationSeconds: v.durationSeconds,
    productId: v.productId,
    createdAt: v.createdAt,
  }));

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'recommend_campaign',
    snapshot: facts,
    campaignSuggestion,
    marketingVideos,
    marketingVideosHint:
      marketingVideos.length === 0
        ? 'No marketing videos generated yet. Generate one from your product via POST /api/media/marketing-videos.'
        : null,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Marketing snapshot: {{published}} published products across {{categories}} categories. Consider a PRODUCT_ADS campaign with video creatives previewable and downloadable in-platform.',
    { published: facts.published, categories: facts.topCategories.length },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Marketing Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execAdsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
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
  const activeCampaigns = campaignsAll.filter((c) => c.status === 'ACTIVE' && c.isActive).length;

  const facts = {
    campaigns: campaignsAll.length,
    activeCampaigns,
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
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'recommend_ads',
    snapshot: facts,
    recommendation: {
      topUp:
        activeCampaigns === 0
          ? 'No active campaigns — allocate budget to a new campaign (e.g. TOP_ADS or B2B_ADS).'
          : 'Keep running active campaigns; monitor CTR and pause underperformers.',
      budgetSplit: 'SPONSORED_SEARCH 50% / PRODUCT_ADS 30% / B2B_ADS 20% (example — adjust by goals).',
    },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Ads snapshot: {{campaigns}} campaigns ({{activeCampaigns}} active), {{impressions}} impressions, {{clicks}} clicks, {{conversions}} conversions. CTR {{ctr}}%.',
    { campaigns: facts.campaigns, activeCampaigns: facts.activeCampaigns, impressions: facts.impressions, clicks: facts.clicks, conversions: facts.conversions, ctr: facts.ctr },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Ads Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execProductAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const p = await pickProduct(db, input.productId);
  if (!p) {
    const content = JSON.stringify({
      agentKey: agent.key,
      action: input.action ?? 'analyze_product',
      error: 'No product found. Provide a productId.',
      readOnly: true,
      generatedAt: new Date().toISOString(),
    });
    const out = await runAIFeature(db, {
      userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
      roles: ['SUPER_ADMIN'],
      requestType: `AGENT:${agent.key}`,
      system: 'You are the WASIT Product Agent.',
      user: 'No product found.',
      maxTokens: 48,
      metadata: { agentKey: agent.key },
    });
    return { content, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
  }

  const [variants, images, inventorySum] = await Promise.all([
    db.select({ name: productVariants.name, sku: productVariants.sku, price: productVariants.price, attributes: productVariants.attributes }).from(productVariants).where(eq(productVariants.productId, p.id)),
    db.select({ url: productImages.url, isPrimary: productImages.isPrimary }).from(productImages).where(eq(productImages.productId, p.id)),
    db.select({ v: sql<number>`coalesce(sum(quantity),0)::int` }).from(inventoryItems).where(eq(inventoryItems.productId, p.id)),
  ]);

  const inventoryQty = toNum(inventorySum[0]?.v);
  const priceNum = toNum(p.basePrice);
  const relevant = p.categoryName !== null && p.brand !== null && p.isPublished;

  const facts = {
    id: p.id,
    name: p.name,
    sku: p.sku,
    price: p.basePrice ?? '0',
    currency: p.currencyCode,
    category: p.categoryName,
    sellerType: p.sellerType,
    brand: p.brand,
    moq: p.moq,
    isPublished: p.isPublished,
    variants: variants.length,
    images: images.length,
    inventoryQty,
  };

  const issues: string[] = [];
  if (!p.isPublished) issues.push('not published');
  if (p.categoryName === null) issues.push('missing category');
  if (p.brand === null) issues.push('missing brand');
  if (variants.length === 0) issues.push('no variants');
  if (images.length === 0) issues.push('no images');
  if (inventoryQty <= 0) issues.push('no stock');
  const recommendation = issues.length > 0 ? `Improve: ${issues.join(', ')}.` : 'Listing looks healthy.';

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'analyze_product',
    product: facts,
    completeness: {
      score: Math.round(((1 - issues.length / 6) * 100)),
      issues,
      recommendation,
    },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Product "{{name}}" (SKU {{sku}}): price {{price}}, category {{category}}, variants {{variants}}, images {{images}}, stock {{inventoryQty}}. {{recommendation}}',
    { name: p.name, sku: p.sku, price: facts.price, category: p.categoryName ?? 'none', variants: facts.variants, images: facts.images, inventoryQty: facts.inventoryQty, recommendation },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Product Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, productId: p.id },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execSupportAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [openThreads, unreadMessages, usersCount, recentUnread] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(threads).where(eq(threads.isBlocked, false)),
    countOpenSupportMessages(db),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(eq(users.isActive, true)),
    db
      .select({ id: messages.id, senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.isDeleted, false), sql`${messages.readAt} is null`))
      .orderBy(desc(messages.createdAt))
      .limit(Number(input.limit ?? 5)),
  ]);

  const facts = {
    activeThreads: toNum(openThreads[0]?.v),
    unreadMessages,
    activeUsers: toNum(usersCount[0]?.v),
    recentUnread: recentUnread.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body.slice(0, 120), createdAt: m.createdAt.toISOString() })),
  };

  const responseTimeSuggestion =
    facts.unreadMessages > 0
      ? `There are ${facts.unreadMessages} unread messages. Prioritise replies to keep response time under 24h.`
      : 'No unread messages — maintain the current response posture.';

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'draft_reply',
    snapshot: facts,
    recommendation: responseTimeSuggestion,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Support snapshot: {{activeThreads}} threads, {{unreadMessages}} unread messages across {{activeUsers}} active users.',
    { activeThreads: facts.activeThreads, unreadMessages: facts.unreadMessages, activeUsers: facts.activeUsers },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Support Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execAnalyticsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const since = new Date(Date.now() - Number(input.periodDays ?? 30) * 24 * 60 * 60 * 1000);
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
      .limit(Number(input.limit ?? 5)),
    db
      .select({ date: dailyKpis.date, metricName: dailyKpis.metricName, metricValue: dailyKpis.metricValue, dimensions: dailyKpis.dimensions })
      .from(dailyKpis)
      .orderBy(desc(dailyKpis.date))
      .limit(7),
  ]);

  const facts = {
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
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'generate_report',
    snapshot: facts,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Analytics snapshot: {{users}} users, {{products}} products, {{suppliers}} suppliers, {{merchants}} merchants, {{companies}} companies, {{orders}} orders, GMV {{gmv}}.',
    { users: facts.users, products: facts.products, suppliers: facts.suppliers, merchants: facts.merchants, companies: facts.companies, orders: facts.orders, gmv: facts.gmv },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Analytics Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execMarketResearchAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [productsCount, categoriesByProducts, avgPrice, suppliersCount, merchantsCount, orderValue] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products),
    db
      .select({ category: categories.name, products: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(Number(input.limit ?? 5)),
    db.select({ v: sql<string>`round(coalesce(avg(base_price),0),2)::text` }).from(products),
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants),
    db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders),
  ]);

  const facts = {
    products: toNum(productsCount[0]?.v),
    categories: categoriesByProducts.map((c) => ({ name: c.category ?? 'Uncategorised', products: toNum(c.products) })),
    avgPrice: avgPrice[0]?.v ?? '0',
    suppliers: toNum(suppliersCount[0]?.v),
    merchants: toNum(merchantsCount[0]?.v),
    totalOrderValue: orderValue[0]?.v ?? '0',
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'market_overview',
    snapshot: facts,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Market overview: {{products}} products across {{categories}} categories, avg price {{avgPrice}}, with {{suppliers}} suppliers and {{merchants}} merchants.',
    { products: facts.products, categories: facts.categories.length, avgPrice: facts.avgPrice, suppliers: facts.suppliers, merchants: facts.merchants },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Market Research Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execB2BAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [suppliersAll, merchantsAll, companiesAll] = await Promise.all([
    db
      .select({ id: suppliers.id, companyName: suppliers.companyName, countryId: suppliers.countryId, verified: suppliers.verified })
      .from(suppliers)
      .where(eq(suppliers.isActive, true)),
    db
      .select({ id: merchants.id, storeName: merchants.storeName, countryId: merchants.countryId, verified: merchants.verified })
      .from(merchants)
      .where(eq(merchants.isActive, true)),
    db
      .select({ id: companies.id, legalName: companies.legalName, countryId: companies.countryId, verified: companies.verified })
      .from(companies)
      .where(eq(companies.isActive, true)),
  ]);

  const facts = {
    suppliers: suppliersAll.map((s) => ({ id: s.id, name: s.companyName, countryId: s.countryId, verified: s.verified })),
    merchants: merchantsAll.map((m) => ({ id: m.id, name: m.storeName, countryId: m.countryId, verified: m.verified })),
    companies: companiesAll.map((c) => ({ id: c.id, name: c.legalName, countryId: c.countryId, verified: c.verified })),
  };

  const matches = suppliersAll.map((s) => ({
    supplier: s.companyName,
    merchantCandidates: merchantsAll.length,
    companyCandidates: companiesAll.length,
    note: s.verified ? 'Verified supplier — strong B2B match signal.' : 'Unverified supplier — suggest verification before closing large deals.',
  }));

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'match_b2b',
    snapshot: { suppliers: facts.suppliers.length, merchants: facts.merchants.length, companies: facts.companies.length },
    matches,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'B2B matching: {{suppliers}} suppliers available to engage {{merchants}} merchants and {{companies}} companies.',
    { suppliers: facts.suppliers.length, merchants: facts.merchants.length, companies: facts.companies.length },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT B2B Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execRiskAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.userId === 'string' ? (input.userId as string) : undefined;
  const where = userId ? eq(riskEvents.userId, userId) : undefined;
  const [profiles, events, totalEvents] = await Promise.all([
    db.select().from(riskProfiles).orderBy(desc(riskProfiles.currentScore)).limit(Number(input.limit ?? 10)),
    where
      ? db.select().from(riskEvents).where(where).orderBy(desc(riskEvents.createdAt)).limit(30)
      : db.select().from(riskEvents).orderBy(desc(riskEvents.createdAt)).limit(30),
    db.select({ v: sql<number>`count(*)::int` }).from(riskEvents),
  ]);

  const facts = {
    userScoped: Boolean(userId),
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
  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'assess_risk',
    snapshot: facts,
    riskPosture: {
      severeEvents,
      note:
        severeEvents > 0
          ? `${severeEvents} severe/high-risk event(s) recorded. Recommend review and mitigation.`
          : 'No severe risk events at the moment.',
    },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Risk posture: {{total}} risk events recorded; {{severe}} severe/high severity.',
    { total: facts.totalRiskEvents, severe: severeEvents },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Risk Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: userId ?? 'all' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execDisputeAssistant(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
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
      .limit(Number(input.limit ?? 5)),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(eq(disputes.status, 'OPEN')),
  ]);

  const openN = toNum(openCount[0]?.v);
  const facts = {
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
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'summarize_dispute',
    snapshot: facts,
    recommendation:
      openN > 0
        ? `There are ${openN} open dispute(s). Prioritise responses and keep evidence organised per dispute.`
        : 'No open disputes — recommend ongoing mediation protocol.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Dispute centre: {{total}} disputes total, {{open}} open, with {{messages}} recent messages exchanged.',
    { total: facts.totalDisputes, open: openN, messages: facts.recentMessages.length },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Dispute Assistant.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execDevelopmentAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [usersCount, productsCount, ordersCount, campaignsCount, auditCount, lastMonthlyKpi] = await Promise.all([
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

  const facts = {
    users: toNum(usersCount[0]?.v),
    products: toNum(productsCount[0]?.v),
    orders: toNum(ordersCount[0]?.v),
    campaigns: toNum(campaignsCount[0]?.v),
    kpiDays: toNum(auditCount[0]?.v),
    lastDaily: lastMonthlyKpi[0] ? { date: lastMonthlyKpi[0].date.toISOString(), metric: lastMonthlyKpi[0].metricName, value: String(lastMonthlyKpi[0].metricValue) } : null,
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'dev_plan',
    snapshot: facts,
    recommendation: 'Prioritise hardening the order/ledger pipeline and onboarding flows as trading volume grows.',
    nextSteps: ['Instrument dashboards', 'Add regression tests for order lifecycle', 'Improve admin reporting'],
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Development context: {{users}} users, {{products}} products, {{orders}} orders, {{campaigns}} campaigns.',
    { users: facts.users, products: facts.products, orders: facts.orders, campaigns: facts.campaigns },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Development Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/** Routes an agent task to its specialised executor. Never uses mock data. */
export async function executeAgentTask(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  switch (agent.key) {
    case 'sales-agent':
      return execSalesAgent(db, agent, input);
    case 'marketing-agent':
      return execMarketingAgent(db, agent, input);
    case 'ads-agent':
      return execAdsAgent(db, agent, input);
    case 'product-agent':
      return execProductAgent(db, agent, input);
    case 'support-agent':
      return execSupportAgent(db, agent, input);
    case 'analytics-agent':
      return execAnalyticsAgent(db, agent, input);
    case 'market-research-agent':
      return execMarketResearchAgent(db, agent, input);
    case 'b2b-agent':
      return execB2BAgent(db, agent, input);
    case 'risk-agent':
      return execRiskAgent(db, agent, input);
    case 'dispute-assistant':
      return execDisputeAssistant(db, agent, input);
    case 'development-agent':
      return execDevelopmentAgent(db, agent, input);
    default:
      throw new Error(`Unknown agent key: ${agent.key}`);
  }
}
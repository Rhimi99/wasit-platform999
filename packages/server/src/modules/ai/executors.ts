import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { type UserRole } from '@wasit/shared';
import type { AgentDefinition } from '../../lib/ai/types';
import { runAIFeature } from '../../lib/ai/runtime';
import { products, categories, productVariants, productImages } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems, transactions, transactionLedger } from '../../db/schema/commerce';
import { inventoryItems, inventoryMovements } from '../../db/schema/commerce_extras';
import { campaigns, adCreatives, adEvents } from '../../db/schema/ads';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages } from '../../db/schema/disputes';
import { trustScores, reviews } from '../../db/schema/trust';
import { messages, threads, threadParticipants } from '../../db/schema/messaging';
import { users } from '../../db/schema/auth';
import { agentTasks } from '../../db/schema/agents';
import { commissionPolicies } from '../../db/schema/engine';
import { dailyKpis } from '../../db/schema/analytics';
import { listRecentMarketingVideos } from '../media/service';
import { listOwnedSellerEntities, resolveOwnedSellerIds } from '../../lib/seller-ownership';
import { ledgerFlowTotals } from '../../lib/ledger-flows';
import { supervise } from './supervisor.js';
import { SYSTEM_PRINCIPAL } from './runner.js';

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

/**
 * Ledger flow totals for one currency, or a sum across all currencies when
 * none is given. Mirrors `ledgerFlowTotals` but tolerates an unscoped request
 * so the Finance Agent can report a portfolio-wide figure.
 */
async function ledgerFlowsForScope(db: DB, currencyCode?: string): Promise<Record<string, string>> {
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

/** Builds a short deterministic advice text from a structured facts object. */
function adviceText(template: string, facts: Record<string, unknown>): string {
  let text = template;
  for (const [k, v] of Object.entries(facts)) {
    text = text.replaceAll(`{{${k}}}`, v === null || v === undefined ? '0' : String(v));
  }
  return text;
}


/**
 * True when the requester may read platform-wide commerce data. Restricted to
 * ADMIN and SUPER_ADMIN only; `analytics:read:all` is NOT sufficient. Resolved
 * from the database so a scheduled task cannot assert a permission it lacks.
 */
async function canReadPlatformData(db: DB, userId: string, agent: AgentDefinition): Promise<boolean> {
  // The named scheduler principal reaches the executor only for a
  // scheduler-provenance task (enforced in `runTask`), so a user or a forged task
  // cannot obtain platform scope by claiming this id. Even then it only gets
  // platform scope for a genuinely platform agent (`requiresPlatformScope`); an
  // own-scope agent has no tenant to anchor to under the scheduler and is
  // refused, so trust in the scheduler never silently widens a tenant-scoped read.
  if (userId === SYSTEM_PRINCIPAL) return agent.requiresPlatformScope === true;
  const res = await db.execute<{ role_name: string }>(sql`
    select r.name as role_name
    from user_roles ur
    join roles r on r.id = ur.role_id
    where ur.user_id = ${userId}
  `);
  const rows = (res as unknown as { rows: { role_name: string }[] }).rows ?? [];
  const roles = rows.map((r) => r.role_name as UserRole);
  // Platform-wide data is restricted to admins only; `analytics:read:all` is
  // deliberately NOT sufficient, so support/risk/dispute roles are refused.
  return roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
}

/**
 * Defence-in-depth gate for the executors whose output is platform-wide.
 *
 * The runner ({@link assertAgentScope}) already refuses a non-admin *before* a
 * task is queued or run, but the executor is also a boundary: a caller that
 * reached `executeAgentTask` directly (bypassing the runner) must still be
 * refused, not shown another owner's data. Every platform-scoped agent
 * (`requiresPlatformScope`) that exposes cross-owner detail calls this first and
 * returns a refusal — never a widened read — when the requester is not an admin.
 * A genuine scheduler task carries the named system principal, which resolves to
 * admin scope server-side in `runTask`.
 */
async function requirePlatformGate(db: DB, userId: string, agent: AgentDefinition): Promise<AgentExecutorResult | null> {
  if (!agent.requiresPlatformScope) return null;
  const ok = await canReadPlatformData(db, userId, agent);
  return ok ? null : scopeDenied(agent.key);
}

/**
 * Explicit refusal for a task whose data scope cannot be established safely.
 * Refusing is mandatory: silently widening the query to the whole platform is
 * exactly the leak we must prevent.
 */
function scopeDenied(scope: string): AgentExecutorResult {
  return {
    content: JSON.stringify({
      agentKey: scope,
      status: 'refused',
      error: 'NO_SCOPE',
      message: 'No owned entities or authorized data scope for this agent — refusing to run.',
      readOnly: true,
    }),
    tokensInput: 0,
    tokensOutput: 0,
  };
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
void countOpenSupportMessages;

// ---------- executors: one specialised query/output per agent ----------

async function execSalesAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const periodDays = Number(input.periodDays ?? 30);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const isPlatform = await canReadPlatformData(db, userId, agent);

  // Least privilege: a non-platform caller only sees orders tied to entities
  // they own (as buyer or seller). Never fall back to a platform-wide read.
  // A caller id is always a valid anchor (they are a buyer in their own orders),
  // so this scope is always determinable; a missing anchor is refused.
  const ownedSellerIds = isPlatform ? [] : await resolveOwnedSellerIds(db, userId);
  if (!isPlatform && (!userId || userId === 'system')) {
    return scopeDenied(agent.key);
  }
  const ownerConds = [eq(orders.buyerId, userId)];
  if (ownedSellerIds.length > 0) ownerConds.push(inArray(orders.sellerId, ownedSellerIds));
  const orderScope = isPlatform ? undefined : (ownerConds.length === 1 ? ownerConds[0] : or(...ownerConds));

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
      .where(and(gte(orders.createdAt, since), ...(orderScope ? [orderScope] : []))),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, itemsTotal: orders.itemsTotal, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(orderScope)
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
    scope: isPlatform ? 'platform' : 'own',
    scopedToOwnSales: !isPlatform,
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
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Sales Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: isPlatform ? 'platform' : 'own' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execMarketingAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Platform-wide catalogue/brand detail is admin-only. A non-admin sees the
  // same shape scoped to the entities they own (empty when they own none), so
  // the agent keeps working without exposing another seller's catalogue.
  const isPlatform = await canReadPlatformData(db, userId, agent);
  const ownedIds = isPlatform ? [] : await resolveOwnedSellerIds(db, userId);
  const productWhere = isPlatform
    ? eq(products.isPublished, true)
    : and(eq(products.isPublished, true), ownedIds.length > 0 ? inArray(products.sellerId, ownedIds) : sql`false`);
  const limit = Math.min(Number(input.limit ?? 5), 10);
  const [published, topCategories, brands] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(products).where(productWhere),
    db
      .select({ category: categories.name, p: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(productWhere)
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(limit),
    db
      .select({ brand: products.brand, p: sql<number>`count(*)::int` })
      .from(products)
      .where(and(sql`${products.brand} is not null`, productWhere))
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
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
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
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const isPlatform = await canReadPlatformData(db, userId, agent);
  // A real caller id is always a valid scope anchor; a missing/system requester
  // with no platform rights has no determinable scope and is refused.
  if (!isPlatform && (!userId || userId === 'system')) {
    return scopeDenied(agent.key);
  }
  const ownedSellerIds = isPlatform ? [] : await resolveOwnedSellerIds(db, userId);

  // Own scope: only threads the caller participates in (or participates via an
  // owned seller entity), and only messages inside those threads.
  const participantThreads = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(inArray(threadParticipants.userId, [userId, ...ownedSellerIds]));
  const threadIds = participantThreads.map((t) => t.threadId);
  const threadScope = isPlatform ? undefined : inArray(messages.threadId, threadIds);

  const [openThreads, unreadRows, usersCount, recentUnread] = await Promise.all([
    isPlatform
      ? db.select({ v: sql<number>`count(*)::int` }).from(threads).where(eq(threads.isBlocked, false))
      : db.select({ v: sql<number>`count(*)::int` }).from(threads).where(and(eq(threads.isBlocked, false), inArray(threads.id, threadIds))),
    isPlatform
      ? db.select({ v: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.isDeleted, false), eq(messages.status, 'SENT'), sql`${messages.readAt} is null`))
      : db
          .select({ v: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.isDeleted, false), eq(messages.status, 'SENT'), sql`${messages.readAt} is null`, ...(threadScope ? [threadScope] : []))),
    db.select({ v: sql<number>`count(*)::int` }).from(users).where(eq(users.isActive, true)),
    db
      .select({ id: messages.id, senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.isDeleted, false), sql`${messages.readAt} is null`, ...(threadScope ? [threadScope] : [])))
      .orderBy(desc(messages.createdAt))
      .limit(Number(input.limit ?? 5)),
  ]);

  const facts = {
    activeThreads: toNum(openThreads[0]?.v),
    unreadMessages: toNum(unreadRows[0]?.v),
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
    scope: isPlatform ? 'platform' : 'own',
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
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Support Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: isPlatform ? 'platform' : 'own' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execAnalyticsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Platform KPIs are platform-wide data: only admins (ADMIN/SUPER_ADMIN) may
  // read them. Everyone else is refused — we never substitute another tenant's
  // order/commission totals.
  const isPlatform = await canReadPlatformData(db, userId, agent);
  if (!isPlatform) {
    return scopeDenied(agent.key);
  }

  const since = new Date(Date.now() - Number(input.periodDays ?? 30) * 24 * 60 * 60 * 1000);
  void since;

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
    scope: 'platform',
    snapshot: facts,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Analytics snapshot: {{users}} users, {{products}} products, {{suppliers}} suppliers, {{merchants}} merchants, {{companies}} companies, {{orders}} orders, GMV {{gmv}}.',
    { users: facts.users, products: facts.products, suppliers: facts.suppliers, merchants: facts.merchants, companies: facts.companies, orders: facts.orders, gmv: facts.gmv },
  );

  const out = await runAIFeature(db, {
    userId,
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
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const ownedIds = await resolveOwnedSellerIds(db, userId);
  const [productsCount, categoriesByProducts, avgPrice, suppliersCount, merchantsCount, orderValue, scoped] = await Promise.all([
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
    // Tenant-isolated view: only the caller's own catalogue and sales. Never
    // another merchant/supplier/company row, only this caller's aggregates.
    ownedIds.length > 0
      ? Promise.all([
          db.select({ v: sql<number>`count(*)::int` }).from(products).where(inArray(products.sellerId, ownedIds)),
          db.select({ v: sql<string>`coalesce(sum(items_total),0)::text` }).from(orders).where(inArray(orders.sellerId, ownedIds)),
        ])
      : Promise.resolve([[{ v: 0 }], [{ v: '0' }]] as [{ v: number }[], { v: string }[]]),
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
    // The scoped block is the caller's own market slice; the snapshot above is
    // platform-wide aggregates only (no other tenant's raw records).
    scopedToOwned: true,
    yourMarket: {
      products: toNum(scoped[0][0]?.v),
      orderValue: scoped[1][0]?.v ?? '0',
    },
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
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Tenant isolation: a B2B partner match must never expose another tenant's
  // books. The private counterparty lists (contactable suppliers/merchants/
  // companies) are scoped to the caller's own entities; only the aggregate
  // counts are platform-wide.
  const ownedIds = await resolveOwnedSellerIds(db, userId);
  const [counts, suppliersAll, merchantsAll, companiesAll] = await Promise.all([
    Promise.all([
      db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.isActive, true)),
      db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.isActive, true)),
      db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.isActive, true)),
    ]),
    ownedIds.length > 0
      ? db
          .select({ id: suppliers.id, companyName: suppliers.companyName, countryId: suppliers.countryId, verified: suppliers.verified })
          .from(suppliers)
          .where(and(eq(suppliers.isActive, true), inArray(suppliers.id, ownedIds)))
      : [],
    ownedIds.length > 0
      ? db
          .select({ id: merchants.id, storeName: merchants.storeName, countryId: merchants.countryId, verified: merchants.verified })
          .from(merchants)
          .where(and(eq(merchants.isActive, true), inArray(merchants.id, ownedIds)))
      : [],
    ownedIds.length > 0
      ? db
          .select({ id: companies.id, legalName: companies.legalName, countryId: companies.countryId, verified: companies.verified })
          .from(companies)
          .where(and(eq(companies.isActive, true), inArray(companies.id, ownedIds)))
      : [],
  ]);

  const platformCounts = {
    suppliers: toNum(counts[0][0]?.v),
    merchants: toNum(counts[1][0]?.v),
    companies: toNum(counts[2][0]?.v),
  };

  const matches = suppliersAll.map((s) => ({
    supplier: s.companyName,
    merchantCandidates: platformCounts.merchants,
    companyCandidates: platformCounts.companies,
    note: s.verified ? 'Verified supplier — strong B2B match signal.' : 'Unverified supplier — suggest verification before closing large deals.',
  }));

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'match_b2b',
    scopedToOwned: true,
    snapshot: {
      platformCounts,
      owned: { suppliers: suppliersAll.length, merchants: merchantsAll.length, companies: companiesAll.length },
    },
    matches,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'B2B matching: platform has {{suppliers}} suppliers, {{merchants}} merchants and {{companies}} companies; you own {{ownedSuppliers}} supplier(s) in scope.',
    { suppliers: platformCounts.suppliers, merchants: platformCounts.merchants, companies: platformCounts.companies, ownedSuppliers: suppliersAll.length },
  );

  const out = await runAIFeature(db, {
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT B2B Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: true },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execRiskAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
  const scopedUserId = typeof input.userId === 'string' ? (input.userId as string) : undefined;
  const where = scopedUserId ? eq(riskEvents.userId, scopedUserId) : undefined;
  const [profiles, events, totalEvents] = await Promise.all([
    db.select().from(riskProfiles).orderBy(desc(riskProfiles.currentScore)).limit(Number(input.limit ?? 10)),
    where
      ? db.select().from(riskEvents).where(where).orderBy(desc(riskEvents.createdAt)).limit(30)
      : db.select().from(riskEvents).orderBy(desc(riskEvents.createdAt)).limit(30),
    db.select({ v: sql<number>`count(*)::int` }).from(riskEvents),
  ]);

  const facts = {
    userScoped: Boolean(scopedUserId),
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
    metadata: { agentKey: agent.key, action: input.action, scope: scopedUserId ?? 'all' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

async function execDisputeAssistant(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
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
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
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

// ---------- Phase 19: the eight additional specialised agents ----------

/**
 * Finance Agent — ledger-backed financial summary. Read-only: it never writes a
 * ledger entry, never moves funds and never touches the commission policy.
 */
async function execFinanceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
  const currency = typeof input.currencyCode === 'string' ? (input.currencyCode as string) : undefined;
  const flows = await ledgerFlowsForScope(db, currency);
  const [policies, recentLedger] = await Promise.all([
    db.select().from(commissionPolicies).where(eq(commissionPolicies.isActive, true)).limit(20),
    db
      .select({ entryType: transactionLedger.entryType, direction: transactionLedger.direction, amount: transactionLedger.amount, currencyCode: transactionLedger.currencyCode, createdAt: transactionLedger.createdAt })
      .from(transactionLedger)
      .orderBy(desc(transactionLedger.createdAt))
      .limit(Number(input.limit ?? 15)),
  ]);

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'reconcile',
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
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Finance summary ({{currency}}): commission {{commission}}, payment fees {{fees}}, refunds {{refunds}}. Commission policy is configuration-driven, never hardcoded here.',
    { currency: data.currencyCode, commission: flows.commission, fees: flows.paymentFees, refunds: flows.refunds },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Finance Agent. Report figures only; never move funds.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Payment & Settlement Agent — monitors payment intents, webhook health and
 * payout status. Never settles autonomously (that is an approved action).
 */
async function execPaymentSettlementAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [intentStatus, webhookStatus, payoutStatus] = await Promise.all([
    db.select({ status: transactions.status, count: sql<number>`count(*)::int` }).from(transactions).groupBy(transactions.status),
    db.execute<{ status: string; count: number }>(sql`select status, count(*)::int as count from payment_webhook_events group by status`),
    db.execute<{ status: string; count: number }>(sql`select status, count(*)::int as count from payouts group by status`),
  ]);
  const rowsOf = (r: unknown): { status: string; count: number }[] => ((r as { rows?: { status: string; count: number }[] }).rows ?? []);
  const webhooks = rowsOf(webhookStatus);
  const payoutsRows = rowsOf(payoutStatus);

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'monitor_settlement',
    paymentIntentStatus: intentStatus.map((s) => ({ status: s.status, count: Number(s.count) })),
    webhookStatus: webhooks,
    payoutStatus: payoutsRows,
    anomalies: {
      deadLetteredWebhooks: webhooks.find((w) => w.status === 'DEAD_LETTERED')?.count ?? 0,
      failedPayouts: payoutsRows.find((p) => p.status === 'FAILED')?.count ?? 0,
    },
    note: 'Settlement and payout execution is an approved action; this agent only reports.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Payment/settlement monitor: {{intents}} payment intents tracked, {{webhooks}} webhook events, {{payouts}} payouts. Dead-lettered webhooks: {{dlq}}.',
    { intents: intentStatus.reduce((a, s) => a + Number(s.count), 0), webhooks: webhooks.reduce((a, w) => a + w.count, 0), payouts: payoutsRows.reduce((a, p) => a + p.count, 0), dlq: (data.anomalies as { deadLetteredWebhooks: number }).deadLetteredWebhooks },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Payment & Settlement Agent. Monitor only.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Compliance Agent — surfaces policy/verification gaps. Produces findings only;
 * a final ruling is an approved action.
 */
async function execComplianceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const [unverifiedSuppliers, unverifiedMerchants, unverifiedCompanies, openDisputes] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.verified, false)),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(inArray(disputes.status, ['OPEN', 'UNDER_REVIEW'])),
  ]);

  const findings = [
    { area: 'KYC/KYB', count: toNum(unverifiedSuppliers[0]?.v) + toNum(unverifiedMerchants[0]?.v) + toNum(unverifiedCompanies[0]?.v), severity: 'MEDIUM', note: 'Entities without completed verification.' },
    { area: 'DISPUTES', count: toNum(openDisputes[0]?.v), severity: 'LOW', note: 'Open or under-review disputes needing resolution.' },
  ];

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'check',
    findings,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Compliance scan: {{kyc}} unverified entities, {{disputes}} open disputes.',
    { kyc: findings[0].count, disputes: findings[1].count },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Compliance Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Supplier Agent — reviews a supplier record. A non-staff caller only ever sees
 * a supplier they own, so tenant data cannot leak across accounts.
 */
async function execSupplierAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const owned = await listOwnedSellerEntities(db, userId);
  const ownedSupplierIds = owned.filter((e) => e.sellerType === 'SUPPLIER').map((e) => e.id);
  const requestedId = typeof input.supplierId === 'string' ? (input.supplierId as string) : undefined;

  const baseQuery = db
    .select({ id: suppliers.id, companyName: suppliers.companyName, countryId: suppliers.countryId, verified: suppliers.verified, isActive: suppliers.isActive })
    .from(suppliers);
  // Isolation: an explicit id is honoured only when the caller owns it. A
  // requested id the caller does not own yields an empty scope, never another
  // tenant's record.
  const ownsRequested = requestedId ? ownedSupplierIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await baseQuery.where(eq(suppliers.id, requestedId)).limit(1)
      : []
    : ownedSupplierIds.length > 0
      ? await baseQuery.where(inArray(suppliers.id, ownedSupplierIds)).limit(Number(input.limit ?? 10))
      : [];

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'onboard',
    scopedToOwned: !requestedId,
    suppliers: rows.map((s) => ({
      id: s.id,
      name: s.companyName,
      countryId: s.countryId,
      verified: s.verified,
      isActive: s.isActive,
    })),
    note: requestedId && rows.length === 0 ? 'Supplier not found in your scope.' : 'Review completeness and verification status.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText('Supplier review: {{count}} record(s) in scope.', { count: rows.length });

  const out = await runAIFeature(db, {
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Supplier Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: !requestedId },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/** Merchant Agent — same isolation rule as the Supplier Agent, for merchants. */
async function execMerchantAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const owned = await listOwnedSellerEntities(db, userId);
  const ownedMerchantIds = owned.filter((e) => e.sellerType === 'MERCHANT').map((e) => e.id);
  const requestedId = typeof input.merchantId === 'string' ? (input.merchantId as string) : undefined;

  const baseQuery = db
    .select({ id: merchants.id, storeName: merchants.storeName, countryId: merchants.countryId, verified: merchants.verified, isActive: merchants.isActive })
    .from(merchants);
  // Isolation: an explicit id is honoured only when the caller owns it.
  const ownsRequested = requestedId ? ownedMerchantIds.includes(requestedId) : false;
  const rows = requestedId
    ? ownsRequested
      ? await baseQuery.where(eq(merchants.id, requestedId)).limit(1)
      : []
    : ownedMerchantIds.length > 0
      ? await baseQuery.where(inArray(merchants.id, ownedMerchantIds)).limit(Number(input.limit ?? 10))
      : [];

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'onboard',
    scopedToOwned: !requestedId,
    merchants: rows.map((m) => ({
      id: m.id,
      name: m.storeName,
      countryId: m.countryId,
      verified: m.verified,
      isActive: m.isActive,
    })),
    note: requestedId && rows.length === 0 ? 'Merchant not found in your scope.' : 'Review completeness and verification status.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText('Merchant review: {{count}} record(s) in scope.', { count: rows.length });

  const out = await runAIFeature(db, {
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Merchant Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: !requestedId },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Customer Intelligence Agent — segments buyers. A non-staff caller only sees
 * orders where they are the seller, so customer data stays tenant-isolated.
 */
async function execCustomerIntelligenceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const isPlatform = await canReadPlatformData(db, userId, agent);
  // A real caller id is always a valid scope anchor; a missing/system requester
  // with no platform rights has no determinable scope and is refused.
  if (!isPlatform && (!userId || userId === 'system')) {
    return scopeDenied(agent.key);
  }
  const ownedSellerIds = isPlatform ? [] : await resolveOwnedSellerIds(db, userId);

  const rows = isPlatform
    ? await db.select({ buyerId: orders.buyerId, itemsTotal: orders.itemsTotal }).from(orders).limit(2000)
    : await db.select({ buyerId: orders.buyerId, itemsTotal: orders.itemsTotal }).from(orders).where(inArray(orders.sellerId, ownedSellerIds)).limit(2000);

  const byBuyer = new Map<string, { orders: number; total: number }>();
  for (const r of rows) {
    const cur = byBuyer.get(r.buyerId) ?? { orders: 0, total: 0 };
    cur.orders += 1;
    cur.total += toNum(r.itemsTotal);
    byBuyer.set(r.buyerId, cur);
  }
  const buyers = [...byBuyer.values()];
  const repeat = buyers.filter((b) => b.orders > 1).length;
  const oneTime = buyers.filter((b) => b.orders === 1).length;
  const avgValue = buyers.length > 0 ? buyers.reduce((a, b) => a + b.total, 0) / buyers.length : 0;

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'segment',
    scope: isPlatform ? 'platform' : 'own',
    scopedToOwnedSales: !isPlatform,
    segments: {
      totalBuyers: buyers.length,
      repeatBuyers: repeat,
      oneTimeBuyers: oneTime,
      avgLifetimeValue: avgValue.toFixed(2),
    },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Customer segmentation: {{total}} buyers, {{repeat}} repeat, {{one}} one-time, avg value {{avg}}.',
    { total: buyers.length, repeat, one: oneTime, avg: avgValue.toFixed(2) },
  );

  const out = await runAIFeature(db, {
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Customer Intelligence Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwnedSales: !isPlatform },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Operations Agent — operational health: order pipeline, failed agent tasks and
 * open disputes. Read-only.
 */
async function execOperationsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
  const [orderPipeline, failedTasks, openDisputes, lowStock] = await Promise.all([
    db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status),
    db.select({ v: sql<number>`count(*)::int` }).from(agentTasks).where(eq(agentTasks.status, 'failed')),
    db.select({ v: sql<number>`count(*)::int` }).from(disputes).where(inArray(disputes.status, ['OPEN', 'UNDER_REVIEW'])),
    db.execute<{ count: number }>(sql`select count(*)::int as count from inventory_items where (quantity - reserved_quantity) <= low_stock_threshold`),
  ]);
  const lowStockRows = (lowStock as { rows?: { count: number }[] }).rows ?? [];

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'health_check',
    orderPipeline: orderPipeline.map((o) => ({ status: o.status, count: Number(o.count) })),
    failedAgentTasks: toNum(failedTasks[0]?.v),
    openDisputes: toNum(openDisputes[0]?.v),
    lowStockItems: Number(lowStockRows[0]?.count ?? 0),
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Operations health: {{failed}} failed agent tasks, {{disputes}} open disputes, {{stock}} low-stock items.',
    { failed: data.failedAgentTasks as never, disputes: data.openDisputes as never, stock: data.lowStockItems as never },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Operations Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Outreach & Acquisition Agent — discovers candidate entities from the platform
 * directory, de-duplicates them, classifies fit and drafts introductions.
 *
 * External sending is deliberately NOT performed here: a draft is produced and
 * an `outreach.send` task would require an explicit human approval. Discovery is
 * capped by the agent's daily limit.
 */
async function execOutreachAcquisitionAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const discoveryLimit = Math.min(Number(agent.limits.dailyDiscoveryLimit ?? 200), Number(input.limit ?? 50));
  // Tenant isolation: an outreach draft is prepared for the caller's *own*
  // entities. We never enumerate another tenant's identity rows (name/country).
  // Only platform-wide *aggregates* (counts) are exposed as market context.
  const ownedIds = await resolveOwnedSellerIds(db, userId);
  const [suppliersRows, merchantsRows, companiesRows, platformCounts] = await Promise.all([
    ownedIds.length > 0
      ? db.select({ id: suppliers.id, name: suppliers.companyName, countryId: suppliers.countryId, verified: suppliers.verified }).from(suppliers).where(and(eq(suppliers.isActive, true), inArray(suppliers.id, ownedIds))).limit(discoveryLimit)
      : Promise.resolve([] as { id: string; name: string; countryId: string | null; verified: boolean }[]),
    ownedIds.length > 0
      ? db.select({ id: merchants.id, name: merchants.storeName, countryId: merchants.countryId, verified: merchants.verified }).from(merchants).where(and(eq(merchants.isActive, true), inArray(merchants.id, ownedIds))).limit(discoveryLimit)
      : Promise.resolve([] as { id: string; name: string; countryId: string | null; verified: boolean }[]),
    ownedIds.length > 0
      ? db.select({ id: companies.id, name: companies.legalName, countryId: companies.countryId, verified: companies.verified }).from(companies).where(and(eq(companies.isActive, true), inArray(companies.id, ownedIds))).limit(discoveryLimit)
      : Promise.resolve([] as { id: string; name: string; countryId: string | null; verified: boolean }[]),
    Promise.all([
      db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.isActive, true)),
      db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.isActive, true)),
      db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.isActive, true)),
    ]),
  ]);

  // Deterministic de-duplication on (type, id) and fit classification.
  const seen = new Set<string>();
  const candidates = [
    ...suppliersRows.map((s) => ({ type: 'SUPPLIER' as const, ...s })),
    ...merchantsRows.map((m) => ({ type: 'MERCHANT' as const, ...m })),
    ...companiesRows.map((c) => ({ type: 'COMPANY' as const, ...c })),
  ].filter((c) => {
    const k = `${c.type}:${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const classified = candidates.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    countryId: c.countryId,
    fit: c.verified ? 'HIGH' : 'MEDIUM',
    rationale: c.verified ? 'Verified entity — ready for a WASIT introduction.' : 'Unverified — verify before outreach.',
  }));

  const drafts = classified
    .filter((c) => c.fit === 'HIGH')
    .slice(0, Math.min(Number(input.draftLimit ?? 5), 10))
    .map((c) => ({ to: c.name, channel: 'EMAIL', status: 'DRAFT', body: `Hello ${c.name}, WASIT BUSINESS GLOBAL helps partners trade globally...` }));

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'run_cycle',
    scopedToOwned: true,
    platformCounts: {
      suppliers: Number(platformCounts[0][0]?.v ?? 0),
      merchants: Number(platformCounts[1][0]?.v ?? 0),
      companies: Number(platformCounts[2][0]?.v ?? 0),
    },
    discovered: classified.length,
    highFit: classified.filter((c) => c.fit === 'HIGH').length,
    candidates: classified.slice(0, Number(input.limit ?? 20)),
    drafts,
    externalSendEnabled: false,
    note: 'Drafts only, scoped to your own entities. Sending requires an approved outreach.send action and is disabled by default.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Outreach cycle: discovered {{n}} of your entities, {{high}} high-fit, {{drafts}} drafts prepared (no external send).',
    { n: classified.length, high: data.highFit as never, drafts: drafts.length },
  );

  const out = await runAIFeature(db, {
    userId,
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Outreach & Acquisition Agent. Never send without approval.',
    user: text,
    maxTokens: 128,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: true },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
}

/**
 * Agent Supervisor — the one executor that is not model-driven. It recomputes
 * task/agent health, persists any needed containment, and returns the report as
 * its "advice". It cannot approve tasks, lift approval gates, change the
 * catalogue or grant permissions.
 */
async function execAgentSupervisor(db: DB, agent: AgentDefinition): Promise<AgentExecutorResult> {
  const report = await supervise(db);
  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: 'supervisor.observe',
    report: {
      total: report.total,
      counts: report.counts,
      loopDetected: report.loopDetected,
      runawayDetected: report.runawayDetected,
      stuckTasks: report.stuckTasks,
      expiredQueued: report.expiredQueued,
      failureRateFlagged: report.failureRateFlagged,
      interventions: report.interventions.length,
      alerts: report.alerts,
    },
    readOnly: true,
    deterministic: true,
    generatedAt: report.generatedAt,
  };
  const advice = JSON.stringify(data);
  // Bytes-based token estimate; the supervisor never calls a model provider.
  return { content: advice, tokensInput: 0, tokensOutput: Math.ceil(advice.length / 4) };
}

/** Routes an agent task to its specialised executor. Never uses mock data. */
export async function executeAgentTask(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  switch (agent.key) {
    case 'agent-supervisor':
      return execAgentSupervisor(db, agent);
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
    case 'finance-agent':
      return execFinanceAgent(db, agent, input);
    case 'payment-settlement-agent':
      return execPaymentSettlementAgent(db, agent, input);
    case 'compliance-agent':
      return execComplianceAgent(db, agent, input);
    case 'supplier-agent':
      return execSupplierAgent(db, agent, input);
    case 'merchant-agent':
      return execMerchantAgent(db, agent, input);
    case 'customer-intelligence-agent':
      return execCustomerIntelligenceAgent(db, agent, input);
    case 'operations-agent':
      return execOperationsAgent(db, agent, input);
    case 'outreach-acquisition-agent':
      return execOutreachAcquisitionAgent(db, agent, input);
    default:
      throw new Error(`Unknown agent key: ${agent.key}`);
  }
}
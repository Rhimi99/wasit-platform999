import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client';
import type { AgentDefinition } from '../../lib/ai/types';
import { runAIFeature } from '../../lib/ai/runtime';
import { requireAction } from '../../lib/ai/agent-run-context';
import { withAgentDataScope } from './agent-scope';
import { products, categories, productVariants, productImages } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems, transactions } from '../../db/schema/commerce';
import { inventoryItems, inventoryMovements } from '../../db/schema/commerce_extras';
import { campaigns, adCreatives, adEvents } from '../../db/schema/ads';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages, disputeEvidence, disputeEvents, disputeAppeals } from '../../db/schema/disputes';
import { trustScores, reviews } from '../../db/schema/trust';
import { messages, threads } from '../../db/schema/messaging';
import { users } from '../../db/schema/auth';
import { countries } from '../../db/schema/geo';
import { countryPolicyGaps } from '../../db/schema/engine';
import { aiRequests } from '../../db/schema/ai';
import { agentTasks } from '../../db/schema/agents';
import { agentRuns, agentRunSteps } from '../../db/schema/agent_runs';
import { dailyKpis } from '../../db/schema/analytics';
import { listRecentMarketingVideos } from '../media/service';
import { ApiError, MARKETING_VIDEO_DURATION } from '@wasit/shared';
import { env } from '../../lib/env';
import { planTimeline, produceMarketingVideo, type ProducedVideo } from '../../lib/media/marketing-video';
import { evaluateMarketingVideo, type QualityReport } from '../../lib/media/video-quality';
import { VOICE_CATALOGUE, VIDEO_LANGUAGES, isVideoLanguage, resolveVoice, type VideoLanguage } from '../../lib/media/tts';
import { MARKETING_OBJECTIVES, buildVideoScript, isMarketingObjective, type MarketingObjective } from '../../lib/media/video-script';
import { resolveVideoProvider } from '../../lib/media/resolve';
import { getAgentRunContext } from '../../lib/ai/agent-run-context';
import { SYSTEM_PRINCIPAL } from './scope';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { measureMp4DurationSeconds } from '../../lib/media/mp4';
import { decodeMp4File, probeMp4File } from '../../lib/media/verify';
import { resolveMediaStorage } from '../../lib/media/resolve';
import { analyseFailures, buildRepairPackage, buildReviewReport, proposePatch } from './diagnostics';
import { buildDisputeSummary, buildDisputeTriage, policyNumber, type DisputePolicySnapshot } from './dispute-summary';

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
  /**
   * The exact USD cost of this task's provider call(s), when the executor knows
   * it (i.e. when it routes through `runAIFeature`). Omitted by the deterministic
   * executors that make no provider call, in which case the cost is unknown and
   * must NOT be assumed to be zero (AI-INTEG-P3-T1.1 / F1).
   */
  cost?: string;
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

async function pickProduct(db: DB, productId?: unknown, scopeFilter?: SQL): Promise<ProductWithCategory | null> {
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
    .where(and(hasId ? eq(products.id, productId as string) : sql`true`, scopeFilter));
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

async function countOpenSupportMessages(db: DB, scope?: SQL): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.isDeleted, false), eq(messages.status, 'SENT'), sql`${messages.readAt} is null`, scope));
  return Number(rows[0]?.v ?? 0);
}

/**
 * The exact capability action each executor performs, keyed by the trusted agent
 * key (AI-INTEG-P3-T2). This is the executor's own declaration of the operation
 * it is about to run; it is a code literal and never taken from task `input`.
 *
 * The value must match the action declared in the agent's catalogue
 * `capabilities[].action`, which `buildRunContext` copies into the trusted run
 * context's `authorizedActions` grant list. `executeAgentTask` calls
 * `requireAction(EXECUTOR_ACTION[key])` at the execution boundary, so a run that
 * has no trusted context, no grant, or a grant for a different agent's action is
 * refused before the executor performs any read or provider call.
 */
/**
 * The action each executor performs, keyed by agent. Exported so the catalogue
 * contract can be asserted: an executor may only perform an action its agent
 * declares as a capability.
 */
export const EXECUTOR_ACTION: Record<string, string> = {
  'sales-agent': 'identify_leads',
  'marketing-agent': 'recommend_campaign',
  'marketing-video-agent': 'plan_video',
  'ads-agent': 'recommend_ads',
  'product-agent': 'analyze_product',
  'support-agent': 'draft_reply',
  'analytics-agent': 'generate_report',
  'market-research-agent': 'market_overview',
  'b2b-agent': 'match_b2b',
  'risk-agent': 'assess_risk',
  'dispute-assistant': 'summarize_dispute',
  'development-agent': 'diagnose_platform',
  'finance-agent': 'report_pnl',
  'outreach-acquisition-agent': 'discover_markets',
  'payment-settlement-agent': 'monitor_settlement',
  'compliance-agent': 'check',
  'supplier-agent': 'onboard',
  'merchant-agent': 'onboard',
  'customer-intelligence-agent': 'segment',
  'operations-agent': 'health_check',
};

/** The most useful message out of an unknown throw (ffmpeg puts its reason in stderr). */
function messageOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (stderr) return String(stderr);
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------- row-level data scope ----------

/**
 * Roles that may read across tenants. Everything else is confined to the rows
 * its own user owns: a seller entity (supplier/merchant/company) it owns, or the
 * orders it placed itself. This mirrors `PLATFORM_SCOPE_ROLES`; the catalogue
 * gates the agents whose data is platform-wide, this gates the *rows* of the
 * agents that stay available to everyone.
 */
const PLATFORM_VIEW_ROLES: readonly string[] = ['ADMIN', 'SUPER_ADMIN'];

export interface RequesterScope {
  requesterId: string | null;
  /** True for ADMIN/SUPER_ADMIN: the caller may read platform-wide rows. */
  isStaff: boolean;
  /** Supplier/merchant/company entity ids owned by the requester. */
  sellerIds: string[];
}

/**
 * Resolves who is asking and which seller entities they own. Reads only the
 * three ownership tables (never raw SQL — `db.execute` is refused inside an
 * agent run by A2), so it works on the scoped handle every executor receives.
 */
async function resolveRequesterScope(db: DB, input: Record<string, unknown>): Promise<RequesterScope> {
  const ctx = getAgentRunContext();
  const requesterId =
    ctx?.requestedBy ?? (typeof input.__userId === 'string' ? (input.__userId as string) : null);
  const roles = (ctx?.requesterRoles ?? []) as readonly string[];
  // The scheduler's system principal is not a tenant: it keeps the platform
  // view it had before row scoping existed.
  const isStaff = requesterId === SYSTEM_PRINCIPAL || roles.some((role) => PLATFORM_VIEW_ROLES.includes(role));
  if (isStaff || !requesterId) return { requesterId, isStaff, sellerIds: [] };

  const [ownedSuppliers, ownedMerchants, ownedCompanies] = await Promise.all([
    db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.userId, requesterId)),
    db.select({ id: merchants.id }).from(merchants).where(eq(merchants.userId, requesterId)),
    db.select({ id: companies.id }).from(companies).where(eq(companies.userId, requesterId)),
  ]);
  return {
    requesterId,
    isStaff,
    sellerIds: [...ownedSuppliers, ...ownedMerchants, ...ownedCompanies].map((row) => row.id),
  };
}

/** The product rows a requester may read: their own listings, or all for staff. */
function productScope(scope: RequesterScope): SQL | undefined {
  if (scope.isStaff) return undefined;
  if (scope.sellerIds.length === 0) return sql`false`;
  return inArray(products.sellerId, scope.sellerIds);
}

/** Orders the requester may read: placed by them, or sold by an entity they own. */
function orderScope(scope: RequesterScope): SQL | undefined {
  if (scope.isStaff) return undefined;
  if (!scope.requesterId) return sql`false`;
  const clauses: SQL[] = [sql`${orders.buyerId} = ${scope.requesterId}`];
  if (scope.sellerIds.length > 0) {
    clauses.push(sql`${orders.sellerId} in (${sql.join(scope.sellerIds.map((id) => sql`${id}`), sql`, `)})`);
    // A multi-seller parent order carries no single seller_id; its per-seller
    // identity lives on the order lines (seller_orders is a financial record and
    // is hard-denied to every agent).
    clauses.push(
      sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.seller_id in (${sql.join(
        scope.sellerIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`,
    );
  }
  return or(...clauses) as SQL;
}

// ---------- executors: one specialised query/output per agent ----------

async function execSalesAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const periodDays = Number(input.periodDays ?? 30);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const scope = await resolveRequesterScope(db, input);
  const ordersFilter = orderScope(scope);
  const productsFilter = productScope(scope);

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
      .where(and(gte(orders.createdAt, since), ordersFilter)),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, itemsTotal: orders.itemsTotal, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(ordersFilter)
      .orderBy(desc(orders.createdAt))
      .limit(Number(input.limit ?? 5)),
    db
      .select({ v: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.isPublished, true), productsFilter)),
    // Supplier/merchant/company counts and the platform trust average are
    // platform metrics: staff only. A tenant gets null rather than a number
    // about other tenants.
    scope.isStaff
      ? db.select({ v: sql<number>`count(*)::int` }).from(suppliers).where(eq(suppliers.isActive, true))
      : Promise.resolve([{ v: 0 }]),
    scope.isStaff
      ? db.select({ v: sql<number>`count(*)::int` }).from(merchants).where(eq(merchants.isActive, true))
      : Promise.resolve([{ v: 0 }]),
    scope.isStaff
      ? db.select({ v: sql<number>`count(*)::int` }).from(companies).where(eq(companies.isActive, true))
      : Promise.resolve([{ v: 0 }]),
    scope.isStaff
      ? db.select({ v: sql<number>`round(avg(score))::int` }).from(trustScores)
      : scope.requesterId
        ? db.select({ v: sql<number>`round(avg(score))::int` }).from(trustScores).where(eq(trustScores.userId, scope.requesterId))
        : Promise.resolve([{ v: 0 }]),
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
    suppliers: scope.isStaff ? toNum(suppliersCount[0]?.v) : null,
    merchants: scope.isStaff ? toNum(merchantsCount[0]?.v) : null,
    companies: scope.isStaff ? toNum(companiesCount[0]?.v) : null,
    avgTrust: toNum(avgTrust[0]?.v),
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'identify_leads',
    dataScope: scope.isStaff ? 'platform' : 'own',
    periodDays,
    kpi: facts,
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      itemsTotal: String(o.itemsTotal),
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    leadsPotential: scope.isStaff
      ? {
          merchants: facts.merchants,
          companies: facts.companies,
          activeProducts: facts.activeProducts,
          note:
            facts.orders > 0
              ? `Active order book (${facts.orders} orders). Focus on repeat buyers and upsell.`
              : 'No orders in period — prioritise outreach to merchants/companies with active listings.',
        }
      : null,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = scope.isStaff
    ? adviceText(
        'Sales analysis over last {{periodDays}}d: {{orders}} orders, GMV {{gmv}}, net {{net}}. Solicit {{merchants}} merchants and {{companies}} companies with {{activeProducts}} active products.',
        { periodDays: facts.periodDays, orders: facts.orders, gmv: facts.gmv, net: facts.net, merchants: facts.merchants, companies: facts.companies, activeProducts: facts.activeProducts },
      )
    : adviceText(
        'Sales analysis over last {{periodDays}}d (own scope): {{orders}} orders, GMV {{gmv}}, net {{net}} across {{activeProducts}} active listings.',
        { periodDays: facts.periodDays, orders: facts.orders, gmv: facts.gmv, net: facts.net, activeProducts: facts.activeProducts },
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

async function execMarketingAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const limit = Math.min(Number(input.limit ?? 5), 10);
  const scope = await resolveRequesterScope(db, input);
  const productsFilter = productScope(scope);
  const [published, topCategories, brands] = await Promise.all([
    db
      .select({ v: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.isPublished, true), productsFilter)),
    db
      .select({ category: categories.name, p: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(and(eq(products.isPublished, true), productsFilter))
      .groupBy(categories.name)
      .orderBy(sql`count(*) desc`)
      .limit(limit),
    db
      .select({ brand: products.brand, p: sql<number>`count(*)::int` })
      .from(products)
      .where(and(sql`${products.brand} is not null`, eq(products.isPublished, true), productsFilter))
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
    dataScope: scope.isStaff ? 'platform' : 'own',
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Marketing Video Agent — plans a video from live product data and hands the
 * owner an executable render request.
 *
 * Why it does not render here: a render must create a `media_assets` row and an
 * audit entry, and `audit_logs` is hard-denied to every agent run (A2). An
 * executor therefore cannot perform an audited business write, so the render is
 * executed by the media module — the same local ffmpeg/libass renderer, with
 * ownership, budget and duration checks. Planning, validation and readiness are
 * real work and run here.
 */
async function execMarketingVideoAgent(
  db: DB,
  agent: AgentDefinition,
  input: Record<string, unknown>,
): Promise<AgentExecutorResult> {
  const ctx = getAgentRunContext();
  const requesterId = ctx?.requestedBy ?? (typeof input.__userId === 'string' ? input.__userId : null);
  const roles = (ctx?.requesterRoles ?? []) as readonly string[];
  const isAdmin = roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
  const productId = typeof input.productId === 'string' && input.productId.length > 0 ? input.productId : null;

  const languages = VIDEO_LANGUAGES;
  const audiences = ['B2B', 'B2C'] as const;
  const styles = ['MODERN', 'MINIMAL', 'BOLD', 'ELEGANT'] as const;

  const language: VideoLanguage = isVideoLanguage(input.language) ? input.language : 'en';
  const audience: (typeof audiences)[number] = audiences.includes(input.audience as never)
    ? (input.audience as (typeof audiences)[number])
    : 'B2B';
  const style: (typeof styles)[number] = styles.includes(input.style as never)
    ? (input.style as (typeof styles)[number])
    : 'MODERN';
  const objective: MarketingObjective = isMarketingObjective(input.objective) ? input.objective : 'SALES';
  const requestedDuration = Number(input.durationSeconds ?? MARKETING_VIDEO_DURATION.default);
  const durationSeconds = Number.isFinite(requestedDuration)
    ? Math.min(Math.max(Math.round(requestedDuration), MARKETING_VIDEO_DURATION.min), MARKETING_VIDEO_DURATION.max)
    : MARKETING_VIDEO_DURATION.default;

  const base = {
    agentKey: agent.key,
    action: 'plan_video',
    readOnly: true,
    // A file on disk is produced (the render runs here); no business row is
    // written: media_assets and audit_logs stay out of reach for an agent.
    renders: false,
    writesPlatformRows: false,
    publishes: false,
    durationWindow: { min: MARKETING_VIDEO_DURATION.min, max: MARKETING_VIDEO_DURATION.max },
    supportedLanguages: VIDEO_LANGUAGES,
    objectives: MARKETING_OBJECTIVES,
    generatedAt: new Date().toISOString(),
  };

  const refuse = async (code: string, message: string, extra: Record<string, unknown> = {}) => {
    const content = JSON.stringify({ ...base, refused: true, error: { code, message }, ...extra });
    const out = await runAIFeature(db, {
      userId: requesterId ?? 'system',
      roles: ['SUPER_ADMIN'],
      requestType: `AGENT:${agent.key}`,
      system: 'You are the WASIT Marketing Video Agent.',
      user: `${code}: ${message}`,
      maxTokens: 32,
      metadata: { agentKey: agent.key, code },
    });
    return { content, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
  };

  if (!productId) return refuse('PRODUCT_REQUIRED', 'A productId is required to plan a marketing video.');

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      nameAr: products.nameAr,
      nameFr: products.nameFr,
      description: products.description,
      brand: products.brand,
      basePrice: products.basePrice,
      currencyCode: products.currencyCode,
      status: products.status,
      sellerId: products.sellerId,
      sellerType: products.sellerType,
      purchaseIntent: products.purchaseIntent,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  const product = rows[0];
  if (!product) return refuse('PRODUCT_NOT_FOUND', 'No product matches that productId.');

  let sellerName: string | null = null;
  if (!isAdmin) {
    if (!requesterId) return refuse('REQUESTER_REQUIRED', 'The run has no requester to check ownership against.');
    const [ownedSuppliers, ownedMerchants, ownedCompanies] = await Promise.all([
      db.select({ id: suppliers.id, name: suppliers.companyName }).from(suppliers).where(eq(suppliers.userId, requesterId)),
      db.select({ id: merchants.id, name: merchants.storeName }).from(merchants).where(eq(merchants.userId, requesterId)),
      db.select({ id: companies.id, name: companies.legalName }).from(companies).where(eq(companies.userId, requesterId)),
    ]);
    const owned = new Map<string, string>();
    for (const row of [...ownedSuppliers, ...ownedMerchants, ...ownedCompanies]) owned.set(row.id, row.name);
    if (!owned.has(product.sellerId)) {
      return refuse('PRODUCT_NOT_OWNED', 'This product belongs to another seller; a video may only be planned for your own catalogue.');
    }
    sellerName = owned.get(product.sellerId) ?? null;
  } else {
    const [s, m, c] = await Promise.all([
      db.select({ name: suppliers.companyName }).from(suppliers).where(eq(suppliers.id, product.sellerId)).limit(1),
      db.select({ name: merchants.storeName }).from(merchants).where(eq(merchants.id, product.sellerId)).limit(1),
      db.select({ name: companies.legalName }).from(companies).where(eq(companies.id, product.sellerId)).limit(1),
    ]);
    sellerName = s[0]?.name ?? m[0]?.name ?? c[0]?.name ?? null;
  }

  if (product.status !== 'ACTIVE') {
    return refuse('PRODUCT_NOT_ACTIVE', 'Only ACTIVE products can be turned into a marketing video.', {
      product: { id: product.id, status: product.status },
    });
  }

  const localizedName =
    language === 'ar' || language === 'ar-TN'
      ? product.nameAr ?? product.name
      : language === 'fr'
        ? product.nameFr ?? product.name
        : product.name;

  const facts = {
    name: localizedName,
    brand: product.brand,
    description: product.description,
    price: product.basePrice,
    currencyCode: product.currencyCode,
    sellerName,
  };

  // A plan-only request still answers with the real script and cut list; the
  // voice lengths are unknown until synthesis, so the timeline uses the floors.
  const plannedScript = buildVideoScript({ language, objective, audience, facts });
  const plannedTimeline = planTimeline(plannedScript, new Map(), durationSeconds);

  const steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }> = [];
  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await fn();
      steps.push({ step, ok: true, ms: Date.now() - started });
      return value;
    } catch (error) {
      steps.push({ step, ok: false, ms: Date.now() - started, detail: messageOf(error).slice(0, 300) });
      throw error;
    }
  };

  const wantsRender = input.render !== false;
  const voiceStatus = resolveVoice(language);
  let video: Record<string, unknown> | null = null;
  let quality: QualityReport | null = null;
  let produced: ProducedVideo | null = null;
  let render:
    | { status: 'READY' | 'FAILED' | 'SKIPPED'; error?: string; failedChecks?: string[]; provider: string }
    | { status: 'UNAVAILABLE'; error: string; provider: string };

  const provider = resolveVideoProvider();
  const providerAvailable = await provider.isAvailable();
  const providerReason = provider.unavailableReason();
  const rendererId = 'structural+voice';

  if (!wantsRender) {
    render = { status: 'SKIPPED', provider: rendererId, error: 'render=false: the plan was requested without a render.' };
  } else if (!providerAvailable) {
    // Preflight: never start a render whose toolchain is missing.
    render = { status: 'UNAVAILABLE', provider: rendererId, error: providerReason ?? 'renderer unavailable' };
    steps.push({ step: 'precheck_renderer', ok: false, ms: 0, detail: render.error });
  } else {
    steps.push({
      step: 'precheck_renderer',
      ok: true,
      ms: 0,
      detail: `ffmpeg present, fonts ${env.VIDEO_ARABIC_FONT}/${env.VIDEO_FONT}`,
    });
    steps.push({
      step: 'precheck_voice',
      ok: voiceStatus.voice !== null,
      ms: 0,
      detail: voiceStatus.voice ? `${voiceStatus.voice.id} (${voiceStatus.voice.locale})` : voiceStatus.reason ?? 'no voice',
    });

    const workDir = await mkdtemp(path.join(tmpdir(), 'wasit-mv-'));
    try {
      produced = await timed('produce', () =>
        produceMarketingVideo({
          facts,
          language,
          objective,
          audience,
          style,
          targetSeconds: durationSeconds,
          workDir,
          outFile: path.join(workDir, 'out.mp4'),
        }),
      );

      quality = await timed('quality_gate', () =>
        evaluateMarketingVideo({
          file: produced!.file,
          produced: produced!,
          expected: { language, width: env.VIDEO_WIDTH, height: env.VIDEO_HEIGHT, fps: env.VIDEO_FPS },
          productSource: [facts.name, facts.brand, facts.description, facts.price, facts.currencyCode, facts.sellerName]
            .filter(Boolean)
            .join(' '),
        }),
      );

      if (!quality.passed) {
        // A file that failed the gate is never stored: nothing to download, no
        // half-finished advert left where a buyer could mistake it for one.
        render = {
          status: 'FAILED',
          provider: rendererId,
          failedChecks: quality.checks.filter((c) => c.required && !c.passed).map((c) => `${c.id}: ${c.detail}`),
          error: quality.message ?? 'quality gate failed',
        };
      } else {
        const bytes = await timed('read', () => readFile(produced!.file));
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const stored = await timed('store', () =>
          resolveMediaStorage().put({
            key: `agent-videos/${requesterId ?? 'system'}/${ctx?.taskId ?? randomUUID()}-${sha256.slice(0, 12)}.mp4`,
            body: bytes,
            contentType: 'video/mp4',
          }),
        );
        const headerDuration = measureMp4DurationSeconds(bytes);
        video = {
          storageKey: stored.key,
          storage: resolveMediaStorage().id,
          contentType: stored.contentType,
          bytes: stored.size,
          sha256,
          durationSeconds: quality.metrics.durationSeconds,
          codec: quality.metrics.video.codec,
          width: quality.metrics.video.width,
          height: quality.metrics.video.height,
          frameRate: quality.metrics.video.frameRate,
          frames: quality.metrics.video.frames,
          containerDurationSeconds: headerDuration,
          decode: { ok: quality.metrics.decodedFully, detail: 'verified by the quality gate' },
          verified: true,
          language,
          voice: produced.voice?.id ?? null,
          audio: {
            codec: quality.metrics.audio.codec,
            sampleRate: quality.metrics.audio.sampleRate,
            channels: quality.metrics.audio.channels,
            loudnessLufs: quality.metrics.audio.loudnessLufs,
            truePeakDb: quality.metrics.audio.truePeakDb,
          },
        };
        render = { status: 'READY', provider: rendererId };
      }
    } catch (error) {
      video = null;
      render = { status: 'FAILED', provider: rendererId, error: messageOf(error).slice(0, 500) };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const scenes = produced?.timeline.scenes ?? plannedTimeline.scenes;
  const script = produced?.script ?? plannedScript;
  const content = JSON.stringify({
    ...base,
    renders: render.status === 'READY',
    product: {
      id: product.id,
      name: localizedName,
      status: product.status,
      sellerType: product.sellerType,
      price: product.basePrice,
      currencyCode: product.currencyCode,
    },
    plan: {
      language,
      dialect: script.dialect,
      objective,
      audience,
      style,
      durationSeconds,
      sceneCount: scenes.length,
      scenes: scenes.map((scene) => ({
        index: scene.index,
        kind: scene.kind,
        from: Number(scene.startSeconds.toFixed(2)),
        to: Number(scene.endSeconds.toFixed(2)),
        headline: scene.headline,
        bullets: scene.bullets,
        voiceover: scene.voiceover,
      })),
      script: script.scenes.map((s) => s.voiceover).join('\n'),
      cta: script.cta,
      facts: script.facts,
      voiceover: produced?.voice
        ? {
            voiceId: produced.voice.id,
            locale: produced.voice.locale,
            engine: produced.voice.engine,
            license: produced.voice.license,
            dialectNative: produced.voice.dialectNative,
          }
        : { voiceId: null, reason: produced?.voiceGap ?? voiceStatus.reason ?? null },
      music: produced?.music ?? null,
      delivery: {
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        width: env.VIDEO_WIDTH,
        height: env.VIDEO_HEIGHT,
        fps: env.VIDEO_FPS,
        maxBytes: env.MEDIA_MAX_VIDEO_BYTES,
      },
    },
    render,
    qualityGate: quality
      ? {
          passed: quality.passed,
          reason: quality.reason,
          message: quality.message,
          checks: quality.checks,
          metrics: quality.metrics,
        }
      : null,
    steps,
    video,
    readiness: {
      provider: rendererId,
      available: providerAvailable,
      reason: providerReason,
      renderer: 'local ffmpeg + libass + piper TTS',
      voice: {
        engine: env.TTS_ENGINE,
        available: voiceStatus.voice !== null,
        reason: voiceStatus.reason,
        supportedLanguages: VOICE_CATALOGUE.map((v) => ({ language: v.language, locale: v.locale, id: v.id })),
      },
      fonts: { latin: env.VIDEO_FONT, arabic: env.VIDEO_ARABIC_FONT, chinese: 'Noto Sans SC' },
      externalServices: false,
      paidServices: false,
    },
    // The same render through the media module, for callers who want a
    // downloadable media_assets row (owner or admin, audited). The agent itself
    // only writes the file and reports it.
    renderRequest: {
      method: 'POST',
      path: '/api/media/marketing-videos',
      body: { productId: product.id, language, audience, style, durationSeconds },
      performedBy: 'product owner or platform admin',
    },
    publish: {
      available: false,
      action: 'video.publish',
      reason: 'No publishing executor exists and video.publish is a sensitive action; nothing is published automatically.',
    },
  });

  const out = await runAIFeature(db, {
    userId: requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Marketing Video Agent.',
    user: `Produced a ${durationSeconds}s ${style} ${language.toUpperCase()} video for "${localizedName}": ${scenes.length} scenes, voice ${produced?.voice?.id ?? 'none'}, render ${render.status}${quality ? `, gate ${quality.passed ? 'passed' : `failed (${quality.reason})`}` : ''}.`,
    maxTokens: 96,
    metadata: {
      agentKey: agent.key,
      productId: product.id,
      renderStatus: render.status,
      qualityPassed: quality?.passed ?? null,
      qualityReason: quality?.reason ?? null,
      videoSha256: video?.sha256 ?? null,
    },
  });

  return { content, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

async function execProductAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  const p = await pickProduct(db, input.productId, productScope(scope));
  if (!p) {
    // One refusal for "not found" and "not yours": a distinct answer would tell
    // a tenant whether another tenant's product id exists.
    const content = JSON.stringify({
      agentKey: agent.key,
      action: input.action ?? 'analyze_product',
      dataScope: scope.isStaff ? 'platform' : 'own',
      error: scope.isStaff
        ? 'No product found. Provide a productId.'
        : 'No product available to you. Provide the id of one of your own products.',
      refused: !scope.isStaff,
      code: scope.isStaff ? 'PRODUCT_NOT_FOUND' : 'PRODUCT_NOT_AVAILABLE',
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
    return { content, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
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
    dataScope: scope.isStaff ? 'platform' : 'own',
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

async function execSupportAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const ctx = getAgentRunContext();
  const requesterId = ctx?.requestedBy ?? (typeof input.__userId === 'string' ? input.__userId : null);
  const roles = (ctx?.requesterRoles ?? []) as readonly string[];
  // Support desks answer every thread; everybody else sees only the threads they
  // take part in. Without this filter a customer could read other users' message
  // bodies through `recentUnread`.
  const isStaff = roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SUPPORT');
  const threadScope = isStaff
    ? undefined
    : sql`${threads.participantIds} @> ${JSON.stringify([requesterId])}::jsonb`;
  const messageScope = isStaff
    ? undefined
    : sql`${messages.threadId} in (select id from threads where participant_ids @> ${JSON.stringify([requesterId])}::jsonb)`;

  const [openThreads, unreadMessages, usersCount, recentUnread] = await Promise.all([
    db.select({ v: sql<number>`count(*)::int` }).from(threads).where(and(eq(threads.isBlocked, false), threadScope)),
    countOpenSupportMessages(db, messageScope),
    isStaff
      ? db.select({ v: sql<number>`count(*)::int` }).from(users).where(eq(users.isActive, true))
      : Promise.resolve([{ v: 0 }]),
    db
      .select({ id: messages.id, senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.isDeleted, false), sql`${messages.readAt} is null`, messageScope))
      .orderBy(desc(messages.createdAt))
      .limit(Number(input.limit ?? 5)),
  ]);

  const facts = {
    activeThreads: toNum(openThreads[0]?.v),
    unreadMessages,
    // Platform-wide user counts are staff information; a participant sees only
    // their own scope and gets null rather than a fabricated number.
    activeUsers: isStaff ? toNum(usersCount[0]?.v) : null,
    recentUnread: recentUnread.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body.slice(0, 120), createdAt: m.createdAt.toISOString() })),
  };

  const responseTimeSuggestion =
    facts.unreadMessages > 0
      ? `There are ${facts.unreadMessages} unread messages. Prioritise replies to keep response time under 24h.`
      : 'No unread messages — maintain the current response posture.';

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'draft_reply',
    dataScope: isStaff ? 'platform' : 'own',
    snapshot: facts,
    recommendation: responseTimeSuggestion,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Support snapshot: {{activeThreads}} threads, {{unreadMessages}} unread messages across {{activeUsers}} active users.',
    { activeThreads: facts.activeThreads, unreadMessages: facts.unreadMessages, activeUsers: facts.activeUsers ?? 'own scope' },
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * B2B Agent — scoped, reasoned partner suggestions.
 *
 * Partner matching names other tenants, so it runs only over tenants that hold
 * an active `B2B_PARTNER_DISCOVERY` consent (resolved by the service layer and
 * passed in as `__partnerConsent`). The requester needs the same consent, the
 * candidates are limited to complementary roles, every suggestion carries the
 * reasons it was made, and no contact detail is ever returned.
 */
async function execB2BAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  const consent = input.__partnerConsent as
    | { consentType?: string; requesterGranted?: boolean; discoverableSellerIds?: string[]; discoverableOwners?: number }
    | undefined;

  if (!consent || !Array.isArray(consent.discoverableSellerIds)) {
    return refuseWith(db, agent, scope.requesterId, 'CONSENT_UNAVAILABLE',
      'Partner discovery needs a consent snapshot, which only the service layer can supply.');
  }
  if (!scope.isStaff && consent.requesterGranted !== true) {
    return refuseWith(db, agent, scope.requesterId, 'CONSENT_REQUIRED',
      'You have not opted in to B2B partner discovery. Grant it first, then re-run.',
      {
        consent: { type: consent.consentType ?? 'B2B_PARTNER_DISCOVERY', granted: false },
        howToGrant: {
          method: 'PUT',
          path: '/api/privacy/consents',
          body: { consentType: 'B2B_PARTNER_DISCOVERY', granted: true },
        },
      });
  }

  const discoverable = new Set(consent.discoverableSellerIds);
  if (discoverable.size === 0) {
    const data = {
      agentKey: agent.key,
      action: EXECUTOR_ACTION[agent.key],
      suggestions: [],
      note: 'No tenant has opted in to partner discovery yet, so there is nothing to suggest.',
      consent: { type: consent.consentType ?? 'B2B_PARTNER_DISCOVERY', granted: consent.requesterGranted === true, optedInTenants: 0 },
      contactPolicy: 'No contact details are returned; both sides opt in before any introduction.',
      readOnly: true,
      generatedAt: new Date().toISOString(),
    };
    const out = await runAIFeature(db, {
      userId: scope.requesterId ?? 'system', roles: ['SUPER_ADMIN'], requestType: `AGENT:${agent.key}`,
      system: 'You are the WASIT B2B Agent.', user: 'No opted-in partners.', maxTokens: 32,
      metadata: { agentKey: agent.key, suggestions: 0 },
    });
    return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
  }

  const ids = [...discoverable];
  const [supplierRows, merchantRows, companyRows] = await Promise.all([
    db.select({ id: suppliers.id, name: suppliers.companyName, countryId: suppliers.countryId, verified: suppliers.verified, active: suppliers.isActive })
      .from(suppliers).where(inArray(suppliers.id, ids)),
    db.select({ id: merchants.id, name: merchants.storeName, countryId: merchants.countryId, verified: merchants.verified, active: merchants.isActive })
      .from(merchants).where(inArray(merchants.id, ids)),
    db.select({ id: companies.id, name: companies.legalName, countryId: companies.countryId, verified: companies.verified, active: companies.isActive })
      .from(companies).where(inArray(companies.id, ids)),
  ]);

  const candidates = [
    ...supplierRows.map((r) => ({ ...r, type: 'SUPPLIER' as const })),
    ...merchantRows.map((r) => ({ ...r, type: 'MERCHANT' as const })),
    ...companyRows.map((r) => ({ ...r, type: 'COMPANY' as const })),
  ];

  // The requester's own entities decide the complementary role and are excluded
  // from their own suggestions.
  const ownRows = scope.requesterId
    ? await Promise.all([
        db.select({ id: suppliers.id, countryId: suppliers.countryId }).from(suppliers).where(eq(suppliers.userId, scope.requesterId)),
        db.select({ id: merchants.id, countryId: merchants.countryId }).from(merchants).where(eq(merchants.userId, scope.requesterId)),
        db.select({ id: companies.id, countryId: companies.countryId }).from(companies).where(eq(companies.userId, scope.requesterId)),
      ])
    : [[], [], []];
  const ownIds = new Set([...ownRows[0], ...ownRows[1], ...ownRows[2]].map((r) => r.id));
  const ownTypes = new Set([
    ...(ownRows[0].length > 0 ? ['SUPPLIER'] : []),
    ...(ownRows[1].length > 0 ? ['MERCHANT'] : []),
    ...(ownRows[2].length > 0 ? ['COMPANY'] : []),
  ]);
  const ownCountries = new Set([...ownRows[0], ...ownRows[1], ...ownRows[2]].map((r) => r.countryId).filter(Boolean) as string[]);
  const complementary = (type: string): boolean => ownTypes.size === 0 || !ownTypes.has(type);

  const published = await db
    .select({ sellerId: products.sellerId, n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.isPublished, true), inArray(products.sellerId, candidates.map((c) => c.id))))
    .groupBy(products.sellerId);

  const limit = clampInt(Number(input.limit ?? 10), 1, 25);
  const suggestions = candidates
    .filter((c) => c.active && !ownIds.has(c.id) && complementary(c.type))
    .map((c) => {
      const publishedCount = toNum(published.find((p) => p.sellerId === c.id)?.n);
      const sameCountry = c.countryId !== null && ownCountries.has(c.countryId);
      const reasons: string[] = [`Complementary role: ${c.type.toLowerCase()} for your ${[...ownTypes].join('/').toLowerCase() || 'buying'} side.`];
      let score = 40;
      if (sameCountry) {
        score += 20;
        reasons.push('Same country as your entity — shorter logistics and simpler compliance.');
      }
      if (c.verified) {
        score += 20;
        reasons.push('Verified on WASIT (verification engine, not self-declared).');
      }
      if (publishedCount > 0) {
        score += 15;
        reasons.push(`${publishedCount} published listing(s) — an active catalogue to trade against.`);
      }
      if (!sameCountry) reasons.push('Different country: check import/tax requirements before closing.');
      return {
        partnerType: c.type,
        partnerRef: createHash('sha256').update(c.id).digest('hex').slice(0, 10),
        displayName: c.name,
        countryId: c.countryId,
        verified: c.verified,
        publishedProducts: publishedCount,
        score: Math.min(100, score),
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    suggestions,
    consent: {
      type: consent.consentType ?? 'B2B_PARTNER_DISCOVERY',
      granted: consent.requesterGranted === true,
      optedInTenants: toNum(consent.discoverableOwners),
      basis: 'Only tenants holding an active B2B_PARTNER_DISCOVERY consent are visible.',
    },
    contactPolicy: 'No contact details are returned; both sides opt in before any introduction.',
    scope: scope.isStaff ? 'platform' : 'own',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT B2B Agent.',
    user: adviceText('{{n}} consented partner suggestion(s) from {{opted}} opted-in tenant(s).',
      { n: suggestions.length, opted: toNum(consent.discoverableOwners) }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, suggestions: suggestions.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
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

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Dispute Assistant.
 *
 * Two modes, both read-only and both advisory:
 * - `disputeId` given: a summary of THAT dispute (facts, evidence, timeline,
 *   policy-derived deadlines, gaps, resolution paths, recommendation).
 * - no `disputeId`: a triage snapshot of the open queue. It carries no message
 *   bodies at all, so a platform operator cannot accidentally read one dispute's
 *   conversation through a request about the queue.
 *
 * The agent never decides: `decisionAuthority` is always HUMAN and every money
 * effect comes from the policy snapshot frozen into the task.
 */
async function execDisputeAssistant(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const now = new Date();
  const disputeId = typeof input.disputeId === 'string' && input.disputeId.trim().length > 0 ? input.disputeId.trim() : null;
  const policy = readPolicySnapshot(input.__disputePolicy);

  if (!disputeId) {
    const [countRows, openRows] = await Promise.all([
      db
        .select({ status: disputes.status, v: sql<number>`count(*)::int` })
        .from(disputes)
        .groupBy(disputes.status),
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
        .where(sql`${disputes.status} not in ('DECIDED', 'CLOSED', 'ARCHIVED')`)
        .orderBy(asc(disputes.createdAt))
        .limit(20),
    ]);

    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.status] = toNum(row.v);

    const decisionDays = policyNumber(policy, 'decisionDeadlineDays');
    const triage = buildDisputeTriage(
      openRows.map((r) => ({
        ...r,
        decisionDueAt: decisionDays === null ? null : new Date(r.createdAt.getTime() + decisionDays * 86_400_000),
      })),
      counts,
      now,
    );
    const data: Record<string, unknown> = {
      agentKey: agent.key,
      action: input.action ?? 'summarize_dispute',
      ...triage,
    };

    const text = adviceText(
      'Dispute queue: {{open}} open of {{total}} total, {{unassigned}} unassigned, {{overdue}} past the decision deadline. No conversation content is included in triage.',
      {
        open: triage.counts.open,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        unassigned: triage.counts.unassigned,
        overdue: triage.counts.decisionOverdue,
      },
    );
    const out = await runAIFeature(db, {
      userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
      roles: ['SUPER_ADMIN'],
      requestType: `AGENT:${agent.key}`,
      system: 'You are the WASIT Dispute Assistant. Summarise the queue for a human reviewer. Never decide a dispute.',
      user: text,
      maxTokens: 96,
      metadata: { agentKey: agent.key, action: input.action, mode: 'triage' },
    });
    return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
  }

  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!dispute) throw ApiError.notFound('Dispute not found');

  // AI-03: a task created by an assignment belongs to the reviewer who held the
  // assignment. If the dispute was reassigned in the meantime, the old owner's
  // task must not run — it would analyse the case under an authority that no
  // longer applies (and could surface a case they no longer review). The owner
  // is read from the stored task row, never from `input`.
  if (input.__disputeSource === 'ASSIGNMENT') {
    // The owner comes from the trusted run context (the stored task row), not
    // from `input` and not from a query — `agent_tasks` is outside this agent's
    // A2 data scope, and reading it here would be refused by the scope gate.
    const ownerId = getAgentRunContext()?.requestedBy ?? null;
    if (!ownerId || dispute.assignedToId !== ownerId) {
      throw ApiError.conflict('This dispute is no longer assigned to the task owner; request a fresh assistant task');
    }
  }

  const [orderRow] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      buyerId: orders.buyerId,
      sellerId: orders.sellerId,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      refundStatus: orders.refundStatus,
      grandTotal: orders.grandTotal,
      currencyCode: orders.currencyCode,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.id, dispute.orderId))
    .limit(1);

  const [messageRows, evidenceRows, eventRows, appealRows] = await Promise.all([
    db
      .select({
        senderId: disputeMessages.senderId,
        body: disputeMessages.body,
        isEvidence: disputeMessages.isEvidence,
        createdAt: disputeMessages.createdAt,
      })
      .from(disputeMessages)
      .where(eq(disputeMessages.disputeId, dispute.id))
      .orderBy(asc(disputeMessages.createdAt))
      .limit(200),
    db
      .select({
        uploadedById: disputeEvidence.uploadedById,
        description: disputeEvidence.description,
        contentType: disputeEvidence.contentType,
        createdAt: disputeEvidence.createdAt,
      })
      .from(disputeEvidence)
      .where(eq(disputeEvidence.disputeId, dispute.id))
      .orderBy(asc(disputeEvidence.createdAt))
      .limit(50),
    db
      .select({
        eventType: disputeEvents.eventType,
        actorId: disputeEvents.actorId,
        createdAt: disputeEvents.createdAt,
      })
      .from(disputeEvents)
      .where(eq(disputeEvents.disputeId, dispute.id))
      .orderBy(asc(disputeEvents.createdAt))
      .limit(50),
    db
      .select({
        status: disputeAppeals.status,
        appealedById: disputeAppeals.appealedById,
        createdAt: disputeAppeals.createdAt,
      })
      .from(disputeAppeals)
      .where(eq(disputeAppeals.disputeId, dispute.id))
      .orderBy(asc(disputeAppeals.createdAt))
      .limit(20),
  ]);

  const summary = buildDisputeSummary({
    dispute: {
      id: dispute.id,
      disputeNumber: dispute.disputeNumber,
      status: dispute.status,
      reasonCode: dispute.reasonCode,
      description: dispute.description,
      decision: dispute.decision,
      assignedToId: dispute.assignedToId,
      appealAllowed: dispute.appealAllowed,
      openedById: dispute.openedById,
      createdAt: dispute.createdAt,
      decidedAt: dispute.decidedAt,
    },
    order: orderRow
      ? {
          id: orderRow.id,
          orderNumber: orderRow.orderNumber,
          status: orderRow.status,
          paymentStatus: orderRow.paymentStatus,
          refundStatus: orderRow.refundStatus,
          grandTotal: toNum(orderRow.grandTotal),
          currencyCode: orderRow.currencyCode,
          createdAt: orderRow.createdAt,
        }
      : null,
    messages: messageRows,
    evidence: evidenceRows,
    events: eventRows,
    appeals: appealRows,
    policy,
    parties: { buyerId: orderRow?.buyerId ?? null, sellerId: orderRow?.sellerId ?? null },
    now,
  });

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'summarize_dispute',
    ...summary,
  };

  // The provider prompt carries counts and the recommendation only — message
  // bodies stay in the stored result and are never sent to a model provider.
  const text = adviceText(
    'Dispute {{number}} ({{status}}, reason {{reason}}) on order {{order}}: {{messages}} messages, {{evidence}} evidence files, {{gaps}} gaps. Recommendation: {{action}} with confidence {{confidence}}. A human decides.',
    {
      number: summary.dispute.disputeNumber,
      status: summary.dispute.status,
      reason: summary.dispute.reasonCode,
      order: summary.order?.orderNumber ?? 'unknown',
      messages: summary.conversation.messages,
      evidence: summary.evidence.count,
      gaps: summary.gaps.length,
      action: summary.recommendation.action,
      confidence: summary.recommendation.confidence,
    },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Dispute Assistant. Summarise the dispute and its options for a human reviewer. Never decide a dispute.',
    user: text,
    maxTokens: 128,
    metadata: { agentKey: agent.key, action: input.action, disputeId: dispute.id },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/** Accepts only a server-injected policy snapshot; a caller-shaped value is ignored. */
function readPolicySnapshot(value: unknown): DisputePolicySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const rules = v.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const source = v.source === 'COUNTRY' || v.source === 'GLOBAL' ? v.source : 'GLOBAL';
  return {
    rules: rules as Record<string, unknown>,
    source,
    countryCode: typeof v.countryCode === 'string' ? v.countryCode : null,
    policyId: typeof v.policyId === 'string' ? v.policyId : null,
    version: typeof v.version === 'number' ? v.version : null,
    capturedAt: typeof v.capturedAt === 'string' ? v.capturedAt : new Date().toISOString(),
  };
}

/** Clamps an integer input to a safe range (window sizes, limits). */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Platform Maintenance & Repair Agent.
 *
 * Diagnosis is deterministic and read-only: it reads the agent layer's own state
 * (`agent_tasks`, `agent_runs`, `agent_run_steps`) plus platform counters, and
 * turns it into findings with evidence and a proposed repair. It cannot apply a
 * repair: there is no executor for `apply_patch` / `merge_change`, and both stay
 * in the agent's `approvalActions` for the General Manager to authorise.
 */
async function execDevelopmentAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const windowDays = clampInt(Number(input.windowDays ?? 7), 1, 90);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const stuckBefore = new Date(Date.now() - 30 * 60_000);

  const [usersCount, productsCount, ordersCount, campaignsCount, kpiCount, lastDailyKpi] = await Promise.all([
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

  const [taskRows, failedTaskRows, stuckTaskRows, runRows, stepRows] = await Promise.all([
    db
      .select({ status: agentTasks.status, n: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(gte(agentTasks.createdAt, since))
      .groupBy(agentTasks.status),
    db
      .select({
        id: agentTasks.id,
        agentKey: agentTasks.agentKey,
        taskType: agentTasks.taskType,
        error: agentTasks.error,
        createdAt: agentTasks.createdAt,
      })
      .from(agentTasks)
      .where(and(eq(agentTasks.status, 'failed'), gte(agentTasks.createdAt, since)))
      .orderBy(desc(agentTasks.createdAt))
      .limit(200),
    db
      .select({ id: agentTasks.id, agentKey: agentTasks.agentKey, startedAt: agentTasks.startedAt })
      .from(agentTasks)
      .where(and(eq(agentTasks.status, 'running'), lt(agentTasks.startedAt, stuckBefore)))
      .limit(5),
    db
      .select({ status: agentRuns.status, n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, since))
      .groupBy(agentRuns.status),
    db
      .select({ status: agentRunSteps.status, n: sql<number>`count(*)::int` })
      .from(agentRunSteps)
      .where(gte(agentRunSteps.createdAt, since))
      .groupBy(agentRunSteps.status),
  ]);

  const byStatus = (rows: { status: string; n: number }[], status: string): number =>
    toNum(rows.find((r) => r.status === status)?.n);
  const taskTotal = taskRows.reduce((acc, r) => acc + toNum(r.n), 0);
  const failedTasks = byStatus(taskRows, 'failed');
  const awaitingApproval = byStatus(taskRows, 'awaiting_approval');
  const failureRate = taskTotal === 0 ? 0 : failedTasks / taskTotal;
  const failedRuns = byStatus(runRows, 'FAILED');
  const failedSteps = byStatus(stepRows, 'FAILED');
  const retryingSteps = byStatus(stepRows, 'RETRYING');

  // Root-cause grouping over the failures already fetched. Deterministic and
  // read-only: same rows in, same clusters out.
  const analysis = analyseFailures(
    failedTaskRows.map((t) => ({
      taskId: t.id,
      agentKey: t.agentKey,
      taskType: t.taskType ?? null,
      error: t.error,
      createdAt: t.createdAt,
    })),
    { days: windowDays, from: since.toISOString(), to: new Date().toISOString() },
  );
  const patchProposals = analysis.clusters.slice(0, 3).map(proposePatch);
  const reviewReport = buildReviewReport(analysis, patchProposals);
  // The GM asked for repairs to be delivered as an independent branch + PR, not
  // applied here. The package carries everything to review one; it carries no
  // diff, because inventing one would be a guess dressed as a fix.
  const repairPackage =
    analysis.dominant && patchProposals[0]
      ? buildRepairPackage(analysis.dominant, patchProposals[0])
      : null;

  const findings: Array<Record<string, unknown>> = [];
  if (stuckTaskRows.length > 0) {
    findings.push({
      code: 'stuck_tasks',
      severity: 'HIGH',
      statement: `${stuckTaskRows.length} task(s) have been RUNNING for more than 30 minutes.`,
      evidence: stuckTaskRows.map((t) => ({ taskId: t.id, agentKey: t.agentKey, startedAt: t.startedAt?.toISOString() ?? null })),
      suggestedRepair: {
        summary: 'Recover or contain the stuck tasks, then confirm the recovery path closes them.',
        steps: [
          'Inspect the task result/error and the provider latency for the affected agent.',
          'Run the recovery cycle (AI-02.3.1) rather than creating a replacement task.',
          'Add a regression test if the stuck state was reachable from a normal request.',
        ],
      },
    });
  }
  if (failedTasks > 0) {
    findings.push({
      code: 'agent_task_failures',
      severity: failureRate >= 0.25 && taskTotal >= 4 ? 'HIGH' : 'MEDIUM',
      statement: `${failedTasks} of ${taskTotal} task(s) failed in the last ${windowDays} day(s) (${(failureRate * 100).toFixed(1)}%).`,
      evidence: failedTaskRows.slice(0, 5).map((t) => ({
        taskId: t.id,
        agentKey: t.agentKey,
        taskType: t.taskType,
        error: t.error,
        createdAt: t.createdAt.toISOString(),
      })),
      // Computed, not narrated: the grouping the old advice asked a human to do.
      rootCause: {
        sampleSize: analysis.sampleSize,
        dominant: analysis.dominant,
        clusters: analysis.clusters.slice(0, 5),
      },
      suggestedRepair: {
        summary: analysis.dominant
          ? `${analysis.dominant.family}: ${analysis.dominant.hypothesis}`
          : 'Group the failures by agent and error code, then fix the dominant cause.',
        steps:
          analysis.dominant
            ? analysis.dominant.nextDiagnostics
            : [
                'Read the stored error for each failing task (no log scraping needed).',
                'Reproduce the dominant failure in an isolated test.',
                'Ship the fix as a patch with the test that fails before it and passes after.',
              ],
      },
    });
  }
  if (failedRuns > 0 || failedSteps > 0) {
    findings.push({
      code: 'run_failures',
      severity: failedRuns > 0 ? 'MEDIUM' : 'LOW',
      statement: `${failedRuns} run(s) and ${failedSteps} step(s) failed in the last ${windowDays} day(s).`,
      evidence: { failedRuns, failedSteps, retryingSteps },
      suggestedRepair: {
        summary: 'Check whether the failing steps share a dependency or an agent.',
        steps: [
          'Inspect the failed steps for the run and their dependency graph.',
          'Verify the retry policy covered them; extend the tests if it did not.',
        ],
      },
    });
  }
  if (awaitingApproval > 0) {
    findings.push({
      code: 'approvals_waiting',
      severity: 'INFO',
      statement: `${awaitingApproval} task(s) are waiting for a human approval.`,
      evidence: { awaitingApproval },
      suggestedRepair: {
        summary: 'Notify the approver; no code change is required.',
        steps: ['Open the approvals list and decide, or reject with a reason.'],
      },
    });
  }
  if (taskTotal === 0) {
    findings.push({
      code: 'no_agent_telemetry',
      severity: 'INFO',
      statement: `No agent tasks were created in the last ${windowDays} day(s); there is nothing to diagnose.`,
      evidence: { taskTotal: 0 },
      suggestedRepair: {
        summary: 'Nothing to repair from telemetry. Re-run with a wider window if work is expected.',
        steps: ['Re-run the diagnosis with a larger windowDays.'],
      },
    });
  }

  const snapshot = {
    users: toNum(usersCount[0]?.v),
    products: toNum(productsCount[0]?.v),
    orders: toNum(ordersCount[0]?.v),
    campaigns: toNum(campaignsCount[0]?.v),
    kpiDays: toNum(kpiCount[0]?.v),
    lastDaily: lastDailyKpi[0]
      ? { date: lastDailyKpi[0].date.toISOString(), metric: lastDailyKpi[0].metricName, value: String(lastDailyKpi[0].metricValue) }
      : null,
  };

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: 'diagnose_platform',
    window: { days: windowDays, from: since.toISOString(), to: new Date().toISOString() },
    snapshot,
    health: {
      taskTotal,
      failedTasks,
      awaitingApproval,
      failureRate: Number(failureRate.toFixed(4)),
      failedRuns,
      failedSteps,
      retryingSteps,
      stuckTasks: stuckTaskRows.length,
    },
    findings,
    rootCauseAnalysis: analysis,
    patchProposals,
    repairPackage,
    reviewReport,
    // The repair protocol is a contract, not a suggestion: every item below is
    // enforced outside the model (approval actions + the absence of an executor).
    repairProtocol: {
      requiresGmApproval: true,
      selfApprovalForbidden: true,
      deliverable: ['diff', 'tests', 'report'],
      forbidden: [
        'rbac_or_business_policy_change',
        'migrations_or_seeds',
        'database_change',
        'financial_change',
        'prod_deploy',
        'merge_without_approval',
      ],
      appliesChanges: false,
      note: 'apply_patch and merge_change are approval actions with no executor; the repair is delivered as a proposal.',
      // Steps this runtime cannot perform, named rather than skipped silently.
      blocked: reviewReport.checklist.filter((step) => step.state !== 'done'),
    },
    recommendation:
      findings.length === 0
        ? 'No failure signal in the window; keep the current instrumentation and re-run periodically.'
        : 'Address the highest-severity finding first, with a test that reproduces it before the fix.',
    nextSteps: findings
      .slice(0, 3)
      .map((f) => String((f.suggestedRepair as { summary?: string } | undefined)?.summary ?? '')),
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Platform diagnosis for {{days}} day(s): {{tasks}} tasks, {{failed}} failed, {{runs}} failed runs, {{stuck}} stuck. Findings: {{findings}}.',
    {
      days: windowDays,
      tasks: taskTotal,
      failed: failedTasks,
      runs: failedRuns,
      stuck: stuckTaskRows.length,
      findings: findings.length,
    },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Platform Maintenance & Repair Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: 'diagnose_platform' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Finance & Cost Accounting Agent.
 *
 * Read-only accounting from order-level aggregates (which already carry the
 * recorded commission and payment fee), campaign spend and AI usage. It never
 * reads the ledger or the commission policy table (hard-denied to every agent)
 * and never writes: the scoped `db` handle refuses anything but reads.
 *
 * Currencies are never mixed. A contribution figure is produced only when the
 * revenue and the costs share a currency; otherwise it is reported as `null`
 * with a reason instead of a fabricated total.
 */
async function execFinanceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const windowDays = clampInt(Number(input.windowDays ?? 30), 1, 365);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [revenueRows, aiRows, adRows] = await Promise.all([
    db
      .select({
        currencyCode: orders.currencyCode,
        orders: sql<number>`count(*) filter (where ${orders.status}::text <> 'CANCELLED')::int`,
        cancelled: sql<number>`count(*) filter (where ${orders.status}::text = 'CANCELLED')::int`,
        gmv: sql<string>`coalesce(sum(${orders.itemsTotal}) filter (where ${orders.status}::text <> 'CANCELLED'), 0)::text`,
        commission: sql<string>`coalesce(sum(${orders.commission}) filter (where ${orders.status}::text <> 'CANCELLED'), 0)::text`,
        paymentFees: sql<string>`coalesce(sum(${orders.paymentFee}) filter (where ${orders.status}::text <> 'CANCELLED'), 0)::text`,
        paidCommission: sql<string>`coalesce(sum(${orders.commission}) filter (where ${orders.status}::text <> 'CANCELLED' and ${orders.paymentStatus}::text = 'PAID'), 0)::text`,
        settledCommission: sql<string>`coalesce(sum(${orders.commission}) filter (where ${orders.status}::text <> 'CANCELLED' and ${orders.settlementStatus}::text = 'SETTLED'), 0)::text`,
      })
      .from(orders)
      .where(gte(orders.createdAt, since))
      .groupBy(orders.currencyCode),
    db
      .select({
        requestType: aiRequests.requestType,
        currencyCode: aiRequests.currencyCode,
        calls: sql<number>`count(*)::int`,
        cost: sql<string>`coalesce(sum(${aiRequests.cost}), 0)::text`,
      })
      .from(aiRequests)
      .where(gte(aiRequests.createdAt, since))
      .groupBy(aiRequests.requestType, aiRequests.currencyCode),
    db
      .select({
        currencyCode: campaigns.currencyCode,
        campaigns: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${campaigns.isActive})::int`,
        spent: sql<string>`coalesce(sum(${campaigns.spent}), 0)::text`,
      })
      .from(campaigns)
      .where(gte(campaigns.createdAt, since))
      .groupBy(campaigns.currencyCode),
  ]);

  const revenue = revenueRows.map((r) => ({
    currencyCode: r.currencyCode,
    orders: toNum(r.orders),
    cancelledOrders: toNum(r.cancelled),
    gmv: String(r.gmv),
    commission: String(r.commission),
    paymentFees: String(r.paymentFees),
    realisedCommission: String(r.paidCommission),
    settledCommission: String(r.settledCommission),
    accruedCommission: (Number(r.commission) - Number(r.paidCommission)).toFixed(4),
    estimated: false,
    source: 'orders (sum of the commission and payment fee recorded on each order)',
  }));

  const aiByCurrency = new Map<
    string,
    { total: number; calls: number; byType: Array<{ requestType: string; agentKey: string | null; cost: string; calls: number }> }
  >();
  for (const row of aiRows) {
    const bucket = aiByCurrency.get(row.currencyCode) ?? { total: 0, calls: 0, byType: [] };
    bucket.total += toNum(row.cost);
    bucket.calls += toNum(row.calls);
    bucket.byType.push({
      requestType: row.requestType,
      agentKey: row.requestType.startsWith('AGENT:') ? row.requestType.slice('AGENT:'.length) : null,
      cost: String(row.cost),
      calls: toNum(row.calls),
    });
    aiByCurrency.set(row.currencyCode, bucket);
  }
  const aiCost = [...aiByCurrency.entries()].map(([currencyCode, b]) => ({
    currencyCode,
    total: b.total.toFixed(10),
    calls: b.calls,
    byType: b.byType.sort((a, z) => Number(z.cost) - Number(a.cost)),
    estimated: false,
    source: 'ai_requests (sum of the exact recorded cost)',
  }));

  const advertising = adRows.map((r) => ({
    currencyCode: r.currencyCode,
    campaigns: toNum(r.campaigns),
    activeCampaigns: toNum(r.active),
    spent: String(r.spent),
    // `campaigns.spent` is cumulative per campaign, so a window filter on
    // `created_at` gives the spend of campaigns opened in the window, not the
    // spend inside it. Reported as estimated rather than silently presented as
    // a period figure.
    estimated: true,
    source: 'campaigns (cumulative spent for campaigns created in the window)',
  }));

  const contribution = revenue.map((r) => {
    const ai = aiCost.find((c) => c.currencyCode === r.currencyCode);
    const ads = advertising.find((c) => c.currencyCode === r.currencyCode);
    const costsInCurrency = (ai ? Number(ai.total) : 0) + (ads ? Number(ads.spent) : 0);
    const missing = [!ai ? 'ai_cost' : null, !ads ? 'advertising_cost' : null].filter(Boolean);
    if (missing.length > 0) {
      return {
        currencyCode: r.currencyCode,
        value: null,
        reason: 'COST_DATA_MISSING',
        missing,
        note: 'Costs exist in another currency or were not recorded in the window; no total is invented.',
      };
    }
    const net = Number(r.commission) + Number(r.paymentFees) - costsInCurrency;
    return {
      currencyCode: r.currencyCode,
      value: net.toFixed(4),
      estimated: ads?.estimated === true,
      formula: 'commission + paymentFees - aiCost - advertisingSpend',
    };
  });

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: 'report_pnl',
    window: { days: windowDays, from: since.toISOString(), to: new Date().toISOString() },
    revenue,
    costs: { ai: aiCost, advertising },
    contribution,
    dataQuality: {
      crossCurrencyTotals: false,
      ledgerAccess: 'denied-to-agents-by-design',
      adsSpendBasis: 'cumulative campaign spend for campaigns created in the window',
      aiCostBasis: 'exact recorded cost per AI request',
      note: 'Every figure carries its source and period; missing data yields null, never a guessed number.',
    },
    sources: [
      { metric: 'orders, gmv, commission, paymentFees', table: 'orders', aggregation: 'sum excluding CANCELLED orders' },
      { metric: 'aiCost', table: 'ai_requests', aggregation: 'sum(cost) grouped by request type' },
      { metric: 'advertisingSpend', table: 'campaigns', aggregation: 'sum(spent) for campaigns created in the window' },
    ],
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Finance window {{days}} day(s): {{currencies}} currency bucket(s), {{orders}} orders, commission {{commission}}.',
    {
      days: windowDays,
      currencies: revenue.length,
      orders: revenue.reduce((acc, r) => acc + r.orders, 0),
      commission: revenue.map((r) => `${r.commission} ${r.currencyCode}`).join(', ') || '0',
    },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Finance & Cost Accounting Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: 'report_pnl' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Global Growth & Acquisition Agent.
 *
 * Market discovery over platform data only: countries with their supply
 * (suppliers/merchants/companies), catalogue depth (published products) and
 * segment distribution. Outputs a ranked market list, qualified opportunities,
 * market-specific outreach drafts and acquisition indicators — and nothing else.
 * No external call, no send, no spend: those are approval actions with no
 * executor.
 */
async function execGrowthAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const maxMarkets = clampInt(Number(input.maxMarkets ?? 12), 1, 12);
  const segmentLimit = clampInt(Number(input.segmentLimit ?? 8), 1, 25);
  const requestedLanguages = Array.isArray(input.languages)
    ? (input.languages as unknown[]).filter((l): l is string => typeof l === 'string').slice(0, 8)
    : null;

  const [marketRows, segmentRows] = await Promise.all([
    db
      .select({
        id: countries.id,
        code: countries.code,
        name: countries.name,
        currencyCode: countries.currencyCode,
        defaultLanguage: countries.defaultLanguage,
        isActive: countries.isActive,
        suppliers: sql<number>`count(distinct ${suppliers.id})::int`,
        merchants: sql<number>`count(distinct ${merchants.id})::int`,
        companies: sql<number>`count(distinct ${companies.id})::int`,
        publishedProducts: sql<number>`count(distinct ${products.id}) filter (where ${products.isPublished})::int`,
      })
      .from(countries)
      .leftJoin(suppliers, eq(suppliers.countryId, countries.id))
      .leftJoin(merchants, eq(merchants.countryId, countries.id))
      .leftJoin(companies, eq(companies.countryId, countries.id))
      .leftJoin(products, eq(products.countryId, countries.id))
      .groupBy(countries.id, countries.code, countries.name, countries.currencyCode, countries.defaultLanguage, countries.isActive)
      .orderBy(desc(sql`count(distinct ${products.id}) filter (where ${products.isPublished})`))
      .limit(60),
    db
      .select({
        id: categories.id,
        name: categories.name,
        products: sql<number>`count(${products.id}) filter (where ${products.isPublished})::int`,
      })
      .from(categories)
      .leftJoin(products, eq(products.categoryId, categories.id))
      .where(eq(categories.isActive, true))
      .groupBy(categories.id, categories.name)
      .orderBy(desc(sql`count(${products.id}) filter (where ${products.isPublished})`))
      .limit(segmentLimit),
  ]);

  const markets = marketRows
    .map((m) => {
      const sellers = toNum(m.suppliers) + toNum(m.merchants) + toNum(m.companies);
      const published = toNum(m.publishedProducts);
      const score = published * 2 + sellers * 3;
      const priority = sellers >= 3 && published >= 5 ? 'EXPAND' : published > 0 ? 'SEED' : 'MONITOR';
      return {
        code: m.code,
        name: m.name,
        currencyCode: m.currencyCode,
        language: m.defaultLanguage,
        platformActive: m.isActive,
        supply: { suppliers: toNum(m.suppliers), merchants: toNum(m.merchants), companies: toNum(m.companies), sellers },
        catalogue: { publishedProducts: published },
        score,
        priority,
        rationale:
          priority === 'EXPAND'
            ? 'Supply and catalogue are both present: the market can absorb acquisition spend.'
            : priority === 'SEED'
              ? 'Catalogue exists but supply is thin: recruit sellers before paying for demand.'
              : 'No supply and no catalogue yet: a market to watch, not to enter.',
      };
    })
    .filter((m) => m.score > 0 || m.platformActive)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMarkets);

  const opportunities = markets.map((m) => ({
    market: m.code,
    marketName: m.name,
    priority: m.priority,
    score: m.score,
    evidence: m.supply,
    qualification: {
      hasSupply: m.supply.sellers > 0,
      hasCatalogue: m.catalogue.publishedProducts > 0,
      platformActive: m.platformActive,
    },
    recommendedMove:
      m.priority === 'EXPAND'
        ? 'Onboard buyers with a category-led campaign once the General Manager approves it.'
        : m.priority === 'SEED'
          ? 'Recruit suppliers/merchants in the categories that already sell elsewhere.'
          : 'Collect market signals before committing any effort.',
  }));

  const drafts = markets.slice(0, 3).map((m) => ({
    market: m.code,
    language: requestedLanguages?.[0] ?? m.language,
    channel: 'email',
    status: 'DRAFT_ONLY',
    subject: `WASIT BUSINESS GLOBAL — ${m.name}`,
    bodyTemplate:
      'Introduce WASIT as a global B2B/B2C marketplace, name the strongest local category, and invite a short call. Personalise per prospect before any send.',
    placeholders: ['prospectName', 'category', 'proofPoint'],
    delivery: 'none',
  }));

  const expandMarkets = markets.filter((m) => m.priority === 'EXPAND').length;
  const publishedProductsInScope = markets.reduce((acc, m) => acc + m.catalogue.publishedProducts, 0);

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: 'discover_markets',
    markets,
    segments: segmentRows.map((s) => ({ id: s.id, name: s.name, publishedProducts: toNum(s.products) })),
    opportunities,
    drafts,
    kpis: {
      marketsRanked: markets.length,
      expandMarkets,
      seedMarkets: markets.filter((m) => m.priority === 'SEED').length,
      sellersInScope: markets.reduce((acc, m) => acc + m.supply.sellers, 0),
      publishedProductsInScope,
      note: 'Conversion and cost-per-acquisition need channel data that the platform does not collect yet.',
    },
    externalActions: {
      enabled: false,
      blocked: ['outreach.send', 'growth.paid_campaign'],
      note: 'No executor exists for sending or paid campaigns; both require General Manager approval.',
    },
    dataSources: ['countries', 'suppliers', 'merchants', 'companies', 'products', 'categories'],
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Growth scan: {{markets}} markets ranked, {{expand}} ready to expand, {{products}} published products in scope.',
    { markets: markets.length, expand: expandMarkets, products: publishedProductsInScope },
  );

  const out = await runAIFeature(db, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Global Growth & Acquisition Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: 'discover_markets' },
  });

  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

type AgentExecutor = (
  db: DB,
  agent: AgentDefinition,
  input: Record<string, unknown>,
) => Promise<AgentExecutorResult>;

// ---------- AI-FIRST-COMPLETION-04: the six supporting agents ----------

/**
 * A refusal that still costs a provider call, so a refused run is accounted for
 * exactly like a successful one (usage/cost/audit stay comparable).
 */
async function refuseWith(
  db: DB,
  agent: AgentDefinition,
  requesterId: string | null,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Promise<AgentExecutorResult> {
  const content = JSON.stringify({
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key] ?? agent.key,
    refused: true,
    code,
    error: message,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    ...extra,
  });
  const out = await runAIFeature(db, {
    userId: requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: `You are the WASIT ${agent.name}.`,
    user: `${code}: ${message}`,
    maxTokens: 32,
    metadata: { agentKey: agent.key, code },
  });
  return { content, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

function severityRank(level: string): number {
  switch (level) {
    case 'CRITICAL':
    case 'SEVERE':
      return 3;
    case 'HIGH':
      return 2;
    case 'MEDIUM':
      return 1;
    default:
      return 0;
  }
}

/**
 * Payment & Settlement Agent — read-only monitor over order payment/settlement
 * state. It cannot see provider intents, webhooks, payouts or the ledger: those
 * are money-movement tables and are hard-denied to every agent (A2). The report
 * says so instead of implying a coverage it does not have, and never moves money.
 */
async function execPaymentSettlementAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  if (!scope.isStaff) {
    return refuseWith(db, agent, scope.requesterId, 'PLATFORM_SCOPE_REQUIRED',
      'Payment and settlement monitoring reads platform-wide order state; only platform roles may run it.');
  }
  const windowDays = clampInt(Number(input.windowDays ?? 7), 1, 90);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const staleBefore = new Date(Date.now() - 48 * 3_600_000);

  const [paymentStates, settlementStates, refundStates, stalePaid, staleUnpaid] = await Promise.all([
    db.select({ status: orders.paymentStatus, n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(grand_total),0)::text` })
      .from(orders).where(gte(orders.createdAt, since)).groupBy(orders.paymentStatus),
    db.select({ status: orders.settlementStatus, n: sql<number>`count(*)::int` })
      .from(orders).where(gte(orders.createdAt, since)).groupBy(orders.settlementStatus),
    db.select({ status: orders.refundStatus, n: sql<number>`count(*)::int` })
      .from(orders).where(and(gte(orders.createdAt, since), sql`${orders.refundStatus} <> 'NONE'`)).groupBy(orders.refundStatus),
    db.select({ n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(grand_total),0)::text` })
      .from(orders).where(and(eq(orders.paymentStatus, 'PAID'), eq(orders.settlementStatus, 'PENDING'), lt(orders.createdAt, staleBefore))),
    db.select({ n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(grand_total),0)::text` })
      .from(orders).where(and(eq(orders.paymentStatus, 'UNPAID'), lt(orders.createdAt, staleBefore))),
  ]);

  const countOf = (rows: { status: string; n: number }[], status: string) =>
    toNum(rows.find((r) => r.status === status)?.n);
  const paid = countOf(paymentStates, 'PAID');
  const total = paymentStates.reduce((acc, r) => acc + toNum(r.n), 0);

  const anomalies: Array<Record<string, unknown>> = [];
  if (toNum(stalePaid[0]?.n) > 0) {
    anomalies.push({
      code: 'paid_not_settled_48h',
      severity: 'HIGH',
      statement: `${toNum(stalePaid[0]?.n)} order(s) were paid more than 48h ago and are still PENDING settlement.`,
      amount: stalePaid[0]?.amount ?? '0',
      nextStep: 'Check the provider settlement evidence in the audited admin settlement surface, then confirm or investigate.',
    });
  }
  if (toNum(staleUnpaid[0]?.n) > 0) {
    anomalies.push({
      code: 'unpaid_past_due',
      severity: 'MEDIUM',
      statement: `${toNum(staleUnpaid[0]?.n)} order(s) are still UNPAID more than 48h after creation.`,
      amount: staleUnpaid[0]?.amount ?? '0',
      nextStep: 'Expire or re-invite the payer; do not mark the order paid by hand.',
    });
  }
  const refundsPending = countOf(refundStates, 'PENDING');
  if (refundsPending > 0) {
    anomalies.push({
      code: 'refunds_pending',
      severity: 'MEDIUM',
      statement: `${refundsPending} order(s) have a pending refund in the window.`,
      nextStep: 'Follow the refund policy path; the agent cannot execute a refund.',
    });
  }

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    windowDays,
    orders: { total, paid, unpaid: countOf(paymentStates, 'UNPAID'), failed: countOf(paymentStates, 'FAILED') },
    paymentStates: paymentStates.map((r) => ({ status: r.status, orders: toNum(r.n), amount: r.amount })),
    settlementStates: settlementStates.map((r) => ({ status: r.status, orders: toNum(r.n) })),
    refundStates: refundStates.map((r) => ({ status: r.status, orders: toNum(r.n) })),
    anomalies,
    moneyMovement: false,
    blindSpots: [
      'Provider payment intents, webhook attempts, payouts and the transaction ledger are money-movement tables and are denied to every agent.',
      'Settlement is confirmed only by a provider settlement event on the audited admin surface; this agent cannot confirm it.',
    ],
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Payment & Settlement Agent.',
    user: adviceText('{{paid}} of {{total}} orders paid; {{anomalies}} anomaly group(s) in the last {{days}} day(s).',
      { paid, total, anomalies: anomalies.length, days: windowDays }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, anomalies: anomalies.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Compliance Agent — findings only. It reads the platform's own verification
 * flags, risk levels, open disputes and unresolved country policy gaps. Consents,
 * policies, verification documents and the audit trail are hard-denied, so the
 * agent reports what it can see and never issues a ruling.
 */
async function execComplianceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  if (!scope.isStaff) {
    return refuseWith(db, agent, scope.requesterId, 'PLATFORM_SCOPE_REQUIRED',
      'Compliance checks read platform-wide records; only platform roles may run them.');
  }
  const windowDays = clampInt(Number(input.windowDays ?? 30), 1, 180);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const staleDisputeBefore = new Date(Date.now() - 7 * 86_400_000);

  const [unverifiedSuppliers, unverifiedMerchants, unverifiedCompanies, riskLevels, severeEvents, staleDisputes, openDisputes, policyGaps] =
    await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(suppliers).where(and(eq(suppliers.isActive, true), eq(suppliers.verified, false))),
      db.select({ n: sql<number>`count(*)::int` }).from(merchants).where(and(eq(merchants.isActive, true), eq(merchants.verified, false))),
      db.select({ n: sql<number>`count(*)::int` }).from(companies).where(and(eq(companies.isActive, true), eq(companies.verified, false))),
      db.select({ level: riskProfiles.level, n: sql<number>`count(*)::int` }).from(riskProfiles).groupBy(riskProfiles.level),
      db.select({ severity: riskEvents.severity, n: sql<number>`count(*)::int` }).from(riskEvents)
        .where(gte(riskEvents.createdAt, since)).groupBy(riskEvents.severity),
      db.select({ n: sql<number>`count(*)::int` }).from(disputes)
        .where(and(sql`${disputes.status} not in ('DECIDED','CLOSED','ARCHIVED')`, lt(disputes.createdAt, staleDisputeBefore))),
      db.select({ n: sql<number>`count(*)::int` }).from(disputes)
        .where(sql`${disputes.status} not in ('DECIDED','CLOSED','ARCHIVED')`),
      db.select({ scope: countryPolicyGaps.scope, status: countryPolicyGaps.status, n: sql<number>`count(*)::int` })
        .from(countryPolicyGaps).where(eq(countryPolicyGaps.status, 'DECISION_REQUIRED')).groupBy(countryPolicyGaps.scope, countryPolicyGaps.status),
    ]);

  const unverified = toNum(unverifiedSuppliers[0]?.n) + toNum(unverifiedMerchants[0]?.n) + toNum(unverifiedCompanies[0]?.n);
  const highRisk = riskLevels.filter((r) => severityRank(r.level) >= 2).reduce((acc, r) => acc + toNum(r.n), 0);
  const severe = severeEvents.filter((r) => severityRank(r.severity) >= 3).reduce((acc, r) => acc + toNum(r.n), 0);

  const findings: Array<Record<string, unknown>> = [];
  if (unverified > 0) {
    findings.push({
      code: 'unverified_active_entities',
      severity: 'MEDIUM',
      statement: `${unverified} active supplier/merchant/company record(s) are not verified.`,
      evidence: {
        suppliers: toNum(unverifiedSuppliers[0]?.n),
        merchants: toNum(unverifiedMerchants[0]?.n),
        companies: toNum(unverifiedCompanies[0]?.n),
      },
      nextStep: 'Route them through the verification engine; do not grant verification from here.',
    });
  }
  if (highRisk > 0 || severe > 0) {
    findings.push({
      code: 'risk_exposure',
      severity: severe > 0 ? 'HIGH' : 'MEDIUM',
      statement: `${highRisk} profile(s) sit at HIGH/CRITICAL risk and ${severe} severe risk event(s) were recorded in ${windowDays} day(s).`,
      evidence: { riskLevels, severeEvents },
      nextStep: 'Review the risk desk; a decision is a human action and is audited there.',
    });
  }
  if (toNum(staleDisputes[0]?.n) > 0) {
    findings.push({
      code: 'disputes_aging',
      severity: 'MEDIUM',
      statement: `${toNum(staleDisputes[0]?.n)} of ${toNum(openDisputes[0]?.n)} open dispute(s) are older than 7 days.`,
      nextStep: 'Assign and decide within the dispute policy window.',
    });
  }
  if (policyGaps.length > 0) {
    findings.push({
      code: 'policy_gaps_open',
      severity: 'HIGH',
      statement: `${policyGaps.reduce((acc, r) => acc + toNum(r.n), 0)} country policy gap(s) are still DECISION_REQUIRED.`,
      evidence: policyGaps.map((r) => ({ scope: r.scope, gaps: toNum(r.n) })),
      nextStep: 'Record the legal decision in the policy engine; the agent never invents one.',
    });
  }

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    windowDays,
    snapshot: { unverified, highRiskProfiles: highRisk, severeRiskEvents: severe, openDisputes: toNum(openDisputes[0]?.n), policyGaps: policyGaps.length },
    findings,
    findingsOnly: true,
    blindSpots: [
      'Consents, policies, verification documents and audit logs are denied to every agent; their status is not inferred.',
      'No ruling, approval or verification is issued by this agent.',
    ],
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Compliance Agent.',
    user: adviceText('{{findings}} compliance finding(s); {{unverified}} unverified entity record(s).',
      { findings: findings.length, unverified }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, findings: findings.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

interface RecordReview {
  completeness: { score: number; present: string[]; missing: string[] };
}

function reviewRecord(kind: 'supplier' | 'merchant', row: Record<string, unknown>): RecordReview {
  const nameField = kind === 'supplier' ? 'companyName' : 'storeName';
  const fields = [nameField, 'description', 'countryId', 'cityId', 'logoUrl'];
  const weights: Record<string, number> = { [nameField]: 30, description: 20, countryId: 20, cityId: 15, logoUrl: 15 };
  const present = fields.filter((f) => {
    const v = row[f];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  const score = present.reduce((acc, f) => acc + (weights[f] ?? 0), 0);
  return { completeness: { score, present, missing: fields.filter((f) => !present.includes(f)) } };
}

async function execOnboardingAgent(
  db: DB,
  agent: AgentDefinition,
  input: Record<string, unknown>,
  kind: 'supplier' | 'merchant',
): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  const table = kind === 'supplier' ? suppliers : merchants;
  const requestedId = typeof input.entityId === 'string' ? input.entityId : null;

  const rows = scope.isStaff
    ? await db.select().from(table).where(requestedId ? eq(table.id, requestedId) : sql`true`).limit(requestedId ? 1 : 25)
    : await db.select().from(table).where(eq(table.userId, scope.requesterId ?? '')).limit(1);

  if (rows.length === 0) {
    return refuseWith(db, agent, scope.requesterId, 'ENTITY_NOT_FOUND',
      requestedId
        ? `No ${kind} record matches ${requestedId} in your scope.`
        : `You do not own a ${kind} record yet; create one before asking for an onboarding review.`);
  }

  const [productCounts, trust] = await Promise.all([
    db.select({ sellerId: products.sellerId, n: sql<number>`count(*)::int` })
      .from(products).where(and(eq(products.isPublished, true), inArray(products.sellerId, rows.map((r) => String(r.id)))))
      .groupBy(products.sellerId),
    db.select({ userId: trustScores.userId, score: trustScores.score })
      .from(trustScores).where(inArray(trustScores.userId, rows.map((r) => String(r.userId)))),
  ]);

  const reviews = rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    const review = reviewRecord(kind, record);
    const publishedProducts = toNum(productCounts.find((p) => p.sellerId === String(record.id))?.n);
    const trustScore = trust.find((t) => t.userId === String(record.userId))?.score ?? null;
    const nextSteps: string[] = [];
    if (review.completeness.missing.length > 0) nextSteps.push(`Fill the missing fields: ${review.completeness.missing.join(', ')}.`);
    if (record.verified !== true) nextSteps.push('Submit the verification request; only the verification engine can approve it.');
    if (publishedProducts === 0) nextSteps.push('Publish at least one listing so buyers can find you.');
    if (trustScore === null) nextSteps.push('Request a trust recomputation to establish a baseline score.');
    return {
      id: String(record.id),
      name: String(record[kind === 'supplier' ? 'companyName' : 'storeName'] ?? ''),
      verified: record.verified === true,
      active: record.isActive === true,
      countryId: (record.countryId as string | null) ?? null,
      completeness: review.completeness,
      publishedProducts,
      trustScore,
      nextSteps,
    };
  });

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    entityType: kind.toUpperCase(),
    reviews,
    averageCompleteness: reviews.length === 0 ? 0 : Math.round(reviews.reduce((a, r) => a + r.completeness.score, 0) / reviews.length),
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: `You are the WASIT ${agent.name}.`,
    user: adviceText('Reviewed {{n}} {{kind}} record(s); average completeness {{avg}}/100.',
      { n: reviews.length, kind, avg: data.averageCompleteness }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, kind, reviews: reviews.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

const execSupplierAgent = (db: DB, agent: AgentDefinition, input: Record<string, unknown>) =>
  execOnboardingAgent(db, agent, input, 'supplier');

const execMerchantAgent = (db: DB, agent: AgentDefinition, input: Record<string, unknown>) =>
  execOnboardingAgent(db, agent, input, 'merchant');

/**
 * Customer Intelligence Agent — RFM-style segmentation over the requester's own
 * orders. Buyer identities are masked: the agent reports segment sizes and value,
 * never an addressable person.
 */
async function execCustomerIntelligenceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  const windowDays = clampInt(Number(input.windowDays ?? 180), 7, 730);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const ordersFilter = orderScope(scope);

  const rows = await db
    .select({
      buyerId: orders.buyerId,
      orderCount: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(items_total),0)::text`,
      firstOrderAt: sql<string>`min(created_at)::text`,
      lastOrderAt: sql<string>`max(created_at)::text`,
    })
    .from(orders)
    .where(and(gte(orders.createdAt, since), ordersFilter))
    .groupBy(orders.buyerId);

  if (rows.length === 0) {
    const empty = {
      agentKey: agent.key, action: EXECUTOR_ACTION[agent.key], windowDays,
      segments: [], customers: 0,
      note: 'No orders in the window for your scope, so there is nothing to segment yet.',
      pii: 'masked', readOnly: true, generatedAt: new Date().toISOString(),
    };
    const out = await runAIFeature(db, {
      userId: scope.requesterId ?? 'system', roles: ['SUPER_ADMIN'], requestType: `AGENT:${agent.key}`,
      system: 'You are the WASIT Customer Intelligence Agent.', user: 'No orders in scope.',
      maxTokens: 32, metadata: { agentKey: agent.key, customers: 0 },
    });
    return { content: JSON.stringify(empty), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
  }

  const now = Date.now();
  const segmentOf = (orderCount: number, lastDays: number): string => {
    if (orderCount >= 5 && lastDays <= 30) return 'CHAMPION';
    if (orderCount >= 5) return lastDays > 90 ? 'AT_RISK' : 'LOYAL';
    if (orderCount >= 2) return lastDays > 90 ? 'AT_RISK' : 'REPEAT';
    return lastDays > 90 ? 'DORMANT' : 'NEW';
  };

  const buckets = new Map<string, { customers: number; revenue: number; orders: number }>();
  const customers = rows.map((r) => {
    const lastDays = Math.floor((now - new Date(String(r.lastOrderAt)).getTime()) / 86_400_000);
    const segment = segmentOf(toNum(r.orderCount), lastDays);
    const revenue = toNum(r.revenue);
    const bucket = buckets.get(segment) ?? { customers: 0, revenue: 0, orders: 0 };
    bucket.customers += 1;
    bucket.revenue += revenue;
    bucket.orders += toNum(r.orderCount);
    buckets.set(segment, bucket);
    return {
      // A stable, non-reversible reference: the raw buyer id never leaves the database.
      customerRef: createHash('sha256').update(String(r.buyerId)).digest('hex').slice(0, 10),
      orders: toNum(r.orderCount),
      revenue: revenue.toFixed(2),
      firstOrderAt: r.firstOrderAt,
      lastOrderAt: r.lastOrderAt,
      daysSinceLastOrder: lastDays,
      segment,
    };
  });

  const totalRevenue = customers.reduce((acc, c) => acc + toNum(c.revenue), 0);
  const segments = [...buckets.entries()]
    .map(([segment, v]) => ({
      segment,
      customers: v.customers,
      orders: v.orders,
      revenue: v.revenue.toFixed(2),
      revenueShare: totalRevenue === 0 ? 0 : Math.round((v.revenue / totalRevenue) * 1000) / 1000,
      averageBasket: v.orders === 0 ? '0.00' : (v.revenue / v.orders).toFixed(2),
    }))
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    windowDays,
    customers: customers.length,
    segments,
    topCustomers: [...customers].sort((a, b) => toNum(b.revenue) - toNum(a.revenue)).slice(0, 5),
    pii: 'masked',
    scope: scope.isStaff ? 'platform' : 'own',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Customer Intelligence Agent.',
    user: adviceText('{{customers}} customer(s) across {{segments}} segment(s) in {{days}} day(s).',
      { customers: customers.length, segments: segments.length, days: windowDays }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, customers: customers.length, segments: segments.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * Operations Agent — a health check over operational tables the agent layer
 * owns and the order/inventory state it is allowed to read. Typed queries only.
 */
async function execOperationsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const scope = await resolveRequesterScope(db, input);
  if (!scope.isStaff) {
    return refuseWith(db, agent, scope.requesterId, 'PLATFORM_SCOPE_REQUIRED',
      'Operational health spans every tenant; only platform roles may run it.');
  }
  const stuckBefore = new Date(Date.now() - 30 * 60_000);
  const dayAgo = new Date(Date.now() - 86_400_000);

  const [openOrders, oldestOpen, stuckTasks, failedTasks, failedRuns, lowStock, unread] = await Promise.all([
    db.select({ status: orders.status, n: sql<number>`count(*)::int` }).from(orders)
      .where(sql`${orders.status} in ('PENDING','CONFIRMED','PROCESSING')`).groupBy(orders.status),
    db.select({ createdAt: orders.createdAt }).from(orders)
      .where(sql`${orders.status} in ('PENDING','CONFIRMED','PROCESSING')`).orderBy(orders.createdAt).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(agentTasks)
      .where(and(eq(agentTasks.status, 'running'), lt(agentTasks.startedAt, stuckBefore))),
    db.select({ n: sql<number>`count(*)::int` }).from(agentTasks)
      .where(and(eq(agentTasks.status, 'failed'), gte(agentTasks.createdAt, dayAgo))),
    db.select({ n: sql<number>`count(*)::int` }).from(agentRuns)
      .where(and(eq(agentRuns.status, 'FAILED'), gte(agentRuns.createdAt, dayAgo))),
    db.select({ n: sql<number>`count(*)::int` }).from(inventoryItems)
      .where(sql`${inventoryItems.quantity} <= ${inventoryItems.lowStockThreshold}`),
    db.select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.isDeleted, false), eq(messages.status, 'SENT'), sql`${messages.readAt} is null`)),
  ]);

  const openTotal = openOrders.reduce((acc, r) => acc + toNum(r.n), 0);
  const oldestAgeHours = oldestOpen[0]?.createdAt
    ? Math.floor((Date.now() - new Date(oldestOpen[0].createdAt).getTime()) / 3_600_000)
    : 0;

  const blockers: Array<Record<string, unknown>> = [];
  if (toNum(stuckTasks[0]?.n) > 0) blockers.push({ code: 'stuck_agent_tasks', severity: 'HIGH', count: toNum(stuckTasks[0]?.n) });
  if (toNum(failedTasks[0]?.n) > 0) blockers.push({ code: 'failed_agent_tasks_24h', severity: 'MEDIUM', count: toNum(failedTasks[0]?.n) });
  if (toNum(failedRuns[0]?.n) > 0) blockers.push({ code: 'failed_runs_24h', severity: 'MEDIUM', count: toNum(failedRuns[0]?.n) });
  if (toNum(lowStock[0]?.n) > 0) blockers.push({ code: 'low_stock_items', severity: 'MEDIUM', count: toNum(lowStock[0]?.n) });
  if (oldestAgeHours > 72) blockers.push({ code: 'orders_aging', severity: 'HIGH', count: openTotal, oldestAgeHours });

  const penalty = blockers.reduce((acc, b) => acc + (b.severity === 'HIGH' ? 25 : 10), 0);
  const healthScore = Math.max(0, 100 - penalty);

  const data = {
    agentKey: agent.key,
    action: EXECUTOR_ACTION[agent.key],
    healthScore,
    openOrders: { total: openTotal, byStatus: openOrders.map((r) => ({ status: r.status, orders: toNum(r.n) })), oldestAgeHours },
    agentLayer: { stuckTasks: toNum(stuckTasks[0]?.n), failedTasks24h: toNum(failedTasks[0]?.n), failedRuns24h: toNum(failedRuns[0]?.n) },
    inventory: { lowStockItems: toNum(lowStock[0]?.n) },
    support: { unreadMessages: toNum(unread[0]?.n) },
    blockers,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeature(db, {
    userId: scope.requesterId ?? 'system',
    roles: ['SUPER_ADMIN'],
    requestType: `AGENT:${agent.key}`,
    system: 'You are the WASIT Operations Agent.',
    user: adviceText('Health {{score}}/100 with {{blockers}} blocker group(s); {{open}} open order(s).',
      { score: healthScore, blockers: blockers.length, open: openTotal }),
    maxTokens: 96,
    metadata: { agentKey: agent.key, healthScore, blockers: blockers.length },
  });
  return { content: JSON.stringify(data), tokensInput: out.tokensInput, tokensOutput: out.tokensOutput, cost: out.cost };
}

/**
 * The executor table. Its keys are the authoritative "this agent can run" set;
 * the catalogue's `executable` flag must agree with it, and `ai-reg01` tests
 * assert the two never drift.
 */
const EXECUTORS: Record<string, AgentExecutor> = {
  'sales-agent': execSalesAgent,
  'marketing-agent': execMarketingAgent,
  'marketing-video-agent': execMarketingVideoAgent,
  'ads-agent': execAdsAgent,
  'product-agent': execProductAgent,
  'support-agent': execSupportAgent,
  'analytics-agent': execAnalyticsAgent,
  'market-research-agent': execMarketResearchAgent,
  'b2b-agent': execB2BAgent,
  'risk-agent': execRiskAgent,
  'dispute-assistant': execDisputeAssistant,
  'development-agent': execDevelopmentAgent,
  'finance-agent': execFinanceAgent,
  'outreach-acquisition-agent': execGrowthAgent,
  'payment-settlement-agent': execPaymentSettlementAgent,
  'compliance-agent': execComplianceAgent,
  'supplier-agent': execSupplierAgent,
  'merchant-agent': execMerchantAgent,
  'customer-intelligence-agent': execCustomerIntelligenceAgent,
  'operations-agent': execOperationsAgent,
};

/** Agent keys with a real executor (the only ones the catalogue may mark executable). */
export const EXECUTABLE_AGENT_KEYS: readonly string[] = Object.freeze(Object.keys(EXECUTORS));

/** Routes an agent task to its specialised executor. Never uses mock data. */
export async function executeAgentTask(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  // Trusted action gate (AI-INTEG-P3-T2). This is the single execution boundary
  // every executor is reached through, so enforcing here — BEFORE any dispatch,
  // read, or provider call — means no agent can perform an action without a
  // trusted run context and an explicit grant for exactly that action. The
  // action id is the executor's own code literal (never task `input`), and the
  // grant list is read from the trusted context (never an argument), so a caller
  // cannot widen its own authority. Fails closed: a missing context, a missing
  // grant, or a grant for a different agent's action throws here.
  requireAction(EXECUTOR_ACTION[agent.key] ?? agent.key);
  // A2 data-scope enforcement: executors receive a scoped `db` handle, so every
  // table access is checked against the run's agent scope at the ACTUAL access
  // boundary. An executor cannot read outside its scope, write business data,
  // run raw SQL or open a transaction — regardless of which executor, task,
  // agent key or parameter is used. Fail-closed on a missing scope.
  const scoped = withAgentDataScope(db);
  const executor = EXECUTORS[agent.key];
  if (!executor) throw new Error(`Unknown agent key: ${agent.key}`);
  return executor(scoped, agent, input);
}
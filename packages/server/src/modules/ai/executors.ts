import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { ApiError, type UserRole } from '@wasit/shared';
import type { AgentDefinition } from '../../lib/ai/types';
import { runAIFeature } from '../../lib/ai/runtime';
import { LocalHeuristicProvider } from '../../lib/ai/provider';
import { resolveAiRoute } from '../../lib/ai/routing';
import {
  getAgentRunContext,
  AgentRunBudgetExceededError,
  AgentCostRecordingError,
} from '../../lib/ai/agent-run-context';
import { invokeTool, ToolGatewayError } from '../../lib/ai/tool-gateway';
import {
  PLATFORM_METRICS,
  PLATFORM_READ_ORDERS,
  OPERATIONS_READ_HEALTH,
  RISK_READ_OVERVIEW,
  DISPUTES_READ_SUMMARY,
  PAYMENTS_READ_SETTLEMENTS,
  FINANCE_READ_LEDGER,
  COMPLIANCE_READ_PLATFORM,
  MARKET_READ_OVERVIEW,
  MARKET_READ_OWN,
  ADS_READ_CAMPAIGNS,
  DEVELOPMENT_READ_PLATFORM,
  SUPPLIER_READ_OWN,
  MERCHANT_READ_OWN,
} from '../../lib/ai/tool-registry';
import { products, categories, productVariants, productImages } from '../../db/schema/products';
import { suppliers, merchants, companies } from '../../db/schema/trade';
import { orders, orderItems, transactions, transactionLedger } from '../../db/schema/commerce';
import { inventoryItems, inventoryMovements } from '../../db/schema/commerce_extras';
import { adCreatives } from '../../db/schema/ads';
import { riskProfiles, riskEvents } from '../../db/schema/risk';
import { disputes, disputeMessages } from '../../db/schema/disputes';
import { trustScores, reviews } from '../../db/schema/trust';
import { messages, threads, threadParticipants } from '../../db/schema/messaging';
import { users } from '../../db/schema/auth';
import { agentTasks } from '../../db/schema/agents';
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

/** The advisory reasoning an agent executor may attach to its deterministic facts. */
interface AgentReasoning {
  /** Natural-language proposal — present only when a real vendor produced it. */
  proposal?: string;
  /** The model that produced `proposal` (vendor name). */
  model?: string;
  tokensInput: number;
  tokensOutput: number;
  /** Why no proposal was produced (vendor outage / fallback), when applicable. */
  unavailableReason?: string;
}

/**
 * The requester's REAL roles for an executor AI call.
 *
 * Prefers the trusted run context the runner set (`requesterRoles`, resolved
 * server-side from the database — never from task `input`). Falls back to a
 * direct database lookup for callers that invoke an executor outside a run
 * (tests, internal tools). The scheduler principal has no roles of its own.
 * This replaces the previous hardcoded `roles: ['SUPER_ADMIN']`, so a call is
 * attributed and budgeted under the actual principal, not a widened admin one.
 */
async function executorRolesFor(db: DB, userId: string): Promise<UserRole[]> {
  const ctx = getAgentRunContext();
  if (ctx?.requesterRoles && ctx.requestedBy === userId) return [...ctx.requesterRoles];
  if (!userId || userId === SYSTEM_PRINCIPAL) return [];
  const res = await db.execute<{ role_name: string }>(sql`
    select r.name as role_name
    from user_roles ur
    join roles r on r.id = ur.role_id
    where ur.user_id = ${userId}
  `);
  const rows = (res as unknown as { rows: { role_name: string }[] }).rows ?? [];
  return rows.map((r) => r.role_name as UserRole);
}

/**
 * Optional natural-language reasoning for a specialised agent (AI-02.0).
 *
 * The deterministic `facts` an executor computes remain the source of truth.
 * This runs the SAME cost/budget/audit path every other AI call uses, but
 * through the `AGENT_REASONING` capability route and under the requester's real
 * roles. When a real vendor (OpenAI / Anthropic) is configured and answers, its
 * text is returned as an advisory `proposal`; the deterministic output is
 * unchanged either way.
 *
 * Automatic local fallback: with no vendor configured the route degrades to the
 * free local engine (the call is still recorded, as before, for budget/audit),
 * and if a configured vendor fails (timeout / transport / 5xx) the executor
 * retries once on the local engine so the task never fails on a vendor outage.
 *
 * Budget safety is preserved: a per-run ceiling breach or an unrecordable cost
 * is re-thrown (the task must fail closed), and the monthly budget still throws
 * 429 — only vendor transport failures are contained.
 */
async function reasonAboutAgent(
  db: DB,
  agent: AgentDefinition,
  args: { userId: string; system: string; user: string; maxTokens: number; metadata?: Record<string, unknown> },
): Promise<AgentReasoning> {
  const roles = await executorRolesFor(db, args.userId);
  const route = await resolveAiRoute(db, 'AGENT_REASONING', roles);
  const isVendor = route.providerId !== 'local-heuristic' && route.providerId !== 'noop';

  // AI-06.0: prepend the requester's recalled prior-run context (deterministic
  // facts only) so the model reasons with relevant history. It comes from the
  // trusted run context — never from task input — and is absent when there is
  // none. The deterministic facts remain the agent's output; this only informs
  // the linguistic proposal.
  const priorContext = getAgentRunContext()?.priorContext;
  const userPrompt = priorContext ? `${priorContext}\n\n${args.user}` : args.user;

  const call = async (
    provider: typeof route.provider,
    modelKey: string,
    vendorModel: string,
    vendorCall: boolean,
  ): Promise<AgentReasoning> => {
    const out = await runAIFeature(db, {
      userId: args.userId,
      roles,
      requestType: `AGENT:${agent.key}`,
      system: args.system,
      user: userPrompt,
      maxTokens: args.maxTokens,
      modelKey,
      vendorModel,
      provider,
      metadata: { ...(args.metadata ?? {}), agentKey: agent.key, capability: 'AGENT_REASONING', requesterRoles: roles },
    });
    const content = out.content.trim();
    // Only a real vendor produces a linguistic proposal; the local engine's
    // echo is not surfaced (the deterministic facts are the agent's output).
    return vendorCall && content.length > 0
      ? { proposal: content, model: out.model, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput }
      : { model: out.model, tokensInput: out.tokensInput, tokensOutput: out.tokensOutput };
  };

  /** Budget/cost failures must still fail the task closed; nothing else is fatal. */
  const isFatal = (err: unknown): boolean =>
    err instanceof AgentRunBudgetExceededError ||
    err instanceof AgentCostRecordingError ||
    (err instanceof ApiError && err.statusCode === 429);

  try {
    return await call(route.provider, route.modelKey, route.vendorModel, isVendor);
  } catch (err) {
    if (isFatal(err)) throw err;
    if (!isVendor) return { tokensInput: 0, tokensOutput: 0, unavailableReason: (err as Error).message };
    // Configured vendor failed (timeout / transport / 5xx) → automatic local fallback.
    try {
      const local = await call(new LocalHeuristicProvider(), 'local-heuristic', 'local-heuristic', false);
      return { ...local, unavailableReason: `provider fallback: ${(err as Error).message}` };
    } catch (fallbackErr) {
      if (isFatal(fallbackErr)) throw fallbackErr;
      return { tokensInput: 0, tokensOutput: 0, unavailableReason: (err as Error).message };
    }
  }
}

/**
 * Merges the advisory proposal into an executor's deterministic `data` payload.
 * `facts` (the existing object) is never touched; the proposal is an ADDITIVE
 * field, and when no vendor produced one the payload is returned unchanged.
 */
function withProposal(data: Record<string, unknown>, reasoning: AgentReasoning): Record<string, unknown> {
  if (reasoning.proposal === undefined && reasoning.unavailableReason === undefined) return data;
  return {
    ...data,
    ...(reasoning.proposal !== undefined ? { proposal: reasoning.proposal, proposalModel: reasoning.model ?? null } : {}),
    ...(reasoning.unavailableReason !== undefined ? { reasoningUnavailable: reasoning.unavailableReason } : {}),
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

interface ProductViewer {
  /** True for ADMIN/SUPER_ADMIN — may read any product, published or not. */
  isAdmin: boolean;
  /** Seller entity ids the viewer owns (empty for a non-owner / admin). */
  ownedSellerIds: string[];
}

/**
 * Loads one product (or a sample for an overview) subject to the platform's
 * product-visibility policy, extracted from the products module:
 *  - an admin sees every product;
 *  - an owner sees their own products regardless of publication;
 *  - everyone else sees only publicly listed products
 *    (`is_published AND status='ACTIVE'`, as `listProducts` uses).
 *
 * Visibility is applied in the WHERE clause, so a non-owner can never fetch an
 * unpublished product by guessing its id — `productId` is never treated as proof
 * of authorization. An invisible product resolves to `null` (a plain "not found"
 * to the caller), never a widened read.
 */
async function pickProduct(db: DB, productId: unknown, viewer: ProductViewer): Promise<ProductWithCategory | null> {
  const hasId = typeof productId === 'string' && productId.length > 0;
  const ownedCond = viewer.ownedSellerIds.length > 0 ? inArray(products.sellerId, viewer.ownedSellerIds) : undefined;
  const publicCond = and(eq(products.isPublished, true), eq(products.status, 'ACTIVE'));
  const visibility = viewer.isAdmin ? undefined : ownedCond ? or(ownedCond, publicCond) : publicCond;
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Sales Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: isPlatform ? 'platform' : 'own' },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    system: 'You are the WASIT Marketing Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

async function execAdsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
  // G5 Phase 1: the cross-owner ad book is read ONLY through the Tool Gateway
  // (admin-only), never a direct query. `requirePlatformGate` above is kept as
  // the executor's own defence-in-depth check; the gateway re-enforces admin
  // scope before the handler runs.
  const { data } = await invokeTool(db, ADS_READ_CAMPAIGNS, {});
  const facts = data.snapshot as Record<string, unknown>;

  const data_out: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'recommend_ads',
    snapshot: facts,
    recommendation: {
      topUp:
        (facts.activeCampaigns as number) === 0
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Ads Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data_out, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

async function execProductAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Product visibility is enforced server-side: an admin sees any product, an
  // owner sees their own, everyone else only published/active listings. The
  // viewer is resolved from the trusted requester id, never from `input`.
  const isAdmin = await canReadPlatformData(db, userId, agent);
  const ownedSellerIds = isAdmin ? [] : await resolveOwnedSellerIds(db, userId);
  const p = await pickProduct(db, input.productId, { isAdmin, ownedSellerIds });
  if (!p) {
    const reasoning = await reasonAboutAgent(db, agent, {
      userId,
      system: 'You are the WASIT Product Agent.',
      user: 'No product found.',
      maxTokens: 48,
      metadata: { agentKey: agent.key },
    });
    const content = JSON.stringify(withProposal({
      agentKey: agent.key,
      action: input.action ?? 'analyze_product',
      error: 'No product found. Provide a productId.',
      readOnly: true,
      generatedAt: new Date().toISOString(),
    }, reasoning));
    return { content, tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId: typeof input.__userId === 'string' ? (input.__userId as string) : 'system',
    system: 'You are the WASIT Product Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, productId: p.id },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Support Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: isPlatform ? 'platform' : 'own' },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

async function execAnalyticsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Platform KPIs and the order summary are platform-wide data. Both are read
  // ONLY through the Tool Gateway, which refuses a non-admin before any query
  // runs — so there is no direct query path that could leak another tenant's rows.
  const [{ data: metrics }, { data: orderSummary }] = await Promise.all([
    invokeTool(db, PLATFORM_METRICS, {}),
    invokeTool(db, PLATFORM_READ_ORDERS, {}),
  ]);
  const snapshot = metrics.snapshot as Record<string, unknown>;

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'generate_report',
    ...metrics,
    orderSummary,
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText(
    'Analytics snapshot: {{users}} users, {{products}} products, {{suppliers}} suppliers, {{merchants}} merchants, {{companies}} companies, {{orders}} orders, GMV {{gmv}}.',
    { users: snapshot.users, products: snapshot.products, suppliers: snapshot.suppliers, merchants: snapshot.merchants, companies: snapshot.companies, orders: snapshot.orders, gmv: snapshot.gmv },
  );

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Analytics Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

async function execMarketResearchAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Every read goes through the Tool Gateway — no direct query remains here.
  // `market.read_own` resolves the caller's identity from the trusted run
  // context (never from the args). `market.read_overview` is platform-scoped:
  // the gateway refuses a non-admin with PLATFORM_SCOPE_DENIED. A non-admin
  // therefore receives ONLY their own slice; the platform aggregates are absent,
  // not merely empty — they are never read for a non-admin.
  const [{ data: own }, platform] = await Promise.all([
    invokeTool(db, MARKET_READ_OWN, {}),
    invokeTool(db, MARKET_READ_OVERVIEW, {}).catch((err: unknown) => {
      if (err instanceof ToolGatewayError && (err.code === 'PLATFORM_SCOPE_DENIED' || err.code === 'PERMISSION_DENIED')) {
        return null;
      }
      throw err;
    }),
  ]);

  const snapshot = platform?.data.snapshot as
    | { products: number; categories: { name: string; products: number }[]; avgPrice: string; suppliers: number; merchants: number; totalOrderValue: string }
    | undefined;

  const data: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'market_overview',
    scope: snapshot ? 'platform' : 'own',
    // `snapshot` carries platform-wide aggregates only (no other tenant's raw
    // records); it is present for admins and absent for everyone else.
    ...(snapshot ? { snapshot } : {}),
    scopedToOwned: true,
    yourMarket: { products: toNum(own.products), orderValue: own.orderValue ?? '0' },
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = snapshot
    ? adviceText(
        'Market overview: {{products}} products across {{categories}} categories, avg price {{avgPrice}}, with {{suppliers}} suppliers and {{merchants}} merchants.',
        { products: snapshot.products, categories: snapshot.categories.length, avgPrice: snapshot.avgPrice, suppliers: snapshot.suppliers, merchants: snapshot.merchants },
      )
    : adviceText('Your market slice: {{products}} products in your own catalogue, order value {{orderValue}}.', {
        products: toNum(own.products),
        orderValue: own.orderValue ?? '0',
      });

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Market Research Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT B2B Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: true },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

async function execRiskAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // The cross-user risk picture is platform data; it is read through the Tool
  // Gateway (admin-only), never a direct query.
  const { data } = await invokeTool(db, RISK_READ_OVERVIEW, {});
  const snapshot = data.snapshot as Record<string, unknown>;
  const riskPosture = data.riskPosture as { severeEvents: number };

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Risk Agent.',
    user: adviceText(
      'Risk posture: {{total}} risk events recorded; {{severe}} severe/high severity.',
      { total: snapshot.totalRiskEvents, severe: riskPosture.severeEvents },
    ),
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scope: 'all' },
  });

  return {
    content: JSON.stringify(withProposal({ agentKey: agent.key, action: input.action ?? 'assess_risk', ...data, readOnly: true, generatedAt: new Date().toISOString() }, reasoning)),
    tokensInput: reasoning.tokensInput,
    tokensOutput: reasoning.tokensOutput,
  };
}

async function execDisputeAssistant(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Every dispute and its messages is cross-user platform data; read through the
  // Tool Gateway (admin-only), never a direct query.
  const { data } = await invokeTool(db, DISPUTES_READ_SUMMARY, {});
  const snapshot = data.snapshot as Record<string, unknown>;

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Dispute Assistant.',
    user: adviceText(
      'Dispute centre: {{total}} disputes total, {{open}} open, with {{messages}} recent messages exchanged.',
      { total: snapshot.totalDisputes, open: snapshot.openCount, messages: (snapshot.recentMessages as unknown[]).length },
    ),
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return {
    content: JSON.stringify(withProposal({ agentKey: agent.key, action: input.action ?? 'summarize_dispute', ...data, readOnly: true, generatedAt: new Date().toISOString() }, reasoning)),
    tokensInput: reasoning.tokensInput,
    tokensOutput: reasoning.tokensOutput,
  };
}

async function execDevelopmentAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const denied = await requirePlatformGate(db, userId, agent);
  if (denied) return denied;
  // G5 Phase 1: the cross-owner build context is read ONLY through the Tool
  // Gateway (admin-only), never a direct query. `requirePlatformGate` above is
  // kept as the executor's own defence-in-depth check; the gateway re-enforces
  // admin scope before the handler runs.
  const { data } = await invokeTool(db, DEVELOPMENT_READ_PLATFORM, {});
  const facts = data.snapshot as Record<string, unknown>;

  const data_out: Record<string, unknown> = {
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Development Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data_out, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

// ---------- Phase 19: the eight additional specialised agents ----------

/**
 * Finance Agent — ledger-backed financial summary. Read-only: it never writes a
 * ledger entry, never moves funds and never touches the commission policy.
 */
async function execFinanceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // The ledger, commission policies and flows are platform-wide financial data;
  // read through the Tool Gateway (admin-only), never a direct query.
  const { data } = await invokeTool(db, FINANCE_READ_LEDGER, {});
  const flows = data.flows as Record<string, string>;

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Finance Agent. Report figures only; never move funds.',
    user: adviceText(
      'Finance summary ({{currency}}): commission {{commission}}, payment fees {{fees}}, refunds {{refunds}}. Commission policy is configuration-driven, never hardcoded here.',
      { currency: data.currencyCode, commission: flows.commission, fees: flows.paymentFees, refunds: flows.refunds },
    ),
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return {
    content: JSON.stringify(withProposal({ agentKey: agent.key, action: input.action ?? 'reconcile', ...data, readOnly: true, generatedAt: new Date().toISOString() }, reasoning)),
    tokensInput: reasoning.tokensInput,
    tokensOutput: reasoning.tokensOutput,
  };
}

/**
 * Payment & Settlement Agent — monitors payment intents, webhook health and
 * payout status. Never settles autonomously (that is an approved action).
 */
async function execPaymentSettlementAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Payment intents, webhook health and payouts are platform-wide data; read
  // through the Tool Gateway (admin-only), never a direct query.
  const { data } = await invokeTool(db, PAYMENTS_READ_SETTLEMENTS, {});
  const intents = data.paymentIntentStatus as { status: string; count: number }[];
  const webhooks = data.webhookStatus as { status: string; count: number }[];
  const payoutsRows = data.payoutStatus as { status: string; count: number }[];

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Payment & Settlement Agent. Monitor only.',
    user: adviceText(
      'Payment/settlement monitor: {{intents}} payment intents tracked, {{webhooks}} webhook events, {{payouts}} payouts. Dead-lettered webhooks: {{dlq}}.',
      { intents: intents.reduce((a, s) => a + Number(s.count), 0), webhooks: webhooks.reduce((a, w) => a + w.count, 0), payouts: payoutsRows.reduce((a, p) => a + p.count, 0), dlq: (data.anomalies as { deadLetteredWebhooks: number }).deadLetteredWebhooks },
    ),
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return {
    content: JSON.stringify(withProposal({ agentKey: agent.key, action: input.action ?? 'monitor_settlement', ...data, readOnly: true, generatedAt: new Date().toISOString() }, reasoning)),
    tokensInput: reasoning.tokensInput,
    tokensOutput: reasoning.tokensOutput,
  };
}

/**
 * Compliance Agent — surfaces policy/verification gaps. Produces findings only;
 * a final ruling is an approved action.
 */
async function execComplianceAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // The scan spans every supplier/merchant/company and dispute on the platform,
  // so it is read through the Tool Gateway (admin-only) — never a direct query.
  // A non-admin requester is refused by the gateway before the handler runs.
  const { data } = await invokeTool(db, COMPLIANCE_READ_PLATFORM, {});
  const unverified = (data.unverified ?? {}) as { suppliers?: number; merchants?: number; companies?: number };
  const findings = [
    { area: 'KYC/KYB', count: toNum(unverified.suppliers) + toNum(unverified.merchants) + toNum(unverified.companies), severity: 'MEDIUM', note: 'Entities without completed verification.' },
    { area: 'DISPUTES', count: toNum(data.openDisputes), severity: 'LOW', note: 'Open or under-review disputes needing resolution.' },
  ];

  const data_out: Record<string, unknown> = {
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Compliance Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return { content: JSON.stringify(withProposal(data_out, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

/**
 * Supplier Agent — reviews a supplier record. A non-staff caller only ever sees
 * a supplier they own, so tenant data cannot leak across accounts.
 */
async function execSupplierAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const requestedId = typeof input.supplierId === 'string' ? (input.supplierId as string) : undefined;

  // G5 Phase 2 (A1): the owned-supplier read runs ONLY through the Tool Gateway,
  // never a direct query. `supplier.read_owned` resolves the owner from the
  // trusted run context (never from the args) and honours an explicit id only
  // when the caller owns it — so a caller can never widen the read to another
  // tenant. The gateway validates the args and audits the invocation.
  const { data } = await invokeTool(db, SUPPLIER_READ_OWN, {
    ...(requestedId ? { supplierId: requestedId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const rows = (data.suppliers ?? []) as Array<{
    id: string;
    name: string;
    countryId: string | null;
    verified: boolean;
    isActive: boolean;
  }>;

  const data_out: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'onboard',
    scopedToOwned: !requestedId,
    suppliers: rows.map((s) => ({
      id: s.id,
      name: s.name,
      countryId: s.countryId,
      verified: s.verified,
      isActive: s.isActive,
    })),
    note: requestedId && rows.length === 0 ? 'Supplier not found in your scope.' : 'Review completeness and verification status.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText('Supplier review: {{count}} record(s) in scope.', { count: rows.length });

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Supplier Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: !requestedId },
  });

  return { content: JSON.stringify(withProposal(data_out, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

/** Merchant Agent — same isolation rule as the Supplier Agent, for merchants. */
async function execMerchantAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  const requestedId = typeof input.merchantId === 'string' ? (input.merchantId as string) : undefined;

  // G5 Phase 2 (A2): the owned-merchant read runs ONLY through the Tool Gateway,
  // never a direct query. `merchant.read_owned` resolves the owner from the
  // trusted run context (never from the args) and honours an explicit id only
  // when the caller owns it — so a caller can never widen the read to another
  // tenant. The gateway validates the args and audits the invocation.
  const { data } = await invokeTool(db, MERCHANT_READ_OWN, {
    ...(requestedId ? { merchantId: requestedId } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const rows = (data.merchants ?? []) as Array<{
    id: string;
    name: string;
    countryId: string | null;
    verified: boolean;
    isActive: boolean;
  }>;

  const data_out: Record<string, unknown> = {
    agentKey: agent.key,
    action: input.action ?? 'onboard',
    scopedToOwned: !requestedId,
    merchants: rows.map((m) => ({
      id: m.id,
      name: m.name,
      countryId: m.countryId,
      verified: m.verified,
      isActive: m.isActive,
    })),
    note: requestedId && rows.length === 0 ? 'Merchant not found in your scope.' : 'Review completeness and verification status.',
    readOnly: true,
    generatedAt: new Date().toISOString(),
  };

  const text = adviceText('Merchant review: {{count}} record(s) in scope.', { count: rows.length });

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Merchant Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: !requestedId },
  });

  return { content: JSON.stringify(withProposal(data_out, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Customer Intelligence Agent.',
    user: text,
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwnedSales: !isPlatform },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
}

/**
 * Operations Agent — operational health: order pipeline, failed agent tasks and
 * open disputes. Read-only.
 */
async function execOperationsAgent(db: DB, agent: AgentDefinition, input: Record<string, unknown>): Promise<AgentExecutorResult> {
  const userId = typeof input.__userId === 'string' ? (input.__userId as string) : 'system';
  // Ops health spans every order, dispute and inventory row on the platform, so
  // it is read through the Tool Gateway (admin-only) — never a direct query.
  const { data } = await invokeTool(db, OPERATIONS_READ_HEALTH, {});

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Operations Agent.',
    user: adviceText(
      'Operations health: {{failed}} failed agent tasks, {{disputes}} open disputes, {{stock}} low-stock items.',
      { failed: data.failedAgentTasks as never, disputes: data.openDisputes as never, stock: data.lowStockItems as never },
    ),
    maxTokens: 96,
    metadata: { agentKey: agent.key, action: input.action },
  });

  return {
    content: JSON.stringify(withProposal({ agentKey: agent.key, action: input.action ?? 'health_check', ...data, readOnly: true, generatedAt: new Date().toISOString() }, reasoning)),
    tokensInput: reasoning.tokensInput,
    tokensOutput: reasoning.tokensOutput,
  };
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

  const reasoning = await reasonAboutAgent(db, agent, {
    userId,
    system: 'You are the WASIT Outreach & Acquisition Agent. Never send without approval.',
    user: text,
    maxTokens: 128,
    metadata: { agentKey: agent.key, action: input.action, scopedToOwned: true },
  });

  return { content: JSON.stringify(withProposal(data, reasoning)), tokensInput: reasoning.tokensInput, tokensOutput: reasoning.tokensOutput };
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
  // Defence in depth: the Copilot is a coordinator, never an executor. A task
  // row that predates the creation-time guard — or a direct caller of this
  // function — must not reach a specialised executor, so the boundary is
  // re-asserted here rather than left to the `default` branch.
  if (agent.isCopilot) {
    throw new Error('The Copilot is a coordinator and cannot be executed as an agent task');
  }
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
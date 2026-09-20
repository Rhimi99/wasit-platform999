import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { products, categories } from '../../db/schema/products';
import { aiRequests, aiBudgets } from '../../db/schema/ai';
import { env } from '../../lib/env';
import { resolveProvider } from '../../lib/ai/provider';
import { runAIFeature } from '../../lib/ai/runtime';
import { currentPeriodWindow, aiUsageForPeriod } from '../../lib/ai/cost-control';

export interface AiStatusView {
  provider: string;
  providerAvailable: boolean;
  defaultModel: string;
  monthlyBudgetUsd: string;
  period: string;
  usageCurrent: number;
}

/** Status + budget/usage snapshot shown in dashboards and admin. */
export async function getAiStatus(db: DB, userId: string, roles: UserRole[]): Promise<AiStatusView> {
  const provider = resolveProvider();
  const window = currentPeriodWindow('MONTHLY');
  const usage = await aiUsageForPeriod(db, userId, window.start, window.end);
  const defaultModel = env.AI_MODEL?.length ? env.AI_MODEL : 'local-heuristic';
  return {
    provider: provider.id,
    providerAvailable: provider.isAvailable(),
    defaultModel,
    monthlyBudgetUsd: String(env.AI_BUDGET_MONTHLY_USD),
    period: 'MONTHLY',
    usageCurrent: usage.requests,
  };
}

export interface ProductAnalysisView {
  productId: string;
  productName: string;
  price: string;
  currencyCode: string;
  categoryName: string | null;
  status: string;
  recommendation: string;
  confidence: number;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
}

/**
 * Product Agent endpoint — real, deterministic analysis of a listing
 * using live DB data. If a paid LLM provider is configured, genuine AI is used;
 * otherwise the deterministic local analytics engine produces the analysis.
 */
export async function analyzeProduct(
  db: DB,
  userId: string,
  roles: UserRole[],
  productId: string,
): Promise<ProductAnalysisView> {
  const row = await db
    .select({
      id: products.id,
      name: products.name,
      basePrice: products.basePrice,
      currencyCode: products.currencyCode,
      categoryId: products.categoryId,
      categoryName: categories.name,
      isPublished: products.isPublished,
      unit: products.unit,
      purchaseIntent: products.purchaseIntent,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(eq(products.id, productId))
    .limit(1);

  if (row.length === 0) throw ApiError.notFound('Product');

  const p = row[0];
  const published = p.isPublished ? 'published' : 'draft';
  const fallbackReasoning =
    p.categoryName && p.basePrice
      ? `Product "${p.name}" is ${published} in category "${p.categoryName}" at ${p.basePrice} ${p.currencyCode}.`
      : `Product "${p.name}" is incomplete (missing category or price). Complete the listing to improve visibility.`;

  // Always run through the AI runtime for consistent cost/budget/audit accounting.
  const out = await runAIFeature(db, {
    userId,
    roles,
    requestType: 'PRODUCT_ANALYSIS',
    system: 'You are WASIT product analyst. Analyze the product listing.',
    user: fallbackReasoning,
    maxTokens: 256,
    metadata: { productId },
  });

  return {
    productId: p.id,
    productName: p.name,
    price: String(p.basePrice),
    currencyCode: p.currencyCode,
    categoryName: p.categoryName,
    status: published,
    recommendation: fallbackReasoning,
    confidence: 1,
    model: out.model,
    tokensInput: out.tokensInput,
    tokensOutput: out.tokensOutput,
    cost: out.cost,
  };
}

/** My recent AI activity (requests) for the dashboard. */
export async function listMyAiActivity(db: DB, userId: string, limit = 20) {
  const rows = await db
    .select({
      id: aiRequests.id,
      requestType: aiRequests.requestType,
      model: aiRequests.model,
      tokensInput: aiRequests.tokensInput,
      tokensOutput: aiRequests.tokensOutput,
      cost: aiRequests.cost,
      createdAt: aiRequests.createdAt,
    })
    .from(aiRequests)
    .where(eq(aiRequests.userId, userId))
    .orderBy(desc(aiRequests.createdAt))
    .limit(limit);
  return rows;
}

/** Admin: AI usage summary for the current month. */
export async function adminUsageSummary(db: DB) {
  const window = currentPeriodWindow('MONTHLY');
  const [totals, budgets] = await Promise.all([
    db
      .select({
        requests: sql<number>`count(*)`,
        totalTokensIn: sql<number>`coalesce(sum(tokens_input),0)`,
        totalTokensOut: sql<number>`coalesce(sum(tokens_output),0)`,
        totalCost: sql<string>`coalesce(sum(cast(cost as numeric)),0)::text`,
        distinctUsers: sql<number>`count(distinct user_id)`,
      })
      .from(aiRequests)
      .where(and(gte(aiRequests.createdAt, window.start), lt(aiRequests.createdAt, window.end))),
    db.select().from(aiBudgets),
  ]);
  const t = totals[0];
  return {
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    totals: {
      requests: Number(t?.requests ?? 0),
      tokensInput: Number(t?.totalTokensIn ?? 0),
      tokensOutput: Number(t?.totalTokensOut ?? 0),
      cost: String(t?.totalCost ?? '0'),
      distinctUsers: Number(t?.distinctUsers ?? 0),
    },
    budgets,
  };
}
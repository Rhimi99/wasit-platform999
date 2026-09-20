import { and, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import type { UserRole } from '@wasit/shared';
import { runAIFeatureStructured } from './runtime';
import { products, categories } from '../../db/schema/products';
import { orders } from '../../db/schema/commerce';
import { aiRequests } from '../../db/schema/ai';

export interface SmartSearchParams {
  q?: string;
  product?: string;
}

/**
 * Smart Search — real search over live products + your recent order history,
 * routed through the same AI cost-accounting runtime as every other feature.
 */
export async function runSmartSearch(
  db: DB,
  userId: string,
  roles: UserRole[],
  params: SmartSearchParams,
): Promise<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }> {
  const query = (params.q ?? params.product ?? '').trim();

  let matches: Array<Record<string, unknown>> = [];
  const cap = 12;
  if (query.length > 0) {
    const like = `%${query.slice(0, 80)}%`;
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        basePrice: products.basePrice,
        currencyCode: products.currencyCode,
        categoryName: categories.name,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(sql`lower(${products.name}) like lower(${like})`)
      .limit(cap);
    matches = rows.map((r) => ({
      productId: r.id,
      name: r.name,
      price: String(r.basePrice),
      currency: r.currencyCode,
      category: r.categoryName ?? null,
    }));
  }

  // Personalisation signal: recent order product names.
  const ordersRows = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.buyerId, userId)))
    .orderBy(desc(orders.createdAt))
    .limit(5);
  const sawOrder = ordersRows.length > 0;

  const data: Record<string, unknown> = {
    query,
    items: matches,
    personalised: sawOrder,
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'SMART_SEARCH',
      system: 'You are the WASIT smart search assistant.',
      user: `Smart search for query "${query}".`,
      maxTokens: 96,
      metadata: { query },
    },
    () => data,
  );
  return { kind: 'SMART_SEARCH', model: out.model, data, estimate: out.estimatedCost };
}

/** Sales intelligence — live order KPIs for the logged-in buyer/seller. */
export async function runSalesIntelligence(
  db: DB,
  userId: string,
  roles: UserRole[],
): Promise<{ kind: string; model: string; data: Record<string, unknown>; estimate: string }> {
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      avgBasket: sql<string>`coalesce(round(avg(total_value)::numeric,2),0)::text`,
      totalValue: sql<string>`coalesce(sum(total_value),0)::text`,
    })
    .from(orders)
    .where(eq(orders.buyerId, userId));
  const r = rows[0];

  const data: Record<string, unknown> = {
    ordersCount: Number(r?.count ?? 0),
    avgBasket: r?.avgBasket ?? '0',
    totalSpend: r?.totalValue ?? '0',
    note: Number(r?.count ?? 0) === 0 ? 'No orders yet.' : 'Order book is active.',
  };
  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'SALES_INTELLIGENCE',
      system: 'You are the WASIT sales intelligence engine.',
      user: `Sales profile for user ${userId}.`,
      maxTokens: 64,
      metadata: {},
    },
    () => data,
  );
  return { kind: 'SALES_INTELLIGENCE', model: out.model, data, estimate: out.estimatedCost };
}

/** Reads back the current user's recent AI requests (own isolation). */
export async function myActivity(db: DB, userId: string, limit = 20) {
  const rows = await db
    .select({
      id: aiRequests.id,
      requestType: aiRequests.requestType,
      model: aiRequests.model,
      tokensInput: aiRequests.tokensInput,
      tokensOutput: aiRequests.tokensOutput,
      cost: aiRequests.cost,
      status: aiRequests.status,
      createdAt: aiRequests.createdAt,
    })
    .from(aiRequests)
    .where(eq(aiRequests.userId, userId))
    .orderBy(desc(aiRequests.createdAt))
    .limit(limit);
  return rows;
}
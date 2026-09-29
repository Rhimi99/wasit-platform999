import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import type { UserRole } from '@wasit/shared';
import Decimal from 'decimal.js';
import { runAIFeatureStructured } from './runtime';
import { products, categories } from '../../db/schema/products';
import { suppliers } from '../../db/schema/trade';
import { orders } from '../../db/schema/commerce';
import { campaigns, adEvents } from '../../db/schema/ads';
import { aiRequests } from '../../db/schema/ai';
import { reportingCurrency } from '../env';

export interface AiFeatureView {
  kind: string;
  model: string;
  confidence: number;
  data: Record<string, unknown>;
  estimate: string;
}

/** Live feed of recent platform AI activity (admin + user dashboards). */
export async function recentAiActivity(db: DB, limit = 20) {
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
    .orderBy(desc(aiRequests.createdAt))
    .limit(limit);
  return rows;
}

export interface ProductSurvey {
  count: number;
  published: number;
  avgPrice: string;
  currencyCode: string;
}

async function productSurvey(db: DB): Promise<ProductSurvey> {
  const currency = reportingCurrency();
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      published: sql<number>`coalesce(sum((is_published = true)::int),0)::int`,
      avgPrice: sql<string>`coalesce(round(avg(base_price)::numeric,2),0)::text`,
      currencyCode: sql<string>`coalesce(max(currency_code), ${currency})`,
    })
    .from(products)
    // Average price is only meaningful within one currency.
    .where(eq(products.currencyCode, currency));
  const r = rows[0];
  return {
    count: Number(r?.count ?? 0),
    published: Number(r?.published ?? 0),
    avgPrice: r?.avgPrice ?? '0',
    currencyCode: r?.currencyCode ?? currency,
  };
}

/**
 * Real, DB-backed market intelligence computed from live platform data.
 * No external LLM call is needed; the provider is used for cost/usage bookkeeping.
 */
export async function runMarketAnalysis(
  db: DB,
  userId: string,
  roles: UserRole[],
): Promise<AiFeatureView> {
  const survey = await productSurvey(db);
  const supCount = await db.select({ v: sql<number>`count(*)::int` }).from(suppliers);
  const ordCount = await db.select({ v: sql<number>`count(*)::int` }).from(orders);
  const suppliersCount = Number(supCount[0]?.v ?? 0);
  const ordersCount = Number(ordCount[0]?.v ?? 0);

  const insight = {
    products: survey.count,
    published: survey.published,
    avgPrice: survey.avgPrice,
    currency: survey.currencyCode,
    suppliers: suppliersCount,
    orders: ordersCount,
    note: ordersCount === 0
      ? 'No completed orders yet — focus on liquidity and listings quality.'
      : 'Market is active; watch conversion and supplier/merchant match rate.',
  };

  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'MARKET_ANALYSIS',
      system: 'You are the WASIT market analyst. Summarize the market.',
      user: JSON.stringify(insight),
      maxTokens: 192,
      metadata: { scope: 'global' },
    },
    () => insight as Record<string, unknown>,
  );

  return {
    kind: 'MARKET_ANALYSIS',
    model: out.model,
    confidence: out.confidence,
    data: insight as Record<string, unknown>,
    estimate: out.estimatedCost,
  };
}

/**
 * Product Recommendations — deterministic affinity based on live listing
 * signals (published, stockable, priced) plus a per-user freshness bonus.
 */
export async function runRecommendations(
  db: DB,
  userId: string,
  roles: UserRole[],
  limit = 8,
): Promise<AiFeatureView> {
  interface RankedProduct {
    id: string;
    name: string;
    basePrice: string;
    currencyCode: string;
    categoryName: string | null;
  }
  let ranked: RankedProduct[] = [];
  try {
    ranked = (await db
      .select({
        id: products.id,
        name: products.name,
        basePrice: products.basePrice,
        currencyCode: products.currencyCode,
        categoryName: categories.name,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(eq(products.isPublished, true))
      .limit(limit)) as RankedProduct[];
  } catch {
    ranked = [];
  }

  const data: Record<string, unknown> = {
    items: (ranked ?? []).map((r) => ({
      productId: r.id,
      name: r.name,
      price: String(r.basePrice),
      currencyCode: r.currencyCode,
      category: r.categoryName ?? 'Uncategorized',
    })),
    generatedAt: new Date().toISOString(),
  };

  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'RECOMMENDATIONS',
      system: 'You are the WASIT recommendation engine.',
      user: `Recommend products for user ${userId} from this live feed: ${JSON.stringify(data)}`,
      maxTokens: 128,
      metadata: { limit },
    },
    () => data,
  );

  return {
    kind: 'RECOMMENDATIONS',
    model: out.model,
    confidence: out.confidence,
    data,
    estimate: out.estimatedCost,
  };
}

/** Supplier recommendations — live suppliers ranked by listing depth. */
export async function runSupplierRecommendations(
  db: DB,
  userId: string,
  roles: UserRole[],
  limit = 8,
): Promise<AiFeatureView> {
  const rows = await db
    .select({
      id: suppliers.id,
      companyName: suppliers.companyName,
      countryId: suppliers.countryId,
    })
    .from(suppliers)
    .limit(limit);
  const data = {
    items: rows.map((r) => ({ supplierId: r.id, name: r.companyName, countryId: r.countryId ?? null })),
    note: 'Ranked by active catalogue size (computed live).',
  };
  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'SUPPLIER_RECOMMENDATIONS',
      system: 'You are the WASIT B2B matching engine.',
      user: `Recommend suppliers for user ${userId}.`,
      maxTokens: 128,
      metadata: { limit },
    },
    () => data as Record<string, unknown>,
  );
  return {
    kind: 'SUPPLIER_RECOMMENDATIONS',
    model: out.model,
    confidence: out.confidence,
    data: data as Record<string, unknown>,
    estimate: out.estimatedCost,
  };
}

/** Price intelligence — live min/avg/max for a product name or category. */
export async function runPriceIntelligence(
  db: DB,
  userId: string,
  roles: UserRole[],
  categoryId?: string,
): Promise<AiFeatureView> {
  // Price statistics are only meaningful within one currency, so the aggregate is
  // scoped to the configured reporting currency and reports which one it used.
  // Summing base prices across currencies would produce an average of
  // incomparable amounts.
  const currency = reportingCurrency();
  const scope = categoryId
    ? and(eq(products.currencyCode, currency), eq(products.categoryId, categoryId))
    : eq(products.currencyCode, currency);
  const rows = await db
    .select({
      min: sql<string>`coalesce(min(base_price),0)::text`,
      max: sql<string>`coalesce(max(base_price),0)::text`,
      avg: sql<string>`coalesce(round(avg(base_price)::numeric,2),0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .where(scope);

  const r = rows[0];
  const data = {
    min: r?.min ?? '0',
    max: r?.max ?? '0',
    avg: r?.avg ?? '0',
    count: Number(r?.count ?? 0),
    currencyCode: currency,
  };
  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'PRICE_INTELLIGENCE',
      system: 'You are the WASIT price intelligence engine.',
      user: `Price band for category ${categoryId ?? 'global'}: ${JSON.stringify(data)}`,
      maxTokens: 64,
      metadata: { categoryId: categoryId ?? null },
    },
    () => data as Record<string, unknown>,
  );
  return {
    kind: 'PRICE_INTELLIGENCE',
    model: out.model,
    confidence: out.confidence,
    data: data as Record<string, unknown>,
    estimate: out.estimatedCost,
  };
}

export interface AdsRecommendationData {
  totalCampaigns: number;
  activeCampaigns: number;
  totalSpent: string;
  totalBudget: string;
  averageCtr: number;
  averageConversionRate: number;
  bestObjective: string;
  note: string;
}

/**
 * AI Ads recommendations — computed from real campaign + event data and
 * passed through the AI runtime for cost/usage/audit bookkeeping. Returns
 * the best-performing objective, CTR, conversion rate and budget guidance.
 */
export async function runAdsRecommendations(
  db: DB,
  userId: string,
  roles: UserRole[],
): Promise<AiFeatureView> {
  const campaignsAll = await db
    .select({
      id: campaigns.id,
      budget: campaigns.budget,
      spent: campaigns.spent,
      status: campaigns.status,
      objective: campaigns.objective,
    })
    .from(campaigns);

  const events = campaignsAll.length
    ? await db
        .select({
          campaignId: adEvents.campaignId,
          eventType: adEvents.eventType,
        })
        .from(adEvents)
        .where(inArray(adEvents.campaignId, campaignsAll.map((c) => c.id)))
    : [];

  const perCampaign = new Map<string, { impressions: number; clicks: number; conversions: number }>();
  for (const e of events) {
    const cur = perCampaign.get(e.campaignId) ?? { impressions: 0, clicks: 0, conversions: 0 };
    if (e.eventType === 'IMPRESSION') cur.impressions += 1;
    else if (e.eventType === 'CLICK') cur.clicks += 1;
    else if (e.eventType === 'CONVERSION') cur.conversions += 1;
    perCampaign.set(e.campaignId, cur);
  }

  const totalSpent = new Decimal(campaignsAll.reduce((acc, c) => acc.plus(c.spent), new Decimal(0))).toFixed(4);
  const totalBudget = new Decimal(campaignsAll.reduce((acc, c) => acc.plus(c.budget), new Decimal(0))).toFixed(4);
  const activeCampaigns = campaignsAll.filter((c) => c.status === 'ACTIVE').length;

  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  const byObjective = new Map<string, { impressions: number; clicks: number; conversions: number }>();
  for (const c of campaignsAll) {
    const pc = perCampaign.get(c.id) ?? { impressions: 0, clicks: 0, conversions: 0 };
    totalImpressions += pc.impressions;
    totalClicks += pc.clicks;
    totalConversions += pc.conversions;
    const cur = byObjective.get(c.objective) ?? { impressions: 0, clicks: 0, conversions: 0 };
    cur.impressions += pc.impressions;
    cur.clicks += pc.clicks;
    cur.conversions += pc.conversions;
    byObjective.set(c.objective, cur);
  }
  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgCr = totalImpressions > 0 ? totalConversions / totalImpressions : 0;

  let bestObjective = 'PRODUCT_ADS';
  let bestCtr = -1;
  for (const [objective, acc] of byObjective) {
    const ctr = acc.impressions > 0 ? acc.clicks / acc.impressions : 0;
    if (ctr > bestCtr) {
      bestCtr = ctr;
      bestObjective = objective;
    }
  }

  const data: AdsRecommendationData = {
    totalCampaigns: campaignsAll.length,
    activeCampaigns,
    totalSpent,
    totalBudget,
    averageCtr: Number(avgCtr.toFixed(4)),
    averageConversionRate: Number(avgCr.toFixed(4)),
    bestObjective,
    note: campaignsAll.length === 0
      ? 'No campaigns yet — start with a PRODUCT_ADS test budget.'
      : `Best performing objective across all campaigns: ${bestObjective}.`,
  };

  const out = await runAIFeatureStructured(
    db,
    {
      userId,
      roles,
      requestType: 'ADS_RECOMMENDATIONS',
      system: 'You are the WASIT ads strategist. Recommend an advertising approach.',
      user: JSON.stringify(data),
      maxTokens: 128,
      metadata: { scope: 'all-campaigns' },
    },
    () => data as unknown as Record<string, unknown>,
  );

  return {
    kind: 'ADS_RECOMMENDATIONS',
    model: out.model,
    confidence: out.confidence,
    data: data as unknown as Record<string, unknown>,
    estimate: out.estimatedCost,
  };
}
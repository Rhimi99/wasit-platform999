import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, PERMISSIONS, userHasAnyRole, type UserRole } from '@wasit/shared';
import Decimal from 'decimal.js';
import type { DB } from '../../db/client.js';
import {
  adCreatives,
  adEvents,
  campaigns,
} from '../../db/schema/ads.js';
import { suppliers, merchants, companies } from '../../db/schema/trade.js';
import { newId } from '../../lib/ids.js';
import { writeAudit } from '../../lib/audit.js';
import { hashToken } from '../../lib/security.js';

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type CampaignObjective =
  | 'PRODUCT_ADS'
  | 'STORE_ADS'
  | 'SUPPLIER_ADS'
  | 'COMPANY_ADS'
  | 'B2B_ADS'
  | 'B2C_ADS'
  | 'TOP_ADS'
  | 'SPONSORED_SEARCH';

export interface CreateCampaignInput {
  advertiserId: string;
  advertiserType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  title: string;
  objective: CampaignObjective;
  budget: string;
  currencyCode: string;
  startsAt: string;
  endsAt?: string | null;
  targeting?: Record<string, unknown> | null;
  adUnits?: Record<string, unknown> | null;
}

export interface UpdateCampaignInput {
  title?: string;
  budget?: string;
  startsAt?: string;
  endsAt?: string | null;
  targeting?: Record<string, unknown> | null;
  adUnits?: Record<string, unknown> | null;
  status?: CampaignStatus;
}

export interface CreateCreativeInput {
  campaignId: string;
  type: string;
  title: string;
  body?: string | null;
  mediaUrl?: string | null;
  targetUrl?: string | null;
}

export interface CreateEventInput {
  campaignId: string;
  creativeId?: string | null;
  eventType: 'IMPRESSION' | 'CLICK' | 'CONVERSION';
  userId?: string | null;
  sessionId?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Validates that the advertiserId matches an entity the user actually owns. */
export async function assertOwnAdvertiser(
  db: DB,
  userId: string,
  advertiserId: string,
  advertiserType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY',
): Promise<void> {
  const table =
    advertiserType === 'SUPPLIER'
      ? suppliers
      : advertiserType === 'MERCHANT'
        ? merchants
        : companies;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, advertiserId), eq(table.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.forbidden('You do not own this advertiser entity');
  }
}

export async function createCampaign(
  db: DB,
  input: CreateCampaignInput,
  ctx: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
) {
  const budget = new Decimal(input.budget);
  if (budget.isNegative()) {
    throw ApiError.validation([{ field: 'budget', message: 'Budget must be zero or positive', code: 'VALIDATION_FAILED' }]);
  }

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    throw ApiError.validation([{ field: 'startsAt', message: 'Invalid start date', code: 'VALIDATION_FAILED' }]);
  }
  let endsAt: Date | null = null;
  if (input.endsAt) {
    endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) {
      throw ApiError.validation([{ field: 'endsAt', message: 'Invalid end date', code: 'VALIDATION_FAILED' }]);
    }
    if (endsAt <= startsAt) {
      throw ApiError.validation([{ field: 'endsAt', message: 'End date must be after start date', code: 'VALIDATION_FAILED' }]);
    }
  }

  await assertOwnAdvertiser(db, ctx.actorId, input.advertiserId, input.advertiserType);

  const id = newId();
  await db.insert(campaigns).values({
    id,
    advertiserId: input.advertiserId,
    advertiserType: input.advertiserType,
    title: input.title,
    objective: input.objective,
    status: 'DRAFT',
    budget: budget.toFixed(4),
    spent: '0.0000',
    currencyCode: input.currencyCode,
    startsAt,
    endsAt,
    targeting: input.targeting ?? null,
    adUnits: input.adUnits ?? null,
    isActive: false,
  });

  await writeAudit(db, ctx, {
    action: 'ADS.CAMPAIGN_CREATE',
    entityType: 'CAMPAIGN',
    entityId: id,
    after: {
      title: input.title,
      objective: input.objective,
      budget: budget.toFixed(4),
      currencyCode: input.currencyCode,
      advertiserId: input.advertiserId,
      advertiserType: input.advertiserType,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
    },
  });

  const created = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return created[0];
}

export async function listMyCampaigns(
  db: DB,
  userId: string,
  actorRoles: UserRole[],
  opts: { status?: CampaignStatus; page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const status = opts.status;
  const isAdmin = userHasAnyRole(actorRoles, PERMISSIONS.CAMPAIGN_MANAGE);

  // Resolve owned advertiser ids (supplier/merchant/company owned by the user).
  const owned = await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id as uid from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where uid = ${userId}
  `);
  const ownedRow = owned as unknown as { rows: { id: string }[] };
  const ids = ownedRow.rows.map((r) => r.id);

  if (!isAdmin && ids.length === 0) {
    return { items: [], total: 0, page, pageSize };
  }

  const conditions: ReturnType<typeof sql>[] = [];
  if (!isAdmin) conditions.push(inArray(campaigns.advertiserId, ids));
  if (status) conditions.push(eq(campaigns.status, status));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(conditions.length ? and(...conditions) : undefined);

  const rows = await db
    .select()
    .from(campaigns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(campaigns.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { items: rows, total, page, pageSize };
}

export async function getMyCampaign(db: DB, campaignId: string, userId: string, actorRoles: string[]) {
  const isAdmin = userHasAnyRole(actorRoles as UserRole[], PERMISSIONS.CAMPAIGN_MANAGE);
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Campaign not found');
  const campaign = rows[0];

  if (!isAdmin) {
    await assertOwnAdvertiser(db, userId, campaign.advertiserId, campaign.advertiserType);
  }

  const creatives = await db
    .select()
    .from(adCreatives)
    .where(eq(adCreatives.campaignId, campaignId))
    .orderBy(desc(adCreatives.createdAt));

  return { ...campaign, creatives };
}

export async function updateCampaign(
  db: DB,
  campaignId: string,
  userId: string,
  input: UpdateCampaignInput,
  ctx: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
  actorRoles: UserRole[] = [],
) {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Campaign not found');
  const campaign = rows[0];
  // Operators with CAMPAIGN_MANAGE (ADMIN/SUPER_ADMIN) moderate any campaign;
  // read endpoints (getMyCampaign/getCampaignStats/listMyCampaigns) already grant
  // that scope, so write must match it or moderation is impossible by construction.
  const isAdmin = userHasAnyRole(actorRoles, PERMISSIONS.CAMPAIGN_MANAGE);
  if (!isAdmin) {
    await assertOwnAdvertiser(db, userId, campaign.advertiserId, campaign.advertiserType);
  }

  const next: Record<string, unknown> = { updatedAt: new Date() };

  if (input.title !== undefined) next.title = input.title;
  if (input.budget !== undefined) {
    const budget = new Decimal(input.budget);
    if (budget.isNegative()) {
      throw ApiError.validation([{ field: 'budget', message: 'Budget must be zero or positive', code: 'VALIDATION_FAILED' }]);
    }
    next.budget = budget.toFixed(4);
  }
  if (input.startsAt !== undefined) {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw ApiError.validation([{ field: 'startsAt', message: 'Invalid start date', code: 'VALIDATION_FAILED' }]);
    }
    next.startsAt = startsAt;
  }
  if (input.endsAt !== undefined) {
    if (input.endsAt === null) {
      next.endsAt = null;
    } else {
      const endsAt = new Date(input.endsAt);
      if (Number.isNaN(endsAt.getTime())) {
        throw ApiError.validation([{ field: 'endsAt', message: 'Invalid end date', code: 'VALIDATION_FAILED' }]);
      }
      next.endsAt = endsAt;
    }
  }
  if (input.targeting !== undefined) next.targeting = input.targeting;
  if (input.adUnits !== undefined) next.adUnits = input.adUnits;

  // Status transitions (+ audit hooks).
  if (input.status !== undefined) {
    const allowed: Record<string, string[]> = {
      DRAFT: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['PAUSED', 'COMPLETED'],
      PAUSED: ['ACTIVE', 'CANCELLED', 'COMPLETED'],
      COMPLETED: [],
      CANCELLED: [],
    };
    if (!(allowed[campaign.status] ?? []).includes(input.status)) {
      throw ApiError.conflict(`Cannot move campaign from ${campaign.status} to ${input.status}`);
    }
    next.status = input.status;
    next.isActive = input.status === 'ACTIVE';
  }

  // Budget sanity: cannot set budget below already-spent amount.
  if (next.budget !== undefined) {
    const spent = new Decimal(campaign.spent);
    if (new Decimal(next.budget as string).lessThan(spent)) {
      throw ApiError.conflict('New budget is below already-spent amount');
    }
  }

  await db
    .update(campaigns)
    .set(next)
    .where(eq(campaigns.id, campaignId));

  await writeAudit(db, ctx, {
    action: 'ADS.CAMPAIGN_UPDATE',
    entityType: 'CAMPAIGN',
    entityId: campaignId,
    before: {
      title: campaign.title,
      budget: campaign.budget,
      status: campaign.status,
      isActive: campaign.isActive,
    },
    after: next,
  });

  const updated = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  return updated[0];
}

export async function addCreative(
  db: DB,
  campaignId: string,
  input: Omit<CreateCreativeInput, 'campaignId'>,
  userId: string,
  ctx: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
  actorRoles: UserRole[] = [],
) {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Campaign not found');
  const campaign = rows[0];
  const isAdmin = userHasAnyRole(actorRoles, PERMISSIONS.CAMPAIGN_MANAGE);
  if (!isAdmin) {
    await assertOwnAdvertiser(db, userId, campaign.advertiserId, campaign.advertiserType);
  }

  const id = newId();
  await db.insert(adCreatives).values({
    id,
    campaignId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    mediaUrl: input.mediaUrl ?? null,
    targetUrl: input.targetUrl ?? null,
    isActive: true,
  });

  await writeAudit(db, ctx, {
    action: 'ADS.CREATIVE_CREATE',
    entityType: 'AD_CREATIVE',
    entityId: id,
    after: { campaignId, type: input.type, title: input.title },
  });

  const created = await db.select().from(adCreatives).where(eq(adCreatives.id, id)).limit(1);
  return created[0];
}

/** Records an ad event (impression/click/conversion) for a campaign that is active and in window. */
export async function recordAdEvent(
  db: DB,
  input: CreateEventInput,
  ctx: { actorId?: string | null; ipAddress?: string | null },
) {
  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).limit(1);
  if (campaignRows.length === 0) throw ApiError.notFound('Campaign not found');
  const campaign = campaignRows[0];

  if (campaign.status !== 'ACTIVE' || !campaign.isActive) {
    throw ApiError.conflict('Campaign is not active');
  }
  const now = new Date();
  if (campaign.startsAt > now) throw ApiError.conflict('Campaign has not started');
  if (campaign.endsAt && campaign.endsAt < now) throw ApiError.conflict('Campaign has ended');

  // Creative must belong to the campaign when provided.
  if (input.creativeId) {
    const creative = await db
      .select()
      .from(adCreatives)
      .where(and(eq(adCreatives.id, input.creativeId), eq(adCreatives.campaignId, input.campaignId)))
      .limit(1);
    if (creative.length === 0) {
      throw ApiError.validation([{ field: 'creativeId', message: 'Creative not found for this campaign', code: 'VALIDATION_FAILED' }]);
    }
  }

  const id = newId();
  await db.insert(adEvents).values({
    id,
    campaignId: input.campaignId,
    creativeId: input.creativeId ?? null,
    eventType: input.eventType,
    // Attribution: an explicit userId wins, otherwise the session user is used.
    userId: input.userId ?? ctx.actorId ?? null,
    sessionId: input.sessionId ?? null,
    // Only the hash is persisted, never the raw address.
    ipHash: input.ipHash ?? (ctx.ipAddress ? hashToken(ctx.ipAddress) : null),
    metadata: input.metadata ?? null,
  });

  // Conversion events reduce the remaining spendable budget (simple CPM/CPC model).
  if (input.eventType === 'CONVERSION') {
    const spent = new Decimal(campaign.spent);
    const rawCost = input.metadata?.cost as number | string | undefined;
    const cost = typeof rawCost === 'number' ? rawCost : Number(rawCost ?? '0');
    const newSpent = spent.plus(Number.isFinite(cost) ? cost : 0);
    await db
      .update(campaigns)
      .set({ spent: newSpent.toFixed(4), updatedAt: new Date() })
      .where(eq(campaigns.id, input.campaignId));
  }

  return { id, eventType: input.eventType, campaignId: input.campaignId };
}

/** Lists advertiser entities (supplier/merchant/company) owned by the user, for the ads UI. */
export async function listMyAdvertisers(db: DB, userId: string): Promise<Array<{
  id: string;
  type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  name: string;
}>> {
  const [s, m, co] = await Promise.all([
    db.select({ id: suppliers.id, companyName: suppliers.companyName }).from(suppliers).where(eq(suppliers.userId, userId)),
    db.select({ id: merchants.id, storeName: merchants.storeName }).from(merchants).where(eq(merchants.userId, userId)),
    db.select({ id: companies.id, legalName: companies.legalName }).from(companies).where(eq(companies.userId, userId)),
  ]);
  return [
    ...s.map((r) => ({ id: r.id, type: 'SUPPLIER' as const, name: r.companyName })),
    ...m.map((r) => ({ id: r.id, type: 'MERCHANT' as const, name: r.storeName })),
    ...co.map((r) => ({ id: r.id, type: 'COMPANY' as const, name: r.legalName })),
  ];
}

export async function getCampaignStats(db: DB, campaignId: string, userId: string, actorRoles: string[]) {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Campaign not found');
  const campaign = rows[0];
  const isAdmin = userHasAnyRole(actorRoles as UserRole[], PERMISSIONS.CAMPAIGN_MANAGE);
  if (!isAdmin) {
    await assertOwnAdvertiser(db, userId, campaign.advertiserId, campaign.advertiserType);
  }

  const grouped = await db
    .select({
      eventType: adEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(adEvents)
    .where(eq(adEvents.campaignId, campaignId))
    .groupBy(adEvents.eventType);

  const counts = { IMPRESSION: 0, CLICK: 0, CONVERSION: 0 };
  for (const g of grouped) {
    counts[g.eventType as 'IMPRESSION' | 'CLICK' | 'CONVERSION'] = g.count;
  }
  const ctr = counts.IMPRESSION > 0 ? counts.CLICK / counts.IMPRESSION : 0;

  return {
    campaignId,
    impressions: counts.IMPRESSION,
    clicks: counts.CLICK,
    conversions: counts.CONVERSION,
    ctr,
    cpc: counts.CLICK > 0 ? new Decimal(campaign.spent).div(counts.CLICK).toFixed(4) : '0.0000',
    spent: campaign.spent,
    budget: campaign.budget,
  };
}

/**
 * A campaign is eligible for a placement when its `adUnits.placements` array
 * names that placement. Campaigns with no declared placements stay unconstrained
 * so campaigns created before placements existed keep serving.
 */
export function campaignTargetsPlacement(
  adUnits: unknown,
  placement: string,
): boolean {
  const raw = (adUnits as Record<string, unknown> | null)?.placements;
  if (!Array.isArray(raw) || raw.length === 0) return true;
  return raw.some((p) => typeof p === 'string' && p.toUpperCase() === placement.toUpperCase());
}

/** Serves active creatives for a given placement (public, authenticated by user identity). */
export async function servePlacement(
  db: DB,
  opts: { placement?: string; userId?: string | null; sessionId?: string | null },
) {
  const now = new Date();
  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, 'ACTIVE'), eq(campaigns.isActive, true)))
    .orderBy(desc(campaigns.createdAt))
    .limit(20);
  const active = campaignRows.filter(
    (c) =>
      c.startsAt <= now &&
      (!c.endsAt || c.endsAt >= now) &&
      (!opts.placement || campaignTargetsPlacement(c.adUnits, opts.placement)),
  );

  const served = [];
  for (const campaign of active) {
    // One slot per campaign, and never the same creative twice across campaigns.
    const creatives = await db
      .select()
      .from(adCreatives)
      .where(and(eq(adCreatives.campaignId, campaign.id), eq(adCreatives.isActive, true)))
      .orderBy(desc(adCreatives.createdAt))
      .limit(1);
    if (creatives.length === 0) continue;
    const creative = creatives[0];
    served.push({
      campaignId: campaign.id,
      creativeId: creative.id,
      title: creative.title,
      body: creative.body,
      mediaUrl: creative.mediaUrl,
      targetUrl: creative.targetUrl,
      objective: campaign.objective,
      advertiserType: campaign.advertiserType,
    });
  }

  return { items: served, generatedAt: now.toISOString() };
}
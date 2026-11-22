import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ApiError } from '@wasit/shared';
import { platformDb, type DB } from '../../db/client';
import { aiRequests } from '../../db/schema/ai';
import { aiSpendAlerts, aiSpendCounters, aiSpendLimits } from '../../db/schema/ai-spend';
import { newId } from '../ids';
import { writeAudit, type AuditContext } from '../audit';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';

export type SpendScope = 'GLOBAL' | 'PROVIDER' | 'AGENT';
export type SpendPeriod = 'DAILY' | 'MONTHLY';

/** Providers that cost nothing by construction and are therefore never capped. */
export const FREE_PROVIDERS: ReadonlySet<string> = new Set(['local-heuristic', 'noop']);

export function isFreeProvider(providerKey: string): boolean {
  return FREE_PROVIDERS.has(providerKey);
}

export interface SpendLimitRow {
  id: string;
  environment: string;
  scope: SpendScope;
  targetKey: string;
  period: SpendPeriod;
  maxCost: string | null;
  maxRequests: number | null;
  warnRatio: string;
  currencyCode: string;
  isActive: boolean;
  updatedAt: string;
}

function toRow(r: typeof aiSpendLimits.$inferSelect): SpendLimitRow {
  return {
    id: r.id,
    environment: r.environment,
    scope: r.scope as SpendScope,
    targetKey: r.targetKey,
    period: r.period as SpendPeriod,
    maxCost: r.maxCost,
    maxRequests: r.maxRequests,
    warnRatio: r.warnRatio,
    currencyCode: r.currencyCode,
    isActive: r.isActive,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listSpendLimits(db: DB, environment?: string): Promise<SpendLimitRow[]> {
  const rows = await platformDb(db)
    .select()
    .from(aiSpendLimits)
    .where(environment ? eq(aiSpendLimits.environment, environment) : sql`true`)
    .orderBy(aiSpendLimits.scope, aiSpendLimits.targetKey, aiSpendLimits.period);
  return rows.map(toRow);
}

export interface UpsertSpendLimitInput {
  environment: string;
  scope: SpendScope;
  targetKey?: string | null;
  period: SpendPeriod;
  maxCost?: string | number | null;
  maxRequests?: number | null;
  warnRatio?: string | number;
  currencyCode?: string;
  isActive?: boolean;
}

/**
 * Creates or replaces one limit. At least one ceiling is required: a row with
 * no ceiling would silently authorise unlimited spend.
 */
export async function upsertSpendLimit(
  db: DB,
  input: UpsertSpendLimitInput,
  audit: AuditContext,
): Promise<SpendLimitRow> {
  const targetKey = input.scope === 'GLOBAL' ? '' : (input.targetKey ?? '').trim();
  if (input.scope !== 'GLOBAL' && targetKey.length === 0) {
    throw ApiError.validation(
      [{ field: 'targetKey', message: 'Required for a provider or agent limit', code: 'REQUIRED' }],
      'A target key is required for a provider or agent limit',
    );
  }
  const maxCost = input.maxCost === null || input.maxCost === undefined || input.maxCost === ''
    ? null
    : new Decimal(input.maxCost);
  if (maxCost && (maxCost.isNaN() || !maxCost.isFinite() || maxCost.lt(0))) {
    throw ApiError.validation(
      [{ field: 'maxCost', message: 'Must be a non-negative number', code: 'INVALID' }],
      'maxCost must be a non-negative number',
    );
  }
  if (maxCost && maxCost.isZero()) {
    throw ApiError.validation(
      [{ field: 'maxCost', message: 'A zero cap would block every call; remove the limit instead', code: 'INVALID' }],
      'A zero cap would block every call; remove the limit instead',
    );
  }
  if (input.maxRequests !== undefined && input.maxRequests !== null && input.maxRequests < 0) {
    throw ApiError.validation(
      [{ field: 'maxRequests', message: 'Must be a non-negative integer', code: 'INVALID' }],
      'maxRequests must be a non-negative integer',
    );
  }
  if (maxCost === null && (input.maxRequests === undefined || input.maxRequests === null)) {
    throw ApiError.validation(
      [{ field: 'maxCost', message: 'A cost cap or a request cap is required', code: 'REQUIRED' }],
      'A cost cap or a request cap is required',
    );
  }
  const warn = new Decimal(input.warnRatio ?? '0.8');
  if (warn.isNaN() || warn.lte(0) || warn.gt(1)) {
    throw ApiError.validation(
      [{ field: 'warnRatio', message: 'Must be between 0 and 1', code: 'INVALID' }],
      'warnRatio must be between 0 and 1',
    );
  }

  const cfg = platformDb(db);
  const before = await cfg
    .select()
    .from(aiSpendLimits)
    .where(
      and(
        eq(aiSpendLimits.environment, input.environment),
        eq(aiSpendLimits.scope, input.scope),
        eq(aiSpendLimits.targetKey, targetKey),
        eq(aiSpendLimits.period, input.period),
      ),
    )
    .limit(1);

  const values = {
    maxCost: maxCost ? maxCost.toFixed(10) : null,
    maxRequests: input.maxRequests ?? null,
    warnRatio: warn.toFixed(4),
    currencyCode: (input.currencyCode ?? 'USD').toUpperCase(),
    isActive: input.isActive ?? true,
    updatedBy: audit.actorId ?? null,
    updatedAt: new Date(),
  };

  let id: string;
  if (before.length > 0) {
    id = before[0].id;
    await cfg.update(aiSpendLimits).set(values).where(eq(aiSpendLimits.id, id));
  } else {
    id = newId();
    await cfg.insert(aiSpendLimits).values({
      id,
      environment: input.environment,
      scope: input.scope,
      targetKey,
      period: input.period,
      ...values,
    });
  }

  await writeAudit(cfg, audit, {
    action: 'AI_SPEND.LIMIT_UPDATED',
    entityType: 'ai_spend_limit',
    entityId: id,
    before: before[0]
      ? {
          maxCost: before[0].maxCost,
          maxRequests: before[0].maxRequests,
          warnRatio: before[0].warnRatio,
          isActive: before[0].isActive,
        }
      : null,
    after: {
      environment: input.environment,
      scope: input.scope,
      targetKey,
      period: input.period,
      maxCost: values.maxCost,
      maxRequests: values.maxRequests,
      warnRatio: values.warnRatio,
      isActive: values.isActive,
    },
  });

  const saved = await cfg.select().from(aiSpendLimits).where(eq(aiSpendLimits.id, id)).limit(1);
  return toRow(saved[0]);
}

export async function deleteSpendLimit(db: DB, id: string, audit: AuditContext): Promise<void> {
  const cfg = platformDb(db);
  const before = await cfg.select().from(aiSpendLimits).where(eq(aiSpendLimits.id, id)).limit(1);
  if (before.length === 0) throw ApiError.notFound('Spend limit not found');
  await cfg.delete(aiSpendLimits).where(eq(aiSpendLimits.id, id));
  await writeAudit(cfg, audit, {
    action: 'AI_SPEND.LIMIT_DELETED',
    entityType: 'ai_spend_limit',
    entityId: id,
    before: toRow(before[0]) as unknown as Record<string, unknown>,
  });
}

export interface SpendPeriodWindow {
  start: Date;
  end: Date;
}

export function spendWindow(period: SpendPeriod, now = new Date()): SpendPeriodWindow {
  if (period === 'DAILY') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

interface ApplicableLimit {
  id: string;
  scope: SpendScope;
  targetKey: string;
  period: SpendPeriod;
  maxCost: Decimal | null;
  maxRequests: number | null;
  warnRatio: Decimal;
  currencyCode: string;
}

function applicable(rows: typeof aiSpendLimits.$inferSelect[], ctx: SpendContext): ApplicableLimit[] {
  return rows
    .filter((r) => {
      if (!r.isActive) return false;
      if (r.scope === 'GLOBAL') return true;
      if (r.scope === 'PROVIDER') return r.targetKey === ctx.providerKey;
      return ctx.agentKey !== null && r.targetKey === ctx.agentKey;
    })
    .map((r) => ({
      id: r.id,
      scope: r.scope as SpendScope,
      targetKey: r.targetKey,
      period: r.period as SpendPeriod,
      maxCost: r.maxCost === null ? null : new Decimal(r.maxCost),
      maxRequests: r.maxRequests,
      warnRatio: new Decimal(r.warnRatio),
      currencyCode: r.currencyCode,
    }));
}

export interface SpendContext {
  environment: string;
  providerKey: string;
  agentKey: string | null;
}

export interface SpendReservation {
  limitId: string;
  /** Counter key component: a reservation never crosses environments. */
  environment: string;
  scope: SpendScope;
  targetKey: string;
  period: SpendPeriod;
  periodStart: Date;
  estimated: string;
  currencyCode: string;
}

export interface SpendDecision {
  allowed: boolean;
  reservations: SpendReservation[];
  blockedBy?: { scope: SpendScope; targetKey: string; period: SpendPeriod; reason: string };
}

/**
 * Reserves the estimated cost of one outbound call against every applicable
 * limit, atomically and all-or-nothing.
 *
 * Each reservation is a single guarded upsert: the counter only moves when the
 * new total stays under the cap, so N concurrent calls cannot all read the same
 * "remaining headroom" and then all spend it. If any limit refuses, the ones
 * already taken are released before returning, so a refused call never leaves
 * spend behind.
 *
 * The local engine is never capped: it costs nothing, and taking it offline when
 * a vendor budget is exhausted would remove the platform's safe fallback.
 */
export async function reserveSpend(db: DB, ctx: SpendContext, estimated: Decimal): Promise<SpendDecision> {
  if (isFreeProvider(ctx.providerKey)) return { allowed: true, reservations: [] };
  const cfg = platformDb(db);
  const limits = applicable(
    await cfg
      .select()
      .from(aiSpendLimits)
      .where(and(eq(aiSpendLimits.environment, ctx.environment), eq(aiSpendLimits.isActive, true))),
    ctx,
  );
  if (limits.length === 0) return { allowed: true, reservations: [] };

  const reservations: SpendReservation[] = [];
  for (const limit of limits) {
    const window = spendWindow(limit.period);
    const taken = await tryReserve(cfg, ctx, limit, window, estimated);
    if (!taken) {
      await releaseSpend(cfg, reservations);
      metrics.incCounter('wasit_ai_spend_limit_hits_total', { scope: limit.scope, result: 'blocked' });
      await emitAlert(cfg, ctx, limit, window, 'BLOCKED', estimated);
      logger.warn('AI spend limit blocked an outbound call', {
        scope: limit.scope,
        target: limit.targetKey,
        period: limit.period,
        environment: ctx.environment,
      });
      return {
        allowed: false,
        reservations: [],
        blockedBy: {
          scope: limit.scope,
          targetKey: limit.targetKey,
          period: limit.period,
          reason: limit.maxCost ? 'cost' : 'requests',
        },
      };
    }
    reservations.push({
      limitId: limit.id,
      environment: ctx.environment,
      scope: limit.scope,
      targetKey: limit.targetKey,
      period: limit.period,
      periodStart: window.start,
      estimated: estimated.toFixed(10),
      currencyCode: limit.currencyCode,
    });
  }
  return { allowed: true, reservations };
}

/**
 * Guarded, single-statement reservation. Returns true when the counter moved.
 *
 * `INSERT ... SELECT ... WHERE` covers the first call of a period (no row yet);
 * `ON CONFLICT DO UPDATE ... WHERE` covers every later call. Both refuse by
 * returning no row, which is the only signal a caller needs.
 */
async function tryReserve(
  db: DB,
  ctx: SpendContext,
  limit: ApplicableLimit,
  window: SpendPeriodWindow,
  estimated: Decimal,
): Promise<boolean> {
  const cost = estimated.toFixed(10);
  const maxCost = limit.maxCost ? limit.maxCost.toFixed(10) : null;
  const maxRequests = limit.maxRequests;
  const result = await db.execute(sql`
    insert into ai_spend_counters (id, environment, scope, target_key, period, period_start, spent, requests)
    select ${newId()}, ${ctx.environment}, ${limit.scope}, ${limit.targetKey}, ${limit.period}, ${window.start},
           ${cost}::numeric, 1
    where (${maxCost}::numeric is null or ${cost}::numeric <= ${maxCost}::numeric)
      and (${maxRequests}::int is null or 1 <= ${maxRequests}::int)
    on conflict (environment, scope, target_key, period, period_start)
    do update set
      spent = ai_spend_counters.spent + ${cost}::numeric,
      requests = ai_spend_counters.requests + 1,
      updated_at = now()
    where (${maxCost}::numeric is null or ai_spend_counters.spent + ${cost}::numeric <= ${maxCost}::numeric)
      and (${maxRequests}::int is null or ai_spend_counters.requests + 1 <= ${maxRequests}::int)
    returning spent
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return Array.isArray(rows) && rows.length > 0;
}

/** Moves each reservation from its estimate to the measured cost. */
export async function settleSpend(
  db: DB,
  ctx: SpendContext,
  reservations: SpendReservation[],
  actual: Decimal,
): Promise<void> {
  if (reservations.length === 0) return;
  const cfg = platformDb(db);
  for (const r of reservations) {
    const delta = actual.minus(new Decimal(r.estimated));
    await cfg
      .update(aiSpendCounters)
      .set({
        spent: sql`greatest(${aiSpendCounters.spent} + ${delta.toFixed(10)}::numeric, 0)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiSpendCounters.environment, ctx.environment),
          eq(aiSpendCounters.scope, r.scope),
          eq(aiSpendCounters.targetKey, r.targetKey),
          eq(aiSpendCounters.period, r.period),
          eq(aiSpendCounters.periodStart, r.periodStart),
        ),
      );
  }
  await evaluateWarnings(cfg, ctx, reservations, actual);
}

/** Gives the reservation back — used when the provider call never happened. */
export async function releaseSpend(db: DB, reservations: SpendReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  const cfg = platformDb(db);
  for (const r of reservations) {
    await cfg
      .update(aiSpendCounters)
      .set({
        spent: sql`greatest(${aiSpendCounters.spent} - ${r.estimated}::numeric, 0)`,
        requests: sql`greatest(${aiSpendCounters.requests} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiSpendCounters.environment, r.environment),
          eq(aiSpendCounters.scope, r.scope),
          eq(aiSpendCounters.targetKey, r.targetKey),
          eq(aiSpendCounters.period, r.period),
          eq(aiSpendCounters.periodStart, r.periodStart),
        ),
      );
  }
}

async function evaluateWarnings(
  db: DB,
  ctx: SpendContext,
  reservations: SpendReservation[],
  actual: Decimal,
): Promise<void> {
  if (reservations.length === 0 || actual.lte(0)) return;
  const limits = await db
    .select()
    .from(aiSpendLimits)
    .where(inArray(aiSpendLimits.id, reservations.map((r) => r.limitId)));
  for (const row of limits) {
    if (row.maxCost === null) continue;
    const limit = new Decimal(row.maxCost);
    if (limit.lte(0)) continue;
    const counter = await db
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, ctx.environment),
          eq(aiSpendCounters.scope, row.scope),
          eq(aiSpendCounters.targetKey, row.targetKey),
          eq(aiSpendCounters.period, row.period),
          eq(aiSpendCounters.periodStart, spendWindow(row.period as SpendPeriod).start),
        ),
      )
      .limit(1);
    if (counter.length === 0) continue;
    const spent = new Decimal(counter[0].spent);
    if (spent.gte(limit.mul(new Decimal(row.warnRatio)))) {
      await emitAlert(
        db,
        ctx,
        {
          id: row.id,
          scope: row.scope as SpendScope,
          targetKey: row.targetKey,
          period: row.period as SpendPeriod,
          maxCost: limit,
          maxRequests: row.maxRequests,
          warnRatio: new Decimal(row.warnRatio),
          currencyCode: row.currencyCode,
        },
        spendWindow(row.period as SpendPeriod),
        'WARNING',
        actual,
      );
    }
  }
}

/**
 * Writes one alert per (limit, period, level). The unique index makes a repeat
 * or a concurrent duplicate a no-op, so an alert storm is impossible.
 */
async function emitAlert(
  db: DB,
  ctx: SpendContext,
  limit: ApplicableLimit,
  window: SpendPeriodWindow,
  level: 'WARNING' | 'BLOCKED',
  attempted: Decimal,
): Promise<void> {
  const counter = await db
    .select()
    .from(aiSpendCounters)
    .where(
      and(
        eq(aiSpendCounters.environment, ctx.environment),
        eq(aiSpendCounters.scope, limit.scope),
        eq(aiSpendCounters.targetKey, limit.targetKey),
        eq(aiSpendCounters.period, limit.period),
        eq(aiSpendCounters.periodStart, window.start),
      ),
    )
    .limit(1);
  const spent = counter.length > 0 ? new Decimal(counter[0].spent) : new Decimal(0);
  const inserted = await db
    .insert(aiSpendAlerts)
    .values({
      id: newId(),
      environment: ctx.environment,
      scope: limit.scope,
      targetKey: limit.targetKey,
      period: limit.period,
      periodStart: window.start,
      level,
      spent: spent.toFixed(10),
      limitAmount: limit.maxCost ? limit.maxCost.toFixed(10) : null,
      currencyCode: limit.currencyCode,
      detail:
        level === 'BLOCKED'
          ? `refused ${attempted.toFixed(10)} for ${ctx.providerKey}${ctx.agentKey ? ` via ${ctx.agentKey}` : ''}`
          : `approaching the ${limit.period.toLowerCase()} cap`,
    })
    .onConflictDoNothing()
    .returning({ id: aiSpendAlerts.id });
  if (inserted.length === 0) return;
  metrics.incCounter('wasit_ai_spend_alerts_total', { level });
  await writeAudit(
    db,
    { actorId: null, actorType: 'SYSTEM' },
    {
      action: level === 'BLOCKED' ? 'AI_SPEND.LIMIT_BLOCKED' : 'AI_SPEND.LIMIT_WARNING',
      entityType: 'ai_spend_limit',
      entityId: limit.id,
      after: {
        environment: ctx.environment,
        scope: limit.scope,
        targetKey: limit.targetKey,
        period: limit.period,
        spent: spent.toFixed(10),
        limit: limit.maxCost ? limit.maxCost.toFixed(10) : null,
        currencyCode: limit.currencyCode,
      },
      metadata: { providerKey: ctx.providerKey, agentKey: ctx.agentKey, level },
    },
  );
}

/**
 * Read-only view of the counters against their caps. Used by routing to avoid
 * selecting a provider that is already out of budget, and by the admin desk.
 */
export async function spendStatus(
  db: DB,
  ctx: SpendContext,
): Promise<{ blocked: boolean; blockedBy?: { scope: SpendScope; targetKey: string; period: SpendPeriod; reason: string } }> {
  if (isFreeProvider(ctx.providerKey)) return { blocked: false };
  const cfg = platformDb(db);
  const limits = applicable(
    await cfg
      .select()
      .from(aiSpendLimits)
      .where(and(eq(aiSpendLimits.environment, ctx.environment), eq(aiSpendLimits.isActive, true))),
    ctx,
  );
  for (const limit of limits) {
    const window = spendWindow(limit.period);
    const rows = await cfg
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, ctx.environment),
          eq(aiSpendCounters.scope, limit.scope),
          eq(aiSpendCounters.targetKey, limit.targetKey),
          eq(aiSpendCounters.period, limit.period),
          eq(aiSpendCounters.periodStart, window.start),
        ),
      )
      .limit(1);
    if (rows.length === 0) continue;
    const spent = new Decimal(rows[0].spent);
    if (limit.maxCost && spent.gte(limit.maxCost)) {
      return { blocked: true, blockedBy: { scope: limit.scope, targetKey: limit.targetKey, period: limit.period, reason: 'cost' } };
    }
    if (limit.maxRequests !== null && rows[0].requests >= limit.maxRequests) {
      return { blocked: true, blockedBy: { scope: limit.scope, targetKey: limit.targetKey, period: limit.period, reason: 'requests' } };
    }
  }
  return { blocked: false };
}

export interface SpendOverview {
  from: string;
  to: string;
  environment: string;
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    tokensInput: number;
    tokensOutput: number;
    estimatedCost: string;
    vendorCost: string;
    localRequests: number;
    unknownCostRequests: number;
  };
  byAgent: {
    agentKey: string;
    providerKey: string;
    vendorModel: string;
    requests: number;
    failed: number;
    tokensInput: number;
    tokensOutput: number;
    estimatedCost: string;
    vendorCost: string;
  }[];
  byProviderModel: {
    providerKey: string;
    vendorModel: string;
    environment: string;
    requests: number;
    failed: number;
    tokensInput: number;
    tokensOutput: number;
    estimatedCost: string;
    vendorCost: string;
  }[];
  limits: {
    id: string;
    scope: SpendScope;
    targetKey: string;
    period: SpendPeriod;
    maxCost: string | null;
    maxRequests: number | null;
    warnRatio: string;
    currencyCode: string;
    isActive: boolean;
    spent: string;
    requests: number;
    state: 'OK' | 'WARNING' | 'BLOCKED';
  }[];
  alerts: {
    id: string;
    scope: string;
    targetKey: string;
    period: string;
    level: string;
    spent: string;
    limitAmount: string | null;
    currencyCode: string;
    createdAt: string;
  }[];
}

const costExpr = sql<string>`coalesce(sum(case when cost_source = 'ESTIMATED' then cast(cost as numeric) else 0 end), 0)::text`;
const vendorCostExpr = sql<string>`coalesce(sum(case when cost_source = 'VENDOR' then cast(cost as numeric) else 0 end), 0)::text`;

/**
 * Aggregated consumption for the admin desk. Every figure comes from recorded
 * rows; a request with no price basis is counted as unknown, never as free.
 */
export async function spendOverview(
  db: DB,
  params: { from: Date; to: Date; environment: string },
): Promise<SpendOverview> {
  const cfg = platformDb(db);
  const range = and(
    gte(aiRequests.createdAt, params.from),
    lt(aiRequests.createdAt, params.to),
    eq(aiRequests.environment, params.environment),
  );

  const [totals, byAgent, byProvider, limits, alerts] = await Promise.all([
    cfg
      .select({
        requests: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where status in ('SUCCESS','OVER_BUDGET'))::int`,
        failed: sql<number>`count(*) filter (where status not in ('SUCCESS','OVER_BUDGET'))::int`,
        tokensInput: sql<number>`coalesce(sum(tokens_input), 0)::int`,
        tokensOutput: sql<number>`coalesce(sum(tokens_output), 0)::int`,
        estimatedCost: costExpr,
        vendorCost: vendorCostExpr,
        localRequests: sql<number>`count(*) filter (where cost_source = 'FREE')::int`,
        unknownCostRequests: sql<number>`count(*) filter (where cost_source is null or cost_source = 'UNKNOWN')::int`,
      })
      .from(aiRequests)
      .where(range),
    cfg
      .select({
        agentKey: sql<string>`coalesce(${aiRequests.agentKey}, 'unattributed')`,
        providerKey: sql<string>`coalesce(${aiRequests.providerKey}, 'unknown')`,
        vendorModel: sql<string>`coalesce(${aiRequests.vendorModel}, ${aiRequests.model})`,
        requests: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where status not in ('SUCCESS','OVER_BUDGET'))::int`,
        tokensInput: sql<number>`coalesce(sum(tokens_input), 0)::int`,
        tokensOutput: sql<number>`coalesce(sum(tokens_output), 0)::int`,
        estimatedCost: costExpr,
        vendorCost: vendorCostExpr,
      })
      .from(aiRequests)
      .where(range)
      .groupBy(
        sql`coalesce(${aiRequests.agentKey}, 'unattributed')`,
        sql`coalesce(${aiRequests.providerKey}, 'unknown')`,
        sql`coalesce(${aiRequests.vendorModel}, ${aiRequests.model})`,
      )
      .orderBy(sql`count(*) desc`),
    cfg
      .select({
        providerKey: sql<string>`coalesce(${aiRequests.providerKey}, 'unknown')`,
        vendorModel: sql<string>`coalesce(${aiRequests.vendorModel}, ${aiRequests.model})`,
        environment: sql<string>`coalesce(${aiRequests.environment}, 'unknown')`,
        requests: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where status not in ('SUCCESS','OVER_BUDGET'))::int`,
        tokensInput: sql<number>`coalesce(sum(tokens_input), 0)::int`,
        tokensOutput: sql<number>`coalesce(sum(tokens_output), 0)::int`,
        estimatedCost: costExpr,
        vendorCost: vendorCostExpr,
      })
      .from(aiRequests)
      .where(range)
      .groupBy(
        sql`coalesce(${aiRequests.providerKey}, 'unknown')`,
        sql`coalesce(${aiRequests.vendorModel}, ${aiRequests.model})`,
        sql`coalesce(${aiRequests.environment}, 'unknown')`,
      )
      .orderBy(sql`count(*) desc`),
    listSpendLimits(cfg, params.environment),
    cfg
      .select()
      .from(aiSpendAlerts)
      .where(eq(aiSpendAlerts.environment, params.environment))
      .orderBy(desc(aiSpendAlerts.createdAt))
      .limit(50),
  ]);

  const limitViews = [] as SpendOverview['limits'];
  for (const l of limits) {
    const window = spendWindow(l.period);
    const counter = await cfg
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, params.environment),
          eq(aiSpendCounters.scope, l.scope),
          eq(aiSpendCounters.targetKey, l.targetKey),
          eq(aiSpendCounters.period, l.period),
          eq(aiSpendCounters.periodStart, window.start),
        ),
      )
      .limit(1);
    const spent = counter.length > 0 ? new Decimal(counter[0].spent) : new Decimal(0);
    const max = l.maxCost ? new Decimal(l.maxCost) : null;
    let state: 'OK' | 'WARNING' | 'BLOCKED' = 'OK';
    if (max && spent.gte(max)) state = 'BLOCKED';
    else if (max && spent.gte(max.mul(new Decimal(l.warnRatio)))) state = 'WARNING';
    else if (l.maxRequests !== null && counter.length > 0 && counter[0].requests >= l.maxRequests) state = 'BLOCKED';
    limitViews.push({
      ...l,
      spent: spent.toFixed(10),
      requests: counter.length > 0 ? counter[0].requests : 0,
      state,
    });
  }

  const t = totals[0];
  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    environment: params.environment,
    totals: {
      requests: Number(t?.requests ?? 0),
      succeeded: Number(t?.succeeded ?? 0),
      failed: Number(t?.failed ?? 0),
      tokensInput: Number(t?.tokensInput ?? 0),
      tokensOutput: Number(t?.tokensOutput ?? 0),
      estimatedCost: String(t?.estimatedCost ?? '0'),
      vendorCost: String(t?.vendorCost ?? '0'),
      localRequests: Number(t?.localRequests ?? 0),
      unknownCostRequests: Number(t?.unknownCostRequests ?? 0),
    },
    byAgent: byAgent.map((r) => ({ ...r, estimatedCost: String(r.estimatedCost), vendorCost: String(r.vendorCost) })),
    byProviderModel: byProvider.map((r) => ({
      ...r,
      estimatedCost: String(r.estimatedCost),
      vendorCost: String(r.vendorCost),
    })),
    limits: limitViews,
    alerts: alerts.map((a) => ({
      id: a.id,
      scope: a.scope,
      targetKey: a.targetKey,
      period: a.period,
      level: a.level,
      spent: a.spent,
      limitAmount: a.limitAmount,
      currencyCode: a.currencyCode,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/** Utility for the admin desk: which limits exist for a target, if any. */
export async function limitsForTarget(
  db: DB,
  environment: string,
  scope: SpendScope,
  targetKey: string,
): Promise<SpendLimitRow[]> {
  const rows = await platformDb(db)
    .select()
    .from(aiSpendLimits)
    .where(
      and(
        eq(aiSpendLimits.environment, environment),
        eq(aiSpendLimits.scope, scope),
        eq(aiSpendLimits.targetKey, targetKey),
      ),
    );
  return rows.map(toRow);
}

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { aiBudgets, aiRequests, aiUsage } from '../../db/schema/ai';
import { newId } from '../ids';

export interface BudgetSnapshot {
  requestsDelta: number;
  tokensInputDelta: number;
  tokensOutputDelta: number;
  costDelta: Decimal;
}

export interface PeriodWindow {
  start: Date;
  end: Date;
}

export function currentPeriodWindow(period: string, now = new Date()): PeriodWindow {
  if (period === 'DAILY') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    return { start, end };
  }
  // MONTHLY (default)
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function usageSum(db: DB, userId: string, window: PeriodWindow): Promise<{
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: Decimal;
}> {
  const rows = await db
    .select({
      requests: sql<number>`coalesce(sum(case when request_type <> 'AGENT_TASK' then 1 else 0 end), 0)`,
      tokensIn: sql<number>`coalesce(sum(tokens_input), 0)`,
      tokensOut: sql<number>`coalesce(sum(tokens_output), 0)`,
      cost: sql<string>`coalesce(sum(cast(cost as numeric)), 0)`,
    })
    .from(aiRequests)
    .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, window.start), lt(aiRequests.createdAt, window.end)));
  const row = rows[0];
  return {
    requests: Number(row.requests),
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    cost: new Decimal(row.cost || '0'),
  };
}

export interface AiLimit {
  maxRequests?: number;
  maxTokensInput?: number;
  maxTokensOutput?: number;
  maxCost?: Decimal;
}

/**
 * Resolves the strictest budget the user is subjected to.
 * Priority: explicit per-user budget > role budget > global budget > env default.
 */
export async function resolveLimit(
  db: DB,
  userId: string,
  roles: UserRole[],
  period: string,
  envMonthlyCap: number,
): Promise<{ limit: AiLimit; periodWindow: PeriodWindow; source: string; currencyCode: string }> {
  const window = currentPeriodWindow(period);
  const rows = await db
    .select()
    .from(aiBudgets)
    .where(and(eq(aiBudgets.period, period), eq(aiBudgets.isActive, true)));

  const byUser = rows.filter((r) => r.userId === userId);
  const byRole = rows.filter((r) => r.userId === null && r.roleTarget && roles.includes(r.roleTarget as UserRole));
  const global = rows.filter((r) => r.userId === null && (r.roleTarget === null || r.roleTarget === ''));

  const candidate = byUser[0] ?? byRole[0] ?? global[0];
  if (candidate) {
    return {
      limit: {
        maxRequests: candidate.maxRequests ?? undefined,
        maxTokensInput: candidate.maxTokensInput ?? undefined,
        maxTokensOutput: candidate.maxTokensOutput ?? undefined,
        maxCost: candidate.maxCost ? new Decimal(candidate.maxCost) : undefined,
      },
      periodWindow: window,
      source: byUser.length ? 'user' : byRole.length ? 'role' : 'global',
      currencyCode: candidate.currencyCode ?? 'USD',
    };
  }

  const cap = new Decimal(envMonthlyCap ?? 0);
  return {
    limit: { maxCost: cap.gt(0) ? cap : undefined },
    periodWindow: window,
    source: 'env',
    currencyCode: 'USD',
  };
}

/**
 * Verifies a prospective AI request against the resolved budget before any
 * provider call. Throws 429 (rate limited) when the budget is exhausted.
 */
export async function assertWithinBudget(
  db: DB,
  userId: string,
  roles: UserRole[],
  period: string,
  snapshot: BudgetSnapshot,
  envMonthlyCap: number,
): Promise<void> {
  const { limit } = await resolveLimit(db, userId, roles, period, envMonthlyCap);
  const usage = await usageSum(db, userId, currentPeriodWindow(period));

  if (limit.maxRequests !== undefined && usage.requests + snapshot.requestsDelta > limit.maxRequests) {
    throw ApiError.tooManyRequests('AI request budget exhausted (requests)');
  }
  if (limit.maxTokensInput !== undefined && usage.tokensIn + snapshot.tokensInputDelta > limit.maxTokensInput) {
    throw ApiError.tooManyRequests('AI request budget exhausted (input tokens)');
  }
  if (limit.maxTokensOutput !== undefined && usage.tokensOut + snapshot.tokensOutputDelta > limit.maxTokensOutput) {
    throw ApiError.tooManyRequests('AI request budget exhausted (output tokens)');
  }
  if (limit.maxCost !== undefined && usage.cost.plus(snapshot.costDelta).gt(limit.maxCost)) {
    throw ApiError.tooManyRequests('AI request budget exhausted (cost)');
  }
}

export interface RecordAiRequestInput {
  userId: string;
  requestType: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  currencyCode: string;
  status?: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

/** Records a single AI request row in ai_requests. */
export async function recordAiRequest(db: DB, input: RecordAiRequestInput): Promise<string> {
  const id = newId();
  await db.insert(aiRequests).values({
    id,
    userId: input.userId,
    requestType: input.requestType,
    model: input.model,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    cost: input.cost,
    currencyCode: input.currencyCode,
    status: input.status ?? 'SUCCESS',
    latencyMs: input.latencyMs ?? 0,
    metadata: input.metadata ?? null,
  });
  return id;
}

/**
 * Aggregates a user's requests for the current period into ai_usage
 * (first upsert for the period, then additive on subsequent calls).
 */
export async function upsertAiUsage(
  db: DB,
  userId: string,
  period: string,
  window: PeriodWindow,
  deltas: { requests?: number; tokensInput?: number; tokensOutput?: number; cost?: string; currencyCode: string },
): Promise<void> {
  const existing = await db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.periodStart, window.start), eq(aiUsage.periodEnd, window.end)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(aiUsage).values({
      id: newId(),
      userId,
      periodStart: window.start,
      periodEnd: window.end,
      requestCount: deltas.requests ?? 1,
      tokensInput: deltas.tokensInput ?? 0,
      tokensOutput: deltas.tokensOutput ?? 0,
      cost: deltas.cost ?? '0',
      currencyCode: deltas.currencyCode,
    });
    return;
  }

  await db
    .update(aiUsage)
    .set({
      requestCount: sql`${aiUsage.requestCount} + ${deltas.requests ?? 1}`,
      tokensInput: sql`${aiUsage.tokensInput} + ${deltas.tokensInput ?? 0}`,
      tokensOutput: sql`${aiUsage.tokensOutput} + ${deltas.tokensOutput ?? 0}`,
      cost: sql`${aiUsage.cost} + ${deltas.cost ?? '0'}::numeric`,
    })
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.periodStart, window.start), eq(aiUsage.periodEnd, window.end)));
}

/** Helper used by admin dashboards: average usage per period for a user. */
export async function aiUsageForPeriod(
  db: DB,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ requests: number; tokensIn: number; tokensOut: number; cost: Decimal }> {
  const rows = await db
    .select({
      requests: sql<number>`coalesce(sum(case when request_type <> 'AGENT_TASK' then 1 else 0 end), 0)`,
      tokensIn: sql<number>`coalesce(sum(tokens_input), 0)`,
      tokensOut: sql<number>`coalesce(sum(tokens_output), 0)`,
      cost: sql<string>`coalesce(sum(cast(cost as numeric)), 0)`,
    })
    .from(aiRequests)
    .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, periodStart), lt(aiRequests.createdAt, periodEnd)));
  const row = rows[0];
  return {
    requests: Number(row.requests),
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    cost: new Decimal(row.cost || '0'),
  };
}
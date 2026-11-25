import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ApiError } from '@wasit/shared';
import { platformDb, type DB } from '../../db/client';
import { aiSpendLimits } from '../../db/schema/ai-spend';
import { writeAudit, type AuditContext } from '../audit';
import { logger } from '../observability/logger';
import { upsertSpendLimit } from './spend-limits';

/**
 * AI-SPEND-GUARD-01 — a paid provider is only callable when the deployment has
 * an explicit money ceiling.
 *
 * AI-05 lets an administrator set caps but ships with none ("no row means no
 * cap"), which is safe only while every provider is free. The moment a paid
 * provider becomes callable, an unconfigured deployment would spend real money
 * with nothing above it but the per-run ceiling. This module makes two GLOBAL
 * caps — a daily and a monthly cost cap — a precondition:
 *
 *  - activation (enable / default / fallback / stored key) is refused without
 *    both caps;
 *  - execution is refused *before* the provider is called, so a provider named
 *    only by `AI_PROVIDER` cannot bypass the rule;
 *  - an unreadable limits table counts as "no caps" (fail-closed).
 *
 * Free providers never read the table and are never blocked: the local engine
 * must stay available as the safe fallback.
 */

export const GUARD_PERIODS = ['DAILY', 'MONTHLY'] as const;
export type GuardPeriod = (typeof GUARD_PERIODS)[number];

export type GuardLimitRow = typeof aiSpendLimits.$inferSelect;

export interface GuardCap {
  limitId: string;
  maxCost: string;
  currencyCode: string;
  warnRatio: string;
  updatedAt: string;
}

export interface SpendGuardState {
  environment: string;
  ready: boolean;
  /** The limits could not be read at all. Treated exactly like "no caps". */
  unavailable: boolean;
  missing: GuardPeriod[];
  caps: Record<'daily' | 'monthly', GuardCap | null>;
  fix: { method: 'PUT'; path: '/api/admin/ai/spend/guard' };
}

const FIX = { method: 'PUT' as const, path: '/api/admin/ai/spend/guard' as const };

function positiveCost(value: string | null): boolean {
  if (value === null) return false;
  const parsed = new Decimal(value);
  return parsed.isFinite() && parsed.gt(0);
}

function toCap(row: GuardLimitRow): GuardCap {
  return {
    limitId: row.id,
    maxCost: row.maxCost ?? '0',
    currencyCode: row.currencyCode,
    warnRatio: row.warnRatio,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Pure: a deployment is guarded when both GLOBAL cost caps are active. */
export function evaluateSpendGuard(rows: GuardLimitRow[], environment: string): SpendGuardState {
  const pick = (period: GuardPeriod): GuardCap | null => {
    const row = rows.find(
      (r) =>
        r.environment === environment &&
        r.scope === 'GLOBAL' &&
        r.targetKey === '' &&
        r.period === period &&
        r.isActive &&
        positiveCost(r.maxCost),
    );
    return row ? toCap(row) : null;
  };
  const daily = pick('DAILY');
  const monthly = pick('MONTHLY');
  const missing = GUARD_PERIODS.filter((p) => (p === 'DAILY' ? daily === null : monthly === null));
  return {
    environment,
    ready: missing.length === 0,
    unavailable: false,
    missing,
    caps: { daily, monthly },
    fix: FIX,
  };
}

function unavailableState(environment: string): SpendGuardState {
  return {
    environment,
    ready: false,
    unavailable: true,
    missing: [...GUARD_PERIODS],
    caps: { daily: null, monthly: null },
    fix: FIX,
  };
}

export async function spendGuardState(db: DB, environment: string): Promise<SpendGuardState> {
  try {
    const rows = await platformDb(db)
      .select()
      .from(aiSpendLimits)
      .where(and(eq(aiSpendLimits.environment, environment), eq(aiSpendLimits.scope, 'GLOBAL')));
    return evaluateSpendGuard(rows as GuardLimitRow[], environment);
  } catch (err) {
    logger.error('AI spend guard could not read the limits table; refusing paid calls', {
      environment,
      error: (err as Error).message,
    });
    return unavailableState(environment);
  }
}

export function spendGuardError(providerKey: string, state: SpendGuardState): ApiError {
  const missing = state.missing
    .map((p) => `GLOBAL ${p.toLowerCase()} cost cap`)
    .join(' and ');
  const message = state.unavailable
    ? `AI spend guard: spend limits could not be read, so the paid provider "${providerKey}" is refused. Configure the caps at PUT /api/admin/ai/spend/guard and retry.`
    : `AI spend guard: no active ${missing} is configured for environment "${state.environment}". Paid provider "${providerKey}" stays disabled until both caps exist — set them at PUT /api/admin/ai/spend/guard.`;
  return new ApiError(409, 'SPEND_GUARD_REQUIRED', message);
}

/**
 * Refuses a paid provider whose environment has no active GLOBAL daily+monthly
 * cap. Callers invoke this before any write that would make the provider
 * callable and before every outbound paid call; they decide what counts as paid
 * (`isPaidProvider`, i.e. a vendor that bills and leaves the process).
 */
export async function assertSpendGuard(
  db: DB,
  providerKey: string,
  environment: string,
): Promise<void> {
  const state = await spendGuardState(db, environment);
  if (!state.ready) throw spendGuardError(providerKey, state);
}

export interface GuardCapsInput {
  dailyMaxCost: string | number;
  monthlyMaxCost: string | number;
  currencyCode?: string;
  warnRatio?: string | number;
}

function positiveAmount(field: string, raw: string | number): Decimal {
  const parsed = new Decimal(raw);
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw ApiError.validation(
      [{ field, code: 'INVALID', message: 'Must be a positive number' }],
      `${field} must be a positive number`,
    );
  }
  return parsed;
}

/** Sets (or replaces) both GLOBAL caps in one explicit administrative action. */
export async function setGlobalGuardCaps(
  db: DB,
  ctx: AuditContext,
  environment: string,
  input: GuardCapsInput,
): Promise<SpendGuardState> {
  const daily = positiveAmount('dailyMaxCost', input.dailyMaxCost);
  const monthly = positiveAmount('monthlyMaxCost', input.monthlyMaxCost);
  if (monthly.lt(daily)) {
    throw ApiError.validation(
      [
        {
          field: 'monthlyMaxCost',
          code: 'BELOW_DAILY',
          message: 'The monthly cap cannot be lower than the daily cap',
        },
      ],
      'The monthly cap cannot be lower than the daily cap',
    );
  }
  const currencyCode = (input.currencyCode ?? 'USD').toUpperCase();
  const warnRatio = input.warnRatio ?? '0.8';

  for (const [period, amount] of [
    ['DAILY', daily],
    ['MONTHLY', monthly],
  ] as const) {
    await upsertSpendLimit(
      db,
      {
        environment,
        scope: 'GLOBAL',
        targetKey: '',
        period,
        maxCost: amount.toFixed(10),
        maxRequests: null,
        warnRatio,
        currencyCode,
      },
      ctx,
    );
  }

  await writeAudit(db, ctx, {
    action: 'AI_SPEND.GUARD_SET',
    entityType: 'AI_SPEND_GUARD',
    entityId: null,
    after: {
      environment,
      dailyMaxCost: daily.toFixed(10),
      monthlyMaxCost: monthly.toFixed(10),
      currencyCode,
      warnRatio,
    },
    metadata: { source: 'AI-SPEND-GUARD-01' },
  });

  return spendGuardState(db, environment);
}

import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { DB } from '../../db/client';
import { aiRequests } from '../../db/schema/ai';
import { auditLogs } from '../../db/schema/audit';
import { env } from '../../lib/env';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/observability/logger';
import { currentPeriodWindow, resolveLimit } from '../../lib/ai/cost-control';
import { dispatchDueSchedules } from './copilot';
import { executeDueTasks, reapStaleTasks } from './runner';
import { dispatchOutboxEvents } from './outbox-worker';

/**
 * On-demand AI agent cycle (G8).
 *
 * The General Manager (`SUPER_ADMIN`) needs to advance the agent team on demand
 * — dispatch due schedules, run queued/approved tasks, fail stale runs and drain
 * the outbox — without turning the in-process scheduler on in production
 * (`SCHEDULER_ENABLED=false` by default).
 *
 * This module adds NO execution machinery. It composes, in the same order, the
 * exact functions the scheduler tick already calls
 * ({@link dispatchDueSchedules} → {@link executeDueTasks} → {@link reapStaleTasks}
 * → {@link dispatchOutboxEvents}), so every guarantee those paths carry — RBAC,
 * per-agent data scope, the kill switch, the human-approval gate, the per-run
 * budget, single-flight claims and the `AI.*` audit trail — is unchanged. It is a
 * *trigger*, never a second engine.
 *
 * Two cycle-level gates are added on top:
 *   - **Single-flight.** A Postgres session advisory lock means two concurrent
 *     triggers cannot run two overlapping cycles; the loser is told
 *     `blocked / ALREADY_RUNNING` rather than piling a second pass on the first.
 *   - **Platform budget.** If the platform's monthly AI budget is already
 *     exhausted, the cycle refuses to start (`blocked / BUDGET_EXHAUSTED`)
 *     instead of spending into the red.
 *
 * Partial failure is never reported as success: a step that throws leaves a
 * terminal `AI.AGENT_CYCLE_FAILED` record with the counts reached so far, and a
 * process that dies mid-cycle leaves an `AI.AGENT_CYCLE_STARTED` record with no
 * terminal — the honest "started, outcome unknown" state.
 */

/** Session advisory-lock namespace for the on-demand cycle. */
const CYCLE_LOCK_KEY = 'wasit.ai.agent_cycle';

/** Default and maximum number of tasks/events one cycle will process. */
export const DEFAULT_CYCLE_LIMIT = 25;
export const MAX_CYCLE_LIMIT = 100;

export type AgentCycleStatus = 'completed' | 'blocked' | 'failed';

/** The four lifecycle states a cycle can be seen in (started is in-flight). */
export type AgentCycleLifecycle = 'started' | 'completed' | 'blocked' | 'failed';

export interface AgentCycleSteps {
  schedulesDispatched: number;
  tasksRan: number;
  tasksFailed: number;
  tasksRefused: number;
  staleReaped: number;
  outboxClaimed: number;
  outboxProcessed: number;
  outboxFailed: number;
  outboxReaped: number;
}

export interface AgentCycleResult {
  correlationId: string;
  status: AgentCycleStatus;
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  budget: { spentUsd: string; limitUsd: string | null; source: string; currencyCode: string };
  steps: AgentCycleSteps;
}

export interface AgentCycleSummary {
  correlationId: string;
  status: AgentCycleLifecycle;
  reason: string | null;
  actorId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: AgentCycleSteps | null;
}

const CYCLE_ACTIONS = [
  'AI.AGENT_CYCLE_STARTED',
  'AI.AGENT_CYCLE_COMPLETED',
  'AI.AGENT_CYCLE_FAILED',
  'AI.AGENT_CYCLE_BLOCKED',
] as const;

function emptySteps(): AgentCycleSteps {
  return {
    schedulesDispatched: 0,
    tasksRan: 0,
    tasksFailed: 0,
    tasksRefused: 0,
    staleReaped: 0,
    outboxClaimed: 0,
    outboxProcessed: 0,
    outboxFailed: 0,
    outboxReaped: 0,
  };
}

function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : DEFAULT_CYCLE_LIMIT;
  return Math.min(Math.max(value, 1), MAX_CYCLE_LIMIT);
}

/**
 * The budget gate for an on-demand cycle.
 *
 * A cycle is refused once the platform has spent its monthly AI budget, OR once
 * the operator (the GM who triggered it) has spent theirs. The platform limit is
 * the active global budget row (no user, no role) if one exists, otherwise the
 * deployment cap (`AI_BUDGET_MONTHLY_USD`) — the precedence {@link resolveLimit}
 * already applies, resolved here platform-wide and per-operator. Spend is the sum
 * of every recorded `ai_requests` cost in the current month.
 *
 * `spentUsd`/`limitUsd`/`source` describe the *binding* limit (the one that
 * blocked, preferring the platform scope) so the report names the real cause.
 */
export interface CycleBudget {
  exhausted: boolean;
  spentUsd: string;
  limitUsd: string | null;
  source: string;
  currencyCode: string;
}

async function monthlySpend(db: DB, userId: string | null, window: { start: Date; end: Date }): Promise<Decimal> {
  const where = userId
    ? and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, window.start), lt(aiRequests.createdAt, window.end))
    : and(gte(aiRequests.createdAt, window.start), lt(aiRequests.createdAt, window.end));
  const rows = await db
    .select({ cost: sql<string>`coalesce(sum(cast(${aiRequests.cost} as numeric)), 0)` })
    .from(aiRequests)
    .where(where);
  return new Decimal(rows[0]?.cost ?? '0');
}

export async function resolveCycleBudget(db: DB, operatorId: string): Promise<CycleBudget> {
  const window = currentPeriodWindow('MONTHLY');
  const [platformLimit, operatorLimit, platformSpent, operatorSpent] = await Promise.all([
    resolveLimit(db, 'platform', [], 'MONTHLY', env.AI_BUDGET_MONTHLY_USD),
    resolveLimit(db, operatorId, ['SUPER_ADMIN'], 'MONTHLY', env.AI_BUDGET_MONTHLY_USD),
    monthlySpend(db, null, window),
    monthlySpend(db, operatorId, window),
  ]);

  const platformMax = platformLimit.limit.maxCost;
  const operatorMax = operatorLimit.limit.maxCost;
  const platformExhausted = platformMax !== undefined && platformSpent.gte(platformMax);
  const operatorExhausted = operatorMax !== undefined && operatorSpent.gte(operatorMax);

  if (platformExhausted) {
    return {
      exhausted: true,
      spentUsd: platformSpent.toFixed(10),
      limitUsd: platformMax!.toFixed(10),
      source: platformLimit.source,
      currencyCode: platformLimit.currencyCode,
    };
  }
  if (operatorExhausted) {
    return {
      exhausted: true,
      spentUsd: operatorSpent.toFixed(10),
      limitUsd: operatorMax!.toFixed(10),
      source: operatorLimit.source,
      currencyCode: operatorLimit.currencyCode,
    };
  }
  return {
    exhausted: false,
    spentUsd: platformSpent.toFixed(10),
    limitUsd: platformMax !== undefined ? platformMax.toFixed(10) : null,
    source: platformLimit.source,
    currencyCode: platformLimit.currencyCode,
  };
}

/**
 * Takes the cycle's session advisory lock on a dedicated connection.
 *
 * The lock is held on ONE pooled connection for the whole cycle (a session lock,
 * not a transaction lock), so the cycle body can run its own independent writes
 * without being wrapped in one long transaction. The connection is returned to
 * the pool — releasing the lock — in {@link CycleLock.release}.
 */
interface CycleLock {
  acquired: boolean;
  release: () => Promise<void>;
}

async function acquireCycleLock(db: DB): Promise<CycleLock> {
  const client = await db.$client.connect();
  try {
    const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [CYCLE_LOCK_KEY]);
    if (res.rows[0]?.ok !== true) {
      client.release();
      return { acquired: false, release: async () => {} };
    }
    return {
      acquired: true,
      release: async () => {
        try {
          await client.query('select pg_advisory_unlock(hashtext($1))', [CYCLE_LOCK_KEY]);
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Runs one on-demand agent cycle and returns its real outcome.
 *
 * `audit.actorId` is the authenticated operator (a real `SUPER_ADMIN` user id,
 * resolved server-side — never from the request body). It is the actor on every
 * cycle audit entry, so the run is attributable to the human who triggered it.
 *
 * The returned `status` is `completed`, `blocked` or `failed`:
 *   - `blocked` — a cycle was already running, or the platform budget is spent;
 *   - `failed`  — a step threw; the counts reached so far are returned and the
 *                 terminal audit says FAILED, never COMPLETED;
 *   - `completed` — every step ran to the end.
 */
export async function runAgentCycle(
  db: DB,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
  opts: { limit?: number } = {},
): Promise<AgentCycleResult> {
  const limit = clampLimit(opts.limit);
  const correlationId = newId();
  const startedAt = new Date();
  const steps = emptySteps();
  const budget = await resolveCycleBudget(db, audit.actorId);

  const lock = await acquireCycleLock(db);
  try {
    if (!lock.acquired) {
      await writeAudit(db, audit, {
        action: 'AI.AGENT_CYCLE_BLOCKED',
        entityType: 'AGENT_CYCLE',
        entityId: correlationId,
        metadata: { reason: 'ALREADY_RUNNING', limit },
      });
      return finalize(correlationId, 'blocked', 'ALREADY_RUNNING', startedAt, steps, budget);
    }

    if (budget.exhausted) {
      await writeAudit(db, audit, {
        action: 'AI.AGENT_CYCLE_BLOCKED',
        entityType: 'AGENT_CYCLE',
        entityId: correlationId,
        metadata: { reason: 'BUDGET_EXHAUSTED', spentUsd: budget.spentUsd, limitUsd: budget.limitUsd, limit },
      });
      return finalize(correlationId, 'blocked', 'BUDGET_EXHAUSTED', startedAt, steps, budget);
    }

    // Honest in-flight marker: if the process dies before the terminal entry,
    // this STARTED row is all that remains — never a false success.
    await writeAudit(db, audit, {
      action: 'AI.AGENT_CYCLE_STARTED',
      entityType: 'AGENT_CYCLE',
      entityId: correlationId,
      metadata: { limit, budgetSpentUsd: budget.spentUsd, budgetLimitUsd: budget.limitUsd },
    });

    let status: AgentCycleStatus = 'completed';
    let reason: string | null = null;
    try {
      const { dispatched } = await dispatchDueSchedules(db, { actorId: audit.actorId });
      steps.schedulesDispatched = dispatched;

      const due = await executeDueTasks(db, limit, { actorId: audit.actorId });
      steps.tasksRan = due.ran;
      steps.tasksFailed = due.failed;
      steps.tasksRefused = due.refused;

      steps.staleReaped = await reapStaleTasks(db);

      const outbox = await dispatchOutboxEvents(db, limit);
      steps.outboxClaimed = outbox.claimed;
      steps.outboxProcessed = outbox.processed;
      steps.outboxFailed = outbox.failed;
      steps.outboxReaped = outbox.reaped;
    } catch (err) {
      status = 'failed';
      reason = err instanceof Error ? err.message : 'cycle step failed';
      logger.error('agent cycle step failed', { correlationId, error: reason });
    }

    const result = finalize(correlationId, status, reason, startedAt, steps, budget);
    await writeAudit(db, audit, {
      action: status === 'completed' ? 'AI.AGENT_CYCLE_COMPLETED' : 'AI.AGENT_CYCLE_FAILED',
      entityType: 'AGENT_CYCLE',
      entityId: correlationId,
      metadata: { status, reason, durationMs: result.durationMs, ...steps },
    });
    return result;
  } finally {
    await lock.release();
  }
}

function finalize(
  correlationId: string,
  status: AgentCycleStatus,
  reason: string | null,
  startedAt: Date,
  steps: AgentCycleSteps,
  budget: { spentUsd: string; limitUsd: string | null; source: string; currencyCode: string },
): AgentCycleResult {
  const finishedAt = new Date();
  return {
    correlationId,
    status,
    reason,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    budget,
    steps: { ...steps },
  };
}

/**
 * Recent on-demand cycles, newest first, decoded from the cycle audit rows.
 *
 * A cycle with a terminal entry reports that terminal status; a cycle with only
 * a `STARTED` entry (a crash, or one still running) reports `started`. Nothing
 * is recomputed from live state and nothing is written.
 */
export async function listAgentCycles(
  db: DB,
  opts: { limit?: number; ownerId?: string } = {},
): Promise<AgentCycleSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.ownerId
    ? and(inArray(auditLogs.action, [...CYCLE_ACTIONS]), eq(auditLogs.actorId, opts.ownerId))
    : inArray(auditLogs.action, [...CYCLE_ACTIONS]);

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityId: auditLogs.entityId,
      actorId: auditLogs.actorId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit * 4);

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.entityId ?? r.id;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const summaries: AgentCycleSummary[] = [];
  for (const [correlationId, group] of groups) {
    const terminal = group.find((r) => r.action !== 'AI.AGENT_CYCLE_STARTED');
    const startedRow = group.find((r) => r.action === 'AI.AGENT_CYCLE_STARTED');
    const meta = (terminal?.metadata ?? startedRow?.metadata ?? {}) as Record<string, unknown>;
    const anchor = startedRow ?? terminal ?? group[0];
    const status: AgentCycleLifecycle = terminal
      ? terminal.action === 'AI.AGENT_CYCLE_COMPLETED'
        ? 'completed'
        : terminal.action === 'AI.AGENT_CYCLE_FAILED'
          ? 'failed'
          : 'blocked'
      : 'started';
    const num = (k: keyof AgentCycleSteps): number => (typeof meta[k] === 'number' ? (meta[k] as number) : 0);
    const hasSteps = terminal?.action === 'AI.AGENT_CYCLE_COMPLETED' || terminal?.action === 'AI.AGENT_CYCLE_FAILED';
    summaries.push({
      correlationId,
      status,
      reason: typeof meta.reason === 'string' ? (meta.reason as string) : null,
      actorId: anchor.actorId,
      startedAt: anchor.createdAt.toISOString(),
      finishedAt: terminal ? terminal.createdAt.toISOString() : null,
      durationMs: typeof meta.durationMs === 'number' ? (meta.durationMs as number) : null,
      steps: hasSteps
        ? {
            schedulesDispatched: num('schedulesDispatched'),
            tasksRan: num('tasksRan'),
            tasksFailed: num('tasksFailed'),
            tasksRefused: num('tasksRefused'),
            staleReaped: num('staleReaped'),
            outboxClaimed: num('outboxClaimed'),
            outboxProcessed: num('outboxProcessed'),
            outboxFailed: num('outboxFailed'),
            outboxReaped: num('outboxReaped'),
          }
        : null,
    });
  }

  summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return summaries.slice(0, limit);
}

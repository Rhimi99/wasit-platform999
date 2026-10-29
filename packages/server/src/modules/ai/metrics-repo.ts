import { and, eq, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentMetrics } from '../../db/schema/agents';
import { newId } from '../../lib/ids';
import { findAgentSpec } from './catalogue';
import { assertValidScope, type AgentScopeCtx } from './scope';

/**
 * Owner-scoped access to `agent_metrics`.
 *
 * This is the ONLY module allowed to touch the `agent_metrics` table. Every
 * statement — read or write — carries `scope_owner = ctx.owner`, injected here so
 * a caller cannot forget it. Platform scope (`ctx.isPlatform`) widens an
 * **aggregate** read across owners; it never widens row-level reads.
 *
 * No executor or route is wired to this module yet: it is inert until a later,
 * separately-approved batch enables it.
 */

export type MetricOutcome = 'succeeded' | 'failed' | 'blocked' | 'refused';

/** The outcomes a metric row may carry. Derived from the task-status machine in
 * `lib/ai/types.ts` (`succeeded|failed|blocked`) plus the executor refusal code. */
export const METRIC_OUTCOMES: readonly MetricOutcome[] = ['succeeded', 'failed', 'blocked', 'refused'];

export interface MetricInput {
  agentKey: string;
  taskType?: string | null;
  /** The originating task id, when the metric comes from a real task. */
  taskId?: string | null;
  outcome: MetricOutcome;
  attempt?: number;
  latencyMs?: number;
  errorCode?: string | null;
}

export interface AgentMetricRow {
  id: string;
  agentKey: string;
  taskId: string | null;
  taskType: string | null;
  scopeOwner: string;
  outcome: string;
  attempt: number;
  latencyMs: number;
  errorCode: string | null;
  createdAt: Date;
}

export interface MetricFilter {
  agentKey?: string;
  outcome?: MetricOutcome;
}

export interface MetricAggregate {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  refused: number;
  avgLatencyMs: number;
}

/** Every operation validates the scope through the runtime guard, which rejects
 * any context not produced by `deriveScope`/`derivePlatformScope`. */
function assertScope(ctx: AgentScopeCtx | null | undefined): AgentScopeCtx {
  return assertValidScope(ctx);
}

function fail(message: string, field: string): never {
  throw ApiError.validation([{ field, message, code: 'VALIDATION_ERROR' }], message);
}

/**
 * Runtime validation for a metric record. TypeScript types vanish at runtime, so
 * a caller can still pass an unknown agent key, an unsupported outcome, or a
 * malformed identifier. These are rejected here — the database column is a plain
 * varchar with no CHECK constraint.
 *
 * `agentKey` is validated against the in-code catalogue (`findAgentSpec`), the
 * single source of truth for agent identity. No list is invented locally.
 */
export function validateMetricInput(input: MetricInput): void {
  if (typeof input.agentKey !== 'string' || !findAgentSpec(input.agentKey)) {
    fail('agentKey must be a known catalogue agent key.', 'agentKey');
  }
  if (!METRIC_OUTCOMES.includes(input.outcome)) {
    fail(`outcome must be one of ${METRIC_OUTCOMES.join('|')}.`, 'outcome');
  }
  if (input.taskId != null && typeof input.taskId !== 'string') {
    fail('taskId must be a string or null.', 'taskId');
  }
  if (input.taskType != null && typeof input.taskType !== 'string') {
    fail('taskType must be a string or null.', 'taskType');
  }
  if (input.attempt !== undefined && (!Number.isInteger(input.attempt) || input.attempt < 1)) {
    fail('attempt must be an integer >= 1.', 'attempt');
  }
  if (input.latencyMs !== undefined && (typeof input.latencyMs !== 'number' || !Number.isFinite(input.latencyMs) || input.latencyMs < 0)) {
    fail('latencyMs must be a non-negative number.', 'latencyMs');
  }
}

/** The scope predicate that must appear in every statement on this table. */
function ownerPredicate(ctx: AgentScopeCtx): SQL {
  return eq(agentMetrics.scopeOwner, ctx.owner);
}

function filterPredicate(filter?: MetricFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter?.agentKey) conds.push(eq(agentMetrics.agentKey, filter.agentKey));
  if (filter?.outcome) conds.push(eq(agentMetrics.outcome, filter.outcome));
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : and(...conds);
}

/**
 * Records one measurement attributed to `ctx.owner`. The owner always comes from
 * the context, never from the caller's payload.
 */
export async function recordMetric(db: DB, ctx: AgentScopeCtx, input: MetricInput): Promise<string> {
  assertScope(ctx);
  validateMetricInput(input);
  const id = newId();
  await db.insert(agentMetrics).values({
    id,
    agentKey: input.agentKey,
    taskId: input.taskId ?? null,
    taskType: input.taskType ?? null,
    scopeOwner: ctx.owner,
    outcome: input.outcome,
    attempt: input.attempt ?? 1,
    latencyMs: input.latencyMs ?? 0,
    errorCode: input.errorCode ?? null,
  });
  return id;
}

/** Lists this owner's metrics only. */
export async function listMetrics(db: DB, ctx: AgentScopeCtx, filter?: MetricFilter): Promise<AgentMetricRow[]> {
  assertScope(ctx);
  const where = and(ownerPredicate(ctx), filterPredicate(filter) ?? sql`true`);
  const rows = await db.select().from(agentMetrics).where(where);
  return rows as AgentMetricRow[];
}

/**
 * Aggregates metrics. A tenant caller only ever sees its own rows; a platform
 * caller sees the platform-wide aggregate. Both are read-only summaries — no row
 * from another owner is ever returned.
 */
export async function aggregateMetrics(db: DB, ctx: AgentScopeCtx, filter?: MetricFilter): Promise<MetricAggregate> {
  assertScope(ctx);
  const conds: SQL[] = [];
  if (!ctx.isPlatform) conds.push(ownerPredicate(ctx));
  const fp = filterPredicate(filter);
  if (fp) conds.push(fp);
  const where = conds.length === 0 ? sql`true` : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'failed')::int`,
      blocked: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'blocked')::int`,
      refused: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'refused')::int`,
      avgLatencyMs: sql<number>`coalesce(avg(${agentMetrics.latencyMs}), 0)::int`,
    })
    .from(agentMetrics)
    .where(where);
  return rows[0] as MetricAggregate;
}

/** The scope predicate builder, exported for tests that assert the predicate is
 * always present (they render it to SQL; no database is involved). */
export const __internal = { ownerPredicate, filterPredicate };

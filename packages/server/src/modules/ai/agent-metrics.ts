import { and, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { agentTasks, agentRegistry } from '../../db/schema/agents';
import { aiRequests } from '../../db/schema/ai';
import { agentRunSteps } from '../../db/schema/agent_runs';
import { auditLogs } from '../../db/schema/audit';
import { assertValidScope, NoScopeError, type AgentScopeCtx } from './scope.js';

/**
 * A3 — Agent Metrics & Outcome Tracking.
 *
 * A read-only, server-side measurement layer over the EXISTING agent lifecycle.
 * It derives every figure from durable, already-recorded rows and never mutates
 * a task, a metric or an audit entry. The agent under measurement therefore
 * cannot forge or edit its own numbers: there is no agent-writable path into any
 * of the tables read here, and this module exposes no write function at all.
 *
 * Design decisions that keep the numbers honest:
 *  - `agent_tasks` is the SINGLE source of truth for runs. A task is one run,
 *    counted once by its primary key — a retry/recovery that re-reads it cannot
 *    inflate the count, and `agent_metrics` (a separate, currently unwritten
 *    table) is deliberately NOT joined in, so a future duplicate row there could
 *    never double-count.
 *  - Cost comes from `ai_requests.cost`, the ledger row the provider call itself
 *    wrote. It is reported as ACTUAL provider spend, never estimated. Tokens and
 *    per-model attribution come from the same rows.
 *  - A task outcome is `succeeded`/`approved` only when the stored result exists.
 *    "Task completed" is NOT the same as "business outcome achieved": this
 *    module never claims a business result. See `verifiedOutcomes`.
 *  - Retries are read from `agent_run_steps.attempt_count` (a real, persisted
 *    counter), never inferred, so a re-run cannot masquerade as a retry.
 *  - A failed/refused task is counted in the failure bucket and is never retried
 *    away by counting only its final success.
 */

/** Terminal task statuses, matching the states `createAgentTask`/`decideAgentTask` settle to. */
const SUCCESS_STATUSES = ['succeeded', 'approved'] as const;
const FAILURE_STATUSES = ['failed', 'rejected'] as const;
const PENDING_STATUSES = ['queued', 'awaiting_approval'] as const;
const RUNNING_STATUSES = ['running'] as const;

/** A run counts as "slow" when it took at least this long. */
const SLOW_RUN_THRESHOLD_MS = 10_000;

/** A run counts as "recent activity" within this window. */
const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

export type AgentHealth = 'healthy' | 'degraded' | 'failing' | 'idle' | 'no_data';

export interface ExecutionMetrics {
  totalRuns: number;
  completed: number;
  failed: number;
  cancelledOrBlocked: number;
  pending: number;
  running: number;
  successRate: number | null;
}

export interface PerformanceMetrics {
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  slowRuns: number;
  measuredRuns: number;
  retriedSteps: number;
  failedSteps: number;
  recoveredRuns: number;
}

export interface CostMetrics {
  /** true only when at least one provider ledger row was found. */
  available: boolean;
  actualProviderCostUsd: string;
  currencyCode: string;
  tokensInput: number;
  tokensOutput: number;
  requests: number;
  byModel: { model: string; provider: string | null; requests: number; costUsd: string }[];
}

export interface VerifiedOutcomes {
  /** Tasks with a stored, non-null result — evidence the executor produced output. */
  tasksWithStoredResult: number;
  /**
   * Business outcomes attributed to an agent with evidence. Always 0 today: no
   * table in the schema records that an agent's recommendation was acted on, so
   * there is nothing to count. Kept explicit so it is never confused with
   * `tasksWithStoredResult`.
   */
  businessOutcomesAchieved: number;
  /** Human-readable reason the business figure is 0. */
  note: string;
}

export interface AgentMetrics {
  agentKey: string;
  name: string;
  requiresHumanApproval: boolean;
  active: boolean;
  execution: ExecutionMetrics;
  performance: PerformanceMetrics;
  cost: CostMetrics;
  outcomes: VerifiedOutcomes;
  lastActivityAt: string | null;
  health: AgentHealth;
  healthReason: string;
}

export interface CompanyMetrics {
  generatedAt: string;
  window: { since: string | null; until: string };
  overall: {
    execution: ExecutionMetrics;
    performance: PerformanceMetrics;
    cost: CostMetrics;
    outcomes: VerifiedOutcomes;
  };
  agents: AgentMetrics[];
  /** Agents that need the GM's attention, worst first. */
  attention: { agentKey: string; name: string; health: AgentHealth; reason: string }[];
  dataFreshness: { latestActivityAt: string | null; latestMetricAt: string | null };
  notes: string[];
}

export interface MetricsOptions {
  /** Only count runs created at/after this instant. */
  since?: Date;
  /** Only include this agent (defaults to all). */
  agentKey?: string;
}

/** The shared, honest caveat about what "outcome" means here. */
const OUTCOME_NOTE =
  'Business outcome achieved is reported only with evidence that an agent recommendation was acted on. ' +
  'No such evidence source exists in the current schema, so it is always 0 and is never inferred from task completion.';

function emptyExecution(): ExecutionMetrics {
  return {
    totalRuns: 0,
    completed: 0,
    failed: 0,
    cancelledOrBlocked: 0,
    pending: 0,
    running: 0,
    successRate: null,
  };
}

function emptyPerformance(): PerformanceMetrics {
  return {
    avgDurationMs: null,
    medianDurationMs: null,
    p95DurationMs: null,
    slowRuns: 0,
    measuredRuns: 0,
    retriedSteps: 0,
    failedSteps: 0,
    recoveredRuns: 0,
  };
}

function emptyCost(): CostMetrics {
  return {
    available: false,
    actualProviderCostUsd: '0',
    currencyCode: 'USD',
    tokensInput: 0,
    tokensOutput: 0,
    requests: 0,
    byModel: [],
  };
}

function emptyOutcomes(): VerifiedOutcomes {
  return { tasksWithStoredResult: 0, businessOutcomesAchieved: 0, note: OUTCOME_NOTE };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Derives health from explicit, persisted signals only — never from a guess.
 * `no_data` is returned when an agent has never run, so the GM sees "no data"
 * rather than a fabricated "healthy".
 */
function deriveHealth(
  execution: ExecutionMetrics,
  lastActivityAt: Date | null,
  now: number,
): { health: AgentHealth; reason: string } {
  if (execution.totalRuns === 0) {
    return { health: 'no_data', reason: 'No runs recorded for this agent.' };
  }
  const settled = execution.completed + execution.failed;
  if (settled > 0 && execution.successRate !== null && execution.successRate < 0.5) {
    return {
      health: 'failing',
      reason: `Success rate ${Math.round(execution.successRate * 100)}% across ${settled} settled runs.`,
    };
  }
  if (execution.failed > 0) {
    return {
      health: 'degraded',
      reason: `${execution.failed} failed run(s) out of ${execution.totalRuns}.`,
    };
  }
  const fresh = lastActivityAt !== null && now - lastActivityAt.getTime() <= RECENT_ACTIVITY_MS;
  if (!fresh) {
    return { health: 'idle', reason: 'No runs in the last 24 hours.' };
  }
  return { health: 'healthy', reason: `All ${execution.totalRuns} runs succeeded.` };
}

function bucketOf(status: string): 'completed' | 'failed' | 'pending' | 'running' | 'other' {
  if ((SUCCESS_STATUSES as readonly string[]).includes(status)) return 'completed';
  if ((FAILURE_STATUSES as readonly string[]).includes(status)) return 'failed';
  if ((PENDING_STATUSES as readonly string[]).includes(status)) return 'pending';
  if ((RUNNING_STATUSES as readonly string[]).includes(status)) return 'running';
  return 'other';
}

/**
 * A run's duration in ms, or `null` when it was never measured.
 *
 * Prefers the executor-measured `latency_ms`; falls back to the persisted span
 * between creation and completion for a settled run. A non-positive measurement
 * is treated as "not measured" rather than a real instantaneous run, so it never
 * skews the average downward.
 */
function measureDurationMs(
  latencyMs: number | null | undefined,
  createdAt: Date | null | undefined,
  completedAt: Date | null | undefined,
): number | null {
  if (typeof latencyMs === 'number' && latencyMs > 0) return latencyMs;
  if (createdAt && completedAt) {
    const span = completedAt.getTime() - createdAt.getTime();
    if (span > 0) return span;
  }
  return null;
}

/**
 * Builds the whole AI-company metrics view. Read-only; safe to call from an
 * admin surface. The caller MUST pass a validated platform scope (admin-only),
 * so per-tenant data is never aggregated for a non-admin.
 */
export async function buildCompanyMetrics(
  db: DB,
  options: MetricsOptions = {},
): Promise<CompanyMetrics> {
  const now = new Date();
  const since = options.since ?? null;

  const taskWhere = since ? gte(agentTasks.createdAt, since) : undefined;
  const agentFilter = options.agentKey ? eq(agentTasks.agentKey, options.agentKey) : undefined;
  const where = agentFilter ? (taskWhere ? and(taskWhere, agentFilter) : agentFilter) : taskWhere;

  // --- Runs (source of truth: agent_tasks, one row = one run) ----------------
  const taskRows = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      status: agentTasks.status,
      result: agentTasks.result,
      cost: agentTasks.cost,
      model: agentTasks.model,
      latencyMs: agentTasks.latencyMs,
      createdAt: agentTasks.createdAt,
      completedAt: agentTasks.completedAt,
    })
    .from(agentTasks)
    .where(where);

  // --- Registry (identity/name; agents with no runs still appear) -----------
  const registry = await db
    .select({
      key: agentRegistry.key,
      name: agentRegistry.name,
      requiresHumanApproval: agentRegistry.requiresHumanApproval,
      isActive: agentRegistry.isActive,
    })
    .from(agentRegistry);

  // --- Provider ledger (ACTUAL cost, tokens, model attribution) -------------
  // Linked to a task via the server-owned metadata key, never a caller value.
  const requestWhere = since ? gte(aiRequests.createdAt, since) : undefined;
  const ledgerRows = await db
    .select({
      taskId: sql<string | null>`${aiRequests.metadata}->>'taskId'`,
      agentKey: sql<string | null>`${aiRequests.metadata}->>'agentKey'`,
      model: aiRequests.model,
      cost: aiRequests.cost,
      tokensInput: aiRequests.tokensInput,
      tokensOutput: aiRequests.tokensOutput,
      status: aiRequests.status,
      createdAt: aiRequests.createdAt,
    })
    .from(aiRequests)
    .where(requestWhere);

  // --- Retries & failures (from persisted step counters / statuses) ----------
  const stepRows = await db
    .select({
      agentKey: agentRunSteps.agentKey,
      status: agentRunSteps.status,
      attemptCount: agentRunSteps.attemptCount,
    })
    .from(agentRunSteps);

  // --- Recovered runs (evidence: the recovery audit action) ------------------
  const recoveryWhere = since ? gte(auditLogs.createdAt, since) : undefined;
  const recoveryRows = await db
    .select({ entityId: auditLogs.entityId, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      recoveryWhere
        ? and(eq(auditLogs.action, 'AI.AGENT_TASK_COST_RECOVERED'), recoveryWhere)
        : eq(auditLogs.action, 'AI.AGENT_TASK_COST_RECOVERED'),
    );

  // --- Aggregate per agent ---------------------------------------------------
  const perAgent = new Map<string, {
    execution: ExecutionMetrics;
    durations: number[];
    lastActivity: Date | null;
    tasksWithResult: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    byModel: Map<string, { requests: number; costUsd: number }>;
  }>();

  const ensure = (key: string) => {
    let entry = perAgent.get(key);
    if (!entry) {
      entry = {
        execution: emptyExecution(),
        durations: [],
        lastActivity: null,
        tasksWithResult: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        requests: 0,
        byModel: new Map(),
      };
      perAgent.set(key, entry);
    }
    return entry;
  };

  for (const t of taskRows) {
    const entry = ensure(t.agentKey);
    const bucket = bucketOf(t.status);
    entry.execution.totalRuns += 1;
    if (bucket === 'completed') entry.execution.completed += 1;
    else if (bucket === 'failed') entry.execution.failed += 1;
    else if (bucket === 'pending') entry.execution.pending += 1;
    else if (bucket === 'running') entry.execution.running += 1;
    else entry.execution.cancelledOrBlocked += 1;
    if (t.result !== null && t.result !== undefined) entry.tasksWithResult += 1;
    // Duration: the executor-measured `latency_ms` when the run recorded one,
    // otherwise the persisted span between creation and completion. Only settled
    // runs with a positive measurement contribute — a 0 is "not measured", never
    // a real instantaneous run.
    const measured = measureDurationMs(t.latencyMs, t.createdAt, t.completedAt);
    if (measured !== null) entry.durations.push(measured);
    const activity = t.completedAt ?? t.createdAt;
    if (activity && (!entry.lastActivity || activity > entry.lastActivity)) entry.lastActivity = activity;
  }

  // Retry/failure counts by agent (from steps).
  const stepsByAgent = new Map<string, { retried: number; failed: number }>();
  for (const s of stepRows) {
    const agg = stepsByAgent.get(s.agentKey) ?? { retried: 0, failed: 0 };
    if (s.attemptCount > 1) agg.retried += 1;
    if (s.status === 'FAILED') agg.failed += 1;
    stepsByAgent.set(s.agentKey, agg);
  }

  // Recovered runs by agent (map task id -> agent key).
  const agentOfTask = new Map<string, string>();
  for (const t of taskRows) agentOfTask.set(t.id, t.agentKey);
  const recoveredByAgent = new Map<string, number>();
  let recoveredTotal = 0;
  for (const r of recoveryRows) {
    if (!r.entityId) continue;
    const key = agentOfTask.get(r.entityId);
    if (!key) continue;
    recoveredTotal += 1;
    recoveredByAgent.set(key, (recoveredByAgent.get(key) ?? 0) + 1);
  }

  // Ledger attribution by agent.
  const ledgerByAgent = new Map<string, {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    byModel: Map<string, { requests: number; costUsd: number }>;
  }>();
  for (const r of ledgerRows) {
    const key = r.agentKey;
    if (!key) continue; // a request not tied to a task is not an agent run's cost
    if (options.agentKey && key !== options.agentKey) continue;
    const agg = ledgerByAgent.get(key) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0, requests: 0, byModel: new Map() };
    const cost = Number(r.cost ?? '0');
    const safeCost = Number.isFinite(cost) && cost >= 0 ? cost : 0;
    agg.costUsd += safeCost;
    agg.tokensIn += r.tokensInput ?? 0;
    agg.tokensOut += r.tokensOutput ?? 0;
    agg.requests += 1;
    const m = agg.byModel.get(r.model) ?? { requests: 0, costUsd: 0 };
    m.requests += 1;
    m.costUsd += safeCost;
    agg.byModel.set(r.model, m);
    ledgerByAgent.set(key, agg);
  }

  // --- Build the per-agent result (registry ∪ agents that ran) ---------------
  const keys = new Set<string>();
  for (const r of registry) keys.add(r.key);
  for (const k of perAgent.keys()) keys.add(k);
  if (options.agentKey) {
    for (const k of [...keys]) if (k !== options.agentKey) keys.delete(k);
  }

  const registryByKey = new Map(registry.map((r) => [r.key, r]));

  const agents: AgentMetrics[] = [];
  for (const key of keys) {
    const entry = perAgent.get(key);
    const reg = registryByKey.get(key);
    const execution = entry?.execution ?? emptyExecution();
    const settled = execution.completed + execution.failed;
    execution.successRate = settled > 0 ? execution.completed / settled : null;

    const sorted = [...(entry?.durations ?? [])].sort((a, b) => a - b);
    const steps = stepsByAgent.get(key);
    const performance: PerformanceMetrics = {
      avgDurationMs: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : null,
      medianDurationMs: median(sorted),
      p95DurationMs: percentile(sorted, 95),
      slowRuns: sorted.filter((d) => d >= SLOW_RUN_THRESHOLD_MS).length,
      measuredRuns: sorted.length,
      retriedSteps: steps?.retried ?? 0,
      failedSteps: steps?.failed ?? 0,
      recoveredRuns: recoveredByAgent.get(key) ?? 0,
    };

    const led = ledgerByAgent.get(key);
    const cost: CostMetrics = led
      ? {
          available: true,
          actualProviderCostUsd: led.costUsd.toFixed(10),
          currencyCode: 'USD',
          tokensInput: led.tokensIn,
          tokensOutput: led.tokensOut,
          requests: led.requests,
          byModel: [...led.byModel.entries()].map(([model, v]) => ({
            model,
            provider: null,
            requests: v.requests,
            costUsd: v.costUsd.toFixed(10),
          })),
        }
      : emptyCost();

    const outcomes: VerifiedOutcomes = {
      tasksWithStoredResult: entry?.tasksWithResult ?? 0,
      businessOutcomesAchieved: 0,
      note: OUTCOME_NOTE,
    };

    const lastActivity = entry?.lastActivity ?? null;
    const { health, reason } = deriveHealth(execution, lastActivity, now.getTime());

    agents.push({
      agentKey: key,
      name: reg?.name ?? key,
      requiresHumanApproval: reg?.requiresHumanApproval ?? false,
      active: reg?.isActive ?? false,
      execution,
      performance,
      cost,
      outcomes,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      health,
      healthReason: reason,
    });
  }

  // Stable, useful ordering: worst health first, then by activity.
  const healthRank: Record<AgentHealth, number> = { failing: 0, degraded: 1, idle: 2, no_data: 3, healthy: 4 };
  agents.sort((a, b) => {
    const hr = healthRank[a.health] - healthRank[b.health];
    if (hr !== 0) return hr;
    return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
  });

  // --- Company-wide roll-up --------------------------------------------------
  const overallExec = emptyExecution();
  const overallDurations: number[] = [];
  let overallWithResult = 0;
  let overallRecovered = 0;
  for (const a of agents) {
    overallExec.totalRuns += a.execution.totalRuns;
    overallExec.completed += a.execution.completed;
    overallExec.failed += a.execution.failed;
    overallExec.pending += a.execution.pending;
    overallExec.running += a.execution.running;
    overallExec.cancelledOrBlocked += a.execution.cancelledOrBlocked;
    overallWithResult += a.outcomes.tasksWithStoredResult;
    overallRecovered += a.performance.recoveredRuns;
  }
  const overallSettled = overallExec.completed + overallExec.failed;
  overallExec.successRate = overallSettled > 0 ? overallExec.completed / overallSettled : null;

  // Company durations: recompute from the task rows so the roll-up is exact.
  for (const t of taskRows) {
    const measured = measureDurationMs(t.latencyMs, t.createdAt, t.completedAt);
    if (measured !== null) overallDurations.push(measured);
  }
  const overallSorted = overallDurations.sort((a, b) => a - b);
  let overallRetried = 0;
  let overallFailedSteps = 0;
  for (const v of stepsByAgent.values()) {
    overallRetried += v.retried;
    overallFailedSteps += v.failed;
  }
  const overallPerformance: PerformanceMetrics = {
    avgDurationMs: overallSorted.length ? Math.round(overallSorted.reduce((s, v) => s + v, 0) / overallSorted.length) : null,
    medianDurationMs: median(overallSorted),
    p95DurationMs: percentile(overallSorted, 95),
    slowRuns: overallSorted.filter((d) => d >= SLOW_RUN_THRESHOLD_MS).length,
    measuredRuns: overallSorted.length,
    retriedSteps: overallRetried,
    failedSteps: overallFailedSteps,
    recoveredRuns: recoveredTotal,
  };

  const overallCost: CostMetrics = (() => {
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let requests = 0;
    const byModel = new Map<string, { requests: number; costUsd: number }>();
    for (const led of ledgerByAgent.values()) {
      cost += led.costUsd;
      tokensIn += led.tokensIn;
      tokensOut += led.tokensOut;
      requests += led.requests;
      for (const [model, v] of led.byModel) {
        const m = byModel.get(model) ?? { requests: 0, costUsd: 0 };
        m.requests += v.requests;
        m.costUsd += v.costUsd;
        byModel.set(model, m);
      }
    }
    if (requests === 0) return emptyCost();
    return {
      available: true,
      actualProviderCostUsd: cost.toFixed(10),
      currencyCode: 'USD',
      tokensInput: tokensIn,
      tokensOutput: tokensOut,
      requests,
      byModel: [...byModel.entries()].map(([model, v]) => ({
        model,
        provider: null,
        requests: v.requests,
        costUsd: v.costUsd.toFixed(10),
      })),
    };
  })();

  const latestActivity = agents.reduce<Date | null>((acc, a) => {
    if (!a.lastActivityAt) return acc;
    const d = new Date(a.lastActivityAt);
    return !acc || d > acc ? d : acc;
  }, null);
  const latestRecovery = recoveryRows.reduce<Date | null>((acc, r) => {
    const d = new Date(r.createdAt);
    return !acc || d > acc ? d : acc;
  }, null);

  const attention = agents
    .filter((a) => a.health === 'failing' || a.health === 'degraded')
    .map((a) => ({ agentKey: a.agentKey, name: a.name, health: a.health, reason: a.healthReason }));

  return {
    generatedAt: now.toISOString(),
    window: { since: since ? since.toISOString() : null, until: now.toISOString() },
    overall: {
      execution: overallExec,
      performance: overallPerformance,
      cost: overallCost,
      outcomes: { tasksWithStoredResult: overallWithResult, businessOutcomesAchieved: 0, note: OUTCOME_NOTE },
    },
    agents,
    attention,
    dataFreshness: {
      latestActivityAt: latestActivity ? latestActivity.toISOString() : null,
      latestMetricAt: latestRecovery ? latestRecovery.toISOString() : null,
    },
    notes: [
      'Runs are counted from agent_tasks (one row = one run); duplicate retries cannot inflate the count.',
      'Cost is ACTUAL provider spend from the ai_requests ledger, never an estimate. It is unavailable until a real provider call is recorded.',
      OUTCOME_NOTE,
    ],
  };
}

/**
 * A convenience wrapper that requires a validated PLATFORM scope before
 * aggregating across owners. `scope` must come from `derivePlatformScope`
 * (admin-only); a forged object is rejected by `assertValidScope`.
 */
export async function buildCompanyMetricsForAdmin(
  db: DB,
  scope: AgentScopeCtx | null | undefined,
  options: MetricsOptions = {},
): Promise<CompanyMetrics> {
  // The scope must be a real, derived context AND carry platform authority.
  // A hand-built object is rejected; an owner-only scope (isPlatform=false) is
  // refused so cross-owner aggregation can never run without an admin identity.
  const valid = assertValidScope(scope);
  if (!valid.isPlatform) {
    throw new NoScopeError('Company-wide agent metrics require an admin platform scope.');
  }
  return buildCompanyMetrics(db, options);
}

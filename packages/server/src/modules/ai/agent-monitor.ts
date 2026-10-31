import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { assertValidScope, deriveSystemScope, SYSTEM_PRINCIPAL, type AgentScopeCtx } from './scope';
import { perAgentMetrics } from './metrics-repo';

/**
 * AI-06.0 — per-agent performance metrics and the General Manager monitoring
 * view. Every number here is derived from real operational records, never a
 * placeholder:
 *
 *   - `agent_metrics`  — append-only outcome/latency/attempt per finished run,
 *                        read through `metrics-repo` (the only module allowed to
 *                        touch that table).
 *   - `agent_tasks`    — live task state (running/queued/awaiting_approval),
 *                        cost, tokens and timestamps.
 *   - `ai_requests`    — the AI cost ledger; joined by `metadata->>'agentKey'`
 *                        (populated by the runner's task-attributed metadata).
 *   - `audit_logs`     — `AI.TOOL_*` entries for tool usage and failures.
 *
 * Tenant scope: a non-platform caller (`ctx.isPlatform === false`) sees only its
 * own rows (`scope_owner = ctx.owner` / `requested_by = ctx.owner`); a platform
 * caller (admin, verified server-side) sees the platform-wide aggregate. No
 * row-level detail ever crosses owners — only counts do.
 *
 * Read-only: nothing here writes, mutates a task or changes a metric.
 */

/** One row per agent, aggregated from the sources above. */
export interface AgentPerformanceRow {
  agentKey: string;
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  refused: number;
  successRate: number;
  failureRate: number;
  avgLatencyMs: number;
  awaitingApproval: number;
  running: number;
  queued: number;
  overdue: number;
  costUsd: string;
  tokensInput: number;
  tokensOutput: number;
  /** ai_requests with a FAILED/UNAVAILABLE status (a provider call that failed). */
  providerFailures: number;
  /** ai_requests served by the free local engine (fallback / no vendor configured). */
  localRuns: number;
  toolCalls: number;
  toolFailures: number;
  lastActivityAt: string | null;
}

export interface PerformanceOptions {
  /** A `running` task older than this many seconds counts as overdue. */
  overdueSeconds?: number;
}

/** A structured alert the GM should see. */
export interface MonitorAlert {
  kind: 'budget' | 'failures' | 'unhealthy' | 'overdue' | 'system-overdue' | 'system-failures';
  severity: 'warning' | 'critical';
  agentKey?: string;
  message: string;
}

export interface TeamHealth {
  generatedAt: string;
  scope: 'platform' | 'owner';
  agents: {
    total: number;
    active: number;
    paused: number;
    disabled: number;
    /** Agents with a failure rate over the supervisor limit. */
    unhealthy: number;
  };
  tasks: {
    queued: number;
    running: number;
    awaitingApproval: number;
    overdue: number;
    succeeded24h: number;
    /** Technical failures only — a deliberate refusal is counted separately. */
    failed24h: number;
    /** Runs the agent (or a human) deliberately declined in the last 24h. */
    refused24h: number;
  };
  budget: { spentUsd24h: string; runsOverCap24h: number };
  /**
   * Scheduler telemetry (AI-06.1), present only in the platform view. The
   * scheduler runs under a dedicated system identity, so its success/failure/
   * refusal/overdue counts are reported here **separately** from the human
   * activity above — never merged into it.
   */
  system?: {
    succeeded24h: number;
    failed24h: number;
    refused24h: number;
    overdue: number;
  };
  alerts: MonitorAlert[];
  /** Items an operator must act on (approvals, unhealthy agents, overdue runs). */
  needsHumanAttention: Array<{ agentKey: string; reason: string }>;
}

const DEFAULT_OVERDUE_SECONDS = 300;
/** Mirror of the supervisor's failure-rate ceiling (Supervisor agent #20). */
const UNHEALTHY_FAILURE_RATE = 0.5;
const UNHEALTHY_MIN_SAMPLES = 5;

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

/** Owner predicate fragment for the tasks/ai/audit tables. The metrics table is
 * reached through `metrics-repo`, which owns its own scope predicate.
 *
 * The platform view deliberately **excludes** the system bucket (`requested_by =
 * 'system'`): scheduler telemetry is reported separately (see the `system` block
 * of {@link teamHealth}) so the GM's human-activity picture is never mixed with
 * it. A system scope sees only the system bucket. */
function ownerClause(column: string, ctx: AgentScopeCtx): ReturnType<typeof sql> {
  if (ctx.isSystem) return sql`${sql.raw(column)} = ${SYSTEM_PRINCIPAL}`;
  if (ctx.isPlatform) return sql`${sql.raw(column)} <> ${SYSTEM_PRINCIPAL}`;
  return sql`${sql.raw(column)} = ${ctx.owner}`;
}

/**
 * Per-agent performance for the caller's scope, one row per agent that has any
 * recorded activity. Agents with no activity are omitted (the registry view
 * supplies the full agent list).
 */
export async function agentPerformance(
  db: DB,
  ctx: AgentScopeCtx,
  opts: PerformanceOptions = {},
): Promise<AgentPerformanceRow[]> {
  assertValidScope(ctx);
  const overdueSeconds = opts.overdueSeconds ?? DEFAULT_OVERDUE_SECONDS;

  const metrics = await perAgentMetrics(db, ctx);

  const tasks = rowsOf<{
    agent_key: string;
    awaiting_approval: number;
    running: number;
    queued: number;
    overdue: number;
    cost: string;
    tokens_input: number;
    tokens_output: number;
    last_at: string | null;
  }>(await db.execute(sql`
    select agent_key,
           count(*) filter (where status = 'awaiting_approval')::int as awaiting_approval,
           count(*) filter (where status = 'running')::int as running,
           count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'running' and started_at < now() - (${overdueSeconds} * interval '1 second'))::int as overdue,
           coalesce(sum(cost::numeric), 0)::text as cost,
           coalesce(sum(tokens_input), 0)::int as tokens_input,
           coalesce(sum(tokens_output), 0)::int as tokens_output,
           max(created_at) as last_at
    from agent_tasks
    where ${ownerClause('requested_by', ctx)}
    group by agent_key
  `));

  const ai = rowsOf<{
    agent_key: string;
    provider_failures: number;
    local_runs: number;
  }>(await db.execute(sql`
    select metadata->>'agentKey' as agent_key,
           count(*) filter (where status in ('FAILED', 'UNAVAILABLE'))::int as provider_failures,
           count(*) filter (where model = 'local-heuristic')::int as local_runs
    from ai_requests
    where metadata->>'agentKey' is not null
      and ${ownerClause('user_id', ctx)}
    group by metadata->>'agentKey'
  `));

  const tools = rowsOf<{
    agent_key: string;
    tool_calls: number;
    tool_failures: number;
  }>(await db.execute(sql`
    select metadata->>'agentKey' as agent_key,
           count(*) filter (where action = 'AI.TOOL_EXECUTED')::int as tool_calls,
           count(*) filter (where action in ('AI.TOOL_FAILED', 'AI.TOOL_REFUSED'))::int as tool_failures
    from audit_logs
    where action like 'AI.TOOL_%'
      and metadata->>'agentKey' is not null
      and ${ownerClause('actor_id', ctx)}
    group by metadata->>'agentKey'
  `));

  const byAgent = new Map<string, AgentPerformanceRow>();
  const ensure = (key: string): AgentPerformanceRow => {
    let row = byAgent.get(key);
    if (!row) {
      row = {
        agentKey: key,
        total: 0, succeeded: 0, failed: 0, blocked: 0, refused: 0,
        successRate: 0, failureRate: 0, avgLatencyMs: 0,
        awaitingApproval: 0, running: 0, queued: 0, overdue: 0,
        costUsd: '0', tokensInput: 0, tokensOutput: 0,
        providerFailures: 0, localRuns: 0, toolCalls: 0, toolFailures: 0,
        lastActivityAt: null,
      };
      byAgent.set(key, row);
    }
    return row;
  };

  for (const m of metrics) {
    const row = ensure(m.agentKey);
    row.total = m.total;
    row.succeeded = m.succeeded;
    row.failed = m.failed;
    row.blocked = m.blocked;
    row.refused = m.refused;
    row.avgLatencyMs = m.avgLatencyMs;
    row.lastActivityAt = m.lastAt ?? row.lastActivityAt;
  }
  for (const t of tasks) {
    const row = ensure(t.agent_key);
    row.awaitingApproval = Number(t.awaiting_approval);
    row.running = Number(t.running);
    row.queued = Number(t.queued);
    row.overdue = Number(t.overdue);
    row.costUsd = String(t.cost);
    row.tokensInput = Number(t.tokens_input);
    row.tokensOutput = Number(t.tokens_output);
    const at = t.last_at ? new Date(t.last_at).toISOString() : null;
    if (at && (!row.lastActivityAt || at > row.lastActivityAt)) row.lastActivityAt = at;
  }
  for (const a of ai) {
    const row = ensure(a.agent_key);
    row.providerFailures = Number(a.provider_failures);
    row.localRuns = Number(a.local_runs);
  }
  for (const t of tools) {
    const row = ensure(t.agent_key);
    row.toolCalls = Number(t.tool_calls);
    row.toolFailures = Number(t.tool_failures);
  }

  for (const row of byAgent.values()) {
    const denom = row.total || 0;
    row.successRate = denom > 0 ? row.succeeded / denom : 0;
    row.failureRate = denom > 0 ? row.failed / denom : 0;
  }

  return [...byAgent.values()].sort((a, b) => b.total - a.total);
}

/**
 * The unified General-Manager health picture: agent lifecycle counts, live task
 * state, 24h outcomes, budget and the alerts an operator should act on. Built on
 * top of {@link agentPerformance} plus the agent registry.
 */
export async function teamHealth(
  db: DB,
  ctx: AgentScopeCtx,
  opts: PerformanceOptions = {},
): Promise<TeamHealth> {
  assertValidScope(ctx);
  const perf = await agentPerformance(db, ctx, opts);

  const registry = rowsOf<{ status: string; key: string }>(await db.execute(sql`
    select key, status from agent_registry
  `));

  const windowRows = rowsOf<{
    succeeded_24h: number;
    failed_24h: number;
    refused_24h: number;
    spent: string;
    over_cap: number;
  }>(
    await db.execute(sql`
      select
        (select count(*) from agent_tasks where status = 'succeeded' and completed_at > now() - interval '24 hours'
          and ${ownerClause('requested_by', ctx)})::int as succeeded_24h,
        (select count(*) from agent_tasks where status = 'failed' and coalesce((error->>'refused')::boolean, false) = false
          and error_at > now() - interval '24 hours'
          and ${ownerClause('requested_by', ctx)})::int as failed_24h,
        (select count(*) from agent_tasks where status = 'rejected' and coalesce((error->>'refused')::boolean, false) = true
          and error_at > now() - interval '24 hours'
          and ${ownerClause('requested_by', ctx)})::int as refused_24h,
        (select coalesce(sum(cost::numeric), 0)::text from ai_requests
          where created_at > now() - interval '24 hours'
          and ${ownerClause('user_id', ctx)}) as spent,
        (select count(*) from ai_requests where status = 'OVER_BUDGET' and created_at > now() - interval '24 hours'
          and ${ownerClause('user_id', ctx)})::int as over_cap
    `),
  );
  const window = windowRows[0] ?? { succeeded_24h: 0, failed_24h: 0, refused_24h: 0, spent: '0', over_cap: 0 };

  // Scheduler telemetry (AI-06.1): reported separately for the platform view so a
  // stuck or failing scheduled run is visible to the GM without being merged into
  // the human-activity counts above.
  let system: TeamHealth['system'];
  if (ctx.isPlatform) {
    const sys = deriveSystemScope();
    const sysRows = rowsOf<{ succeeded_24h: number; failed_24h: number; refused_24h: number; overdue: number }>(
      await db.execute(sql`
        select
          (select count(*) from agent_tasks where status = 'succeeded' and completed_at > now() - interval '24 hours'
            and ${ownerClause('requested_by', sys)})::int as succeeded_24h,
          (select count(*) from agent_tasks where status = 'failed' and coalesce((error->>'refused')::boolean, false) = false
            and error_at > now() - interval '24 hours'
            and ${ownerClause('requested_by', sys)})::int as failed_24h,
          (select count(*) from agent_tasks where status = 'rejected' and coalesce((error->>'refused')::boolean, false) = true
            and error_at > now() - interval '24 hours'
            and ${ownerClause('requested_by', sys)})::int as refused_24h,
          (select count(*) from agent_tasks where status = 'running' and started_at < now() - interval '5 minutes'
            and ${ownerClause('requested_by', sys)})::int as overdue
      `),
    );
    const s = sysRows[0] ?? { succeeded_24h: 0, failed_24h: 0, refused_24h: 0, overdue: 0 };
    system = {
      succeeded24h: Number(s.succeeded_24h),
      failed24h: Number(s.failed_24h),
      refused24h: Number(s.refused_24h),
      overdue: Number(s.overdue),
    };
  }

  const unhealthy = perf.filter(
    (p) => p.total >= UNHEALTHY_MIN_SAMPLES && p.failureRate > UNHEALTHY_FAILURE_RATE,
  );

  const alerts: MonitorAlert[] = [];
  for (const p of unhealthy) {
    alerts.push({
      kind: 'unhealthy',
      severity: 'critical',
      agentKey: p.agentKey,
      message: `Agent ${p.agentKey} failure rate ${(p.failureRate * 100).toFixed(0)}% over ${p.total} runs`,
    });
  }
  for (const p of perf) {
    if (p.overdue > 0) {
      alerts.push({
        kind: 'overdue',
        severity: 'warning',
        agentKey: p.agentKey,
        message: `${p.overdue} run(s) exceeding the timeout for ${p.agentKey}`,
      });
    }
  }
  if (Number(window.over_cap) > 0) {
    alerts.push({
      kind: 'budget',
      severity: 'critical',
      message: `${window.over_cap} AI request(s) exceeded the per-run cost ceiling in the last 24h`,
    });
  }
  // Scheduler-specific alerts (platform view only): a stuck or failing scheduled
  // run is an operational signal the GM must see, reported separately.
  if (system) {
    if (system.overdue > 0) {
      alerts.push({
        kind: 'system-overdue',
        severity: 'warning',
        message: `${system.overdue} scheduled run(s) have been running longer than the timeout`,
      });
    }
    if (system.failed24h > 0) {
      alerts.push({
        kind: 'system-failures',
        severity: 'warning',
        message: `${system.failed24h} scheduled run(s) failed in the last 24h`,
      });
    }
  }

  const needsHumanAttention: Array<{ agentKey: string; reason: string }> = [];
  for (const p of perf) {
    if (p.awaitingApproval > 0) needsHumanAttention.push({ agentKey: p.agentKey, reason: `${p.awaitingApproval} task(s) awaiting approval` });
    if (p.overdue > 0) needsHumanAttention.push({ agentKey: p.agentKey, reason: `${p.overdue} overdue run(s)` });
  }
  for (const p of unhealthy) needsHumanAttention.push({ agentKey: p.agentKey, reason: 'failure rate over limit' });

  const disabled = registry.filter((r) => r.status === 'DISABLED').length;
  const paused = registry.filter((r) => r.status === 'PAUSED').length;

  return {
    generatedAt: new Date().toISOString(),
    scope: ctx.isPlatform ? 'platform' : 'owner',
    agents: {
      total: registry.length,
      active: registry.length - disabled - paused,
      paused,
      disabled,
      unhealthy: unhealthy.length,
    },
    tasks: {
      queued: sum(perf, 'queued'),
      running: sum(perf, 'running'),
      awaitingApproval: sum(perf, 'awaitingApproval'),
      overdue: sum(perf, 'overdue'),
      succeeded24h: Number(window.succeeded_24h),
      failed24h: Number(window.failed_24h),
      refused24h: Number(window.refused_24h),
    },
    budget: { spentUsd24h: String(window.spent), runsOverCap24h: Number(window.over_cap) },
    ...(system ? { system } : {}),
    alerts,
    needsHumanAttention,
  };
}

function sum(rows: AgentPerformanceRow[], key: keyof AgentPerformanceRow): number {
  return rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
}

/** One recent task row for the monitor activity feed. */
export interface RecentActivityRow {
  id: string;
  agentKey: string;
  taskType: string | null;
  status: string;
  requestedBy: string;
  triggeredBy: string;
  latencyMs: number | null;
  cost: string;
  createdAt: string;
  completedAt: string | null;
}

/** The most recent significant agent activity (newest tasks) for the monitor. */
export async function recentActivity(db: DB, ctx: AgentScopeCtx, limit = 20): Promise<RecentActivityRow[]> {
  assertValidScope(ctx);
  const safe = Number.isFinite(limit) && limit > 0 && limit <= 100 ? Math.floor(limit) : 20;
  const res = rowsOf<{
    id: string; agent_key: string; task_type: string | null; status: string; requested_by: string;
    triggered_by: string; latency_ms: number | null; cost: string; created_at: string; completed_at: string | null;
  }>(await db.execute(sql`
    select id, agent_key, task_type, status, requested_by, triggered_by, latency_ms, cost, created_at, completed_at
    from agent_tasks
    where ${ownerClause('requested_by', ctx)}
    order by created_at desc
    limit ${safe}
  `));
  return res.map((r) => ({
    id: r.id,
    agentKey: r.agent_key,
    taskType: r.task_type,
    status: r.status,
    requestedBy: r.requested_by,
    triggeredBy: r.triggered_by,
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    cost: String(r.cost),
    createdAt: new Date(r.created_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  }));
}

export const __internal = { UNHEALTHY_FAILURE_RATE, UNHEALTHY_MIN_SAMPLES, DEFAULT_OVERDUE_SECONDS };

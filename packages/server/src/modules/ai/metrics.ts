import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { agentMetrics, agentTasks, agentRegistry, agentMemory } from '../../db/schema/agents';
import { aiRequests } from '../../db/schema/ai';
import { agentRunSteps } from '../../db/schema/agent_runs';
import { auditLogs } from '../../db/schema/audit';
import { env } from '../../lib/env';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { logger } from '../../lib/observability/logger';

/**
 * AI-MET-01 — persistent agent performance intelligence.
 *
 * A3 (`agent-metrics.ts`) answers "how is every agent doing right now" by
 * recomputing from live tables on each request. That view is correct but
 * stateless: it cannot answer "how did this agent do last week", it forgets
 * everything a retention job removes from `agent_tasks`, and every call is a
 * full scan. This module adds the missing half — an append-only measurement log
 * in the existing `agent_metrics` table, written as tasks settle, and read back
 * as per-period aggregates.
 *
 * Why `agent_metrics` and no migration:
 *  - the table already exists (migration 0033) with the columns this needs:
 *    agent, task, task type, owner, outcome, attempt, latency, error code, time;
 *  - it is append-only and never read by a task, so a metric can never change
 *    what an agent did;
 *  - its primary key is the deduplication mechanism. A row id is derived from
 *    (agent, task, attempt, outcome), so writing the same settled event twice —
 *    a retried handler, a duplicated webhook, a backfill racing a live write —
 *    collides with itself and is dropped by the database, not by a hope.
 *
 * What is deliberately NOT here: note or task text, prompts, model output,
 * credentials, memory content or raw financial rows. The log records counts,
 * durations, statuses and machine error codes only.
 */

/** Outcomes a settled attempt can have. */
export const METRIC_OUTCOMES = ['succeeded', 'failed', 'rejected', 'blocked'] as const;
export type MetricOutcome = (typeof METRIC_OUTCOMES)[number];

/** Statuses that mean the task settled successfully (mirrors `agent-metrics.ts`). */
const SUCCESS_STATUSES = ['succeeded', 'approved'] as const;

export type Granularity = 'day' | 'week' | 'month';
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];

/** A run counts as slow at or above this latency. */
const SLOW_RUN_THRESHOLD_MS = 10_000;

/**
 * Deterministic, UUID-shaped id for a metric event.
 *
 * Including `outcome` in the key keeps the log lossless: a task that fails and
 * is later re-settled as succeeded is two real events, not one overwritten
 * value. Aggregation decides what counts as a "task" (distinct task id) versus
 * an "attempt" (distinct attempt number), so no event is lost and none is
 * counted twice.
 */
export function metricEventId(parts: { agentKey: string; taskId: string; attempt: number; outcome: string }): string {
  const hash = createHash('sha256')
    // JSON-encoded, not joined: a "|" inside a key would otherwise let two
    // different events collapse onto one id and silently drop a measurement.
    .update(JSON.stringify([parts.agentKey, parts.taskId, parts.attempt, parts.outcome]), 'utf8')
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Random UUID-shaped id for an event that has no stable natural key (a refusal). */
function eventId(seed: string): string {
  const hash = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export interface RecordMetricInput {
  agentKey: string;
  taskId: string | null;
  taskType?: string | null;
  /** The task's requester — the isolation key. Never taken from request input. */
  scopeOwner: string;
  outcome: MetricOutcome;
  attempt?: number;
  latencyMs?: number;
  errorCode?: string | null;
}

/**
 * Appends one measurement. Idempotent for a settled task event: the row id is
 * derived from the event, so `ON CONFLICT DO NOTHING` absorbs a duplicate.
 * Returns whether a row was actually written.
 */
export async function recordAgentMetric(db: DB, input: RecordMetricInput): Promise<boolean> {
  const attempt = Math.max(1, Math.trunc(input.attempt ?? 1));
  const id = input.taskId
    ? metricEventId({ agentKey: input.agentKey, taskId: input.taskId, attempt, outcome: input.outcome })
    : eventId(`${input.agentKey}|refusal|${input.scopeOwner}|${Date.now()}|${Math.random()}`);
  const latency = Math.max(0, Math.trunc(input.latencyMs ?? 0));
  const inserted = await db
    .insert(agentMetrics)
    .values({
      id,
      agentKey: input.agentKey,
      taskId: input.taskId,
      taskType: input.taskType ?? null,
      scopeOwner: input.scopeOwner,
      outcome: input.outcome,
      attempt,
      latencyMs: latency,
      errorCode: input.errorCode ? input.errorCode.slice(0, 64) : null,
    })
    .onConflictDoNothing({ target: agentMetrics.id })
    .returning({ id: agentMetrics.id });
  return inserted.length > 0;
}

/**
 * Records a metric without ever endangering the task it describes. A metrics
 * outage must not fail an agent run, so every failure is logged and swallowed.
 * The caller gets a boolean only for tests and diagnostics.
 */
export async function recordMetricSafely(db: DB, input: RecordMetricInput): Promise<boolean> {
  if (!env.AI_METRICS_AUTO_RECORD) return false;
  try {
    return await recordAgentMetric(db, input);
  } catch (err) {
    logger.warn('agent metric write failed', {
      agentKey: input.agentKey,
      taskId: input.taskId,
      outcome: input.outcome,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backfill — close the gap between the live tables and the log
// ---------------------------------------------------------------------------

export interface BackfillResult {
  scanned: number;
  inserted: number;
  skipped: number;
  truncated: boolean;
}

/**
 * Reconstructs metric rows for tasks that settled before the log existed (or
 * while it was failing). Safe to run repeatedly and while the service is live:
 * each candidate maps to the same deterministic id, so an already-recorded
 * event is a no-op.
 *
 * Only terminal tasks are considered — a queued or running task has no outcome
 * to record, and inventing one would be a fabricated measurement.
 */
export async function backfillAgentMetrics(
  db: DB,
  options: { since?: Date; limit?: number } = {},
): Promise<BackfillResult> {
  const limit = Math.min(Math.max(options.limit ?? env.AI_METRICS_BACKFILL_BATCH, 1), 5000);
  const conditions = [
    inArray(agentTasks.status, [...SUCCESS_STATUSES, 'failed', 'rejected']),
  ];
  if (options.since) conditions.push(gte(agentTasks.createdAt, options.since));

  const candidates = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      taskType: agentTasks.taskType,
      requestedBy: agentTasks.requestedBy,
      status: agentTasks.status,
      attempts: agentTasks.attempts,
      latencyMs: agentTasks.latencyMs,
      createdAt: agentTasks.createdAt,
      completedAt: agentTasks.completedAt,
      errorAt: agentTasks.errorAt,
      error: agentTasks.error,
    })
    .from(agentTasks)
    .where(and(...conditions))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit + 1);

  const truncated = candidates.length > limit;
  const rows = truncated ? candidates.slice(0, limit) : candidates;
  if (rows.length === 0) return { scanned: 0, inserted: 0, skipped: 0, truncated: false };

  const ids = rows.map((r) => r.id);
  const existing = await db
    .select({ taskId: agentMetrics.taskId })
    .from(agentMetrics)
    .where(inArray(agentMetrics.taskId, ids));
  const seen = new Set(existing.map((r) => r.taskId));

  let inserted = 0;
  let skipped = 0;
  for (const task of rows) {
    if (seen.has(task.id)) {
      skipped += 1;
      continue;
    }
    const outcome: MetricOutcome = (SUCCESS_STATUSES as readonly string[]).includes(task.status)
      ? 'succeeded'
      : task.status === 'rejected'
        ? 'rejected'
        : 'failed';
    const wrote = await recordAgentMetric(db, {
      agentKey: task.agentKey,
      taskId: task.id,
      taskType: task.taskType,
      scopeOwner: task.requestedBy,
      outcome,
      attempt: Math.max(1, task.attempts + 1),
      latencyMs: task.latencyMs > 0 ? task.latencyMs : spanMs(task.createdAt, task.completedAt ?? task.errorAt),
      errorCode: outcome === 'failed' ? 'BACKFILLED_UNKNOWN_CAUSE' : null,
    });
    if (wrote) inserted += 1;
    else skipped += 1;
  }
  return { scanned: rows.length, inserted, skipped, truncated };
}

function spanMs(from: Date | null | undefined, to: Date | null | undefined): number {
  if (!from || !to) return 0;
  const span = to.getTime() - from.getTime();
  return span > 0 ? span : 0;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ExecutionStats {
  /** Distinct tasks with at least one recorded attempt in the window. */
  tasks: number;
  /** Distinct (task, attempt) pairs — a retry is a new attempt. */
  attempts: number;
  /** Attempt-level counts: one settled attempt each. */
  succeeded: number;
  failed: number;
  rejected: number;
  /**
   * Refusals before any execution (unknown/declared-only agent, supervisor,
   * Copilot). These are events, not attempts: no task row ever existed.
   */
  blockedEvents: number;
  /** succeeded / (succeeded + failed + rejected); null when nothing settled. */
  successRate: number | null;
  failureRate: number | null;
  rejectionRate: number | null;
}

export interface RetryStats {
  retriedTasks: number;
  attemptsPerTask: number | null;
  maxAttempts: number;
  /** Orchestration steps whose stored attempt count exceeded one. */
  retriedSteps: number;
  /** Steps that exhausted `max_attempts`. */
  exhaustedSteps: number;
}

export interface LatencyStats {
  measured: number;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  slowRuns: number;
}

export interface ApprovalStats {
  requested: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number | null;
}

export interface ToolStats {
  executed: number;
  refused: number;
  failed: number;
  timeouts: number;
  replayed: number;
  /** Tool id → invocation count. Identifiers only, never arguments. */
  topTools: { toolId: string; calls: number }[];
}

export interface MemoryStats {
  /** Runs that recalled memory before executing. */
  recalls: number;
  /** recalls / settled tasks, or null when nothing settled. */
  recallRate: number | null;
  /** Automatic `task_result` writes observed in the window (audit events). */
  recorded: number;
  /** `task_result` rows currently stored for this agent (count only). */
  storedTaskResults: number;
  /** Owner-authored notes currently stored (content never read). */
  ownerNotes: number;
  integrityFailures: number;
}

export type Availability = 'available' | 'unavailable';

export interface CostStats {
  status: Availability;
  /** Reason the figure is unavailable — never a guess. */
  reason: string | null;
  costUsd: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  requests: number;
}

export interface QualityStats {
  /** Share of tasks that stored an executor result. Evidence of output, not of quality. */
  storedResultRate: number | null;
  /** Share of human approval decisions that were rejections. */
  humanRejectionRate: number | null;
  businessOutcomes: Availability;
  note: string;
}

export interface ComplianceStats {
  /** Pre-execution refusals (unknown/declared-only agent, supervisor, Copilot). */
  refusedRuns: number;
  /** Failed runs whose machine code shows an owner-scope refusal. */
  scopeFailures: number;
  toolRefusals: number;
  memoryIntegrityFailures: number;
}

export interface StalledStats {
  /** Open tasks past the stall threshold, measured live (not from the log). */
  count: number;
  oldestAgeMinutes: number | null;
  thresholdMinutes: number;
}

export interface AgentMetricsReport {
  agentKey: string;
  name: string;
  execution: ExecutionStats;
  retries: RetryStats;
  latency: LatencyStats;
  approvals: ApprovalStats;
  tools: ToolStats;
  memory: MemoryStats;
  cost: CostStats;
  quality: QualityStats;
  compliance: ComplianceStats;
  stalled: StalledStats;
  lastActivityAt: string | null;
}

export interface MetricsSeriesPoint {
  bucket: string;
  tasks: number;
  attempts: number;
  succeeded: number;
  failed: number;
  rejected: number;
  blocked: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  costUsd: string | null;
}

export interface MetricsReport {
  generatedAt: string;
  window: { from: string; to: string; granularity: Granularity };
  filters: { agentKey: string | null; taskType: string | null };
  overall: Omit<AgentMetricsReport, 'agentKey' | 'name' | 'lastActivityAt'>;
  agents: AgentMetricsReport[];
  series: MetricsSeriesPoint[];
  coverage: {
    tasksInWindow: number;
    tasksWithMetric: number;
    percent: number | null;
    backfillRecommended: boolean;
  };
  integrity: {
    distinctOwners: number;
    eventsScanned: number;
    truncated: boolean;
  };
  notes: string[];
}

const BUSINESS_OUTCOME_NOTE =
  'Business outcomes are unavailable: nothing in the schema records that an agent recommendation was acted on. ' +
  'Task completion and stored results are reported separately and are never presented as business impact.';

function emptyExecution(): ExecutionStats {
  return {
    tasks: 0,
    attempts: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    blockedEvents: 0,
    successRate: null,
    failureRate: null,
    rejectionRate: null,
  };
}

function emptyLatency(): LatencyStats {
  return { measured: 0, avgMs: null, medianMs: null, p95Ms: null, slowRuns: 0 };
}

function emptyTools(): ToolStats {
  return { executed: 0, refused: 0, failed: 0, timeouts: 0, replayed: 0, topTools: [] };
}

function emptyMemory(): MemoryStats {
  return { recalls: 0, recallRate: null, recorded: 0, storedTaskResults: 0, ownerNotes: 0, integrityFailures: 0 };
}

function emptyCost(): CostStats {
  return { status: 'unavailable', reason: 'No provider ledger row in this window.', costUsd: null, tokensInput: null, tokensOutput: null, requests: 0 };
}

function emptyApprovals(): ApprovalStats {
  return { requested: 0, approved: 0, rejected: 0, pending: 0, approvalRate: null };
}

function emptyQuality(): QualityStats {
  return { storedResultRate: null, humanRejectionRate: null, businessOutcomes: 'unavailable', note: BUSINESS_OUTCOME_NOTE };
}

function emptyCompliance(): ComplianceStats {
  return { refusedRuns: 0, scopeFailures: 0, toolRefusals: 0, memoryIntegrityFailures: 0 };
}

function emptyRetries(): RetryStats {
  return { retriedTasks: 0, attemptsPerTask: null, maxAttempts: 0, retriedSteps: 0, exhaustedSteps: 0 };
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

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Bucket label for a timestamp at the requested granularity (UTC, SQL-side). */
function bucketExpr(granularity: Granularity) {
  // Inlined rather than bound: a bind parameter in the SELECT and another in the
  // GROUP BY are two different expressions to PostgreSQL, which then rejects the
  // query. `granularity` is a validated union, so this cannot inject anything.
  const unit = sql.raw(`'${granularity}'`);
  return sql<string>`to_char(date_trunc(${unit}, ${agentMetrics.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
}

export interface ReportOptions {
  from?: Date;
  to?: Date;
  agentKey?: string;
  taskType?: string;
  granularity?: Granularity;
  /** Cap on metric rows read for percentile maths. */
  maxRows?: number;
}

interface MetricRow {
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

/**
 * Builds the report from durable sources only:
 *  - execution/retries/latency: the `agent_metrics` log (append-only);
 *  - approvals & stalled tasks: `agent_tasks` (live state);
 *  - tools: `audit_logs` tool events;
 *  - memory usage: memory audits + row counts (never content);
 *  - cost: the `ai_requests` provider ledger (actual spend or unavailable).
 *
 * No figure is estimated. When a source has no rows the field is null and its
 * `status` is `unavailable`, so a zero can never be mistaken for a measurement.
 */
export async function buildMetricsReport(db: DB, options: ReportOptions = {}): Promise<MetricsReport> {
  const granularity = options.granularity ?? 'day';
  if (!GRANULARITIES.includes(granularity)) {
    throw new Error(`Unsupported granularity: ${granularity}`);
  }
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from.getTime() > to.getTime()) throw new Error('`from` must be before `to`');
  const maxRows = Math.min(Math.max(options.maxRows ?? env.AI_METRICS_MAX_ROWS, 100), 200_000);

  const metricConditions = [gte(agentMetrics.createdAt, from), lte(agentMetrics.createdAt, to)];
  if (options.agentKey) metricConditions.push(eq(agentMetrics.agentKey, options.agentKey));
  if (options.taskType) metricConditions.push(eq(agentMetrics.taskType, options.taskType));

  const metricRows = (await db
    .select({
      agentKey: agentMetrics.agentKey,
      taskId: agentMetrics.taskId,
      taskType: agentMetrics.taskType,
      scopeOwner: agentMetrics.scopeOwner,
      outcome: agentMetrics.outcome,
      attempt: agentMetrics.attempt,
      latencyMs: agentMetrics.latencyMs,
      errorCode: agentMetrics.errorCode,
      createdAt: agentMetrics.createdAt,
    })
    .from(agentMetrics)
    .where(and(...metricConditions))
    .orderBy(desc(agentMetrics.createdAt))
    .limit(maxRows + 1)) as MetricRow[];
  const truncated = metricRows.length > maxRows;
  const rows = truncated ? metricRows.slice(0, maxRows) : metricRows;

  // --- Tasks (live) in the same window/filters ------------------------------
  const taskConditions = [gte(agentTasks.createdAt, from), lte(agentTasks.createdAt, to)];
  if (options.agentKey) taskConditions.push(eq(agentTasks.agentKey, options.agentKey));
  if (options.taskType) taskConditions.push(eq(agentTasks.taskType, options.taskType));
  const taskRows = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      taskType: agentTasks.taskType,
      status: agentTasks.status,
      requiresApproval: agentTasks.requiresApproval,
      approvedAt: agentTasks.approvedAt,
      result: agentTasks.result,
      latencyMs: agentTasks.latencyMs,
      createdAt: agentTasks.createdAt,
      startedAt: agentTasks.startedAt,
      completedAt: agentTasks.completedAt,
    })
    .from(agentTasks)
    .where(and(...taskConditions));

  // --- Steps (retries) ------------------------------------------------------
  const stepConditions = options.agentKey ? [eq(agentRunSteps.agentKey, options.agentKey)] : [];
  const stepRows = await db
    .select({
      agentKey: agentRunSteps.agentKey,
      status: agentRunSteps.status,
      attemptCount: agentRunSteps.attemptCount,
      maxAttempts: agentRunSteps.maxAttempts,
    })
    .from(agentRunSteps)
    .where(stepConditions.length ? and(...stepConditions) : undefined);

  // --- Tool events ----------------------------------------------------------
  const toolActions = ['AI.TOOL_EXECUTED', 'AI.TOOL_REFUSED', 'AI.TOOL_FAILED', 'AI.TOOL_REPLAYED'];
  const toolRows = await db
    .select({
      action: auditLogs.action,
      agentKey: sql<string | null>`${auditLogs.metadata}->>'agentKey'`,
      toolId: sql<string | null>`${auditLogs.metadata}->>'toolId'`,
      code: sql<string | null>`${auditLogs.metadata}->>'code'`,
    })
    .from(auditLogs)
    .where(and(inArray(auditLogs.action, toolActions), gte(auditLogs.createdAt, from), lte(auditLogs.createdAt, to)));

  // --- Memory usage (counts only, never content) ----------------------------
  const memoryAuditRows = await db
    .select({
      action: auditLogs.action,
      agentKey: sql<string | null>`${auditLogs.metadata}->>'agentKey'`,
      source: sql<string | null>`${auditLogs.metadata}->>'source'`,
    })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.action, ['AI.MEMORY_RECALLED', 'AI.MEMORY_RECORDED', 'AI.MEMORY_INTEGRITY_FAILED']),
        gte(auditLogs.createdAt, from),
        lte(auditLogs.createdAt, to),
      ),
    );

  const memoryRowCounts = await db
    .select({ agentKey: agentMemory.agentKey, kind: agentMemory.kind, count: sql<number>`count(*)::int` })
    .from(agentMemory)
    .groupBy(agentMemory.agentKey, agentMemory.kind);

  // --- Cost ledger ----------------------------------------------------------
  const ledgerRows = await db
    .select({
      agentKey: sql<string | null>`${aiRequests.metadata}->>'agentKey'`,
      cost: aiRequests.cost,
      tokensInput: aiRequests.tokensInput,
      tokensOutput: aiRequests.tokensOutput,
    })
    .from(aiRequests)
    .where(and(gte(aiRequests.createdAt, from), lte(aiRequests.createdAt, to)));

  // --- Registry (agents with no events still appear) ------------------------
  const registry = await db
    .select({ key: agentRegistry.key, name: agentRegistry.name })
    .from(agentRegistry);

  const stallThreshold = env.AI_METRICS_STALL_AFTER_MINUTES;

  type Acc = {
    execution: ExecutionStats;
    taskIds: Set<string>;
    attemptsByTask: Map<string, Set<number>>;
    durations: number[];
    latency: LatencyStats;
    approvals: ApprovalStats;
    tools: ToolStats;
    toolCalls: Map<string, number>;
    memory: MemoryStats;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    storedResults: number;
    decidedApprovals: number;
    rejectedApprovals: number;
    scopeFailures: number;
    lastActivity: Date | null;
    stalled: StalledStats;
  };

  const makeAcc = (): Acc => ({
    execution: emptyExecution(),
    taskIds: new Set(),
    attemptsByTask: new Map(),
    durations: [],
    latency: emptyLatency(),
    approvals: emptyApprovals(),
    tools: emptyTools(),
    toolCalls: new Map(),
    memory: emptyMemory(),
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    requests: 0,
    storedResults: 0,
    decidedApprovals: 0,
    rejectedApprovals: 0,
    scopeFailures: 0,
    lastActivity: null,
    stalled: { count: 0, oldestAgeMinutes: null, thresholdMinutes: stallThreshold },
  });

  const perAgent = new Map<string, Acc>();
  const ensure = (key: string): Acc => {
    let acc = perAgent.get(key);
    if (!acc) {
      acc = makeAcc();
      perAgent.set(key, acc);
    }
    return acc;
  };

  const now = Date.now();
  for (const row of rows) {
    const acc = ensure(row.agentKey);
    acc.execution.attempts += 1;
    if (row.taskId) {
      acc.taskIds.add(row.taskId);
      const set = acc.attemptsByTask.get(row.taskId) ?? new Set<number>();
      set.add(row.attempt);
      acc.attemptsByTask.set(row.taskId, set);
    }
    if (row.outcome === 'succeeded') acc.execution.succeeded += 1;
    else if (row.outcome === 'failed') {
      acc.execution.failed += 1;
      if (/^(NO_SCOPE|SCOPE_)/i.test(row.errorCode ?? '')) acc.scopeFailures += 1;
    }
    else if (row.outcome === 'rejected') acc.execution.rejected += 1;
    else if (row.outcome === 'blocked') acc.execution.blockedEvents += 1;
    if (row.latencyMs > 0) acc.durations.push(row.latencyMs);
    if (!acc.lastActivity || row.createdAt > acc.lastActivity) acc.lastActivity = row.createdAt;
  }

  for (const task of taskRows) {
    const acc = ensure(task.agentKey);
    if (task.requiresApproval) {
      acc.approvals.requested += 1;
      if (task.status === 'rejected') {
        acc.approvals.rejected += 1;
        acc.decidedApprovals += 1;
        acc.rejectedApprovals += 1;
      } else if (task.approvedAt || (SUCCESS_STATUSES as readonly string[]).includes(task.status)) {
        acc.approvals.approved += 1;
        acc.decidedApprovals += 1;
      } else if (task.status === 'awaiting_approval') {
        acc.approvals.pending += 1;
      }
    }
    if (task.result !== null && task.result !== undefined) acc.storedResults += 1;
    const activity = task.completedAt ?? task.startedAt ?? task.createdAt;
    if (!acc.lastActivity || activity > acc.lastActivity) acc.lastActivity = activity;
  }

  for (const event of toolRows) {
    if (!event.agentKey) continue;
    if (options.agentKey && event.agentKey !== options.agentKey) continue;
    const acc = ensure(event.agentKey);
    if (event.action === 'AI.TOOL_EXECUTED') {
      acc.tools.executed += 1;
      if (event.toolId) acc.toolCalls.set(event.toolId, (acc.toolCalls.get(event.toolId) ?? 0) + 1);
    } else if (event.action === 'AI.TOOL_REFUSED') {
      acc.tools.refused += 1;
    } else if (event.action === 'AI.TOOL_FAILED') {
      acc.tools.failed += 1;
      if (event.code === 'TOOL_TIMEOUT') acc.tools.timeouts += 1;
    } else if (event.action === 'AI.TOOL_REPLAYED') {
      acc.tools.replayed += 1;
    }
  }

  for (const event of memoryAuditRows) {
    if (!event.agentKey) continue;
    if (options.agentKey && event.agentKey !== options.agentKey) continue;
    const acc = ensure(event.agentKey);
    if (event.action === 'AI.MEMORY_RECALLED' && event.source === 'RUN_CONTEXT') acc.memory.recalls += 1;
    else if (event.action === 'AI.MEMORY_RECORDED') acc.memory.recorded += 1;
    else if (event.action === 'AI.MEMORY_INTEGRITY_FAILED') acc.memory.integrityFailures += 1;
  }

  for (const row of memoryRowCounts) {
    if (options.agentKey && row.agentKey !== options.agentKey) continue;
    const acc = ensure(row.agentKey);
    if (row.kind === 'task_result') acc.memory.storedTaskResults += row.count;
    else acc.memory.ownerNotes += row.count;
  }

  for (const row of ledgerRows) {
    if (!row.agentKey) continue;
    if (options.agentKey && row.agentKey !== options.agentKey) continue;
    const acc = ensure(row.agentKey);
    const cost = Number(row.cost ?? '0');
    acc.costUsd += Number.isFinite(cost) && cost >= 0 ? cost : 0;
    acc.tokensIn += row.tokensInput ?? 0;
    acc.tokensOut += row.tokensOutput ?? 0;
    acc.requests += 1;
  }

  // Stalled is a PRESENT-STATE property, so it is not bounded by the report's
  // creation window: a task open for a week is exactly the one the GM must see,
  // not one that falls outside a 30-day chart. Measured from the row's own
  // timestamps, never inferred from the absence of an event.
  const stallCutoff = new Date(now - stallThreshold * 60_000);
  const stalledRows = await db
    .select({
      agentKey: agentTasks.agentKey,
      count: sql<number>`count(*)::int`,
      oldestMinutes: sql<number>`coalesce(max(floor(extract(epoch from (now() - coalesce(${agentTasks.startedAt}, ${agentTasks.createdAt}))) / 60)), 0)::int`,
    })
    .from(agentTasks)
    .where(
      and(
        inArray(agentTasks.status, ['queued', 'running', 'awaiting_approval']),
        sql`coalesce(${agentTasks.startedAt}, ${agentTasks.createdAt}) <= ${stallCutoff}`,
        options.agentKey ? eq(agentTasks.agentKey, options.agentKey) : undefined,
      ),
    )
    .groupBy(agentTasks.agentKey);
  for (const row of stalledRows) {
    const acc = ensure(row.agentKey);
    acc.stalled = {
      count: row.count,
      oldestAgeMinutes: row.oldestMinutes > 0 ? row.oldestMinutes : null,
      thresholdMinutes: stallThreshold,
    };
  }

  const tasksPerAgent = new Map<string, number>();
  for (const task of taskRows) tasksPerAgent.set(task.agentKey, (tasksPerAgent.get(task.agentKey) ?? 0) + 1);

  const registryName = new Map(registry.map((r) => [r.key, r.name]));
  const keys = new Set<string>();
  for (const key of perAgent.keys()) keys.add(key);
  if (options.agentKey) {
    for (const key of [...keys]) if (key !== options.agentKey) keys.delete(key);
  }
  if (keys.size === 0 && options.agentKey) keys.add(options.agentKey);

  const agents: AgentMetricsReport[] = [];
  for (const key of [...keys].sort()) {
    const acc = perAgent.get(key) ?? makeAcc();
    const settled = acc.execution.succeeded + acc.execution.failed + acc.execution.rejected;
    acc.execution.tasks = acc.taskIds.size;
    acc.execution.successRate = ratio(acc.execution.succeeded, settled);
    acc.execution.failureRate = ratio(acc.execution.failed, settled);
    acc.execution.rejectionRate = ratio(acc.execution.rejected, settled);

    let retriedTasks = 0;
    let maxAttempts = 0;
    for (const set of acc.attemptsByTask.values()) {
      if (set.size > 1) retriedTasks += 1;
      for (const a of set) maxAttempts = Math.max(maxAttempts, a);
    }

    const sorted = [...acc.durations].sort((a, b) => a - b);
    acc.latency = {
      measured: sorted.length,
      avgMs: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : null,
      medianMs: median(sorted),
      p95Ms: percentile(sorted, 95),
      slowRuns: sorted.filter((d) => d >= SLOW_RUN_THRESHOLD_MS).length,
    };

    acc.approvals.approvalRate = ratio(acc.approvals.approved, acc.decidedApprovals);
    acc.tools.topTools = [...acc.toolCalls.entries()]
      .map(([toolId, calls]) => ({ toolId, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 5);

    acc.memory.recallRate = ratio(acc.memory.recalls, acc.execution.tasks);

    const cost: CostStats =
      acc.requests > 0
        ? {
            status: 'available',
            reason: null,
            costUsd: acc.costUsd.toFixed(10),
            tokensInput: acc.tokensIn,
            tokensOutput: acc.tokensOut,
            requests: acc.requests,
          }
        : emptyCost();

    const quality: QualityStats = {
      storedResultRate: ratio(acc.storedResults, tasksPerAgent.get(key) ?? 0),
      humanRejectionRate: ratio(acc.rejectedApprovals, acc.decidedApprovals),
      businessOutcomes: 'unavailable',
      note: BUSINESS_OUTCOME_NOTE,
    };

    const stepsForAgent = stepRows.filter((s) => s.agentKey === key);
    const retries: RetryStats = {
      retriedTasks,
      attemptsPerTask: ratio(acc.execution.attempts, acc.execution.tasks),
      maxAttempts,
      retriedSteps: stepsForAgent.filter((s) => s.attemptCount > 1).length,
      exhaustedSteps: stepsForAgent.filter((s) => s.attemptCount >= s.maxAttempts && s.status === 'FAILED').length,
    };

    agents.push({
      agentKey: key,
      name: registryName.get(key) ?? key,
      execution: acc.execution,
      retries,
      latency: acc.latency,
      approvals: acc.approvals,
      tools: acc.tools,
      memory: acc.memory,
      cost,
      quality,
      compliance: {
        refusedRuns: acc.execution.blockedEvents,
        scopeFailures: acc.scopeFailures,
        toolRefusals: acc.tools.refused,
        memoryIntegrityFailures: acc.memory.integrityFailures,
      },
      stalled: acc.stalled,
      lastActivityAt: acc.lastActivity ? acc.lastActivity.toISOString() : null,
    });
  }

  // --- Overall roll-up ------------------------------------------------------
  const overallExecution = emptyExecution();
  const overallLatencyDurations: number[] = [];
  const overallTools = emptyTools();
  const overallToolCalls = new Map<string, number>();
  const overallMemory = emptyMemory();
  const overallApprovals = emptyApprovals();
  const overallCompliance = emptyCompliance();
  const overallStalled: StalledStats = { count: 0, oldestAgeMinutes: null, thresholdMinutes: stallThreshold };
  let overallStored = 0;
  let overallTasks = 0;
  let overallDecided = 0;
  let overallRejected = 0;
  let overallCost = 0;
  let overallTokensIn = 0;
  let overallTokensOut = 0;
  let overallRequests = 0;
  const overallTaskIds = new Set<string>();
  let overallRetriedTasks = 0;
  let overallMaxAttempts = 0;
  for (const a of agents) {
    overallExecution.attempts += a.execution.attempts;
    overallExecution.succeeded += a.execution.succeeded;
    overallExecution.failed += a.execution.failed;
    overallExecution.rejected += a.execution.rejected;
    overallExecution.blockedEvents += a.execution.blockedEvents;
    overallApprovals.requested += a.approvals.requested;
    overallApprovals.approved += a.approvals.approved;
    overallApprovals.rejected += a.approvals.rejected;
    overallApprovals.pending += a.approvals.pending;
    overallTools.executed += a.tools.executed;
    overallTools.refused += a.tools.refused;
    overallTools.failed += a.tools.failed;
    overallTools.timeouts += a.tools.timeouts;
    overallTools.replayed += a.tools.replayed;
    for (const t of a.tools.topTools) {
      overallToolCalls.set(t.toolId, (overallToolCalls.get(t.toolId) ?? 0) + t.calls);
    }
    overallMemory.recalls += a.memory.recalls;
    overallMemory.recorded += a.memory.recorded;
    overallMemory.storedTaskResults += a.memory.storedTaskResults;
    overallMemory.ownerNotes += a.memory.ownerNotes;
    overallMemory.integrityFailures += a.memory.integrityFailures;
    overallCompliance.refusedRuns += a.compliance.refusedRuns;
    overallCompliance.scopeFailures += a.compliance.scopeFailures;
    overallCompliance.toolRefusals += a.compliance.toolRefusals;
    overallCompliance.memoryIntegrityFailures += a.compliance.memoryIntegrityFailures;
    overallStalled.count += a.stalled.count;
    overallStalled.oldestAgeMinutes = Math.max(overallStalled.oldestAgeMinutes ?? 0, a.stalled.oldestAgeMinutes ?? 0);
    if (a.cost.status === 'available') {
      overallCost += Number(a.cost.costUsd ?? '0');
      overallTokensIn += a.cost.tokensInput ?? 0;
      overallTokensOut += a.cost.tokensOutput ?? 0;
      overallRequests += a.cost.requests;
    }
    overallRetriedTasks += a.retries.retriedTasks;
    overallMaxAttempts = Math.max(overallMaxAttempts, a.retries.maxAttempts);
  }
  for (const row of rows) {
    if (row.taskId) {
      overallTaskIds.add(row.taskId);
    }
    if (row.latencyMs > 0) overallLatencyDurations.push(row.latencyMs);
  }
  for (const task of taskRows) {
    overallTasks += 1;
    if (task.result !== null && task.result !== undefined) overallStored += 1;
    if (task.requiresApproval && (task.status === 'rejected' || task.approvedAt || (SUCCESS_STATUSES as readonly string[]).includes(task.status))) {
      overallDecided += 1;
      if (task.status === 'rejected') overallRejected += 1;
    }
  }
  overallExecution.tasks = overallTaskIds.size;
  const overallSettled = overallExecution.succeeded + overallExecution.failed + overallExecution.rejected;
  overallExecution.successRate = ratio(overallExecution.succeeded, overallSettled);
  overallExecution.failureRate = ratio(overallExecution.failed, overallSettled);
  overallExecution.rejectionRate = ratio(overallExecution.rejected, overallSettled);
  overallApprovals.approvalRate = ratio(overallApprovals.approved, overallDecided);
  overallMemory.recallRate = ratio(overallMemory.recalls, overallExecution.tasks);
  const overallSorted = overallLatencyDurations.sort((a, b) => a - b);

  const series = await buildSeries(db, { from, to, granularity, agentKey: options.agentKey, taskType: options.taskType });

  const distinctOwners = new Set(rows.map((r) => r.scopeOwner)).size;
  const tasksWithMetric = new Set(rows.filter((r) => r.taskId).map((r) => r.taskId as string)).size;
  const coveragePercent = ratio(tasksWithMetric, overallTasks);

  return {
    generatedAt: new Date().toISOString(),
    window: { from: from.toISOString(), to: to.toISOString(), granularity },
    filters: { agentKey: options.agentKey ?? null, taskType: options.taskType ?? null },
    overall: {
      execution: overallExecution,
      retries: {
        retriedTasks: overallRetriedTasks,
        attemptsPerTask: ratio(overallExecution.attempts, overallExecution.tasks),
        maxAttempts: overallMaxAttempts,
        retriedSteps: stepRows.filter((s) => s.attemptCount > 1).length,
        exhaustedSteps: stepRows.filter((s) => s.attemptCount >= s.maxAttempts && s.status === 'FAILED').length,
      },
      latency: {
        measured: overallSorted.length,
        avgMs: overallSorted.length ? Math.round(overallSorted.reduce((s, v) => s + v, 0) / overallSorted.length) : null,
        medianMs: median(overallSorted),
        p95Ms: percentile(overallSorted, 95),
        slowRuns: overallSorted.filter((d) => d >= SLOW_RUN_THRESHOLD_MS).length,
      },
      approvals: overallApprovals,
      tools: {
        ...overallTools,
        topTools: [...overallToolCalls.entries()]
          .map(([toolId, calls]) => ({ toolId, calls }))
          .sort((a, b) => b.calls - a.calls)
          .slice(0, 5),
      },
      memory: overallMemory,
      cost:
        overallRequests > 0
          ? {
              status: 'available',
              reason: null,
              costUsd: overallCost.toFixed(10),
              tokensInput: overallTokensIn,
              tokensOutput: overallTokensOut,
              requests: overallRequests,
            }
          : emptyCost(),
      quality: {
        storedResultRate: ratio(overallStored, overallTasks),
        humanRejectionRate: ratio(overallRejected, overallDecided),
        businessOutcomes: 'unavailable',
        note: BUSINESS_OUTCOME_NOTE,
      },
      compliance: overallCompliance,
      stalled: overallStalled,
    },
    agents,
    series,
    coverage: {
      tasksInWindow: overallTasks,
      tasksWithMetric,
      percent: coveragePercent,
      backfillRecommended: coveragePercent !== null && coveragePercent < 0.99 && overallTasks > 0,
    },
    integrity: {
      distinctOwners,
      eventsScanned: rows.length,
      truncated,
    },
    notes: [
      'Execution, retry and latency figures come from the append-only agent_metrics log; one row is one settled attempt.',
      'A task is counted once by its id; a retry is a new attempt, so retries are visible rather than overwritten.',
      'Approvals and stalled tasks are live agent_tasks state, not log rows.',
      'Cost is actual provider spend from ai_requests; when no ledger row exists the field is unavailable, never zero.',
      BUSINESS_OUTCOME_NOTE,
      'Per-owner breakdowns are not exposed; only a distinct-owner count is reported.',
      coveragePercent !== null && coveragePercent < 0.99
        ? 'Coverage is below 100%: tasks that settled before the log existed have no row yet. Run the backfill endpoint to close the gap.'
        : 'Coverage is complete for the window.',
      truncated ? `Event scan truncated at ${maxRows} rows; widen the window or narrow the agent filter.` : 'Event scan complete for the window.',
    ],
  };
}

/** Per-bucket series for charts. Same sources and the same honesty rules. */
export async function buildSeries(
  db: DB,
  options: { from: Date; to: Date; granularity: Granularity; agentKey?: string; taskType?: string },
): Promise<MetricsSeriesPoint[]> {
  const conditions = [gte(agentMetrics.createdAt, options.from), lte(agentMetrics.createdAt, options.to)];
  if (options.agentKey) conditions.push(eq(agentMetrics.agentKey, options.agentKey));
  if (options.taskType) conditions.push(eq(agentMetrics.taskType, options.taskType));

  const bucket = bucketExpr(options.granularity);
  const rows = await db
    .select({
      bucket,
      tasks: sql<number>`count(distinct ${agentMetrics.taskId})::int`,
      attempts: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'failed')::int`,
      rejected: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'rejected')::int`,
      blocked: sql<number>`count(*) filter (where ${agentMetrics.outcome} = 'blocked')::int`,
      latencySum: sql<number>`coalesce(sum(${agentMetrics.latencyMs}) filter (where ${agentMetrics.latencyMs} > 0), 0)::int`,
      latencyCount: sql<number>`count(*) filter (where ${agentMetrics.latencyMs} > 0)::int`,
    })
    .from(agentMetrics)
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  return rows.map((r) => {
    const settled = r.succeeded + r.failed + r.rejected;
    return {
      bucket: r.bucket,
      tasks: r.tasks,
      attempts: r.attempts,
      succeeded: r.succeeded,
      failed: r.failed,
      rejected: r.rejected,
      blocked: r.blocked,
      successRate: settled > 0 ? r.succeeded / settled : null,
      avgLatencyMs: r.latencyCount > 0 ? Math.round(r.latencySum / r.latencyCount) : null,
      // Cost per bucket is not read here: `ai_requests` carries no agent column,
      // only a metadata key, so a per-bucket cost would need a second scan. The
      // report exposes the exact window cost instead of a partial series.
      costUsd: null,
    };
  });
}

/**
 * Coverage check used by the API to tell the operator whether the log is
 * complete for a window — an honest "these numbers start on date X" instead of
 * a silently partial chart.
 */
export async function metricsCoverage(
  db: DB,
  options: { from: Date; to: Date; agentKey?: string },
): Promise<{ tasksInWindow: number; tasksWithMetric: number; percent: number | null; firstMetricAt: string | null }> {
  const taskConditions = [gte(agentTasks.createdAt, options.from), lte(agentTasks.createdAt, options.to)];
  if (options.agentKey) taskConditions.push(eq(agentTasks.agentKey, options.agentKey));
  const tasks = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(...taskConditions));

  const metricConditions = [gte(agentMetrics.createdAt, options.from), lte(agentMetrics.createdAt, options.to)];
  if (options.agentKey) metricConditions.push(eq(agentMetrics.agentKey, options.agentKey));
  const metrics = await db
    .select({ taskId: agentMetrics.taskId, createdAt: agentMetrics.createdAt })
    .from(agentMetrics)
    .where(and(...metricConditions));

  const withMetric = new Set(metrics.map((m) => m.taskId).filter((id): id is string => Boolean(id)));
  const taskIds = new Set(tasks.map((t) => t.id));
  let covered = 0;
  for (const id of withMetric) if (taskIds.has(id)) covered += 1;
  const first = metrics.reduce<Date | null>((acc, m) => (!acc || m.createdAt < acc ? m.createdAt : acc), null);
  return {
    tasksInWindow: taskIds.size,
    tasksWithMetric: covered,
    percent: taskIds.size > 0 ? covered / taskIds.size : null,
    firstMetricAt: first ? first.toISOString() : null,
  };
}

/** Audits a backfill so the log's own history is accountable. */
export async function auditBackfill(db: DB, audit: AuditContext, result: BackfillResult): Promise<void> {
  await writeAudit(db, audit, {
    action: 'AI.METRICS_BACKFILLED',
    entityType: 'AGENT_METRICS',
    metadata: { ...result },
  });
}

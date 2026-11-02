import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Agent Registry — declares the specialised WASIT agents and their
 * capabilities. It is a persistent, auditable catalogue (not a mock).
 */
export const agentRegistry = pgTable(
  'agent_registry',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    nameAr: varchar('name_ar', { length: 200 }),
    mission: text('mission'),
    category: varchar('category', { length: 40 }).notNull().default('general'),
    description: text('description'),
    capabilities: jsonb('capabilities').notNull(),
    /** Declarative tool allow-list. An executor may only reach data via these. */
    allowedTools: jsonb('allowed_tools').notNull().default([]),
    /** Actions from this agent that require an explicit human approval first. */
    approvalActions: jsonb('approval_actions').notNull().default([]),
    /** Deterministic per-run limits (cost, fanout, daily quotas, interval). */
    limits: jsonb('limits').notNull().default({}),
    /** Task types this agent is designed to handle. */
    taskTypes: jsonb('task_types').notNull().default([]),
    permissionsRequired: jsonb('permissions_required').notNull(),
    requiresHumanApproval: boolean('requires_human_approval').notNull().default(false),
    inputSchema: jsonb('input_schema'),
    /** Lifecycle: ACTIVE | PAUSED | DISABLED. A paused/disabled agent cannot run. */
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    /** The Copilot is the coordinator and is not counted among the 20 agents. */
    isCopilot: boolean('is_copilot').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentKeyIdx: index('agent_registry_key_idx').on(t.key),
  }),
);

/**
 * Agent Task — a deterministic execution of an agent on live data.
 * State machine: queued → running → succeeded | failed | awaiting_approval
 *                → approved | rejected  (+ blocked by kill switch/policy)
 * Human approval gates sensitive side effects (financial/admin actions).
 *
 * Idempotency: `dedupeKey` prevents the same logical task being queued twice
 * while an earlier instance is still open. Retry: `attempts`/`maxAttempts` with
 * an exponential `scheduledFor` backoff, plus `reapStaleTasks` for a watchdog.
 */
export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    requestedBy: varchar('requested_by', { length: 36 }).notNull(),
    /** The action/task-type being run; drives the approval + tool allow-list. */
    taskType: varchar('task_type', { length: 64 }),
    input: jsonb('input').notNull(),
    status: varchar('status', { length: 30 }).notNull().default('queued'),
    result: jsonb('result'),
    error: jsonb('error'),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    /** The specific approval action when requiresApproval is true. */
    approvalAction: varchar('approval_action', { length: 64 }),
    approvedBy: varchar('approved_by', { length: 36 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    /** Idempotency key: a second enqueue with the same open key returns the first. */
    dedupeKey: varchar('dedupe_key', { length: 200 }),
    /** Correlates a Copilot dispatch with the task(s) it spawned. */
    correlationId: varchar('correlation_id', { length: 36 }),
    triggeredBy: varchar('triggered_by', { length: 64 }).notNull().default('user'),
    priority: integer('priority').notNull().default(100),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    cost: varchar('cost', { length: 40 }).notNull().default('0'),
    model: varchar('model', { length: 100 }).notNull().default('local-heuristic'),
    latencyMs: integer('latency_ms').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorAt: timestamp('error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentTaskAgentIdx: index('agent_tasks_agent_idx').on(t.agentKey),
    agentTaskUserIdx: index('agent_tasks_user_idx').on(t.requestedBy),
    agentTaskStatusIdx: index('agent_tasks_status_idx').on(t.status),
    agentTaskDedupeIdx: index('agent_tasks_dedupe_idx').on(t.dedupeKey),
    // At most one *open* task per (owner, dedupe key). A partial index means a
    // terminal task (succeeded/failed/rejected/blocked) drops out and frees the
    // key for reuse, exactly as before. Scoping by `requested_by` also stops a
    // caller from colliding with — or reading — another owner's open task just
    // by guessing its key. NULL keys are never constrained.
    agentTaskDedupeOpenUidx: uniqueIndex('agent_tasks_dedupe_open_uidx')
      .on(t.requestedBy, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} not in ('succeeded', 'failed', 'rejected', 'blocked')`),
  }),
);

/**
 * Agent Schedule — periodic, deterministic jobs owned by an agent (the Copilot
 * delegates them). Kept inside the existing scheduler rather than a cron
 * framework; `intervalSeconds` drives the next due run and `lastRunAt` the
 * idempotent skip so two instances cannot double-run a due window.
 */
export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    taskType: varchar('task_type', { length: 64 }).notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(86400),
    payload: jsonb('payload').notNull().default({}),
    /** KILL SWITCH: when false the schedule is not dispatched. */
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastTaskId: varchar('last_task_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentScheduleAgentIdx: index('agent_schedules_agent_idx').on(t.agentKey),
    agentScheduleEnabledIdx: index('agent_schedules_enabled_idx').on(t.enabled),
  }),
);

/**
 * Agent Metric — an append-only record of how an agent task actually ended.
 *
 * This is a measurement log, not state: a row is written after a task reaches a
 * terminal outcome and never influences the task itself (no executor, approval
 * or state-machine reads it). It carries `scope_owner` — the requester of the
 * originating task — so per-tenant performance can be aggregated without ever
 * joining one owner's rows to another's. No business payload is stored here.
 */
export const agentMetrics = pgTable(
  'agent_metrics',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    /** The task this measurement came from (null for a synthetic sample). */
    taskId: varchar('task_id', { length: 36 }),
    taskType: varchar('task_type', { length: 64 }),
    /** Isolation key: the requester of the originating task (agent_tasks.requested_by). */
    scopeOwner: varchar('scope_owner', { length: 36 }).notNull(),
    /** Terminal outcome: succeeded | failed | blocked | refused. */
    outcome: varchar('outcome', { length: 20 }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    latencyMs: integer('latency_ms').notNull().default(0),
    /** Short machine code when outcome is not `succeeded` (e.g. NO_SCOPE, timeout). */
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentMetricAgentIdx: index('agent_metrics_agent_idx').on(t.agentKey),
    agentMetricOwnerIdx: index('agent_metrics_owner_idx').on(t.scopeOwner),
    agentMetricOutcomeIdx: index('agent_metrics_outcome_idx').on(t.outcome),
    agentMetricCreatedIdx: index('agent_metrics_created_idx').on(t.createdAt),
  }),
);

/**
 * Agent Memory — scoped, per-owner notes/learnings an agent accumulates.
 *
 * Strictly tenant-scoped: `scopeOwner` is NOT NULL and every read must filter by
 * it, so one owner's memory can never be read for another's benefit. It stores
 * only compact operational notes/learnings — never credentials, personal data or
 * raw business payloads. Nothing writes to this table yet; a later batch adds the
 * writer behind the central execution gate and the same scope rule.
 */
export const agentMemory = pgTable(
  'agent_memory',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    /** Isolation key — a memory row is only ever visible to its own owner. */
    scopeOwner: varchar('scope_owner', { length: 36 }).notNull(),
    /** note | learning | summary. */
    kind: varchar('kind', { length: 32 }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentMemoryAgentIdx: index('agent_memory_agent_idx').on(t.agentKey),
    agentMemoryOwnerIdx: index('agent_memory_owner_idx').on(t.scopeOwner),
    agentMemoryKindIdx: index('agent_memory_kind_idx').on(t.kind),
  }),
);
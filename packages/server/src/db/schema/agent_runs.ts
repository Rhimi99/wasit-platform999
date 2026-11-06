import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * AI-02.1 — Agent Runs & State Machine (foundational persistence only).
 *
 * An `agent_run` is ONE orchestration: a goal that will be decomposed into
 * several specialised agent steps. This layer deliberately contains NO planning
 * or dispatching logic (that is AI-02.2+); it only defines the durable shape of a
 * run, its steps, and the legal lifecycle states so later phases cannot invent
 * their own.
 *
 * Separation of identity (carried over from AI-01): a run and its steps are
 * always attributed to the human who requested them (`requestedBy`). The
 * `SYSTEM` actor used for automated *execution* in `audit_logs` is never
 * substituted for the requester here.
 */

/** Lifecycle of an orchestration run. */
export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'DRAFT',
  'PLANNING',
  'AWAITING_APPROVAL',
  'DISPATCHING',
  'RUNNING',
  'PAUSED',
  'AGGREGATING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/** Lifecycle of a single step inside a run. */
export const agentRunStepStatusEnum = pgEnum('agent_run_step_status', [
  'PENDING',
  'BLOCKED',
  'READY',
  'AWAITING_APPROVAL',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYING',
  'SKIPPED',
  'CANCELLED',
]);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /**
     * Caller-supplied idempotency key. Unique, so re-submitting the same goal
     * (a retried request, a duplicated webhook) can never open a second run.
     */
    runKey: varchar('run_key', { length: 128 }).notNull(),
    /** Short human-readable goal, e.g. "Launch product X in France". */
    title: varchar('title', { length: 300 }).notNull(),
    /** Longer context / instructions supplied by the General Manager. */
    description: text('description'),
    status: agentRunStatusEnum('status').notNull().default('DRAFT'),
    /** Human who requested the run. Never a SYSTEM placeholder. */
    requestedBy: varchar('requested_by', { length: 36 }).notNull(),
    /** Aggregated final summary once the run reaches a terminal state. */
    summary: jsonb('summary'),
    error: jsonb('error'),
    metadata: jsonb('metadata'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runKeyIdx: uniqueIndex('agent_runs_key_idx').on(t.runKey),
    requesterIdx: index('agent_runs_requester_idx').on(t.requestedBy),
    statusIdx: index('agent_runs_status_idx').on(t.status),
    createdIdx: index('agent_runs_created_idx').on(t.createdAt),
  }),
);

export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    /** Stable key of this step within its run, e.g. "market-research". */
    stepKey: varchar('step_key', { length: 64 }).notNull(),
    /**
     * Specialised agent this step will run. Validated against the catalogue by
     * the planning phase (AI-02.2), not by a DB constraint.
     */
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    status: agentRunStepStatusEnum('status').notNull().default('PENDING'),
    input: jsonb('input').notNull(),
    result: jsonb('result'),
    error: jsonb('error'),
    /** Higher runs first; kept >= 0 so ordering is well defined. */
    priority: integer('priority').notNull().default(0),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    /**
     * Keys of steps in the SAME run this step depends on (a small, explicit
     * list). Acyclicity is a run-level invariant enforced by the state-machine
     * helper, because a cycle across rows cannot be expressed as a row CHECK.
     */
    dependsOn: jsonb('depends_on').notNull().default(sql`'[]'::jsonb`),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    approvedBy: varchar('approved_by', { length: 36 }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One step key per run: the same step cannot be planned twice.
    runStepIdx: uniqueIndex('agent_run_steps_run_step_idx').on(t.runId, t.stepKey),
    runIdx: index('agent_run_steps_run_idx').on(t.runId),
    agentIdx: index('agent_run_steps_agent_idx').on(t.agentKey),
    statusIdx: index('agent_run_steps_status_idx').on(t.status),
    // A step always belongs to a real run. ON DELETE CASCADE: deleting a run
    // (only ever done for an unstarted run) removes its steps, never orphans.
    runFk: foreignKey({
      columns: [t.runId],
      foreignColumns: [agentRuns.id],
      name: 'agent_run_steps_run_id_fk',
    }).onDelete('cascade'),
    // Invalid numeric values are refused at the database, not just in code.
    priorityValid: check('agent_run_steps_priority_valid', sql`${t.priority} >= 0`),
    attemptsValid: check(
      'agent_run_steps_attempts_valid',
      sql`${t.attemptCount} >= 0 and ${t.maxAttempts} >= 1 and ${t.attemptCount} <= ${t.maxAttempts}`,
    ),
    // dependsOn must be a JSON array.
    dependsOnArray: check(
      'agent_run_steps_depends_on_array',
      sql`jsonb_typeof(${t.dependsOn}) = 'array'`,
    ),
  }),
);

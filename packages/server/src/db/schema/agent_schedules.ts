import { boolean, index, integer, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Agent Schedule — a persisted, periodic trigger for an agent task.
 *
 * The row is the source of truth, not the process memory: a server restart, a
 * crashed worker, or a second instance never loses a schedule. Execution is
 * claimed with a DB-level lease (see `leaseOwner`/`leaseExpiresAt`) so only one
 * worker runs a given due schedule at a time, even across instances.
 *
 * `createdBy` is the human administrator who created the schedule. Automated
 * runs are attributed to `SYSTEM` in the audit trail; the schedule keeps a
 * durable link to its creator so "who asked for this" is always answerable.
 */
export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    /** Optional task-type discriminator used by Copilot-authored schedules. */
    taskType: varchar('task_type', { length: 64 }),
    /** Agent input payload, validated against the agent's schema before a run. */
    input: jsonb('input').notNull(),
    /** Copilot/AI-layer payload for `taskType` schedules; mirrors `input`. */
    payload: jsonb('payload').notNull().default({}),
    /** Fixed cadence in minutes. Enforced >= the configured safe minimum. */
    intervalMinutes: integer('interval_minutes').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** UTC instant the schedule next becomes eligible to run. */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    /** UTC instant of the last successful claim (advance marker, not success). */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** Lease holder id (process/instance). Null when the schedule is free. */
    leaseOwner: varchar('lease_owner', { length: 64 }),
    /** When the current lease expires; an expired lease may be reclaimed. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Id of the most recent agent task created from this schedule. */
    lastTaskId: varchar('last_task_id', { length: 36 }),
    /** Human administrator who created the schedule. */
    createdBy: varchar('created_by', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('agent_schedules_due_idx').on(t.isActive, t.nextRunAt),
    agentIdx: index('agent_schedules_agent_idx').on(t.agentKey),
    creatorIdx: index('agent_schedules_creator_idx').on(t.createdBy),
  }),
);

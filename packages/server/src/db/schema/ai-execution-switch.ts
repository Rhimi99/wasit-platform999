import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Fleet-wide AI execution switches (WASIT-AI-KILLSWITCH-FLEET-01).
 *
 * One row per controlled scope, so every instance reads the same authority from
 * PostgreSQL instead of a per-process boolean:
 *   - `scope='GLOBAL', target_key='*'`  — the emergency stop for all AI work.
 *   - `scope='AGENT',  target_key=<key>` — a single agent stopped on its own.
 *
 * The global row is written by the migration (not a seed): its presence is an
 * invariant. A missing or unreadable row is treated as CONTROL_UNAVAILABLE and
 * fails closed, never as "open".
 *
 * `version` increments on every accepted change so concurrent operators can be
 * told which decision they overrode; `actor_id`/`reason`/`updated_at` keep the
 * provenance queryable without replaying the audit log.
 */
export const aiExecutionSwitches = pgTable(
  'ai_execution_switches',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    scope: varchar('scope', { length: 10 }).notNull(),
    targetKey: varchar('target_key', { length: 64 }).notNull(),
    stopped: boolean('stopped').notNull().default(false),
    reason: text('reason'),
    actorId: varchar('actor_id', { length: 36 }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeTargetIdx: uniqueIndex('ai_execution_switches_scope_target_idx').on(t.scope, t.targetKey),
    scopeChk: check('ai_execution_switches_scope_chk', sql`${t.scope} in ('GLOBAL', 'AGENT')`),
    targetChk: check(
      'ai_execution_switches_target_chk',
      sql`(${t.scope} = 'GLOBAL' and ${t.targetKey} = '*') or (${t.scope} = 'AGENT' and ${t.targetKey} <> '*')`,
    ),
  }),
);

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    description: text('description'),
    capabilities: jsonb('capabilities').notNull(),
    permissionsRequired: jsonb('permissions_required').notNull(),
    requiresHumanApproval: boolean('requires_human_approval').notNull().default(false),
    inputSchema: jsonb('input_schema'),
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
 * Human approval gates sensitive side effects (financial/admin actions).
 */
export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    agentKey: varchar('agent_key', { length: 64 }).notNull(),
    requestedBy: varchar('requested_by', { length: 36 }).notNull(),
    input: jsonb('input').notNull(),
    status: varchar('status', { length: 30 }).notNull().default('queued'),
    result: jsonb('result'),
    error: jsonb('error'),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    approvedBy: varchar('approved_by', { length: 36 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
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
  }),
);
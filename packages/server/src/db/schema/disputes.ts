import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const disputeStatusEnum = pgEnum('dispute_status', [
  'OPEN',
  'UNDER_REVIEW',
  'REQUESTED_FURTHER_EVIDENCE',
  'ESCALATED',
  'DECIDED',
  'CLOSED',
  'ARCHIVED',
]);

export const disputeEventTypeEnum = pgEnum('dispute_event_type', [
  'CREATED',
  'EVIDENCE_ADDED',
  'MESSAGE_ADDED',
  'STATUS_CHANGED',
  'ASSIGNED',
  'DECIDED',
  'REOPENED',
  'APPEALED',
]);

export const disputeDecisionEnum = pgEnum('dispute_decision', [
  'NONE',
  'IN_FAVOR_OF_BUYER',
  'IN_FAVOR_OF_SELLER',
  'SPLIT',
  'REJECTED',
]);

export const disputes = pgTable(
  'disputes',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    disputeNumber: varchar('dispute_number', { length: 40 }).notNull(),
    orderId: varchar('order_id', { length: 36 }).notNull(),
    openedById: varchar('opened_by_id', { length: 36 }).notNull(),
    reasonCode: varchar('reason_code', { length: 100 }).notNull(),
    description: text('description').notNull(),
    status: disputeStatusEnum('status').notNull().default('OPEN'),
    decision: disputeDecisionEnum('decision').notNull().default('NONE'),
    decisionNote: text('decision_note'),
    decidedBy: varchar('decided_by', { length: 36 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    assignedToId: varchar('assigned_to_id', { length: 36 }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    appealAllowed: boolean('appeal_allowed').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberIdx: uniqueIndex('disputes_number_idx').on(t.disputeNumber),
    orderIdx: index('disputes_order_idx').on(t.orderId),
    openedIdx: index('disputes_opened_idx').on(t.openedById),
    statusIdx: index('disputes_status_idx').on(t.status),
    assignedIdx: index('disputes_assigned_idx').on(t.assignedToId),
  }),
);

export const disputeEvents = pgTable(
  'dispute_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    disputeId: varchar('dispute_id', { length: 36 }).notNull(),
    actorId: varchar('actor_id', { length: 36 }),
    eventType: disputeEventTypeEnum('event_type').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    disputeIdx: index('dispute_events_dispute_idx').on(t.disputeId),
    actorIdx: index('dispute_events_actor_idx').on(t.actorId),
  }),
);

export const disputeMessages = pgTable(
  'dispute_messages',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    disputeId: varchar('dispute_id', { length: 36 }).notNull(),
    senderId: varchar('sender_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    isEvidence: boolean('is_evidence').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    disputeIdx: index('dispute_messages_dispute_idx').on(t.disputeId),
  }),
);

export const disputeEvidence = pgTable(
  'dispute_evidence',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    disputeId: varchar('dispute_id', { length: 36 }).notNull(),
    uploadedById: varchar('uploaded_by_id', { length: 36 }).notNull(),
    fileRef: text('file_ref').notNull(),
    description: text('description'),
    contentType: varchar('content_type', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    disputeIdx: index('dispute_evidence_dispute_idx').on(t.disputeId),
  }),
);

export const disputeAppeals = pgTable(
  'dispute_appeals',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    disputeId: varchar('dispute_id', { length: 36 }).notNull(),
    appealedById: varchar('appealed_by_id', { length: 36 }).notNull(),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 30 }).notNull().default('PENDING'),
    decidedBy: varchar('decided_by', { length: 36 }),
    decisionNote: text('decision_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    disputeIdx: index('dispute_appeals_dispute_idx').on(t.disputeId),
    statusIdx: index('dispute_appeals_status_idx').on(t.status),
  }),
);
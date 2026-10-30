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

export const threads = pgTable(
  'threads',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    // JSON array of participant user IDs
    participantIds: jsonb('participant_ids').notNull(),
    subject: varchar('subject', { length: 200 }),
    relatedEntityType: varchar('related_entity_type', { length: 60 }),
    relatedEntityId: varchar('related_entity_id', { length: 36 }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('threads_entity_idx').on(t.relatedEntityType, t.relatedEntityId),
  }),
);

export const threadParticipants = pgTable(
  'thread_participants',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    threadId: varchar('thread_id', { length: 36 }).notNull(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    isMuted: boolean('is_muted').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('thread_participants_thread_idx').on(t.threadId),
    userIdx: index('thread_participants_user_idx').on(t.userId),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    threadId: varchar('thread_id', { length: 36 }).notNull(),
    senderId: varchar('sender_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    messageType: varchar('message_type', { length: 40 }).notNull().default('TEXT'),
    status: varchar('status', { length: 20 }).notNull().default('SENT'),
    readAt: timestamp('read_at', { withTimezone: true }),
    attachments: jsonb('attachments'),
    isReported: boolean('is_reported').notNull().default(false),
    reportReason: text('report_reason'),
    isDeleted: boolean('is_deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('messages_thread_idx').on(t.threadId),
    senderIdx: index('messages_sender_idx').on(t.senderId),
    // A thread renders oldest-first; pair the sort with the thread filter.
    threadCreatedIdx: index('messages_thread_created_idx').on(t.threadId, t.createdAt),
  }),
);

export const notifications = pgTable(
  'notifications',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 60 }).notNull(),
    title: varchar('title', { length: 250 }).notNull(),
    body: text('body'),
    data: jsonb('data'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('notifications_user_idx').on(t.userId),
    readIdx: index('notifications_read_idx').on(t.userId, t.readAt),
    // The bell lists a user's notifications newest first; the userId index
    // alone leaves the sort to an in-memory pass.
    userCreatedIdx: index('notifications_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    channel: varchar('channel', { length: 30 }).notNull().default('IN_APP'),
    category: varchar('category', { length: 60 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('notification_prefs_user_idx').on(t.userId),
  }),
);

/**
 * Per-channel delivery ledger for lifecycle notifications.
 *
 * One row per (event, entity, recipient, channel). `dedupe_key` is unique, so a
 * repeated trigger (a webhook redelivery, a retried order transition) inserts
 * nothing and the send is a no-op — idempotency is enforced by the database, not
 * by a read-then-write race. `status` records the outcome: SENT (the transport
 * confirmed delivery), FAILED (all attempts exhausted), or SKIPPED (a channel
 * the user opted out of, or a real external channel not yet approved). A row is
 * written only after the attempt, so it is the durable signal of what actually
 * left the system.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    notificationId: varchar('notification_id', { length: 36 }),
    userId: varchar('user_id', { length: 36 }).notNull(),
    eventType: varchar('event_type', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 60 }),
    entityId: varchar('entity_id', { length: 36 }),
    channel: varchar('channel', { length: 30 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Template variables captured at queue time, replayed when the row is sent. */
    vars: jsonb('vars'),
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupeIdx: uniqueIndex('notification_deliveries_dedupe_idx').on(t.dedupeKey),
    userIdx: index('notification_deliveries_user_idx').on(t.userId),
    entityIdx: index('notification_deliveries_entity_idx').on(t.entityType, t.entityId),
    statusIdx: index('notification_deliveries_status_idx').on(t.status),
  }),
);
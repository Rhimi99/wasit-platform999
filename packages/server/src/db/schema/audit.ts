import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 36 }),
    action: varchar('action', { length: 120 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: varchar('entity_id', { length: 36 }),
    before: jsonb('before'),
    after: jsonb('after'),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index('audit_logs_actor_idx').on(t.actorId),
    entityIdx: index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    actionIdx: index('audit_logs_action_idx').on(t.action),
    createdIdx: index('audit_logs_created_idx').on(t.createdAt),
  }),
);

export const favorites = pgTable(
  'favorites',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: varchar('entity_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userEntityIdx: index('favorites_user_entity_idx').on(t.userId, t.entityType, t.entityId),
  }),
);

// Saved products/suppliers for buyer lists
export const savedItems = pgTable(
  'saved_items',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    itemType: varchar('item_type', { length: 40 }).notNull(),
    itemId: varchar('item_id', { length: 36 }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userItemIdx: index('saved_items_user_idx').on(t.userId),
  }),
);

// User search history
export const searchHistory = pgTable(
  'search_history',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    query: varchar('query', { length: 400 }).notNull(),
    filters: jsonb('filters'),
    resultsCount: varchar('results_count', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('search_history_user_idx').on(t.userId),
  }),
);
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const advertiserTypeEnum = pgEnum('advertiser_type', ['MERCHANT', 'SUPPLIER', 'COMPANY']);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
]);

export const campaignObjectiveEnum = pgEnum('campaign_objective', [
  'PRODUCT_ADS',
  'STORE_ADS',
  'SUPPLIER_ADS',
  'COMPANY_ADS',
  'B2B_ADS',
  'B2C_ADS',
  'TOP_ADS',
  'SPONSORED_SEARCH',
]);

export const campaigns = pgTable(
  'campaigns',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    advertiserId: varchar('advertiser_id', { length: 36 }).notNull(),
    advertiserType: advertiserTypeEnum('advertiser_type').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    objective: campaignObjectiveEnum('objective').notNull(),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),
    budget: numeric('budget', { precision: 18, scale: 4 }).notNull(),
    spent: numeric('spent', { precision: 18, scale: 4 }).notNull().default('0'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('TND'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    targeting: jsonb('targeting'),
    adUnits: jsonb('ad_units'),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    advertiserIdx: index('campaigns_advertiser_idx').on(t.advertiserId, t.advertiserType),
    statusIdx: index('campaigns_status_idx').on(t.status),
  }),
);

export const adCreatives = pgTable(
  'ad_creatives',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    campaignId: varchar('campaign_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 60 }).notNull(),
    title: varchar('title', { length: 250 }).notNull(),
    body: text('body'),
    mediaUrl: text('media_url'),
    targetUrl: text('target_url'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index('ad_creatives_campaign_idx').on(t.campaignId),
  }),
);

export const adEventTypeEnum = pgEnum('ad_event_type', ['IMPRESSION', 'CLICK', 'CONVERSION']);

export const adEvents = pgTable(
  'ad_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    campaignId: varchar('campaign_id', { length: 36 }).notNull(),
    creativeId: varchar('creative_id', { length: 36 }),
    eventType: adEventTypeEnum('event_type').notNull(),
    userId: varchar('user_id', { length: 36 }),
    sessionId: varchar('session_id', { length: 100 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index('ad_events_campaign_idx').on(t.campaignId, t.eventType),
    createdAtIdx: index('ad_events_created_idx').on(t.createdAt),
  }),
);
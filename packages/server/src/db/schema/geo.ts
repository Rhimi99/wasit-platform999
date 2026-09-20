import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const currencies = pgTable(
  'currencies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    code: varchar('code', { length: 3 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    symbol: varchar('symbol', { length: 10 }).notNull(),
    decimals: integer('decimals').notNull().default(2),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex('currencies_code_idx').on(t.code),
  }),
);

export const countries = pgTable(
  'countries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    code: varchar('code', { length: 2 }).notNull(),
    iso3: varchar('iso3', { length: 3 }),
    name: varchar('name', { length: 200 }).notNull(),
    nameAr: varchar('name_ar', { length: 200 }),
    nameFr: varchar('name_fr', { length: 200 }),
    phonePrefix: varchar('phone_prefix', { length: 10 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    defaultLanguage: varchar('default_language', { length: 10 }).notNull().default('ar'),
    isActive: boolean('is_active').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    // Policy-related fields per country
    policyConfig: text('policy_config'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex('countries_code_idx').on(t.code),
  }),
);

export const regions = pgTable(
  'regions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    countryId: varchar('country_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryIdx: index('regions_country_idx').on(t.countryId),
    nameIdx: index('regions_name_idx').on(t.name),
  }),
);

export const cities = pgTable(
  'cities',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    regionId: varchar('region_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    regionIdx: index('cities_region_idx').on(t.regionId),
    nameIdx: index('cities_name_idx').on(t.name),
  }),
);

// Exchange rates readiness
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    fromCode: varchar('from_code', { length: 3 }).notNull(),
    toCode: varchar('to_code', { length: 3 }).notNull(),
    rate: text('rate').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    source: varchar('source', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairIdx: index('exchange_rates_pair_idx').on(t.fromCode, t.toCode),
  }),
);

export const languages = pgTable(
  'languages',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    code: varchar('code', { length: 10 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    nativeName: varchar('native_name', { length: 100 }).notNull(),
    isRtl: boolean('is_rtl').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    codeIdx: uniqueIndex('languages_code_idx').on(t.code),
  }),
);
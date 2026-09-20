import {
  boolean,
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

// ---------- Profiles ----------
export const profiles = pgTable(
  'profiles',
  {
    userId: varchar('user_id', { length: 36 }).primaryKey(),
    displayName: varchar('display_name', { length: 150 }),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    countryId: varchar('country_id', { length: 36 }),
    cityId: varchar('city_id', { length: 36 }),
    defaultCurrencyId: varchar('default_currency_id', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryIdx: index('profiles_country_idx').on(t.countryId),
  }),
);

export const purchaseIntent = pgEnum('purchase_intent', ['B2B', 'B2C']);

// ---------- Suppliers ----------
export const suppliers = pgTable(
  'suppliers',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    companyName: varchar('company_name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 250 }).notNull(),
    countryId: varchar('country_id', { length: 36 }),
    cityId: varchar('city_id', { length: 36 }),
    description: text('description'),
    logoUrl: text('logo_url'),
    verified: boolean('verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('suppliers_user_idx').on(t.userId),
    slugIdx: uniqueIndex('suppliers_slug_idx').on(t.slug),
    countryIdx: index('suppliers_country_idx').on(t.countryId),
  }),
);

export const supplierContacts = pgTable(
  'supplier_contacts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    supplierId: varchar('supplier_id', { length: 36 }).notNull(),
    fullName: varchar('full_name', { length: 150 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    position: varchar('position', { length: 100 }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => ({
    supplierIdx: index('supplier_contacts_supplier_idx').on(t.supplierId),
  }),
);

// ---------- Merchants ----------
export const merchants = pgTable(
  'merchants',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    storeName: varchar('store_name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 250 }).notNull(),
    countryId: varchar('country_id', { length: 36 }),
    cityId: varchar('city_id', { length: 36 }),
    description: text('description'),
    logoUrl: text('logo_url'),
    verified: boolean('verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('merchants_user_idx').on(t.userId),
    slugIdx: uniqueIndex('merchants_slug_idx').on(t.slug),
    countryIdx: index('merchants_country_idx').on(t.countryId),
  }),
);

// ---------- Companies ----------
export const companies = pgTable(
  'companies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    legalName: varchar('legal_name', { length: 250 }).notNull(),
    slug: varchar('slug', { length: 250 }).notNull(),
    registrationNumber: varchar('registration_number', { length: 100 }),
    taxId: varchar('tax_id', { length: 100 }),
    countryId: varchar('country_id', { length: 36 }),
    cityId: varchar('city_id', { length: 36 }),
    industry: varchar('industry', { length: 150 }),
    description: text('description'),
    logoUrl: text('logo_url'),
    verified: boolean('verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('companies_user_idx').on(t.userId),
    slugIdx: uniqueIndex('companies_slug_idx').on(t.slug),
    countryIdx: index('companies_country_idx').on(t.countryId),
  }),
);

export const companyBranches = pgTable(
  'company_branches',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    companyId: varchar('company_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    address: text('address'),
    countryId: varchar('country_id', { length: 36 }),
    cityId: varchar('city_id', { length: 36 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('company_branches_company_idx').on(t.companyId),
  }),
);
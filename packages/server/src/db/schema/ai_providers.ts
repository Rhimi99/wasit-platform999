import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * AI provider configuration, scoped per deployment environment.
 *
 * A secret is never stored in plaintext: `secret_ciphertext` holds an
 * AES-256-GCM envelope sealed with a master key that lives outside the database
 * (`AI_SECRET_ENCRYPTION_KEY`). Providers whose key lives in an environment
 * variable store only the variable *name* (`key_env_var`).
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /** production | staging | development | test — config never crosses these. */
    environment: varchar('environment', { length: 20 }).notNull(),
    providerKey: varchar('provider_key', { length: 50 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    isFallback: boolean('is_fallback').notNull().default(false),
    model: varchar('model', { length: 100 }).notNull().default(''),
    baseUrl: varchar('base_url', { length: 300 }),
    /** NONE | ENV | DB */
    keySource: varchar('key_source', { length: 20 }).notNull().default('NONE'),
    keyEnvVar: varchar('key_env_var', { length: 100 }),
    secretCiphertext: text('secret_ciphertext'),
    /** Salted-free SHA-256 prefix of the stored secret, for rotation checks only. */
    secretFingerprint: varchar('secret_fingerprint', { length: 32 }),
    secretUpdatedAt: timestamp('secret_updated_at', { withTimezone: true }),
    /** NEVER | OK | FAILED | CONFIG_ONLY | BLOCKED */
    lastTestStatus: varchar('last_test_status', { length: 30 }).notNull().default('NEVER'),
    lastTestMode: varchar('last_test_mode', { length: 20 }),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestDetail: jsonb('last_test_detail'),
    updatedBy: varchar('updated_by', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    envProviderUidx: uniqueIndex('ai_providers_env_provider_uidx').on(t.environment, t.providerKey),
    envIdx: index('ai_providers_env_idx').on(t.environment),
    envDefaultUidx: uniqueIndex('ai_providers_env_default_uidx')
      .on(t.environment)
      .where(sql`${t.isDefault}`),
  }),
);

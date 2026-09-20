import { sql } from 'drizzle-orm';
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

export const userRoleEnum = pgEnum('user_role', [
  'CUSTOMER',
  'MERCHANT',
  'SUPPLIER',
  'COMPANY',
  'MARKETER',
  'SUPPORT',
  'RISK',
  'DISPUTE',
  'ADMIN',
  'SUPER_ADMIN',
]);

export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    phone: varchar('phone', { length: 32 }),
    passwordHash: text('password_hash').notNull(),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    emailVerified: boolean('email_verified').notNull().default(false),
    phoneVerified: boolean('phone_verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    isLocked: boolean('is_locked').notNull().default(false),
    locale: varchar('locale', { length: 10 }).notNull().default('ar'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    phoneIdx: index('users_phone_idx').on(t.phone),
  }),
);

export const roles = pgTable(
  'roles',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    description: text('description'),
    system: boolean('system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('roles_name_idx').on(t.name),
  }),
);

export const permissions = pgTable(
  'permissions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('permissions_name_idx').on(t.name),
  }),
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    roleId: varchar('role_id', { length: 36 }).notNull(),
    permissionId: varchar('permission_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rolePermIdx: uniqueIndex('role_perm_idx').on(t.roleId, t.permissionId),
    roleIdx: index('role_permissions_role_idx').on(t.roleId),
  }),
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    roleId: varchar('role_id', { length: 36 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userRoleIdx: uniqueIndex('user_role_idx').on(t.userId, t.roleId),
    roleUserIdx: index('user_roles_role_idx').on(t.roleId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    tokenHashIdx: index('sessions_token_hash_idx').on(t.tokenHash),
  }),
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('evt_user_idx').on(t.userId),
    tokenHashIdx: index('evt_token_idx').on(t.tokenHash),
  }),
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('prt_user_idx').on(t.userId),
    tokenHashIdx: index('prt_token_idx').on(t.tokenHash),
  }),
);

// Phone (SMS) verification. Only a hash of the 6-digit code is stored; the
// attempt counter caps brute-force guessing before expiry.
export const phoneVerificationTokens = pgTable(
  'phone_verification_tokens',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('pvt_user_idx').on(t.userId),
    tokenHashIdx: index('pvt_token_idx').on(t.tokenHash),
  }),
);

// Two-factor authentication
export const authenticatorApp = pgTable(
  'authenticator_apps',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    recoveryCodesHash: text('recovery_codes_hash'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('authenticator_user_idx').on(t.userId),
  }),
);

// Pending second-factor challenges issued after a correct password when the
// account has MFA enabled. Only a hash of the challenge token is stored; the
// row is single-use (consumedAt) and short-lived (expiresAt).
export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('mfa_challenges_user_idx').on(t.userId),
    tokenHashIdx: index('mfa_challenges_token_hash_idx').on(t.tokenHash),
  }),
);

// Security settings per user
export const securitySettings = pgTable(
  'security_settings',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    require2FA: boolean('require_2fa').notNull().default(false),
    loginNotifications: boolean('login_notifications').notNull().default(false),
    deviceTracking: boolean('device_tracking').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('security_settings_user_idx').on(t.userId),
  }),
);

// Consent record (privacy)
export const consents = pgTable(
  'consents',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    consentType: varchar('consent_type', { length: 100 }).notNull(),
    granted: boolean('granted').notNull().default(false),
    givenAt: timestamp('given_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userConsentIdx: uniqueIndex('consent_user_type_idx').on(t.userId, t.consentType),
  }),
);
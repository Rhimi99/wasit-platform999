import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Delegated read access to the security centre (WCDC-02).
 *
 * The GM's decision: `SECURITY_READ` belongs to `SUPER_ADMIN` alone, and an
 * `ADMIN` may read the centre only through an explicit, scoped, expiring grant
 * that a named `SUPER_ADMIN` issued. Nothing here changes `user_roles`: the
 * grant is consulted on every request, so revoking it takes effect on the next
 * call rather than at the next login.
 *
 * Only reads are delegated. Containment keeps its own permissions and its own
 * second-approval rule, which a grant can never satisfy.
 */
export const securityReadGrants = pgTable(
  'security_read_grants',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /** The beneficiary: must hold ADMIN at issue time, and never SUPER_ADMIN. */
    adminUserId: varchar('admin_user_id', { length: 36 }).notNull(),
    /**
     * Read surfaces this grant opens (`overview`, `incidents`, `events`,
     * `actions`, `blocks`, `rules`, `sessions`, `external`). Validated against
     * the same list the routes use, so a typo cannot widen anything.
     */
    scopes: text('scopes').array().notNull(),
    /** Why the GM issued it; required and shown in the audit trail. */
    reason: text('reason').notNull(),
    /** The SUPER_ADMIN who issued it. Never the beneficiary. */
    grantedById: varchar('granted_by_id', { length: 36 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastAmendedById: varchar('last_amended_by_id', { length: 36 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: varchar('revoked_by_id', { length: 36 }),
    /** Set by the sweep when the clock passes `expires_at`, never by hand. */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    adminIdx: index('security_read_grants_admin_idx').on(t.adminUserId),
    /** A beneficiary has at most one live grant: amend it, do not stack them. */
    oneLiveIdx: uniqueIndex('security_read_grants_one_live_idx')
      .on(t.adminUserId)
      .where(sql`revoked_at IS NULL AND expired_at IS NULL`),
    expiryIdx: index('security_read_grants_expiry_idx').on(t.expiresAt),
  }),
);

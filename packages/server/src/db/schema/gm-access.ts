import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Break-glass authorisation tickets (GM-ACCESS-01).
 *
 * A ticket is minted ONLY by the local operator CLI (`scripts/gm-access.ts`),
 * never by an HTTP route: possessing shell access plus database credentials is
 * the proof of deployment ownership. It authorises exactly one thing — letting a
 * named SUPER_ADMIN whose mailbox cannot receive the verification link pass that
 * gate once — and it never resets a password, changes a role, or opens a session
 * on its own. Only a hash is stored, the row is single-use (`consumedAt`), short
 * lived (`expiresAt`) and attempt-capped, so a leaked database cannot mint or
 * replay one.
 */
export const gmAccessTickets = pgTable(
  'gm_access_tickets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Operator-supplied justification; required, shown in the audit trail. */
    reason: text('reason').notNull(),
    /** OS account that ran the CLI (never an HTTP-supplied value). */
    issuedBy: varchar('issued_by', { length: 120 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('gm_access_tickets_token_hash_idx').on(t.tokenHash),
    userIdx: index('gm_access_tickets_user_idx').on(t.userId),
  }),
);

/**
 * Remembers that a given SUPER_ADMIN has completed the operator-assisted
 * bootstrap once, so the flow cannot be replayed later to "re-prove" anything.
 * Kept separate from the ticket row so deleting expired tickets never erases the
 * fact that a recovery happened (the audit log holds the durable copy).
 */
export const gmAccessRecoveries = pgTable(
  'gm_access_recoveries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 36 }).notNull(),
    ticketId: varchar('ticket_id', { length: 36 }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    /** True when the account already held a confirmed factor at recovery time. */
    hadFactor: boolean('had_factor').notNull().default(false),
  },
  (t) => ({
    userIdx: index('gm_access_recoveries_user_idx').on(t.userId),
  }),
);

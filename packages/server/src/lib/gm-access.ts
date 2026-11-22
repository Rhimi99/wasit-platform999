import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../db/client';
import { authenticatorApp, users } from '../db/schema/auth';
import { gmAccessRecoveries, gmAccessTickets } from '../db/schema/gm-access';
import { newId } from './ids';
import { hashToken } from './security';
import { writeAudit } from './audit';

/**
 * GM-ACCESS-01 — operator-assisted access recovery for the general manager.
 *
 * The general manager's account can only be reached through the local operator
 * CLI: there is no HTTP route that mints a ticket, no shared password, no role
 * change and no password reset. See `docs/GM-ACCESS-01.md` for the procedure and
 * AD-058 for the decision.
 */

/** A ticket is valid for one bootstrap attempt, not for a working day. */
export const GM_TICKET_TTL_MINUTES = 15;
/** Wrong-password attempts against one ticket before it must be re-minted. */
export const GM_TICKET_MAX_ATTEMPTS = 3;

export interface IssuedGmTicket {
  ticket: string;
  ticketId: string;
  expiresAt: Date;
  userId: string;
  email: string;
}

/** The single-use secret a caller must present alongside the password. */
function mintTicket(): string {
  // 32 bytes of CSPRNG output, base64url: far beyond guessing, and it is only
  // ever shown once on the operator's own terminal.
  return randomBytes(32).toString('base64url');
}

/**
 * Issues a recovery ticket for one SUPER_ADMIN account.
 *
 * Callers are the local CLI only. The role check lives here rather than in the
 * CLI so no caller can widen it: a ticket for a CUSTOMER, MERCHANT, ADMIN or any
 * other staff role is refused outright, which is what keeps this from becoming a
 * privilege-escalation primitive.
 */
export async function issueGmAccessTicket(
  db: DB,
  input: { email: string; reason: string; issuedBy: string },
): Promise<IssuedGmTicket> {
  const email = input.email.trim().toLowerCase();
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw ApiError.validation(
      [{ field: 'reason', message: 'Give a reason of at least 10 characters (it is audited)', code: 'REQUIRED' }],
      'A recovery reason of at least 10 characters is required',
    );
  }

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Account');
  const user = rows[0];
  if (!user.isActive) throw ApiError.validation([{ field: 'email', message: 'Account is disabled', code: 'INACTIVE' }], 'Account is disabled');

  const roleRows = await db.execute(sql`
    select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${user.id}
  `);
  const roles = ((roleRows as unknown as { rows?: { name: string }[] }).rows ?? (roleRows as unknown as { name: string }[])).map((r) => r.name);
  if (!roles.includes('SUPER_ADMIN')) {
    // Deliberately the same message for "not a SUPER_ADMIN" and "no such role":
    // the operator already knows the address, so there is nothing to protect —
    // but the refusal must be explicit in the audit trail.
    await writeAudit(db, { actorId: null, ipAddress: null, userAgent: null }, {
      action: 'GM_ACCESS.TICKET_REFUSED',
      entityType: 'USER',
      entityId: user.id,
      metadata: { reason: 'NOT_SUPER_ADMIN', issuedBy: input.issuedBy },
    });
    throw ApiError.forbidden('Recovery tickets are limited to SUPER_ADMIN accounts');
  }

  // A confirmed factor already satisfies the login gate, so a ticket would add
  // nothing but an attack surface. Refuse instead of quietly minting one.
  if (await hasConfirmedSecondFactor(db, user.id)) {
    await writeAudit(db, { actorId: null, ipAddress: null, userAgent: null }, {
      action: 'GM_ACCESS.TICKET_REFUSED',
      entityType: 'USER',
      entityId: user.id,
      metadata: { reason: 'FACTOR_ALREADY_CONFIRMED', issuedBy: input.issuedBy },
    });
    throw ApiError.validation(
      [{ field: 'email', message: 'Account already has a confirmed second factor', code: 'FACTOR_CONFIRMED' }],
      'This account already has a confirmed second factor; use reset-factor if the device is lost',
    );
  }

  // One live ticket per account: minting a new one retires the old, so a ticket
  // read from a terminal scrollback cannot be used after a newer one exists.
  await db
    .update(gmAccessTickets)
    .set({ revokedAt: new Date() })
    .where(and(eq(gmAccessTickets.userId, user.id), isNull(gmAccessTickets.consumedAt), isNull(gmAccessTickets.revokedAt)));

  const ticket = mintTicket();
  const expiresAt = new Date(Date.now() + GM_TICKET_TTL_MINUTES * 60_000);
  const ticketId = newId();
  await db.insert(gmAccessTickets).values({
    id: ticketId,
    userId: user.id,
    tokenHash: hashToken(ticket),
    reason,
    issuedBy: input.issuedBy,
    expiresAt,
  });

  // The audit row records WHO and WHY, never the ticket itself.
  await writeAudit(db, { actorId: null, ipAddress: null, userAgent: null }, {
    action: 'GM_ACCESS.TICKET_ISSUED',
    entityType: 'USER',
    entityId: user.id,
    metadata: { ticketId, issuedBy: input.issuedBy, reason, expiresAt: expiresAt.toISOString() },
  });

  return { ticket, ticketId, expiresAt, userId: user.id, email: user.email };
}

export interface GmTicketOutcome {
  ok: boolean;
  ticketId?: string;
  reason?: 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED' | 'REVOKED' | 'TOO_MANY_ATTEMPTS';
}

/**
 * Checks and consumes a ticket for one account.
 *
 * The update is conditional (`consumed_at IS NULL`, unexpired, not revoked), so
 * two concurrent logins cannot both consume the same ticket: the loser's update
 * matches no row and is refused. The attempt counter is incremented in SQL for
 * the same reason the MFA challenge counter is — parallel guesses must not be
 * able to slip past the cap.
 */
export async function consumeGmAccessTicket(db: DB, userId: string, ticket: string): Promise<GmTicketOutcome> {
  const tokenHash = hashToken(ticket.trim());
  const rows = await db.select().from(gmAccessTickets).where(eq(gmAccessTickets.tokenHash, tokenHash)).limit(1);
  if (rows.length === 0) return { ok: false, reason: 'NOT_FOUND' };
  const row = rows[0];
  if (row.userId !== userId) return { ok: false, reason: 'NOT_FOUND' };
  if (row.revokedAt) return { ok: false, reason: 'REVOKED' };
  if (row.consumedAt) return { ok: false, reason: 'CONSUMED' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED' };
  if (row.attempts >= GM_TICKET_MAX_ATTEMPTS) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };

  const consumed = await db
    .update(gmAccessTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(gmAccessTickets.id, row.id),
        isNull(gmAccessTickets.consumedAt),
        isNull(gmAccessTickets.revokedAt),
        sql`${gmAccessTickets.expiresAt} > now()`,
      ),
    )
    .returning({ id: gmAccessTickets.id });
  if (consumed.length === 0) return { ok: false, reason: 'CONSUMED' };
  return { ok: true, ticketId: row.id };
}

/** Records a rejected ticket attempt so repeated guesses hit the cap. */
export async function registerGmTicketFailure(db: DB, ticket: string): Promise<void> {
  const tokenHash = hashToken(ticket.trim());
  await db
    .update(gmAccessTickets)
    .set({ attempts: sql`${gmAccessTickets.attempts} + 1` })
    .where(and(eq(gmAccessTickets.tokenHash, tokenHash), isNull(gmAccessTickets.consumedAt)));
}

/**
 * True when the account holds a confirmed authenticator factor.
 *
 * Used by the login gate: a confirmed factor is proof of control that is at
 * least as strong as a mailbox, so it satisfies email verification. The check is
 * per account and requires `enabled` AND `confirmedAt`, so a half-finished
 * enrollment (secret generated, never confirmed) never counts.
 */
export async function hasConfirmedSecondFactor(db: DB, userId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: authenticatorApp.enabled, confirmedAt: authenticatorApp.confirmedAt })
    .from(authenticatorApp)
    .where(eq(authenticatorApp.userId, userId))
    .limit(1);
  return rows.length > 0 && rows[0].enabled === true && rows[0].confirmedAt !== null;
}

/** Marks a completed recovery; the audit log keeps the durable copy. */
export async function recordGmRecovery(
  db: DB,
  input: { userId: string; ticketId: string | null; hadFactor: boolean },
): Promise<void> {
  await db.insert(gmAccessRecoveries).values({
    id: newId(),
    userId: input.userId,
    ticketId: input.ticketId,
    hadFactor: input.hadFactor,
  });
}

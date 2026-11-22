/**
 * Operator CLI: recover access to the general manager account (GM-ACCESS-01).
 *
 * This is the only way to obtain a recovery ticket. There is deliberately no
 * HTTP route that mints one: the proof of authority is shell access to the
 * deployment plus the database credentials it already holds, which is exactly
 * what the person who owns the platform has. Nothing here resets a password,
 * grants a role or opens a session.
 *
 * Usage (run on the server, from packages/server):
 *
 *   npm run gm:access -- issue --email owner@example.com --reason "Lost authenticator, verified by phone"
 *   npm run gm:access -- reset-factor --email owner@example.com --reason "Authenticator device lost"
 *   npm run gm:access -- status --email owner@example.com
 *
 * Every action requires `--confirm`; without it the command only explains what
 * it would do. The ticket is printed once, to this terminal, and is valid for 15
 * minutes and one use. It is never written to a file, a log or the audit trail.
 */
import { eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client';
import { authenticatorApp, users } from '../db/schema/auth';
import { gmAccessTickets } from '../db/schema/gm-access';
import { issueGmAccessTicket, hasConfirmedSecondFactor, GM_TICKET_TTL_MINUTES } from '../lib/gm-access';
import { revokeAllSessionsForUser } from '../lib/session-admin';
import { writeAudit } from '../lib/audit';
import { ApiError } from '@wasit/shared';

type Action = 'issue' | 'reset-factor' | 'status';

interface Args {
  action: Action;
  email: string;
  reason: string;
  confirm: boolean;
}

function usage(): never {
  console.error(
    [
      'Usage: npm run gm:access -- <issue|reset-factor|status> --email <address> [--reason "..."] [--confirm]',
      '',
      '  issue          mint a single-use ticket that satisfies the email-verification',
      '                 gate once at login (valid 15 minutes)',
      '  reset-factor   remove a lost authenticator so the account can enrol a new one',
      '                 at its next sign-in; sessions are revoked, password untouched',
      '  status         show whether the account exists, its factor state and any',
      '                 live ticket (no secrets printed)',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const [action, ...rest] = argv;
  if (!action || !['issue', 'reset-factor', 'status'].includes(action)) usage();
  let email = '';
  let reason = '';
  let confirm = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--email') email = rest[++i] ?? '';
    else if (arg === '--reason') reason = rest[++i] ?? '';
    else if (arg === '--confirm') confirm = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else if (arg.startsWith('--reason=')) reason = arg.slice('--reason='.length);
    else usage();
  }
  if (!email) usage();
  return { action: action as Action, email, reason, confirm };
}

function operatorName(): string {
  return process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown-operator';
}

async function loadSuperAdmin(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'No account with that address');
  const user = rows[0];
  const roleRows = await db.execute(sql`
    select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${user.id}
  `);
  const roles = ((roleRows as unknown as { rows?: { name: string }[] }).rows ?? (roleRows as unknown as { name: string }[])).map(
    (r) => r.name,
  );
  if (!roles.includes('SUPER_ADMIN')) {
    throw new ApiError(403, 'FORBIDDEN', 'This account is not a SUPER_ADMIN; this tool is limited to the general manager');
  }
  return user;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const user = await loadSuperAdmin(args.email);
  const hasFactor = await hasConfirmedSecondFactor(db, user.id);

  if (args.action === 'status') {
    const live = await db
      .select({ id: gmAccessTickets.id, expiresAt: gmAccessTickets.expiresAt })
      .from(gmAccessTickets)
      .where(sql`${gmAccessTickets.userId} = ${user.id} and ${gmAccessTickets.consumedAt} is null and ${gmAccessTickets.revokedAt} is null and ${gmAccessTickets.expiresAt} > now()`);
    console.log(`account:        ${user.email}`);
    console.log(`active:         ${user.isActive}`);
    console.log(`email verified: ${user.emailVerified}`);
    console.log(`second factor:  ${hasFactor ? 'confirmed' : 'not enrolled'}`);
    console.log(`live tickets:   ${live.length}`);
    if (live.length > 0) {
      for (const t of live) console.log(`  ticket ${t.id} expires ${t.expiresAt.toISOString()}`);
    }
    return;
  }

  if (!args.confirm) {
    console.log(`Would ${args.action} access for ${user.email} (second factor: ${hasFactor ? 'confirmed' : 'not enrolled'}).`);
    console.log('Re-run with --confirm to proceed.');
    process.exitCode = 2;
    return;
  }

  if (args.action === 'issue') {
    if (hasFactor) {
      // A confirmed factor already satisfies the login gate, so a ticket would
      // add nothing but risk. Point the operator at the honest alternatives.
      console.error('This account already has a confirmed second factor; it does not need a recovery ticket.');
      console.error('If the device is lost, use `reset-factor`, then sign in with the password and enrol again.');
      process.exitCode = 2;
      return;
    }
    const issued = await issueGmAccessTicket(db, {
      email: user.email,
      reason: args.reason,
      issuedBy: operatorName(),
    });
    console.log('Recovery ticket (single use, shown once, valid 15 minutes):');
    console.log('');
    console.log(`  ${issued.ticket}`);
    console.log('');
    console.log(`account: ${issued.email}`);
    console.log(`expires: ${issued.expiresAt.toISOString()} (${GM_TICKET_TTL_MINUTES} minutes)`);
    console.log('');
    console.log('Give it to the account holder over a channel you trust. Enter it in the');
    console.log('"recovery ticket" field on the sign-in screen together with the password.');
    console.log('This ticket does not reset the password and does not bypass a second factor.');
    return;
  }

  if (args.action === 'reset-factor') {
    const removed = await db
      .delete(authenticatorApp)
      .where(eq(authenticatorApp.userId, user.id))
      .returning({ id: authenticatorApp.id });
    const revoked = await revokeAllSessionsForUser(db, user.id);
    await writeAudit(db, { actorId: null, ipAddress: null, userAgent: null }, {
      action: 'GM_ACCESS.FACTOR_RESET',
      entityType: 'USER',
      entityId: user.id,
      metadata: { removedFactors: removed.length, sessionsRevoked: revoked, issuedBy: operatorName(), reason: args.reason },
    });
    console.log(`Removed ${removed.length} authenticator record(s) and revoked ${revoked} session(s).`);
    console.log('The password was NOT changed. The account must sign in and enrol a new factor.');
    return;
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof ApiError) {
      console.error(`Refused [${err.code}]: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error('gm:access failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

/**
 * Operator CLI: recover access to the general manager account (GM-ACCESS-01).
 *
 * This is the only way to obtain a recovery ticket. There is deliberately no
 * HTTP route that mints one: the proof of authority is shell access to the
 * deployment plus the database credentials it already holds, which is exactly
 * what the person who owns the platform has. Nothing here grants a role, opens a
 * session, or bypasses a second factor; the one credential operation it offers
 * (`set-password`) replaces the password of a single SUPER_ADMIN account and
 * invalidates that account's sessions.
 *
 * Usage (run on the server, from packages/server):
 *
 *   npm run gm:access -- status --email owner@example.com
 *   npm run gm:access -- issue --email owner@example.com --reason "Lost authenticator, verified by phone"
 *   npm run gm:access -- reset-factor --email owner@example.com --reason "Authenticator device lost"
 *   npm run gm:access -- set-password --email owner@example.com --reason "Rotating a leaked credential" --generate
 *   npm run gm:access -- set-password --email owner@example.com --reason "..." --password-file /path/to/secret
 *
 * Every action requires `--confirm`; without it the command only explains what
 * it would do. The ticket is printed once, to this terminal, and is valid for 15
 * minutes and one use. It is never written to a file, a log or the audit trail.
 *
 * `set-password` never accepts a password on the command line (argv is visible
 * in `ps` and in shell history) and never prints one. It either generates a
 * 32-character password and writes it to a 0600 file outside the repository, or
 * reads one from an existing 0600 file. See docs/GM-ACCESS-02.md.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client';
import { authenticatorApp, users } from '../db/schema/auth';
import { gmAccessTickets } from '../db/schema/gm-access';
import {
  issueGmAccessTicket,
  hasConfirmedSecondFactor,
  setSuperAdminPassword,
  generateGmPassword,
  assertStrongGmPassword,
  GM_TICKET_TTL_MINUTES,
  GM_PASSWORD_GENERATED_LENGTH,
} from '../lib/gm-access';
import { revokeAllSessionsForUser } from '../lib/session-admin';
import { writeAudit } from '../lib/audit';
import { ApiError } from '@wasit/shared';

type Action = 'issue' | 'reset-factor' | 'status' | 'set-password';

interface Args {
  action: Action;
  email: string;
  reason: string;
  confirm: boolean;
  generate: boolean;
  passwordFile: string | null;
  vault: string | null;
}

function usage(): never {
  console.error(
    [
      'Usage: npm run gm:access -- <issue|reset-factor|set-password|status> --email <address> [--reason "..."] [--confirm]',
      '',
      '  issue          mint a single-use ticket that satisfies the email-verification',
      '                 gate once at login (valid 15 minutes)',
      '  reset-factor   remove a lost authenticator so the account can enrol a new one',
      '                 at its next sign-in; sessions are revoked, password untouched',
      '  set-password   replace the password of this SUPER_ADMIN account only, and',
      '                 revoke its sessions. The password is never printed: either',
      '                 --generate writes a fresh 32-character one to a 0600 file',
      '                 outside the repository, or --password-file reads one from a',
      '                 0600 file. Roles, email verification and MFA are untouched.',
      '  status         show whether the account exists, its factor state and any',
      '                 live ticket (no secrets printed)',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const [action, ...rest] = argv;
  if (!action || !['issue', 'reset-factor', 'set-password', 'status'].includes(action)) usage();
  let email = '';
  let reason = '';
  let confirm = false;
  let generate = false;
  let passwordFile: string | null = null;
  let vault: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--email') email = rest[++i] ?? '';
    else if (arg === '--reason') reason = rest[++i] ?? '';
    else if (arg === '--confirm') confirm = true;
    else if (arg === '--generate') generate = true;
    else if (arg === '--password-file') passwordFile = rest[++i] ?? '';
    else if (arg === '--vault') vault = rest[++i] ?? '';
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else if (arg.startsWith('--reason=')) reason = arg.slice('--reason='.length);
    else if (arg.startsWith('--password-file=')) passwordFile = arg.slice('--password-file='.length);
    else if (arg.startsWith('--vault=')) vault = arg.slice('--vault='.length);
    else if (arg === '--password' || arg.startsWith('--password=')) {
      // Refuse rather than ignore: accepting it would put the credential in the
      // process table and in the operator's shell history.
      console.error('Refusing --password: pass the secret through --generate or a 0600 --password-file.');
      process.exit(2);
    } else usage();
  }
  if (!email) usage();
  if (passwordFile !== null && generate) {
    console.error('Choose one source: --generate or --password-file, not both.');
    process.exit(2);
  }
  return { action: action as Action, email, reason, confirm, generate, passwordFile, vault };
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


/**
 * Where a generated password is written.
 *
 * Outside the repository by construction (`~/.wasit-secrets`), so it cannot be
 * committed by accident, and overridable for a deployment that keeps secrets on
 * another volume.
 */
function defaultVaultDir(): string {
  const configured = process.env.WASIT_SECRETS_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), '.wasit-secrets');
}

function vaultPathFor(email: string, explicit: string | null): string {
  if (explicit) return resolve(explicit);
  const slug = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '-').slice(0, 40) || 'account';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  return join(defaultVaultDir(), `gm-${slug}-${stamp}.txt`);
}

/** Refuses a destination inside any Git working tree, including this repository. */
function assertOutsideGitTree(target: string): void {
  let dir = dirname(target);
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Refusing to write a secret inside a Git working tree (${dir}); choose --vault outside the repository`);
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Creates the file with 0600 and never overwrites an existing one. */
function writeSecretFile(target: string, secret: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(dirname(target), 0o700);
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeSync(fd, `${secret}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, 0o600);
}

/** Reads a password from a file that only its owner can read. */
function readSecretFile(target: string): string {
  const path = resolve(target);
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new ApiError(400, 'VALIDATION_ERROR', '--password-file must be a regular file');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '--password-file must not be readable by group or others (chmod 600 it first)');
  }
  if (stat.size > 4096) {
    throw new ApiError(400, 'VALIDATION_ERROR', '--password-file is too large to be a password');
  }
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
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
    if (args.action === 'set-password') {
      const source = args.passwordFile ? `from ${resolve(args.passwordFile)}` : 'with a freshly generated 32-character password';
      console.log(`Would replace the password of ${user.email} ${source}, and revoke all of its sessions.`);
      console.log('Roles, email verification and any second factor are left untouched.');
      console.log('Re-run with --confirm to proceed.');
      process.exitCode = 2;
      return;
    }
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


  if (args.action === 'set-password') {
    let password: string;
    let vaultPath: string | null = null;

    if (args.passwordFile) {
      password = readSecretFile(args.passwordFile);
      // Fail on a weak secret before the database is touched at all.
      assertStrongGmPassword(password, user.email);
    } else {
      password = generateGmPassword(GM_PASSWORD_GENERATED_LENGTH);
      vaultPath = vaultPathFor(user.email, args.vault);
      assertOutsideGitTree(vaultPath);
      // Written before the change: if the vault cannot be written, nothing has
      // happened yet, and the alternative order risks a password nobody holds.
      writeSecretFile(vaultPath, password);
    }

    let rotation;
    try {
      rotation = await setSuperAdminPassword(db, {
        email: user.email,
        password,
        reason: args.reason,
        changedBy: operatorName(),
      });
    } catch (err) {
      // A generated secret that was never applied must not linger.
      if (vaultPath) {
        try {
          unlinkSync(vaultPath);
        } catch {
          /* best effort */
        }
      }
      throw err;
    }

    console.log(`Password replaced for ${rotation.email}.`);
    console.log(`sessions revoked: ${rotation.sessionsRevoked}`);
    console.log('roles / email verification / second factor: unchanged');
    if (vaultPath) {
      const mode = (statSync(vaultPath).mode & 0o777).toString(8);
      console.log('');
      console.log(`password: written to ${vaultPath} (mode ${mode}) — not displayed here`);
      console.log('Read it in a local terminal and move it to the owner password manager,');
      console.log('then delete the file:  shred -u <path>');
    } else {
      console.log('password: read from --password-file, not displayed');
    }
    console.log('');
    console.log('The owner signs in with this password. The email-verification gate is');
    console.log('unchanged: a confirmed second factor satisfies it, otherwise mint a');
    console.log('ticket with `issue` (when no factor is enrolled).');
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

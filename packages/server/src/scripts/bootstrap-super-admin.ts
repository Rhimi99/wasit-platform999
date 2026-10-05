/**
 * One-shot CLI: provision the first SUPER_ADMIN.
 *
 * Usage:
 *   SUPER_ADMIN_EMAIL=owner@example.com SUPER_ADMIN_PASSWORD='...' \
 *     npm run bootstrap:super-admin
 *
 * Run with no password and it prompts interactively (input hidden). The password
 * is never echoed, never written to logs, and never stored anywhere but the
 * argon2id hash in the users table.
 *
 * Flags / env:
 *   SUPER_ADMIN_EMAIL            required (or prompted)
 *   SUPER_ADMIN_PASSWORD         optional (prompted when absent)
 *   SUPER_ADMIN_ALLOW_ADDITIONAL 'true' to permit a second platform owner
 *   SUPER_ADMIN_ACTION           'status' to report whether one exists, then exit
 *
 * Exit codes: 0 success, 1 failure, 2 refused (already provisioned / bad input).
 */
import { createInterface } from 'node:readline';
import { db, closeDb } from '../db/client';
import {
  bootstrapSuperAdmin,
  BootstrapError,
  normalizeBootstrapEmail,
  SUPER_ADMIN_ROLE,
} from '../lib/super-admin-bootstrap';
import { eq, sql } from 'drizzle-orm';
import { roles, userRoles, users } from '../db/schema/auth';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-interactive stdin (a pipe): read one line. Used by automation that
      // would rather pipe the secret than export it into the environment.
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
        const nl = data.indexOf('\n');
        if (nl !== -1) {
          process.stdin.pause();
          resolve(data.slice(0, nl).replace(/\r$/, ''));
        }
      });
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
    const wasRaw = stdin.isRaw ?? false;

    process.stdout.write(prompt);
    // Suppress echo while the secret is typed. readline still receives the data.
    const onData = (): void => {
      // Re-print the prompt and clear whatever the terminal echoed.
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(prompt);
    };
    stdin.on('data', onData);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);

    rl.question('', (answer) => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function reportStatus(): Promise<void> {
  const roleRows = await db.select().from(roles).where(eq(roles.name, SUPER_ADMIN_ROLE)).limit(1);
  if (roleRows.length === 0) {
    console.log(`Role ${SUPER_ADMIN_ROLE} is not seeded. Run: npm run db:seed`);
    return;
  }
  const rows = await db
    .select({ email: users.email, isActive: users.isActive, isLocked: users.isLocked })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(eq(userRoles.roleId, roleRows[0].id));

  console.log(`SUPER_ADMIN accounts: ${rows.length}`);
  for (const r of rows) {
    console.log(`  - ${r.email} (active=${r.isActive}, locked=${r.isLocked})`);
  }
  if (rows.length === 0) {
    console.log('No SUPER_ADMIN exists yet. Run the bootstrap to create the first one.');
  }
}

async function main(): Promise<void> {
  const action = (process.env.SUPER_ADMIN_ACTION ?? '').trim().toLowerCase();
  if (action === 'status') {
    await reportStatus();
    return;
  }

  const allowAdditional = (process.env.SUPER_ADMIN_ALLOW_ADDITIONAL ?? '').trim().toLowerCase() === 'true';

  let email = (process.env.SUPER_ADMIN_EMAIL ?? '').trim();
  if (!email) {
    if (!process.stdin.isTTY) {
      throw new BootstrapError('EMAIL_REQUIRED', 'SUPER_ADMIN_EMAIL is required in non-interactive mode');
    }
    email = (await readVisible('Super admin email: ')).trim();
  }
  email = normalizeBootstrapEmail(email);

  let password = process.env.SUPER_ADMIN_PASSWORD ?? '';
  if (!password) {
    if (!process.stdin.isTTY) {
      // Piped secret: a single line on stdin.
      password = await readHidden('');
    } else {
      password = await readHidden('Super admin password (hidden): ');
      const confirm = await readHidden('Confirm password (hidden): ');
      if (password !== confirm) {
        throw new BootstrapError('PASSWORD_MISMATCH', 'Passwords do not match');
      }
    }
  }

  const result = await bootstrapSuperAdmin(db, {
    email,
    password,
    allowAdditional,
    source: 'cli',
  });

  // Deliberately prints no credential — only what identifies the account.
  console.log('SUPER_ADMIN provisioned.');
  console.log(`  email : ${result.email}`);
  console.log(`  userId: ${result.userId}`);
  console.log(`  role  : ${result.role}`);
  console.log(`  status: ${result.grantedExisting ? 'role granted to existing account' : 'account created'}`);
  console.log('Sign in at /login with the password you supplied.');
}

main()
  .catch((err: unknown) => {
    if (err instanceof BootstrapError) {
      console.error(`Bootstrap refused [${err.code}]: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import argon2 from 'argon2';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { roles, sessions, userRoles, users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  auditPayloadLeaksSecret,
  compareBaseline,
  lookupRecoveryTarget,
  maskEmail,
  passwordAlgorithm,
  passwordResetAuditRowsSince,
  RecoveryTargetError,
  type AccountSnapshot,
  type RecoveryBaseline,
} from '../src/lib/gm-recovery.js';
import type { DatabaseIdentity } from '../src/lib/db-target-guard.js';

const run = promisify(execFile);
const PREFIX = 'gmrec';
const PASSWORD = 'GmRec0very!Pass#2026';
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const PROD_DB: DatabaseIdentity = { name: 'wasit_prod', host: '10.0.0.12', port: 5432, user: 'wasit' };

afterAll(async () => {
  const created = await db.select({ id: users.id }).from(users).where(like(users.email, `${PREFIX}-%`));
  for (const { id } of created) {
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(userRoles).where(eq(userRoles.userId, id));
  }
  await db.delete(users).where(like(users.email, `${PREFIX}-%`));
  await db.delete(auditLogs).where(eq(auditLogs.entityId, sql`any(select id from users where false)`)).catch(() => undefined);
});

async function roleId(name: string): Promise<string> {
  const rows = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  if (rows.length === 0) throw new Error(`missing role ${name}`);
  return rows[0].id;
}

async function createUser(role: 'SUPER_ADMIN' | 'CUSTOMER', emailVerified = true, mfaEnabled = false) {
  const id = randomUUID();
  const email = `${PREFIX}-${role.toLowerCase()}-${stamp()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: role,
    emailVerified,
    mfaEnabled,
    isActive: true,
  });
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: await roleId(role) });
  return { id, email };
}

describe('GM-ACCESS-05 — masking and hash inspection', () => {
  it('keeps the domain and two characters of the local part', () => {
    expect(maskEmail('owner@wasit.tn')).toBe('o***r@wasit.tn');
    expect(maskEmail('rhimiimed18@gmail.com')).toBe('r***8@gmail.com');
  });

  it('never returns the full address for short local parts', () => {
    expect(maskEmail('ab@wasit.tn')).toBe('a***@wasit.tn');
    expect(maskEmail('nonsense')).toBe('***');
  });

  it('classifies the stored hash without exposing it', () => {
    expect(passwordAlgorithm('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe('argon2');
    expect(passwordAlgorithm('5f4dcc3b5aa765d61d8327deb882cf99')).toBe('unknown');
    expect(passwordAlgorithm('')).toBe('unknown');
  });
});

describe('GM-ACCESS-05 — audit payload inspection', () => {
  it('accepts ids, timestamps and counts', () => {
    expect(auditPayloadLeaksSecret({ sessionsRevoked: 2, changedBy: 'operator', at: '2026-11-23T00:00:00Z' })).toBe(false);
    expect(auditPayloadLeaksSecret({ userId: randomUUID() })).toBe(false);
    expect(auditPayloadLeaksSecret(null)).toBe(false);
  });

  it('rejects a key that names a credential', () => {
    expect(auditPayloadLeaksSecret({ password: 'x' })).toBe(true);
    expect(auditPayloadLeaksSecret({ nested: { passwordHash: 'x' } })).toBe(true);
    expect(auditPayloadLeaksSecret({ items: [{ token: 'x' }] })).toBe(true);
  });

  it('rejects a value that is an argon2 hash', () => {
    expect(auditPayloadLeaksSecret({ note: '$argon2id$v=19$m=65536$abc' })).toBe(true);
  });
});

describe('GM-ACCESS-05 — the target must be exactly one SUPER_ADMIN', () => {
  it('finds the account and reports its safety-relevant state', async () => {
    const admin = await createUser('SUPER_ADMIN', true, false);
    const target = await lookupRecoveryTarget(db, admin.email.toUpperCase());

    expect(target.matchingAccounts).toBe(1);
    expect(target.matchingSuperAdmins).toBe(1);
    expect(target.superAdminsTotal).toBeGreaterThanOrEqual(1);
    expect(target.snapshot.id).toBe(admin.id);
    expect(target.snapshot.emailMasked).toBe(maskEmail(admin.email));
    expect(target.snapshot.emailMasked).not.toBe(admin.email);
    expect(target.snapshot.roles).toContain('SUPER_ADMIN');
    expect(target.snapshot.emailVerified).toBe(true);
    expect(target.snapshot.passwordAlgorithm).toBe('argon2');
  });

  it('counts the live sessions a rotation would revoke', async () => {
    const admin = await createUser('SUPER_ADMIN');
    await db.insert(sessions).values([
      { id: randomUUID(), userId: admin.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
      { id: randomUUID(), userId: admin.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    const target = await lookupRecoveryTarget(db, admin.email);
    expect(target.snapshot.liveSessions).toBe(2);
  });

  it('refuses an unknown address', async () => {
    await expect(lookupRecoveryTarget(db, `${PREFIX}-ghost@wasit.tn`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an account that is not a SUPER_ADMIN', async () => {
    const customer = await createUser('CUSTOMER');
    await expect(lookupRecoveryTarget(db, customer.email)).rejects.toBeInstanceOf(RecoveryTargetError);
    await expect(lookupRecoveryTarget(db, customer.email)).rejects.toMatchObject({ code: 'NOT_SUPER_ADMIN' });
  });
});

describe('GM-ACCESS-05 — post-rotation checks', () => {
  const baseline: RecoveryBaseline = {
    version: 1,
    createdAt: '2026-11-23T00:00:00.000Z',
    nodeEnv: 'production',
    declaredName: 'wasit_prod',
    database: PROD_DB,
    account: {
      id: 'acc-1',
      emailMasked: 'o***r@wasit.tn',
      isActive: true,
      emailVerified: true,
      mfaEnabled: true,
      hasConfirmedFactor: true,
      roles: ['SUPER_ADMIN'],
      passwordAlgorithm: 'argon2',
      liveSessions: 2,
    },
    lastPasswordResetAuditId: null,
  };

  const after: AccountSnapshot = { ...baseline.account, liveSessions: 0 };

  const check = (over: Partial<{ db: DatabaseIdentity; account: AccountSnapshot; rows: { id: string; metadata: unknown }[] }>) =>
    compareBaseline(baseline, {
      database: over.db ?? PROD_DB,
      account: over.account ?? after,
      newAuditRows: over.rows ?? [{ id: 'a1', metadata: { sessionsRevoked: 2 } }],
    });

  const failed = (checks: ReturnType<typeof check>) => checks.filter((c) => !c.ok).map((c) => c.name);

  it('passes when every promise held', () => {
    const checks = check({});
    expect(failed(checks)).toEqual([]);
    expect(checks.length).toBe(10);
  });

  it('fails when the database changed under the operator', () => {
    expect(failed(check({ db: { ...PROD_DB, name: 'wasit_other' } }))).toContain('same database');
  });

  it('fails when the account is not the one in the baseline', () => {
    expect(failed(check({ account: { ...after, id: 'acc-2' } }))).toContain('same account');
  });

  it('fails when email verification was touched', () => {
    expect(failed(check({ account: { ...after, emailVerified: false } }))).toContain('email verification unchanged');
  });

  it('fails when the second factor was dropped', () => {
    expect(failed(check({ account: { ...after, mfaEnabled: false } }))).toContain('second factor unchanged');
    expect(failed(check({ account: { ...after, hasConfirmedFactor: false } }))).toContain('second factor unchanged');
  });

  it('fails when roles changed', () => {
    expect(failed(check({ account: { ...after, roles: ['SUPER_ADMIN', 'ADMIN'] } }))).toContain('roles unchanged');
  });

  it('fails when a session survived', () => {
    expect(failed(check({ account: { ...after, liveSessions: 1 } }))).toContain('previous sessions revoked');
  });

  it('fails when no audit row was written', () => {
    expect(failed(check({ rows: [] }))).toContain('rotation audit row written');
  });

  it('fails when the audit row carries a secret', () => {
    expect(failed(check({ rows: [{ id: 'a1', metadata: { passwordHash: '$argon2id$x' } }] }))).toContain('audit row carries no secret');
  });

  it('fails when the stored hash is not argon2', () => {
    expect(failed(check({ account: { ...after, passwordAlgorithm: 'unknown' } }))).toContain('password hash is argon2');
  });
});

describe('GM-ACCESS-05 — audit rows are found from the baseline timestamp', () => {
  it('returns only rows written after the baseline', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const before = new Date(Date.now() - 60_000).toISOString();
    await db.insert(auditLogs).values({
      id: randomUUID(),
      action: 'GM_ACCESS.PASSWORD_RESET',
      entityType: 'USER',
      entityId: admin.id,
      metadata: { sessionsRevoked: 1 },
    });
    const rows = await passwordResetAuditRowsSince(db, admin.id, before);
    expect(rows.length).toBe(1);
    expect(auditPayloadLeaksSecret(rows[0].metadata)).toBe(false);

    const none = await passwordResetAuditRowsSince(db, admin.id, new Date(Date.now() + 60_000).toISOString());
    expect(none).toEqual([]);
  });
});

/**
 * The shipped CLI, driven as a subprocess. These prove the package's entry
 * points work and that none of them can be pointed at a test database.
 */
const SCRIPT = join(process.cwd(), 'src/scripts/gm-access.ts');
const TSX = join(process.cwd(), '..', '..', 'node_modules', '.bin', 'tsx');
const PACKAGE = join(process.cwd(), '..', '..', 'deploy', 'gm-recovery');

async function runCli(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        DOTENV_CONFIG_PATH: '/nonexistent/.env',
        JWT_SECRET: randomBytes(32).toString('hex'),
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        ...env,
      },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('GM-ACCESS-05 — precheck refuses before it writes', () => {
  it('refuses wasit_test even when the deployment declares it production', async () => {
    const result = await runCli(['precheck', '--email', 'nobody@wasit.tn'], {
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_test',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test, demo, development, staging or system database');
    expect(result.stdout).toContain('gate:');
    expect(result.stdout).toContain('REFUSED');
    expect(result.stderr).not.toContain('postgresql://');
  });

  it('refuses when the deployment does not declare production', async () => {
    const result = await runCli(['precheck', '--email', 'nobody@wasit.tn'], { NODE_ENV: 'development' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not "production"');
  });

  it('writes a baseline only when the gate allows — and it cannot here', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gm-precheck-'));
    const baseline = join(dir, 'baseline.json');
    const result = await runCli(['precheck', '--email', 'nobody@wasit.tn', '--baseline-out', baseline], {
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_test',
    });
    expect(result.code).toBe(2);
    expect(existsSync(baseline)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('GM-ACCESS-05 — password generation writes a file and touches no account', () => {
  it('refuses without --confirm and creates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gm-gen-'));
    const target = join(dir, 'secret.txt');
    const result = await runCli(['generate-password', '--vault', target], { NODE_ENV: 'production' });
    expect(result.code).toBe(2);
    expect(existsSync(target)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a destination inside a Git working tree', async () => {
    const result = await runCli(['generate-password', '--vault', join(process.cwd(), 'secret.txt'), '--confirm'], {
      NODE_ENV: 'production',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Git working tree');
  });

  it('writes a 0600 file, prints the path only, and leaves the account hash alone', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const before = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, admin.id));
    const dir = mkdtempSync(join(tmpdir(), 'gm-gen-'));
    const target = join(dir, 'secret.txt');

    const result = await runCli(['generate-password', '--email', admin.email, '--vault', target, '--confirm'], {
      NODE_ENV: 'production',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const secret = readFileSync(target, 'utf8').replace(/\r?\n$/, '');
    expect(secret.length).toBe(32);
    // The value never reaches the terminal.
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);

    const after = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, admin.id));
    expect(after[0].hash).toBe(before[0].hash);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('GM-ACCESS-05 — the package scripts refuse a non-production shell', () => {
  async function runScript(script: string, args: string[], env: Record<string, string>) {
    try {
      const { stdout, stderr } = await run('bash', [join(PACKAGE, script), ...args], {
        cwd: PACKAGE,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          GM_ACCESS_CLI: `${TSX} ${SCRIPT}`,
          DOTENV_CONFIG_PATH: '/nonexistent/.env',
          JWT_SECRET: randomBytes(32).toString('hex'),
          ...env,
        },
        timeout: 60_000,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('precheck.sh refuses a test database declared as production', async () => {
    const result = await runScript('precheck.sh', ['--email', 'nobody@wasit.tn'], {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_test',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test, demo, development, staging or system database');
  });

  it('precheck.sh refuses a shell that does not declare production', async () => {
    const result = await runScript('precheck.sh', ['--email', 'nobody@wasit.tn'], {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'development',
      WASIT_PRODUCTION_DB_NAME: 'wasit_prod',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("NODE_ENV must be 'production'");
  });

  it('precheck.sh refuses a demo database name before connecting', async () => {
    const result = await runScript('precheck.sh', ['--email', 'nobody@wasit.tn'], {
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5434/wasit_demo',
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_demo',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test, demo, development, staging or system database');
    expect(result.stderr).not.toContain('pass@');
  });

  it('rotate.sh refuses without a reason', async () => {
    const result = await runScript('rotate.sh', ['--email', 'nobody@wasit.tn', '--generate'], {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_prod',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--reason is required');
  });

  it('verify.sh refuses without a baseline', async () => {
    const result = await runScript('verify.sh', ['--email', 'nobody@wasit.tn'], {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'production',
      WASIT_PRODUCTION_DB_NAME: 'wasit_prod',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--baseline is required');
  });

  it('generate-password.sh --dry-run creates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gm-dry-'));
    const result = await runScript('generate-password.sh', ['--dry-run', '--vault', join(dir, 'x.txt')], {
      WASIT_SECRETS_DIR: dir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dry run: nothing was created');
    expect(existsSync(join(dir, 'x.txt'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

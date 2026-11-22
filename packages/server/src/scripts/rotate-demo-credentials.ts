/**
 * DEMO-SEC-03 — rotate every public-demo credential and cut its sessions.
 *
 * The public demo publishes its account list, so the only thing between a visitor
 * and a demo account is its password. This script gives each fixture its **own**
 * random secret (never one shared value), re-hashes it through the normal
 * argon2id path, revokes every live session, and parks the result in a 0600 file
 * that git already ignores. Nothing secret is ever printed.
 *
 * What it touches, per account: `users.password_hash`, `sessions.revoked_at`,
 * `password_reset_tokens.used_at`, `mfa_challenges.consumed_at`, one audit row.
 * No migration, no schema change, no RBAC change.
 *
 * Usage (from `packages/server`, with the demo env loaded):
 *   npx tsx src/scripts/rotate-demo-credentials.ts [--env-file .env.demo]
 *        [--out .env.demo.secrets] [--include-staff] [--dry-run]
 *
 * Re-running is safe: every run mints new secrets and revokes what came before.
 * Run it again after a re-seed if the seeder was started without the generated
 * env file.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db, closeDb } from '../db/client';
import { hashPassword } from '../lib/security';
import { writeAudit } from '../lib/audit';
import { users, sessions, passwordResetTokens, mfaChallenges } from '../db/schema/auth';
import { demoAccountEnvKey, demoStaffEnvKey } from '../lib/demo-credentials';

interface Target {
  email: string;
  envKey: string;
}

const DEMO_TARGETS: Target[] = ['customer1@wasit.tn', 'suppliera@wasit.tn', 'merchanta@wasit.tn', 'companya@wasit.tn', 'demo@wasit.tn'].map(
  (email) => ({ email, envKey: demoAccountEnvKey(email) as string }),
);

const STAFF_TARGETS: Target[] = [
  { email: 'admin@wasit.tn', envKey: demoStaffEnvKey('admin') },
  { email: 'admin2@wasit.tn', envKey: demoStaffEnvKey('admin2') },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = flag('dry-run');
const INCLUDE_STAFF = flag('include-staff');
const OUT_FILE = resolve(value('out', '.env.demo.secrets'));
const ENV_FILE = resolve(value('env-file', '.env.demo'));

/** 24 url-safe characters ≈ 144 bits — typed once, never shared between accounts. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

interface Rotated {
  email: string;
  envKey: string;
  password: string;
  sessionsRevoked: number;
}

async function rotate(target: Target): Promise<Rotated | null> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, target.email.toLowerCase()))
    .limit(1);
  if (rows.length === 0) {
    console.log(`skip    ${target.email} — not present in this database`);
    return null;
  }
  const userId = rows[0].id;
  const password = generatePassword();
  const envKey = target.envKey;

  if (DRY_RUN) {
    console.log(`dry-run ${target.email} — would rotate and revoke sessions`);
    return { email: target.email, envKey, password, sessionsRevoked: 0 };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
    .where(eq(users.id, userId));

  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  // A pending reset or MFA challenge would outlive the password it was issued
  // for, so both are closed in the same step.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  await db
    .update(mfaChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(mfaChallenges.userId, userId), isNull(mfaChallenges.consumedAt)));

  await writeAudit(
    db,
    { actorId: null, actorType: 'SYSTEM' },
    {
      action: 'AUTH.DEMO_CREDENTIAL_ROTATED',
      entityType: 'USER',
      entityId: userId,
      metadata: {
        account: target.email,
        sessionsRevoked: revoked.length,
        reason: 'DEMO-SEC-03 public demo credential rotation',
      },
    },
  );

  console.log(`rotated ${target.email} — sessions revoked: ${revoked.length}`);
  return { email: target.email, envKey, password, sessionsRevoked: revoked.length };
}

/**
 * Replaces the managed keys in the env file and keeps everything else verbatim,
 * so a later `seed-demo` reproduces the rotated state instead of restoring one
 * shared (or published) password.
 */
function syncEnvFile(rotated: Rotated[]): void {
  if (!existsSync(ENV_FILE)) {
    console.log(`note    ${ENV_FILE} not found — secrets written to ${OUT_FILE} only`);
    return;
  }
  const managed = new Set(rotated.map((r) => r.envKey));
  const kept = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((line) => {
      const key = line.split('=')[0]?.trim();
      if (!key) return true;
      // Drop the shared fallbacks once every fixture has its own secret, so a
      // re-seed cannot hand two accounts the same password again.
      if (key === 'DEMO_ACCOUNT_PASSWORD' || key === 'DEMO_STAFF_PASSWORD') return false;
      return !managed.has(key) && !/^DEMO_(ACCOUNT|STAFF)_PASSWORD_/.test(key);
    })
    .join('\n')
    .replace(/\n+$/, '\n');
  const block = [
    '',
    `# DEMO-SEC-03 — rotated ${new Date().toISOString()}`,
    ...rotated.map((r) => `${r.envKey}=${r.password}`),
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, kept + block, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  console.log(`updated ${ENV_FILE} (mode 600, git-ignored)`);
}

async function main(): Promise<void> {
  const targets = INCLUDE_STAFF ? [...DEMO_TARGETS, ...STAFF_TARGETS] : DEMO_TARGETS;
  const rotated: Rotated[] = [];
  for (const target of targets) {
    const result = await rotate(target);
    if (result) rotated.push(result);
  }

  if (DRY_RUN) {
    console.log(`dry-run — ${rotated.length} account(s) would rotate; nothing written`);
    return;
  }

  const header = [
    '# WASIT demo credentials — generated by rotate-demo-credentials.ts (DEMO-SEC-03).',
    `# Rotated ${new Date().toISOString()}. Mode 600, git-ignored: never commit, never paste in a report.`,
    '# Re-run the script to rotate again; re-run seed-demo only with this file loaded.',
    '',
  ].join('\n');
  writeFileSync(OUT_FILE, header + rotated.map((r) => `${r.envKey}=${r.password}`).join('\n') + '\n', {
    mode: 0o600,
  });
  chmodSync(OUT_FILE, 0o600);
  console.log(`secrets written to ${OUT_FILE} (mode 600)`);

  syncEnvFile(rotated);
  console.log(`done — ${rotated.length} account(s) rotated, all sessions revoked`);
}

main()
  .catch((err) => {
    console.error('rotation failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

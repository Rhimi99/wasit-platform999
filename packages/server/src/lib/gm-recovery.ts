import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { describeIdentity, type DatabaseIdentity } from './db-target-guard';

/** What the recovery package records before it changes anything. */
export interface AccountSnapshot {
  id: string;
  emailMasked: string;
  isActive: boolean;
  emailVerified: boolean;
  mfaEnabled: boolean;
  hasConfirmedFactor: boolean;
  roles: string[];
  /** `argon2` or `unknown` — the algorithm of the stored hash, never the hash. */
  passwordAlgorithm: string;
  liveSessions: number;
}

export interface RecoveryBaseline {
  version: 1;
  createdAt: string;
  nodeEnv: string | null;
  declaredName: string | null;
  database: DatabaseIdentity;
  account: AccountSnapshot;
  lastPasswordResetAuditId: string | null;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `r***9@wasit.tn` — enough for an operator to confirm they are on the right
 * account, not enough to be a usable address if the log leaks.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? '*'}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

export function passwordAlgorithm(hash: string): 'argon2' | 'unknown' {
  return hash.startsWith('$argon2') ? 'argon2' : 'unknown';
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

export interface AccountLookup {
  snapshot: AccountSnapshot;
  /** Every SUPER_ADMIN in the database — reported, never a reason to change one. */
  superAdminsTotal: number;
  /** Accounts sharing the target address; must be exactly one. */
  matchingAccounts: number;
  /** Of those, how many carry SUPER_ADMIN; must be exactly one. */
  matchingSuperAdmins: number;
}

export class RecoveryTargetError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'NOT_SUPER_ADMIN' | 'AMBIGUOUS_TARGET',
  ) {
    super(message);
    this.name = 'RecoveryTargetError';
  }
}

/**
 * Reads the target account and proves the target is unambiguous.
 *
 * Refuses when the address is unknown, when it is not a SUPER_ADMIN, or when
 * more than one row answers to it — a recovery tool must never guess which
 * account the owner meant.
 */
export async function lookupRecoveryTarget(db: DB, email: string): Promise<AccountLookup> {
  const normalized = email.trim().toLowerCase();

  const matching = rowsOf<{ id: string; is_active: boolean; email_verified: boolean; mfa_enabled: boolean; password_hash: string; roles: string[] | null }>(
    await db.execute(sql`
      select u.id, u.is_active, u.email_verified, u.mfa_enabled, u.password_hash,
             array_remove(array_agg(r.name), null) as roles
      from users u
        left join user_roles ur on ur.user_id = u.id
        left join roles r on r.id = ur.role_id
      where lower(u.email) = ${normalized}
      group by u.id
    `),
  );

  if (matching.length === 0) {
    throw new RecoveryTargetError('No account with that address', 'NOT_FOUND');
  }
  if (matching.length > 1) {
    throw new RecoveryTargetError(
      `Refusing: ${matching.length} accounts answer to that address; the target is ambiguous`,
      'AMBIGUOUS_TARGET',
    );
  }

  const user = matching[0];
  const roles = (user.roles ?? []).filter(Boolean);
  if (!roles.includes('SUPER_ADMIN')) {
    throw new RecoveryTargetError(
      'This account is not a SUPER_ADMIN; this tool is limited to the general manager',
      'NOT_SUPER_ADMIN',
    );
  }

  const totals = rowsOf<{ super_admins: string; matching_super_admins: string }>(
    await db.execute(sql`
      select
        (select count(distinct u.id) from users u
           join user_roles ur on ur.user_id = u.id
           join roles r on r.id = ur.role_id
         where r.name = 'SUPER_ADMIN') as super_admins,
        (select count(distinct u.id) from users u
           join user_roles ur on ur.user_id = u.id
           join roles r on r.id = ur.role_id
         where r.name = 'SUPER_ADMIN' and lower(u.email) = ${normalized}) as matching_super_admins
    `),
  );

  const sessions = rowsOf<{ live: string }>(
    await db.execute(sql`
      select count(*) as live from sessions
      where user_id = ${user.id} and revoked_at is null and expires_at > now()
    `),
  );

  const factor = rowsOf<{ confirmed: string }>(
    await db.execute(sql`
      select count(*) as confirmed from authenticator_apps
      where user_id = ${user.id} and confirmed_at is not null
    `),
  );

  const snapshot: AccountSnapshot = {
    id: user.id,
    emailMasked: maskEmail(normalized),
    isActive: Boolean(user.is_active),
    emailVerified: Boolean(user.email_verified),
    mfaEnabled: Boolean(user.mfa_enabled),
    hasConfirmedFactor: Number(factor[0]?.confirmed ?? 0) > 0,
    roles,
    passwordAlgorithm: passwordAlgorithm(String(user.password_hash ?? '')),
    liveSessions: Number(sessions[0]?.live ?? 0),
  };

  return {
    snapshot,
    superAdminsTotal: Number(totals[0]?.super_admins ?? 0),
    matchingAccounts: matching.length,
    matchingSuperAdmins: Number(totals[0]?.matching_super_admins ?? 0),
  };
}

export interface AuditRow {
  id: string;
  metadata: unknown;
}

export async function passwordResetAuditRowsSince(db: DB, accountId: string, since: string): Promise<AuditRow[]> {
  return rowsOf<AuditRow>(
    await db.execute(sql`
      select id, metadata from audit_logs
      where action = 'GM_ACCESS.PASSWORD_RESET' and entity_id = ${accountId} and created_at > ${since}
      order by created_at asc
    `),
  );
}

export async function lastPasswordResetAuditId(db: DB, accountId: string): Promise<string | null> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      select id from audit_logs
      where action = 'GM_ACCESS.PASSWORD_RESET' and entity_id = ${accountId}
      order by created_at desc
      limit 1
    `),
  );
  return rows[0]?.id ?? null;
}

export async function buildBaseline(
  db: DB,
  email: string,
  database: DatabaseIdentity,
  declaration: { nodeEnv: string | null; declaredName: string | null },
): Promise<RecoveryBaseline> {
  const { snapshot } = await lookupRecoveryTarget(db, email);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    nodeEnv: declaration.nodeEnv,
    declaredName: declaration.declaredName,
    database,
    account: snapshot,
    lastPasswordResetAuditId: await lastPasswordResetAuditId(db, snapshot.id),
  };
}

/**
 * Post-rotation checks. Every one is a property the operator promised not to
 * change, or a property the rotation promised to change.
 */
export function compareBaseline(
  baseline: RecoveryBaseline,
  current: { database: DatabaseIdentity; account: AccountSnapshot; newAuditRows: AuditRow[] },
): Check[] {
  const before = baseline.account;
  const after = current.account;
  const checks: Check[] = [];

  checks.push({
    name: 'same database',
    ok:
      before !== null &&
      current.database.name === baseline.database.name &&
      current.database.host === baseline.database.host &&
      current.database.port === baseline.database.port,
    detail: `before ${describeIdentity(baseline.database)} → now ${describeIdentity(current.database)}`,
  });

  checks.push({
    name: 'same account',
    ok: after.id === before.id,
    detail: `${before.emailMasked} (id unchanged: ${after.id === before.id})`,
  });

  checks.push({
    name: 'password hash is argon2',
    ok: after.passwordAlgorithm === 'argon2',
    detail: `algorithm ${after.passwordAlgorithm}`,
  });

  checks.push({
    name: 'email verification unchanged',
    ok: after.emailVerified === before.emailVerified,
    detail: `${before.emailVerified} → ${after.emailVerified}`,
  });

  checks.push({
    name: 'second factor unchanged',
    ok: after.mfaEnabled === before.mfaEnabled && after.hasConfirmedFactor === before.hasConfirmedFactor,
    detail: `mfaEnabled ${before.mfaEnabled} → ${after.mfaEnabled}; confirmed factor ${before.hasConfirmedFactor} → ${after.hasConfirmedFactor}`,
  });

  checks.push({
    name: 'roles unchanged',
    ok: after.roles.join(',') === before.roles.join(','),
    detail: `${before.roles.join(',') || '(none)'} → ${after.roles.join(',') || '(none)'}`,
  });

  checks.push({
    name: 'account still active',
    ok: after.isActive,
    detail: `isActive ${after.isActive}`,
  });

  checks.push({
    name: 'previous sessions revoked',
    ok: after.liveSessions === 0,
    detail: `live sessions now ${after.liveSessions} (before ${before.liveSessions})`,
  });

  checks.push({
    name: 'rotation audit row written',
    ok: current.newAuditRows.length > 0,
    detail: `${current.newAuditRows.length} new GM_ACCESS.PASSWORD_RESET row(s) since the baseline`,
  });

  const leaking = current.newAuditRows.filter((row) => auditPayloadLeaksSecret(row.metadata));
  checks.push({
    name: 'audit row carries no secret',
    ok: leaking.length === 0,
    detail: leaking.length === 0 ? 'no password, hash or token field' : `${leaking.length} row(s) contain a secret-shaped field`,
  });

  return checks;
}

const SECRET_KEY = /^(password|passwd|secret|token|hash|credential|newpassword|passwordhash)/i;

/**
 * True when a stored audit payload would leak the credential.
 *
 * Keys are matched by name and any value carrying an argon2 prefix is treated
 * as a stored hash; ids and timestamps are deliberately not considered secrets.
 */
export function auditPayloadLeaksSecret(metadata: unknown): boolean {
  const walk = (value: unknown): boolean => {
    if (typeof value === 'string') return value.startsWith('$argon2');
    if (Array.isArray(value)) return value.some(walk);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(key)) return true;
        if (walk(child)) return true;
      }
    }
    return false;
  };
  return walk(metadata);
}

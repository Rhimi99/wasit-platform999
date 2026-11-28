import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { ApiError, PERMISSIONS, userHasAnyRole, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import { roles, userRoles, users } from '../../db/schema/auth.js';
import { securityReadGrants } from '../../db/schema/security-delegations.js';
import { env } from '../../lib/env.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';

/**
 * Delegated read access to the security centre (WCDC-02).
 *
 * The GM's rule: `SECURITY_READ` is a `SUPER_ADMIN` capability. An `ADMIN` reads
 * the centre only through an explicit grant naming the beneficiary, the surfaces
 * it opens and the moment it ends, issued by a named `SUPER_ADMIN` and revocable
 * at any time. A grant never touches `user_roles`, so it cannot leak into other
 * permissions, and it is read on every request, so a revocation is effective on
 * the next call — no new login, no token to wait out.
 */

export const SECURITY_READ_SCOPES = [
  'overview',
  'incidents',
  'events',
  'actions',
  'blocks',
  'rules',
  'sessions',
  'external',
] as const;

export type SecurityReadScope = (typeof SECURITY_READ_SCOPES)[number];

/** Surfaces whose content is personal enough that a delegated read is audited. */
export const SENSITIVE_SECURITY_SCOPES: readonly SecurityReadScope[] = [
  'incidents',
  'events',
  'sessions',
  'actions',
];

export interface SecurityReadGrantRow {
  id: string;
  adminUserId: string;
  scopes: string[];
  reason: string;
  grantedById: string;
  expiresAt: Date;
  lastAmendedById: string | null;
  revokedAt: Date | null;
  revokedById: string | null;
  expiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isSecurityReadScope(value: string): value is SecurityReadScope {
  return (SECURITY_READ_SCOPES as readonly string[]).includes(value);
}

function validateScopes(scopes: string[]): SecurityReadScope[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) {
    throw ApiError.validation([
      { field: 'scopes', message: 'At least one read scope is required', code: 'REQUIRED' },
    ]);
  }
  const unknown = unique.filter((scope) => !isSecurityReadScope(scope));
  if (unknown.length > 0) {
    throw ApiError.validation([
      { field: 'scopes', message: `Unknown scope(s): ${unknown.join(', ')}`, code: 'INVALID' },
    ]);
  }
  return unique as SecurityReadScope[];
}

function validateExpiry(expiresAt: Date): Date {
  const maxDays = env.SECURITY_DELEGATION_MAX_DAYS;
  const now = Date.now();
  if (expiresAt.getTime() <= now) {
    throw ApiError.validation([
      { field: 'expiresAt', message: 'The expiry must be in the future', code: 'INVALID' },
    ]);
  }
  if (expiresAt.getTime() > now + maxDays * 24 * 3600 * 1000) {
    throw ApiError.validation([
      {
        field: 'expiresAt',
        message: `The expiry may not exceed ${maxDays} days from now`,
        code: 'OUT_OF_RANGE',
      },
    ]);
  }
  return expiresAt;
}

async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.name as UserRole);
}

/** The grant that is live right now, or null. Checked on every request. */
export async function findActiveSecurityReadGrant(
  db: DB,
  adminUserId: string,
): Promise<SecurityReadGrantRow | null> {
  const [row] = await db
    .select()
    .from(securityReadGrants)
    .where(
      and(
        eq(securityReadGrants.adminUserId, adminUserId),
        isNull(securityReadGrants.revokedAt),
        isNull(securityReadGrants.expiredAt),
        gt(securityReadGrants.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return (row as SecurityReadGrantRow | undefined) ?? null;
}

export async function listSecurityReadGrants(
  db: DB,
  options: { adminUserId?: string; includeClosed?: boolean } = {},
): Promise<Array<SecurityReadGrantRow & { adminEmail: string | null; lastAmendedByEmail: string | null }>> {
  const conditions = [];
  if (options.adminUserId) conditions.push(eq(securityReadGrants.adminUserId, options.adminUserId));
  if (!options.includeClosed) {
    conditions.push(isNull(securityReadGrants.revokedAt));
    conditions.push(isNull(securityReadGrants.expiredAt));
    conditions.push(gt(securityReadGrants.expiresAt, new Date()));
  }
  const rows = await db
    .select({
      grant: securityReadGrants,
      adminEmail: users.email,
    })
    .from(securityReadGrants)
    .leftJoin(users, eq(users.id, securityReadGrants.adminUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(securityReadGrants.createdAt));

  return rows.map((row) => ({
    ...(row.grant as SecurityReadGrantRow),
    adminEmail: row.adminEmail ?? null,
    lastAmendedByEmail: null,
  }));
}

export interface CreateGrantInput {
  adminUserId: string;
  scopes: string[];
  expiresAt: Date;
  reason: string;
  actor: AuditContext;
}

/**
 * Closes grants whose clock ran out. The sweep calls it too; create() calls it
 * first so an expired row never blocks a new grant through the unique index.
 */
export async function expireSecurityReadGrants(
  db: DB,
  options: { adminUserId?: string; actor?: AuditContext } = {},
): Promise<number> {
  const conditions = [
    isNull(securityReadGrants.expiredAt),
    isNull(securityReadGrants.revokedAt),
    lte(securityReadGrants.expiresAt, new Date()),
  ];
  if (options.adminUserId) conditions.push(eq(securityReadGrants.adminUserId, options.adminUserId));

  const rows = await db
    .update(securityReadGrants)
    .set({ expiredAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions))
    .returning();

  for (const row of rows) {
    await writeAudit(
      db,
      options.actor ?? { actorId: null, actorType: 'SYSTEM', ipAddress: null, userAgent: 'security-sweep' },
      {
      action: 'SECURITY.DELEGATION_EXPIRED',
      entityType: 'security_read_grant',
      entityId: row.id,
      after: {
        adminUserId: row.adminUserId,
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        grantedById: row.grantedById,
      },
      },
    );
  }
  return rows.length;
}

export async function createSecurityReadGrant(db: DB, input: CreateGrantInput): Promise<SecurityReadGrantRow> {
  const [beneficiary] = await db.select().from(users).where(eq(users.id, input.adminUserId)).limit(1);
  if (!beneficiary) throw ApiError.notFound('Administrator account');
  if (!beneficiary.isActive) throw ApiError.conflict('The administrator account is not active');

  const beneficiaryRoles = await rolesOf(db, beneficiary.id);
  if (userHasAnyRole(beneficiaryRoles, PERMISSIONS.SECURITY_READ)) {
    throw ApiError.conflict('This account already holds SECURITY_READ; no delegation is needed');
  }
  if (!beneficiaryRoles.includes('ADMIN')) {
    throw ApiError.conflict('A delegation can only be issued to an account that holds ADMIN');
  }
  if (beneficiary.id === input.actor.actorId) {
    throw ApiError.conflict('The issuer cannot delegate to itself');
  }

  const scopes = validateScopes(input.scopes);
  const expiresAt = validateExpiry(input.expiresAt);
  const reason = input.reason.trim();
  if (reason.length < 8) {
    throw ApiError.validation([
      { field: 'reason', message: 'A written reason is required', code: 'REQUIRED' },
    ]);
  }

  await expireSecurityReadGrants(db, { adminUserId: beneficiary.id, actor: input.actor });

  const live = await findActiveSecurityReadGrant(db, beneficiary.id);
  if (live) {
    throw ApiError.conflict('This administrator already has a live grant; amend or revoke it first');
  }

  const issuerId = input.actor.actorId;
  if (!issuerId) throw ApiError.unauthorized('The issuer must be an authenticated SUPER_ADMIN');

  const [row] = await db
    .insert(securityReadGrants)
    .values({
      id: randomUUID(),
      adminUserId: beneficiary.id,
      scopes,
      reason,
      grantedById: issuerId,
      expiresAt,
    })
    .returning();

  await writeAudit(db, input.actor, {
    action: 'SECURITY.DELEGATION_GRANTED',
    entityType: 'security_read_grant',
    entityId: row.id,
    after: {
      adminUserId: beneficiary.id,
      adminEmail: beneficiary.email,
      scopes,
      expiresAt,
      reason,
    },
  });
  return row as SecurityReadGrantRow;
}

export interface AmendGrantInput {
  id: string;
  scopes?: string[];
  expiresAt?: Date;
  reason?: string;
  actor: AuditContext;
}

export async function amendSecurityReadGrant(db: DB, input: AmendGrantInput): Promise<SecurityReadGrantRow> {
  const [current] = await db
    .select()
    .from(securityReadGrants)
    .where(eq(securityReadGrants.id, input.id))
    .limit(1);
  if (!current) throw ApiError.notFound('Security read grant');
  if (current.revokedAt) throw ApiError.conflict('This grant was revoked and cannot be amended');
  if (current.expiredAt || current.expiresAt.getTime() <= Date.now()) {
    throw ApiError.conflict('This grant has expired and cannot be amended');
  }

  const scopes = input.scopes ? validateScopes(input.scopes) : undefined;
  const expiresAt = input.expiresAt ? validateExpiry(input.expiresAt) : undefined;
  if (!scopes && !expiresAt) {
    throw ApiError.validation([{ field: 'scopes', message: 'Nothing to change', code: 'REQUIRED' }]);
  }

  const [row] = await db
    .update(securityReadGrants)
    .set({
      ...(scopes ? { scopes } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      lastAmendedById: input.actor.actorId,
      updatedAt: new Date(),
    })
    .where(eq(securityReadGrants.id, input.id))
    .returning();

  await writeAudit(db, input.actor, {
    action: 'SECURITY.DELEGATION_UPDATED',
    entityType: 'security_read_grant',
    entityId: row.id,
    before: { scopes: current.scopes, expiresAt: current.expiresAt },
    after: { scopes: row.scopes, expiresAt: row.expiresAt },
    metadata: { reason: input.reason ?? null },
  });
  return row as SecurityReadGrantRow;
}

export async function revokeSecurityReadGrant(
  db: DB,
  input: { id: string; reason?: string; actor: AuditContext },
): Promise<SecurityReadGrantRow> {
  const [current] = await db
    .select()
    .from(securityReadGrants)
    .where(eq(securityReadGrants.id, input.id))
    .limit(1);
  if (!current) throw ApiError.notFound('Security read grant');
  if (current.revokedAt) throw ApiError.conflict('This grant was already revoked');
  if (current.expiredAt || current.expiresAt.getTime() <= Date.now()) {
    throw ApiError.conflict('This grant has already expired');
  }

  const now = new Date();
  const [row] = await db
    .update(securityReadGrants)
    .set({ revokedAt: now, revokedById: input.actor.actorId, updatedAt: now })
    .where(eq(securityReadGrants.id, input.id))
    .returning();

  await writeAudit(db, input.actor, {
    action: 'SECURITY.DELEGATION_REVOKED',
    entityType: 'security_read_grant',
    entityId: row.id,
    before: { revokedAt: null, scopes: current.scopes, expiresAt: current.expiresAt },
    after: { revokedAt: now, revokedById: input.actor.actorId },
    metadata: { reason: input.reason ?? null, adminUserId: current.adminUserId },
  });
  return row as SecurityReadGrantRow;
}

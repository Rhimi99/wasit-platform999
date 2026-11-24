import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { ApiError, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { auditLogs } from '../../db/schema/audit';
import { roles, userRoles, users } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { hashPassword } from '../../lib/security';
import { requestPasswordReset, revokeAllSessionsForUser } from '../auth/service';
import {
  ASSIGNABLE_STAFF_ROLES,
  STAFF_AUDIT_FEED_ACTIONS,
  isAssignableStaffRole,
  isStaffRoleName,
  type AssignableStaffRole,
  type StaffListQuery,
  type StaffMember,
} from './types';

const SUPER_ADMIN = 'SUPER_ADMIN';

/**
 * The staff desk.
 *
 * Three invariants shape every function here:
 *  1. the population is *staff only* — a CUSTOMER/MERCHANT account is never
 *     readable or writable through these paths (it is a 404, not a 403: the
 *     caller must not learn whether the id exists);
 *  2. no path grants or edits SUPER_ADMIN — the top role stays provisioned by
 *     the out-of-band bootstrap, and the last active one can never be disabled;
 *  3. nothing secret is ever read or written: passwords are random and hashed,
 *     the invite goes out as a single-use reset link, and MFA material is only
 *     ever a boolean.
 */

async function staffRoleIds(db: DB): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(inArray(roles.name, [...STAFF_ROLES]));
  const map = new Map(rows.map((r) => [r.name, r.id] as const));
  if (map.size !== STAFF_ROLES.length) {
    const missing = STAFF_ROLES.filter((r) => !map.has(r));
    throw ApiError.internal(`Staff roles not seeded: ${missing.join(', ')}`);
  }
  return map;
}

function toMember(
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
    isLocked: boolean;
    emailVerified: boolean;
    mfaEnabled: boolean;
    createdAt: Date;
    lastLoginAt: Date | null;
  },
  roleNames: UserRole[],
): StaffMember {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles: roleNames,
    isActive: user.isActive,
    isLocked: user.isLocked,
    emailVerified: user.emailVerified,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

async function roleNamesByUser(db: DB, userIds: string[]): Promise<Map<string, UserRole[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userRoles.userId, roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(inArray(userRoles.userId, userIds), inArray(roles.name, [...STAFF_ROLES])));
  const map = new Map<string, UserRole[]>();
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row.roleName as UserRole);
    map.set(row.userId, list);
  }
  for (const list of map.values()) list.sort();
  return map;
}

export interface StaffListResult {
  items: StaffMember[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listStaff(db: DB, query: StaffListQuery): Promise<StaffListResult> {
  const roleMap = await staffRoleIds(db);
  const staffRoleIdList = [...roleMap.values()];

  const memberships = await db
    .select({ userId: userRoles.userId, roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(inArray(userRoles.roleId, staffRoleIdList));

  const staffUserIds = [...new Set(memberships.map((m) => m.userId))];
  if (staffUserIds.length === 0) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  }

  const conditions = [inArray(users.id, staffUserIds)];
  if (query.role) {
    const idsWithRole = memberships.filter((m) => m.roleName === query.role).map((m) => m.userId);
    if (idsWithRole.length === 0) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    conditions.push(inArray(users.id, idsWithRole));
  }
  if (query.status === 'active') conditions.push(eq(users.isActive, true));
  if (query.status === 'inactive') conditions.push(eq(users.isActive, false));
  if (query.q) {
    const pattern = `%${query.q.trim()}%`;
    const search = or(ilike(users.email, pattern), ilike(users.firstName, pattern), ilike(users.lastName, pattern));
    if (search) conditions.push(search);
  }

  const where = and(...conditions);
  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(users).where(where);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      isActive: users.isActive,
      isLocked: users.isLocked,
      emailVerified: users.emailVerified,
      mfaEnabled: users.mfaEnabled,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const roleNames = await roleNamesByUser(db, rows.map((r) => r.id));
  return {
    items: rows.map((r) => toMember(r, roleNames.get(r.id) ?? [])),
    total: countRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Reads one staff account. A non-staff id is a 404 so the desk cannot probe accounts. */
export async function getStaffMember(db: DB, userId: string): Promise<StaffMember> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Staff member');
  const roleNames = await roleNamesByUser(db, [userId]);
  const staffRoles = roleNames.get(userId) ?? [];
  if (staffRoles.length === 0) throw ApiError.notFound('Staff member');
  return toMember(rows[0], staffRoles);
}

async function refuse(
  db: DB,
  audit: AuditContext,
  targetId: string | null,
  reason: string,
  message: string,
): Promise<ApiError> {
  await writeAudit(db, audit, {
    action: 'RBAC.ESCALATION_REJECTED',
    entityType: 'USER',
    entityId: targetId,
    metadata: { reason },
  });
  return ApiError.forbidden(message);
}

export interface CreateStaffInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: AssignableStaffRole;
  sendInvite: boolean;
}

export interface CreateStaffResult {
  member: StaffMember;
  inviteSent: boolean;
  /** Development-only invite link token, mirroring the forgot-password tooling. */
  devResetToken?: string;
}

export async function createStaffMember(
  db: DB,
  input: CreateStaffInput,
  audit: AuditContext,
): Promise<CreateStaffResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw ApiError.validation([{ field: 'email', message: 'Invalid email address', code: 'VALIDATION_FAILED' }]);
  }
  if (!isAssignableStaffRole(input.role)) {
    throw ApiError.validation([
      { field: 'role', message: 'Role cannot be assigned through the staff desk', code: 'VALIDATION_FAILED' },
    ]);
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const roleMap = await staffRoleIds(db);
  const roleId = roleMap.get(input.role);
  if (!roleId) throw ApiError.internal(`Role ${input.role} is not seeded`);

  // The password is generated here and never leaves the server: the account is
  // activated through the invite link, which is the only credential the employee
  // ever receives. Nothing about it is written to the audit trail.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const userId = newId();

  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    firstName: input.firstName?.trim() || null,
    lastName: input.lastName?.trim() || null,
    emailVerified: true,
    isActive: true,
  });
  await db.insert(userRoles).values({ id: newId(), userId, roleId });

  let inviteSent = false;
  let devResetToken: string | undefined;
  if (input.sendInvite) {
    const invite = await requestPasswordReset(db, email);
    inviteSent = invite.userExists;
    devResetToken = invite.resetToken || undefined;
  }

  await writeAudit(db, audit, {
    action: 'RBAC.STAFF_CREATED',
    entityType: 'USER',
    entityId: userId,
    after: { email, role: input.role, inviteSent },
    metadata: { source: 'staff-desk', emailVerifiedBy: 'staff-invite' },
  });

  return { member: await getStaffMember(db, userId), inviteSent, devResetToken };
}

export async function changeStaffRole(
  db: DB,
  userId: string,
  role: AssignableStaffRole,
  actorId: string,
  audit: AuditContext,
): Promise<StaffMember> {
  const target = await getStaffMember(db, userId);

  if (target.id === actorId) {
    throw await refuse(db, audit, userId, 'self_role_change', 'You cannot change your own role');
  }
  if (target.roles.includes(SUPER_ADMIN as UserRole)) {
    throw await refuse(
      db,
      audit,
      userId,
      'super_admin_protected',
      'SUPER_ADMIN accounts are provisioned out of band and cannot be changed here',
    );
  }
  if (!isAssignableStaffRole(role)) {
    throw ApiError.validation([
      { field: 'role', message: 'Role cannot be assigned through the staff desk', code: 'VALIDATION_FAILED' },
    ]);
  }

  if (target.roles.length === 1 && target.roles[0] === role) return target;

  const roleMap = await staffRoleIds(db);
  const roleId = roleMap.get(role);
  if (!roleId) throw ApiError.internal(`Role ${role} is not seeded`);
  const staffRoleIdList = [...roleMap.values()];

  // Replace only the staff assignment(s): an account that also holds a business
  // role (a support agent who is also a merchant) keeps it.
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), inArray(userRoles.roleId, staffRoleIdList)));
  await db.insert(userRoles).values({ id: newId(), userId, roleId });

  const revoked = await revokeAllSessionsForUser(db, userId);

  await writeAudit(db, audit, {
    action: 'RBAC.STAFF_ROLE_CHANGED',
    entityType: 'USER',
    entityId: userId,
    before: { roles: target.roles },
    after: { roles: [role] },
    metadata: { source: 'staff-desk', sessionsRevoked: revoked },
  });

  return getStaffMember(db, userId);
}

export type StaffStatusRefusal = 'last_super_admin' | 'super_admin_protected' | 'self_status_change';

const STATUS_REFUSAL_MESSAGES: Record<StaffStatusRefusal, string> = {
  last_super_admin: 'The last active SUPER_ADMIN cannot be disabled',
  super_admin_protected: 'Only a SUPER_ADMIN may disable a SUPER_ADMIN',
  self_status_change: 'You cannot change your own account status',
};

/**
 * The decision behind {@link setStaffStatus}, kept pure so every branch is
 * testable without mutating the shared test database (the suite runs in
 * parallel against one PostgreSQL instance, so an integration test cannot
 * safely drive the deployment down to a single SUPER_ADMIN).
 *
 * The order matters: "this would leave no owner" is a more precise answer than
 * "you may not touch this account", so it is reported first.
 */
export function staffStatusRefusal(input: {
  isSelf: boolean;
  isDeactivating: boolean;
  targetIsSuperAdmin: boolean;
  actorIsSuperAdmin: boolean;
  activeSuperAdmins: number;
}): StaffStatusRefusal | null {
  if (!input.isDeactivating) return input.isSelf ? 'self_status_change' : null;
  if (input.targetIsSuperAdmin && input.activeSuperAdmins <= 1) return 'last_super_admin';
  if (input.targetIsSuperAdmin && !input.actorIsSuperAdmin) return 'super_admin_protected';
  if (input.isSelf) return 'self_status_change';
  return null;
}

export async function setStaffStatus(
  db: DB,
  userId: string,
  isActive: boolean,
  actor: { id: string; roles: UserRole[] },
  audit: AuditContext,
): Promise<StaffMember> {
  const target = await getStaffMember(db, userId);

  const targetIsSuperAdmin = target.roles.includes(SUPER_ADMIN as UserRole);
  const refusal = staffStatusRefusal({
    isSelf: target.id === actor.id,
    isDeactivating: !isActive,
    targetIsSuperAdmin,
    actorIsSuperAdmin: actor.roles.includes(SUPER_ADMIN as UserRole),
    activeSuperAdmins: targetIsSuperAdmin && !isActive ? await activeSuperAdminCount(db) : 0,
  });
  if (refusal) {
    throw await refuse(db, audit, userId, refusal, STATUS_REFUSAL_MESSAGES[refusal]);
  }

  if (target.isActive === isActive) return target;

  await db.update(users).set({ isActive, updatedAt: new Date() }).where(eq(users.id, userId));
  const revoked = isActive ? 0 : await revokeAllSessionsForUser(db, userId);

  await writeAudit(db, audit, {
    action: 'RBAC.STAFF_STATUS_CHANGED',
    entityType: 'USER',
    entityId: userId,
    before: { isActive: target.isActive },
    after: { isActive },
    metadata: { source: 'staff-desk', sessionsRevoked: revoked },
  });

  return getStaffMember(db, userId);
}

export async function activeSuperAdminCount(db: DB): Promise<number> {
  const roleMap = await staffRoleIds(db);
  const superAdminRoleId = roleMap.get(SUPER_ADMIN);
  if (!superAdminRoleId) return 0;
  const [row] = await db
    .select({ total: sql<number>`count(distinct ${users.id})::int` })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.roleId, superAdminRoleId), eq(users.isActive, true)));
  return row?.total ?? 0;
}

export interface RoleCatalogEntry {
  role: AssignableStaffRole;
  permissions: Permission[];
}

/** Assignable roles with the permissions they actually produce — shown before confirming. */
export function roleCatalog(): RoleCatalogEntry[] {
  return ASSIGNABLE_STAFF_ROLES.map((role) => ({
    role,
    permissions: [...ROLE_PERMISSIONS[role]].sort(),
  }));
}

export interface StaffAuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
}

export async function listStaffActivity(db: DB, userId: string): Promise<StaffAuditEntry[]> {
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      actorEmail: users.email,
      before: auditLogs.before,
      after: auditLogs.after,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorId, users.id))
    .where(and(eq(auditLogs.entityId, userId), inArray(auditLogs.action, [...STAFF_AUDIT_FEED_ACTIONS])))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** True when the id belongs to a staff account; used to guard the legacy status route. */
export async function isStaffAccount(db: DB, userId: string): Promise<boolean> {
  const roleNames = await roleNamesByUser(db, [userId]);
  return (roleNames.get(userId) ?? []).some((r) => isStaffRoleName(r));
}

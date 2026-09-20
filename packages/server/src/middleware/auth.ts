import { getCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ApiError, PERMISSIONS, type Permission, type PermissionKey, userHasAnyRole, type UserRole } from '@wasit/shared';
import { db } from '../db/client';
import { sessions, userRoles, users } from '../db/schema/auth';
import { roles } from '../db/schema/auth';
import { getContext, setContext } from '../lib/request-context';
import { hashToken } from '../lib/security';

export const SESSION_COOKIE = 'wasit_session';

const byKey = (k: PermissionKey): Permission => PERMISSIONS[k];

export interface SessionPayload {
  userId: string;
}

async function loadAuthUser(c: Context): Promise<void> {
  const ctx = getContext(c);
  const token = getCookie(c, SESSION_COOKIE) ?? undefined;
  if (!token) return;

  const tokenHash = hashToken(token);
  const now = new Date();

  const session = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, now),
        isNull(sessions.revokedAt),
      ),
    )
    .limit(1);

  if (session.length === 0) return;

  const userRow = await db
    .select()
    .from(users)
    .where(eq(users.id, session[0].userId))
    .limit(1);

  if (userRow.length === 0 || !userRow[0].isActive || userRow[0].isLocked) return;

  const roleRows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userRow[0].id));

  setContext(c, {
    ...ctx,
    user: {
      id: userRow[0].id,
      email: userRow[0].email,
      emailVerified: userRow[0].emailVerified,
      isActive: userRow[0].isActive,
      roles: roleRows.map((r) => r.roleName as UserRole),
    },
  });
}

/** Attaches the current user to the request context if a valid session exists. */
export async function optionalAuth(c: Context, next: Next): Promise<Response | void> {
  await loadAuthUser(c);
  return next();
}

/** Requires an authenticated user. */
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  await loadAuthUser(c);
  const ctx = getContext(c);
  if (!ctx.user) {
    throw ApiError.unauthorized('Authentication required');
  }
  return next();
}

/** RBAC authorization: requires the user to hold one of the given permissions. */
export function requirePermission(...permissions: Permission[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    await loadAuthUser(c);
    const ctx = getContext(c);
    if (!ctx.user) {
      throw ApiError.unauthorized('Authentication required');
    }
    const allowed = permissions.some((p) => userHasAnyRole(ctx.user!.roles, p));
    if (!allowed) {
      throw ApiError.forbidden();
    }
    return next();
  };
}

/** Restrict to specific roles only. */
export function requireRole(...rolesAllowed: UserRole[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    await loadAuthUser(c);
    const ctx = getContext(c);
    if (!ctx.user) {
      throw ApiError.unauthorized('Authentication required');
    }
    const hasRole = ctx.user.roles.some((r) => rolesAllowed.includes(r));
    if (!hasRole) {
      throw ApiError.forbidden();
    }
    return next();
  };
}
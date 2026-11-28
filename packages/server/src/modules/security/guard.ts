import type { Context, Next } from 'hono';
import { ApiError, PERMISSIONS, userHasAnyRole } from '@wasit/shared';
import { getContext, getDb } from '../../lib/request-context.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import {
  SENSITIVE_SECURITY_SCOPES,
  findActiveSecurityReadGrant,
  type SecurityReadScope,
} from './delegations.js';

export function auditContext(c: Context): AuditContext {
  const ctx = getContext(c);
  return {
    actorId: ctx?.user?.id ?? null,
    ipAddress: ctx?.ipAddress ?? null,
    userAgent: ctx?.userAgent ?? null,
  };
}

/**
 * Read gate for the security centre (WCDC-02).
 *
 * Two ways in, and only two:
 *  - the account's roles carry `SECURITY_READ` (today: `SUPER_ADMIN`), or
 *  - the account holds `ADMIN` **and** a live grant from a `SUPER_ADMIN` that
 *    covers this exact scope.
 *
 * Everything is resolved from the database on this request. The grant is not a
 * claim inside the session, so revoking it stops the next call, and removing the
 * ADMIN role stops it too.
 */
export function requireSecurityRead(scope: SecurityReadScope) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ctx = getContext(c);
    const user = ctx?.user;
    if (!user) throw ApiError.unauthorized('Authentication required');

    if (userHasAnyRole(user.roles, PERMISSIONS.SECURITY_READ)) {
      return next();
    }

    const db = getDb(c);
    const audit = auditContext(c);

    // An ADMIN whose role was removed must not keep reading through an old grant.
    if (!user.roles.includes('ADMIN')) {
      await writeAudit(db, audit, {
        action: 'SECURITY.READ_REFUSED',
        entityType: 'security_read_grant',
        entityId: null,
        after: { scope, path: c.req.path, code: 'NOT_ADMIN' },
        metadata: { roles: user.roles },
      });
      throw ApiError.forbidden('The security centre is not delegated to this account');
    }

    const grant = await findActiveSecurityReadGrant(db, user.id);
    if (!grant) {
      await writeAudit(db, audit, {
        action: 'SECURITY.READ_REFUSED',
        entityType: 'security_read_grant',
        entityId: null,
        after: { scope, path: c.req.path, code: 'NO_ACTIVE_GRANT' },
        metadata: { roles: user.roles },
      });
      throw ApiError.forbidden('No active delegation permits reading the security centre');
    }

    if (!grant.scopes.includes(scope)) {
      await writeAudit(db, audit, {
        action: 'SECURITY.READ_SCOPE_REFUSED',
        entityType: 'security_read_grant',
        entityId: grant.id,
        after: { scope, path: c.req.path, delegatedScopes: grant.scopes },
      });
      throw ApiError.forbidden(`The delegation does not cover "${scope}"`);
    }

    if (SENSITIVE_SECURITY_SCOPES.includes(scope)) {
      await writeAudit(db, audit, {
        action: 'SECURITY.DELEGATED_READ',
        entityType: 'security_read_grant',
        entityId: grant.id,
        after: { scope, path: c.req.path, expiresAt: grant.expiresAt },
      });
    }

    return next();
  };
}

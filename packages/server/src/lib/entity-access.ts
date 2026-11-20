import { PERMISSIONS, type Permission, type UserRole, userHasAnyRole } from '@wasit/shared';

/**
 * Who is asking for a business-entity profile.
 *
 * Built by the route from the request context: `userId`/`roles` are present only
 * when a valid session exists (the entity routes use `optionalAuth`, so an
 * anonymous visitor yields `{}`).
 */
export interface EntityViewer {
  userId?: string;
  roles?: UserRole[];
}

/**
 * The existing permission that marks internal staff allowed to read an entity's
 * private data (contact list, legal/tax identifiers).
 *
 * `user:read` is granted to SUPPORT, RISK, DISPUTE, ADMIN and SUPER_ADMIN and to
 * no seller role (sellers hold `user:read:own` only), so it discriminates staff
 * from owners without inventing a new permission or widening any role.
 */
export const ENTITY_PRIVATE_READ_PERMISSION: Permission = PERMISSIONS.USER_READ;

/** True when the viewer holds the staff permission for entity-private data. */
export function isEntityStaff(viewer: EntityViewer): boolean {
  return userHasAnyRole(viewer.roles ?? [], ENTITY_PRIVATE_READ_PERMISSION);
}

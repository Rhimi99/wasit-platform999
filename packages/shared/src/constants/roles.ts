export const USER_ROLES = [
  'CUSTOMER',
  'MERCHANT',
  'SUPPLIER',
  'COMPANY',
  'MARKETER',
  'SUPPORT',
  'RISK',
  'DISPUTE',
  'ADMIN',
  'SUPER_ADMIN',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Roles a visitor may choose for themselves at public registration.
 *
 * This is an allow-list, not a deny-list: a role is self-selectable only by
 * being named here, so adding a new privileged role to {@link USER_ROLES} can
 * never make it self-grantable by omission. Staff and platform roles (SUPPORT,
 * RISK, DISPUTE, ADMIN, SUPER_ADMIN) are deliberately absent — they are
 * provisioned out of band (seeder, or the super-admin bootstrap) and can never
 * be requested through the public API.
 */
export const SELF_SELECTABLE_ROLES = [
  'CUSTOMER',
  'MERCHANT',
  'SUPPLIER',
  'COMPANY',
  'MARKETER',
] as const;

export type SelfSelectableRole = (typeof SELF_SELECTABLE_ROLES)[number];

/**
 * Narrows an untrusted role value to one a visitor is allowed to pick.
 *
 * Used by both the registration schema and the registration service, so a
 * crafted request body and a direct service call are judged by the same rule.
 */
export function isSelfSelectableRole(value: unknown): value is SelfSelectableRole {
  return (
    typeof value === 'string' &&
    (SELF_SELECTABLE_ROLES as readonly string[]).includes(value)
  );
}

export const ROLE_HIERARCHY: Record<string, number> = {
  CUSTOMER: 0,
  MERCHANT: 1,
  SUPPLIER: 1,
  COMPANY: 1,
  MARKETER: 1,
  SUPPORT: 40,
  RISK: 50,
  DISPUTE: 50,
  ADMIN: 90,
  SUPER_ADMIN: 100,
};

/**
 * Internal WASIT staff roles.
 *
 * These are the roles provisioned out of band (seeder / super-admin bootstrap)
 * that operate the platform's desks and administrative surfaces — exactly the
 * complement of {@link SELF_SELECTABLE_ROLES}. They are the roles for which
 * mandatory multi-factor authentication is enforced (LC-06): a staff account may
 * not reach a staff API or hold a fully authenticated staff session until it has
 * an enabled second factor.
 *
 * Kept as a single source of truth so enforcement is derived from the role set,
 * never from a hand-maintained list at a call site.
 */
export const STAFF_ROLES = ['SUPPORT', 'RISK', 'DISPUTE', 'ADMIN', 'SUPER_ADMIN'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/** True when the role set includes at least one internal staff role. */
export function isStaffRole(roles: readonly string[] | undefined | null): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));
}
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
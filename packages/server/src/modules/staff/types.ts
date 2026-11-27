import { STAFF_ROLES, type UserRole } from '@wasit/shared';

/**
 * Roles the staff desk may hand out.
 *
 * SUPER_ADMIN is deliberately absent: the top role is provisioned out of band by
 * the one-shot bootstrap CLI (`npm run bootstrap:super-admin`), so no HTTP path —
 * not even a SUPER_ADMIN's — can mint a second platform owner. That is the same
 * rule the public registration allow-list follows: a privileged role is never
 * grantable by a request body.
 */
export const ASSIGNABLE_STAFF_ROLES = ['SUPPORT', 'RISK', 'DISPUTE', 'ADMIN'] as const;

export type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];

export function isAssignableStaffRole(value: unknown): value is AssignableStaffRole {
  return typeof value === 'string' && (ASSIGNABLE_STAFF_ROLES as readonly string[]).includes(value);
}

export function isStaffRoleName(value: string): value is UserRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

/** Account-state filter accepted by the staff list. */
export const STAFF_STATUS_FILTERS = ['all', 'active', 'inactive'] as const;
export type StaffStatusFilter = (typeof STAFF_STATUS_FILTERS)[number];

/** Audit actions the staff desk writes; also the ones its activity feed reads back. */
export const STAFF_AUDIT_ACTIONS = [
  'RBAC.STAFF_CREATED',
  'RBAC.STAFF_ROLE_CHANGED',
  'RBAC.STAFF_STATUS_CHANGED',
  'RBAC.ESCALATION_REJECTED',
] as const;

/**
 * Actions shown in a staff member's activity feed. `ADMIN.USER_STATUS` is the
 * legacy account-status action: it can still land on a staff row, so it belongs
 * in the same timeline.
 */
export const STAFF_AUDIT_FEED_ACTIONS = [...STAFF_AUDIT_ACTIONS, 'ADMIN.USER_STATUS'] as const;

export interface StaffMember {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roles: UserRole[];
  isActive: boolean;
  isLocked: boolean;
  emailVerified: boolean;
  /** Whether a second factor is enrolled. The secret and recovery codes never leave the DB. */
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface StaffListQuery {
  q?: string;
  role?: AssignableStaffRole | 'SUPER_ADMIN';
  status?: StaffStatusFilter;
  page: number;
  pageSize: number;
}

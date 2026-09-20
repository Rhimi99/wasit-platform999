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
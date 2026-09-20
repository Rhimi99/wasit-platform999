import type { Permission } from './permissions';
import { PERMISSIONS as P } from './permissions';
import { USER_ROLES, type UserRole } from './roles';

type PermissionKey = keyof typeof P;
const perm = (k: PermissionKey): Permission => P[k];

/**
 * Role -> Permission matrix. All grants are explicit.
 * The hierarchy does NOT imply permission inheritance automatically:
 * higher roles must still be granted the permissions explicitly (principle of least privilege).
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  CUSTOMER: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'),
    perm('PRODUCT_READ'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_LIST'),
    perm('COMPANY_READ'), perm('COMPANY_LIST'),
    perm('SEARCH_PUBLIC'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
    perm('ORDER_CREATE'), perm('ORDER_READ_OWN'),
    perm('TRANSACTION_READ'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('VERIFICATION_SUBMIT'), perm('VERIFICATION_READ'),
    perm('TRUST_READ_OWN'),
    perm('DISPUTE_CREATE'), perm('DISPUTE_READ_OWN'),
    perm('ANALYTICS_READ_OWN'),
    perm('AI_USE'),
    perm('MEDIA_READ_OWN'),
    perm('SUBSCRIPTION_READ_OWN'), perm('SUBSCRIPTION_CREATE'), perm('SUBSCRIPTION_UPDATE'), perm('SUBSCRIPTION_CANCEL'),
  ]),

  MERCHANT: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'),
    perm('PRODUCT_CREATE'), perm('PRODUCT_READ'), perm('PRODUCT_UPDATE'), perm('PRODUCT_DELETE'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_UPDATE'),
    perm('COMPANY_READ'),
    perm('SEARCH_PUBLIC'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
    perm('ORDER_CREATE'), perm('ORDER_READ_OWN'), perm('ORDER_UPDATE'), perm('ORDER_LIST'),
    perm('TRANSACTION_READ'),
    perm('PAYMENT_CREATE'), perm('PAYMENT_READ'),
    perm('COMMISSION_READ'),
    perm('INVENTORY_READ'), perm('INVENTORY_UPDATE'), perm('INVENTORY_MOVEMENT_CREATE'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('VERIFICATION_SUBMIT'), perm('VERIFICATION_READ'),
    perm('TRUST_READ_OWN'),
    perm('DISPUTE_CREATE'), perm('DISPUTE_READ_OWN'),
    perm('AD_CREATE'), perm('CAMPAIGN_CREATE'),
    perm('AI_USE'),
    perm('MEDIA_UPLOAD'), perm('MEDIA_READ_OWN'), perm('MEDIA_DELETE_OWN'),
    perm('ANALYTICS_READ_OWN'),
    perm('SUBSCRIPTION_READ_OWN'), perm('SUBSCRIPTION_CREATE'), perm('SUBSCRIPTION_UPDATE'), perm('SUBSCRIPTION_CANCEL'),
  ]),

  SUPPLIER: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'),
    perm('PRODUCT_CREATE'), perm('PRODUCT_READ'), perm('PRODUCT_UPDATE'), perm('PRODUCT_DELETE'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_UPDATE'),
    perm('MERCHANT_READ'), perm('MERCHANT_LIST'),
    perm('COMPANY_READ'),
    perm('SEARCH_PUBLIC'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
    perm('ORDER_READ_OWN'), perm('ORDER_UPDATE'), perm('ORDER_LIST'),
    perm('TRANSACTION_READ'),
    perm('PAYMENT_READ'),
    perm('COMMISSION_READ'),
    perm('INVENTORY_READ'), perm('INVENTORY_UPDATE'), perm('INVENTORY_MOVEMENT_CREATE'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('VERIFICATION_SUBMIT'), perm('VERIFICATION_READ'),
    perm('TRUST_READ_OWN'),
    perm('DISPUTE_CREATE'), perm('DISPUTE_READ_OWN'),
    perm('AD_CREATE'), perm('CAMPAIGN_CREATE'),
    perm('AI_USE'),
    perm('MEDIA_UPLOAD'), perm('MEDIA_READ_OWN'), perm('MEDIA_DELETE_OWN'),
    perm('ANALYTICS_READ_OWN'),
    perm('SUBSCRIPTION_READ_OWN'), perm('SUBSCRIPTION_CREATE'), perm('SUBSCRIPTION_UPDATE'), perm('SUBSCRIPTION_CANCEL'),
  ]),

  COMPANY: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'),
    perm('PRODUCT_READ'), perm('PRODUCT_CREATE'), perm('PRODUCT_UPDATE'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_LIST'),
    perm('COMPANY_READ'), perm('COMPANY_UPDATE'),
    perm('SEARCH_PUBLIC'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
    perm('ORDER_READ_OWN'), perm('ORDER_UPDATE'), perm('ORDER_LIST'),
    perm('TRANSACTION_READ'),
    perm('PAYMENT_READ'),
    perm('COMMISSION_READ'),
    perm('INVENTORY_READ'), perm('INVENTORY_UPDATE'), perm('INVENTORY_MOVEMENT_CREATE'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('VERIFICATION_SUBMIT'), perm('VERIFICATION_READ'),
    perm('TRUST_READ_OWN'),
    perm('DISPUTE_CREATE'), perm('DISPUTE_READ_OWN'),
    perm('AD_CREATE'), perm('CAMPAIGN_CREATE'),
    perm('AI_USE'),
    perm('MEDIA_UPLOAD'), perm('MEDIA_READ_OWN'), perm('MEDIA_DELETE_OWN'),
    perm('ANALYTICS_READ_OWN'),
    perm('SUBSCRIPTION_READ_OWN'), perm('SUBSCRIPTION_CREATE'), perm('SUBSCRIPTION_UPDATE'), perm('SUBSCRIPTION_CANCEL'),
  ]),

  MARKETER: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'),
    perm('PRODUCT_READ'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_LIST'),
    perm('SEARCH_PUBLIC'), perm('SEARCH_ADVANCED'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
    perm('AD_CREATE'), perm('AD_MANAGE'), perm('CAMPAIGN_CREATE'), perm('CAMPAIGN_MANAGE'),
    perm('ANALYTICS_READ_OWN'),
    perm('AI_USE'),
    perm('MEDIA_UPLOAD'), perm('MEDIA_READ_OWN'), perm('MEDIA_DELETE_OWN'),
  ]),

  SUPPORT: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ_OWN'), perm('USER_READ'), perm('USER_LIST'),
    perm('PRODUCT_READ'), perm('PRODUCT_LIST'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_LIST'),
    perm('COMPANY_READ'), perm('COMPANY_LIST'),
    perm('ORDER_READ'), perm('ORDER_LIST'),
    perm('TRANSACTION_READ'), perm('TRANSACTION_LIST'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('VERIFICATION_READ'),
    perm('TRUST_READ'),
    perm('DISPUTE_READ'), perm('DISPUTE_READ_OWN'), perm('DISPUTE_REVIEW'), perm('DISPUTE_MANAGE'),
    perm('ANALYTICS_READ_ALL'),
    perm('AI_USE'),
  ]),

  RISK: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ'), perm('USER_LIST'),
    perm('TRANSACTION_READ'), perm('TRANSACTION_LIST'),
    perm('ORDER_READ'), perm('ORDER_LIST'),
    perm('RISK_READ'), perm('RISK_MANAGE'), perm('RISK_REVIEW'),
    perm('VERIFICATION_READ'),
    perm('TRUST_READ'), perm('TRUST_READ_ALL'),
    perm('ADMIN_RISK'),
    perm('REPORT_READ'),
    perm('AUDIT_LOG_READ'),
    perm('ANALYTICS_READ_ALL'),
    perm('AI_USE'),
  ]),

  DISPUTE: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ'),
    perm('ORDER_READ'),
    perm('DISPUTE_CREATE'), perm('DISPUTE_READ'), perm('DISPUTE_READ_OWN'),
    perm('DISPUTE_REVIEW'), perm('DISPUTE_ASSIGN'), perm('DISPUTE_MANAGE'), perm('DISPUTE_DECIDE'), perm('DISPUTE_RESOLVE'),
    perm('MESSAGE_SEND'), perm('MESSAGE_READ_OWN'),
    perm('TRANSACTION_READ'),
    perm('AUDIT_LOG_READ'),
    perm('ANALYTICS_READ_ALL'),
    perm('AI_USE'),
  ]),

  ADMIN: new Set([
    perm('AUTH_READ_OWN'), perm('AUTH_UPDATE_OWN'),
    perm('USER_READ'), perm('USER_CREATE'), perm('USER_UPDATE'), perm('USER_DELETE'), perm('USER_LIST'),
    perm('PRODUCT_READ'), perm('PRODUCT_UPDATE'), perm('PRODUCT_DELETE'), perm('PRODUCT_LIST'), perm('PRODUCT_MANAGE'),
    perm('SUPPLIER_READ'), perm('SUPPLIER_UPDATE'), perm('SUPPLIER_LIST'),
    perm('MERCHANT_READ'), perm('MERCHANT_UPDATE'), perm('MERCHANT_LIST'),
    perm('COMPANY_READ'), perm('COMPANY_UPDATE'), perm('COMPANY_LIST'),
    perm('ORDER_READ'), perm('ORDER_UPDATE'), perm('ORDER_LIST'),
    perm('TRANSACTION_READ'), perm('TRANSACTION_LIST'),
    perm('LEDGER_READ'),
    perm('COMMISSION_READ'), perm('COMMISSION_MANAGE'),
    perm('PAYMENT_READ'), perm('REFUND_MANAGE'),
    perm('MESSAGE_SEND'),
    perm('VERIFICATION_READ'), perm('VERIFICATION_REVIEW'), perm('VERIFICATION_APPROVE'), perm('VERIFICATION_REJECT'), perm('VERIFICATION_MANAGE'),
    perm('TRUST_READ'), perm('TRUST_READ_ALL'),
    perm('RISK_READ'), perm('RISK_MANAGE'), perm('RISK_REVIEW'),
    perm('DISPUTE_READ'), perm('DISPUTE_REVIEW'), perm('DISPUTE_ASSIGN'), perm('DISPUTE_MANAGE'), perm('DISPUTE_DECIDE'), perm('DISPUTE_RESOLVE'), perm('DISPUTE_READ_OWN'),
    perm('AD_MANAGE'), perm('CAMPAIGN_MANAGE'),
    perm('AI_MANAGE'), perm('AI_COST_READ'), perm('AI_USE'),
    perm('MEDIA_UPLOAD'), perm('MEDIA_READ_OWN'), perm('MEDIA_DELETE_OWN'), perm('MEDIA_DELETE_ANY'),
    perm('ANALYTICS_READ_ALL'),
    perm('ADMIN_USERS'), perm('ADMIN_ADS'), perm('ADMIN_AI'),
    perm('ADMIN_ANALYTICS'), perm('ADMIN_SYSTEM'), perm('ADMIN_POLICIES'),
    perm('ADMIN_COMMISSIONS'), perm('ADMIN_SUBSCRIPTIONS'),
    perm('ADMIN_VERIFICATION'), perm('ADMIN_TRUST'), perm('ADMIN_RISK'),
    perm('ADMIN_DISPUTES'), perm('ADMIN_REPORTS'),
    perm('AUDIT_LOG_READ'), perm('AUDIT_LOG_EXPORT'),
    perm('SUBSCRIPTION_MANAGE'),
    perm('SEARCH_ADVANCED'),
    perm('FAVORITE_MANAGE'), perm('SAVED_ITEM_MANAGE'), perm('SEARCH_HISTORY_MANAGE'),
  ]),

  SUPER_ADMIN: new Set<Permission>(
    (Object.values(P) as Permission[]),
  ),
};

export function getPermissionsForRole(role: UserRole): ReadonlySet<Permission> {
  const set = ROLE_PERMISSIONS[role];
  if (!set) {
    throw new Error(`Unknown role: ${role}`);
  }
  return set;
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return getPermissionsForRole(role).has(permission);
}

export function userHasAnyRole(
  roles: UserRole[],
  permission: Permission,
): boolean {
  return roles.some((r) => roleHasPermission(r, permission));
}

export const ALL_USER_ROLES = USER_ROLES;
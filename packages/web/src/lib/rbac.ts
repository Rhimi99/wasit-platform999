// مرآة لصلاحيات الـ Backend (من @wasit/shared) — للتحكم في ظهور الوظائف في الواجهة.
// ملاحظة أمنية: الأمان الفعلي في الـ Backend (requireRole/requirePermission).
// هذه الأداة تحدد ما نعرضه للمستخدم فقط.

import type { UserRole } from './types';

// أسماء الصلاحيات على مستوى عالٍ (تجميعية) لاستخدام الواجهة — تطابق وظائف الـ API المتاحة.
export type Feature =
  | 'product.create'
  | 'product.manage.own'
  | 'supplier.create'
  | 'supplier.update'
  | 'merchant.create'
  | 'merchant.update'
  | 'company.create'
  | 'company.update'
  | 'order.create'
  | 'order.manage'
  | 'admin'
  | 'admin.buildDashboard'
  | 'billing.payments'
  | 'billing.commissions'
  | 'inventory.manage'
  | 'ads.manage'
  | 'campaign.manage'
  | 'ai.use'
  | 'media.use'
  | 'analytics.own'
  | 'analytics.all'
  | 'disputes.manage'
  | 'risk.manage'
  | 'verification.submit'
  | 'subscriptions.manage'
  | 'subscription.own'
  | 'messages'
  | 'library';

// الدور -> الميزات. تُقرأ الصلاحيات الفعلية من RBAC الخادم عند الحاجة؛ هنا عيّنة واضحة للواجهة.
const ROLE_FEATURES: Record<UserRole, ReadonlySet<Feature>> = {
  CUSTOMER: new Set<Feature>([
    'order.create', 'verification.submit', 'payment.view' as Feature, 'messages', 'library',
    'subscription.own',
  ]),
  MERCHANT: new Set<Feature>([
    'product.create', 'product.manage.own', 'order.create', 'order.manage',
    'inventory.manage', 'ads.manage', 'campaign.manage', 'ai.use', 'media.use', 'analytics.own',
    'billing.payments', 'billing.commissions', 'messages', 'verification.submit', 'library',
    'subscription.own',
  ]),
  SUPPLIER: new Set<Feature>([
    'product.create', 'product.manage.own', 'supplier.create', 'supplier.update',
    'order.manage', 'inventory.manage', 'ads.manage', 'campaign.manage', 'ai.use', 'media.use',
    'analytics.own', 'billing.payments', 'billing.commissions', 'messages', 'verification.submit', 'library',
    'subscription.own',
  ]),
  COMPANY: new Set<Feature>([
    'company.create', 'company.update', 'order.create', 'order.manage',
    'inventory.manage', 'ads.manage', 'campaign.manage', 'ai.use', 'media.use', 'analytics.own',
    'billing.payments', 'billing.commissions', 'messages', 'verification.submit', 'library',
    'subscription.own',
  ]),
  MARKETER: new Set<Feature>([
    'ads.manage', 'campaign.manage', 'ai.use', 'media.use', 'analytics.own', 'library',
  ]),
  SUPPORT: new Set<Feature>([
    'messages', 'disputes.manage', 'analytics.all',
  ]),
  RISK: new Set<Feature>([
    'risk.manage', 'analytics.all',
  ]),
  DISPUTE: new Set<Feature>([
    'disputes.manage', 'analytics.all',
  ]),
  ADMIN: new Set<Feature>([
    'admin', 'admin.buildDashboard', 'billing.payments', 'billing.commissions',
    'ads.manage', 'campaign.manage', 'ai.use', 'media.use', 'analytics.all', 'disputes.manage',
    'risk.manage', 'subscriptions.manage', 'inventory.manage',
  ]),
  SUPER_ADMIN: new Set<Feature>([
    'admin', 'admin.buildDashboard', 'billing.payments', 'billing.commissions',
    'ads.manage', 'campaign.manage', 'ai.use', 'media.use', 'analytics.all', 'disputes.manage',
    'risk.manage', 'subscriptions.manage', 'inventory.manage',
  ]),
};

export function userHasFeature(roles: UserRole[], feature: Feature): boolean {
  return roles.some((r) => ROLE_FEATURES[r]?.has(feature));
}

export function isDashboardRole(roles: UserRole[]): boolean {
  return roles.some((r) =>
    ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'RISK', 'DISPUTE', 'MARKETER'].includes(r),
  );
}

export function primaryRole(roles: UserRole[]): UserRole {
  if (roles.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (roles.includes('ADMIN')) return 'ADMIN';
  if (roles.includes('SUPPLIER')) return 'SUPPLIER';
  if (roles.includes('MERCHANT')) return 'MERCHANT';
  if (roles.includes('COMPANY')) return 'COMPANY';
  if (roles.includes('MARKETER')) return 'MARKETER';
  if (roles.includes('SUPPORT')) return 'SUPPORT';
  if (roles.includes('RISK')) return 'RISK';
  if (roles.includes('DISPUTE')) return 'DISPUTE';
  return 'CUSTOMER';
}
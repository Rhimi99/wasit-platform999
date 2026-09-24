import type { Feature } from './rbac';
import type { UserRole } from './types';

/**
 * The auditable surface of the platform, as data.
 *
 * The Owner Audit Center renders this list so the owner has one index of every
 * module rather than having to remember routes. Each entry carries:
 *
 *  * `path` — the real SPA route, opened with the current session;
 *  * `probe` — a real API endpoint of that module, which the "probe" button calls
 *    with the current session and reports the status code for, so a permission is
 *    verified against server RBAC instead of a UI badge;
 *  * `features` / `roles` — how the entry is *marked* for the current session.
 *    This is a hint only: the server still refuses what the session may not read,
 *    which is what the probe proves.
 */
export interface AuditModule {
  id: string;
  /** i18n label key; falls back to the English dictionary when missing. */
  labelKey: string;
  path: string;
  probe: { method: 'GET' | 'POST'; path: string };
  /** Any of these features grants the module (client-side hint). */
  features?: Feature[];
  /** Roles that additionally grant it (e.g. admin-only surfaces). */
  roles?: UserRole[];
  /** Marks the entry as a full E2E flow (Marketing Video). */
  flow?: boolean;
}

export const ADMIN_ROLES: UserRole[] = ['ADMIN', 'SUPER_ADMIN'];
export const STAFF_ROLES: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'RISK', 'DISPUTE'];

/** Ordered groups, each a coherent slice of the platform. */
export const AUDIT_MODULE_GROUPS: { id: string; labelKey: string; modules: AuditModule[] }[] = [
  {
    id: 'overview',
    labelKey: 'demo.owner.group.overview',
    modules: [
      { id: 'dashboard', labelKey: 'dashboard.overview', path: '/dashboard', probe: { method: 'GET', path: '/api/auth/me' } },
      { id: 'admin-dashboard', labelKey: 'admin.title', path: '/admin', probe: { method: 'GET', path: '/api/admin/stats' }, roles: ADMIN_ROLES },
      { id: 'admin-analytics', labelKey: 'admin.analytics', path: '/admin/analytics', probe: { method: 'GET', path: '/api/admin/analytics/overview' }, roles: ADMIN_ROLES },
      { id: 'admin-reports', labelKey: 'admin.reports', path: '/admin/reports', probe: { method: 'GET', path: '/api/admin/reports' }, roles: ADMIN_ROLES },
    ],
  },
  {
    id: 'commerce',
    labelKey: 'demo.owner.group.commerce',
    modules: [
      { id: 'marketplace', labelKey: 'nav.marketplace', path: '/marketplace', probe: { method: 'GET', path: '/api/products' } },
      { id: 'search', labelKey: 'nav.search', path: '/search?q=olive', probe: { method: 'GET', path: '/api/search?q=olive' } },
      { id: 'price-comparison', labelKey: 'nav.priceComparison', path: '/price-comparison', probe: { method: 'GET', path: '/api/price-comparison?productName=olive' } },
      { id: 'categories', labelKey: 'nav.categories', path: '/categories', probe: { method: 'GET', path: '/api/categories' } },
      { id: 'products-manage', labelKey: 'dashboard.products', path: '/dashboard/products', probe: { method: 'GET', path: '/api/products/mine' }, features: ['product.manage.own'] },
      { id: 'product-new', labelKey: 'demo.owner.lbl.newProduct', path: '/dashboard/products/new', probe: { method: 'GET', path: '/api/products/mine' }, features: ['product.create'] },
      { id: 'inventory', labelKey: 'dashboard.inventory', path: '/dashboard/inventory', probe: { method: 'GET', path: '/api/inventory' }, features: ['inventory.manage'] },
      { id: 'comparison', labelKey: 'dashboard.priceComparison', path: '/dashboard/comparison', probe: { method: 'GET', path: '/api/price-comparison?productName=olive' }, features: ['product.manage.own'] },
    ],
  },
  {
    id: 'orders',
    labelKey: 'demo.owner.group.orders',
    modules: [
      { id: 'orders', labelKey: 'dashboard.orders', path: '/dashboard/orders', probe: { method: 'GET', path: '/api/orders' }, features: ['order.create', 'order.manage'] },
      { id: 'sales', labelKey: 'dashboard.sales', path: '/dashboard/sales', probe: { method: 'GET', path: '/api/orders' }, features: ['order.manage'] },
      { id: 'finance', labelKey: 'dashboard.finance', path: '/dashboard/finance', probe: { method: 'GET', path: '/api/inventory' }, features: ['billing.payments'] },
      { id: 'reports', labelKey: 'dashboard.reports', path: '/dashboard/reports', probe: { method: 'GET', path: '/api/inventory' }, features: ['billing.payments'] },
      { id: 'admin-orders', labelKey: 'admin.orders', path: '/admin/orders', probe: { method: 'GET', path: '/api/admin/orders' }, roles: ADMIN_ROLES },
      { id: 'admin-transactions', labelKey: 'admin.transactions', path: '/admin/transactions', probe: { method: 'GET', path: '/api/admin/transactions' }, roles: ADMIN_ROLES },
      { id: 'admin-ledger', labelKey: 'admin.ledger', path: '/admin/ledger', probe: { method: 'GET', path: '/api/admin/ledger' }, roles: ADMIN_ROLES },
    ],
  },
  {
    id: 'trade',
    labelKey: 'demo.owner.group.trade',
    modules: [
      { id: 'my-suppliers', labelKey: 'dashboard.suppliers', path: '/dashboard/my-suppliers', probe: { method: 'GET', path: '/api/directory/my/SUPPLIER' }, features: ['order.create', 'order.manage'] },
      { id: 'my-merchants', labelKey: 'dashboard.merchants', path: '/dashboard/my-merchants', probe: { method: 'GET', path: '/api/directory/my/MERCHANT' }, features: ['order.manage'] },
      { id: 'customers', labelKey: 'dashboard.customers', path: '/dashboard/customers', probe: { method: 'GET', path: '/api/directory/my/CUSTOMER' }, features: ['order.manage'] },
      { id: 'buyers', labelKey: 'dashboard.buyers', path: '/dashboard/buyers', probe: { method: 'GET', path: '/api/directory/buyers' }, features: ['order.create', 'order.manage'] },
      { id: 'suppliers-dir', labelKey: 'nav.suppliers', path: '/suppliers', probe: { method: 'GET', path: '/api/suppliers' } },
      { id: 'merchants-dir', labelKey: 'nav.merchants', path: '/merchants', probe: { method: 'GET', path: '/api/merchants' } },
      { id: 'companies-dir', labelKey: 'nav.companies', path: '/companies', probe: { method: 'GET', path: '/api/companies' } },
      { id: 'directory', labelKey: 'demo.owner.lbl.directory', path: '/dashboard/suppliers', probe: { method: 'GET', path: '/api/directory/my-entities' }, features: ['order.create', 'order.manage'] },
    ],
  },
  {
    id: 'engagement',
    labelKey: 'demo.owner.group.engagement',
    modules: [
      { id: 'messages', labelKey: 'dashboard.messages', path: '/dashboard/messages', probe: { method: 'GET', path: '/api/messages' }, features: ['messages'] },
      { id: 'library', labelKey: 'dashboard.favorites', path: '/dashboard/library', probe: { method: 'GET', path: '/api/library/favorites' }, features: ['library'] },
      { id: 'ads', labelKey: 'dashboard.ads', path: '/dashboard/ads', probe: { method: 'GET', path: '/api/ads/campaigns' }, features: ['ads.manage'] },
      { id: 'admin-ads', labelKey: 'admin.ads', path: '/admin/ads', probe: { method: 'GET', path: '/api/admin/ads/summary' }, roles: ADMIN_ROLES },
      { id: 'ai', labelKey: 'dashboard.ai', path: '/dashboard/ai', probe: { method: 'GET', path: '/api/ai/status' }, features: ['ai.use'] },
      { id: 'admin-ai', labelKey: 'admin.aiGovernance', path: '/admin/ai', probe: { method: 'GET', path: '/api/admin/ai/usage' }, roles: ADMIN_ROLES },
      {
        id: 'video-studio',
        labelKey: 'studio.title',
        path: '/dashboard/video-studio',
        probe: { method: 'GET', path: '/api/media/assets?kind=MARKETING_VIDEO' },
        features: ['media.use'],
        flow: true,
      },
      { id: 'analytics', labelKey: 'demo.owner.lbl.myAnalytics', path: '/dashboard/analytics', probe: { method: 'GET', path: '/api/analytics/my-overview' }, features: ['analytics.own'] },
    ],
  },
  {
    id: 'trust',
    labelKey: 'demo.owner.group.trust',
    modules: [
      { id: 'verification', labelKey: 'dashboard.verification', path: '/dashboard/verification', probe: { method: 'GET', path: '/api/verification/me' }, features: ['verification.submit'] },
      { id: 'trust', labelKey: 'dashboard.trust', path: '/dashboard/trust', probe: { method: 'GET', path: '/api/trust/me' }, features: ['verification.submit'] },
      { id: 'disputes', labelKey: 'dashboard.disputes', path: '/dashboard/disputes', probe: { method: 'GET', path: '/api/disputes' }, features: ['order.create', 'order.manage'] },
      { id: 'admin-verification', labelKey: 'admin.verification', path: '/admin/verification', probe: { method: 'GET', path: '/api/admin/verification/requests' }, roles: STAFF_ROLES },
      { id: 'admin-trust', labelKey: 'admin.trust', path: '/admin/trust', probe: { method: 'GET', path: '/api/admin/trust' }, roles: STAFF_ROLES },
      { id: 'admin-risk', labelKey: 'admin.risk', path: '/admin/risk', probe: { method: 'GET', path: '/api/admin/risk/profiles' }, roles: STAFF_ROLES },
      { id: 'admin-disputes', labelKey: 'admin.disputes', path: '/admin/disputes', probe: { method: 'GET', path: '/api/admin/disputes' }, roles: STAFF_ROLES },
    ],
  },
  {
    id: 'platform',
    labelKey: 'demo.owner.group.platform',
    modules: [
      { id: 'subscriptions', labelKey: 'sub.title', path: '/dashboard/subscriptions', probe: { method: 'GET', path: '/api/subscriptions/me' }, features: ['subscription.own'] },
      { id: 'admin-subscriptions', labelKey: 'admin.subscriptions', path: '/admin/subscriptions', probe: { method: 'GET', path: '/api/subscriptions/admin/subscriptions' }, roles: ADMIN_ROLES },
      { id: 'admin-users', labelKey: 'admin.users', path: '/admin/users', probe: { method: 'GET', path: '/api/admin/users' }, roles: ADMIN_ROLES },
      { id: 'admin-products', labelKey: 'admin.products', path: '/admin/products', probe: { method: 'GET', path: '/api/admin/products' }, roles: ADMIN_ROLES },
      { id: 'admin-policies', labelKey: 'admin.policies', path: '/admin/policies', probe: { method: 'GET', path: '/api/admin/policies/dispute' }, roles: ADMIN_ROLES },
      { id: 'admin-privacy', labelKey: 'admin.privacy', path: '/admin/privacy', probe: { method: 'GET', path: '/api/admin/privacy/deletions' }, roles: ADMIN_ROLES },
      { id: 'admin-geo', labelKey: 'demo.owner.lbl.countryGeo', path: '/admin/policies', probe: { method: 'GET', path: '/api/admin/countries' }, roles: ADMIN_ROLES },
      { id: 'admin-audit', labelKey: 'admin.audit', path: '/admin/audit', probe: { method: 'GET', path: '/api/admin/audit-logs' }, roles: ADMIN_ROLES },
      { id: 'admin-observability', labelKey: 'admin.observability', path: '/admin/observability', probe: { method: 'GET', path: '/api/admin/observability/metrics' }, roles: ADMIN_ROLES },
    ],
  },
];

/** Flattened list, for counting. */
export const AUDIT_MODULES: AuditModule[] = AUDIT_MODULE_GROUPS.flatMap((g) => g.modules);

/**
 * Whether the current session may open a module, per the same client-side role
 * rules the app itself uses. The server remains the authority; this only colours
 * the card so the owner knows what to expect before clicking.
 */
export function moduleVisibleFor(
  m: AuditModule,
  roles: UserRole[],
  hasFeature: (f: Feature) => boolean,
): boolean {
  if (m.roles) return m.roles.some((r) => roles.includes(r));
  if (m.features) return m.features.some((f) => hasFeature(f));
  return true;
}

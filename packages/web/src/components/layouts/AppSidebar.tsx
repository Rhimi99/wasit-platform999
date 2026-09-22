import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import type { Feature } from '@/lib/rbac';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { NotificationsBell } from '@/components/layouts/NotificationsBell';

export interface NavItem {
  to: string;
  key: string;
  icon: string;
  feature?: Feature;
}

function baseNav(roleKey: string): NavItem[] {
  const common: NavItem[] = [
    { to: '/dashboard', key: 'dashboard.overview', icon: '📊' },
    { to: '/dashboard/orders', key: 'dashboard.orders', icon: '🧾' },
    { to: '/dashboard/library', key: 'library.favorites', icon: '⭐', feature: 'library' },
    { to: '/dashboard/messages', key: 'dashboard.messages', icon: '💬' },
    { to: '/dashboard/security', key: 'dashboard.security', icon: '🔐' },
    { to: '/dashboard/settings', key: 'dashboard.settings', icon: '⚙️' },
  ];

  switch (roleKey) {
    case 'MERCHANT':
    case 'COMPANY':
      return [
        { to: '/dashboard', key: 'dashboard.overview', icon: '📊' },
        { to: '/dashboard/products', key: 'dashboard.products', icon: '📦' },
        { to: '/dashboard/products/new', key: 'nav.products', icon: '➕' },
        { to: '/dashboard/inventory', key: 'dashboard.inventory', icon: '🗃️' },
        { to: '/dashboard/orders', key: 'dashboard.orders', icon: '🧾' },
        { to: '/dashboard/analytics', key: 'dashboard.analytics', icon: '📈' },
        { to: '/dashboard/ads', key: 'dashboard.ads', icon: '📣', feature: 'ads.manage' },
        { to: '/dashboard/ai', key: 'dashboard.ai', icon: '🤖', feature: 'ai.use' },
        { to: '/dashboard/video-studio', key: 'studio.title', icon: '🎬', feature: 'media.use' },
        { to: '/dashboard/suppliers', key: 'dashboard.suppliers', icon: '🏭' },
        { to: '/dashboard/customers', key: 'dashboard.customers', icon: '👥' },
        { to: '/dashboard/library', key: 'library.favorites', icon: '⭐', feature: 'library' },
        { to: '/dashboard/trust', key: 'dashboard.trust', icon: '🛡️' },
        { to: '/dashboard/verification', key: 'dashboard.verification', icon: '✅' },
        { to: '/dashboard/disputes', key: 'dashboard.disputes', icon: '⚖️' },
        { to: '/dashboard/messages', key: 'dashboard.messages', icon: '💬' },
        { to: '/dashboard/security', key: 'dashboard.security', icon: '🔐' },
        { to: '/dashboard/settings', key: 'dashboard.settings', icon: '⚙️' },
      ];
    case 'SUPPLIER':
      return [
        { to: '/dashboard', key: 'dashboard.overview', icon: '📊' },
        { to: '/dashboard/products', key: 'dashboard.products', icon: '📦' },
        { to: '/dashboard/products/new', key: 'nav.products', icon: '➕' },
        { to: '/dashboard/inventory', key: 'dashboard.inventory', icon: '🗃️' },
        { to: '/dashboard/orders', key: 'dashboard.orders', icon: '🧾' },
        { to: '/dashboard/sales', key: 'dashboard.sales', icon: '💰' },
        { to: '/dashboard/analytics', key: 'dashboard.analytics', icon: '📈' },
        { to: '/dashboard/ads', key: 'dashboard.ads', icon: '📣', feature: 'ads.manage' },
        { to: '/dashboard/ai', key: 'dashboard.ai', icon: '🤖', feature: 'ai.use' },
        { to: '/dashboard/video-studio', key: 'studio.title', icon: '🎬', feature: 'media.use' },
        { to: '/dashboard/buyers', key: 'dashboard.buyers', icon: '🤝' },
        { to: '/dashboard/merchants-list', key: 'dashboard.merchants', icon: '🏪' },
        { to: '/dashboard/library', key: 'library.favorites', icon: '⭐', feature: 'library' },
        { to: '/dashboard/trust', key: 'dashboard.trust', icon: '🛡️' },
        { to: '/dashboard/verification', key: 'dashboard.verification', icon: '✅' },
        { to: '/dashboard/disputes', key: 'dashboard.disputes', icon: '⚖️' },
        { to: '/dashboard/messages', key: 'dashboard.messages', icon: '💬' },
        { to: '/dashboard/security', key: 'dashboard.security', icon: '🔐' },
        { to: '/dashboard/settings', key: 'dashboard.settings', icon: '⚙️' },
      ];
    default:
      return common;
  }
}

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', key: 'admin.title', icon: '🖥️' },
  { to: '/admin/analytics', key: 'admin.analytics', icon: '📊' },
  { to: '/admin/users', key: 'admin.users', icon: '👥' },
  { to: '/admin/products', key: 'admin.products', icon: '📦' },
  { to: '/admin/orders', key: 'admin.orders', icon: '🧾' },
  { to: '/admin/transactions', key: 'admin.transactions', icon: '💳' },
  { to: '/admin/ledger', key: 'admin.ledger', icon: '📒' },
  { to: '/admin/verification', key: 'admin.verification', icon: '✅' },
  { to: '/admin/trust', key: 'admin.trust', icon: '🛡️' },
  { to: '/admin/risk', key: 'admin.risk', icon: '⚠️' },
  { to: '/admin/disputes', key: 'admin.disputes', icon: '⚖️' },
  { to: '/admin/policies', key: 'admin.policies', icon: '📜' },
  { to: '/admin/subscriptions', key: 'admin.subscriptions', icon: '🔁' },
  { to: '/admin/ai', key: 'admin.aiGovernance', icon: '🤖' },
  { to: '/admin/observability', key: 'admin.observability', icon: '📈' },
  { to: '/admin/audit', key: 'admin.audit', icon: '🔎' },
];

export function AppSidebar() {
  const { t } = useI18n();
  const { user, role, can, logout } = useAuth();
  const navigate = useNavigate();

  const items = user?.roles.includes('ADMIN') || user?.roles.includes('SUPER_ADMIN')
    ? [...ADMIN_NAV, ...baseNav(role)]
    : baseNav(role);

  const visible = items.filter((i) => !i.feature || can(i.feature));

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-e border-slate-200 bg-white">
      <div className="px-4 py-4 text-center">
        <p className="text-xs font-medium text-slate-400">{t(`role.${role}`)}</p>
        <p className="truncate text-sm font-semibold text-slate-700">{user?.email}</p>
      </div>
      <nav className="flex-1 space-y-1 px-2">
        {visible.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-wasit-50 hover:text-wasit-700"
          >
            <span className="text-base" aria-hidden>{i.icon}</span>
            {t(i.key)}
          </Link>
        ))}
      </nav>
      <div className="space-y-1 border-t border-slate-100 p-2">
        <Link to="/" className="block rounded-md px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50">
          🏠 {t('nav.home')}
        </Link>
        <button onClick={handleLogout} className="block w-full rounded-md px-3 py-2 text-start text-sm font-medium text-red-600 hover:bg-red-50">
          🚪 {t('nav.logout')}
        </button>
      </div>
    </aside>
  );
}

export function TopHeader() {
  const { user } = useAuth();
  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4">
      <div className="text-sm">
        <span className="font-semibold text-slate-700">{user?.email}</span>
      </div>
      <div className="flex items-center gap-3">
        <NotificationsBell />
        <LanguageSwitcher />
      </div>
    </header>
  );
}
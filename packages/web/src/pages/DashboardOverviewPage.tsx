import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminStats, MyAnalyticsOverview, Order, ProductSummary } from '@/lib/types';

export function DashboardOverviewPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [mine, setMine] = useState<MyAnalyticsOverview | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isAdmin = user?.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r));
    Promise.all([
      apiCall(() => api.listMyOrders()),
      // Sellers see the products they own; buyers see the public catalog.
      isAdmin ? apiCall(() => api.listProducts({ pageSize: '5' })) : apiCall(() => api.listMyProducts({ pageSize: 5 })),
      isAdmin ? apiCall(() => api.adminStats()) : Promise.resolve({ data: null as AdminStats | null, error: null }),
      isAdmin ? Promise.resolve({ data: null as MyAnalyticsOverview | null, error: null }) : apiCall(() => api.myAnalyticsOverview()),
    ]).then(([o, p, s, m]) => {
      if (o.error) setError(o.error);
      setOrders(o.data ?? []);
      const owned = p.data?.items ?? [];
      // A non-seller has no owned products yet; fall back to the public catalog.
      setProducts(owned);
      setStats(s?.data ?? null);
      setMine(m?.data ?? null);
      setLoading(false);
    });
  }, [user]);

  const isAdmin = user?.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r));
  const cards: Array<{ label: string; value: string | number }> = isAdmin
    ? [
        { label: t('home.stats.users'), value: stats?.users ?? '—' },
        { label: t('home.stats.products'), value: stats?.products ?? '—' },
        { label: t('home.stats.orders'), value: stats?.orders ?? '—' },
        { label: t('home.stats.gmv'), value: stats ? formatMoney(stats.gmv) : '—' },
      ]
    : [
        { label: t('home.stats.orders'), value: orders.length },
        { label: t('home.stats.products'), value: mine?.hasBusinessEntity ? mine.products : products.length },
        { label: t('analytics.gmv'), value: mine?.hasBusinessEntity ? formatMoney(mine.gmvAsSeller) : formatMoney(orders.reduce((sum, o) => sum + Number(o.itemsTotal ?? 0), 0)) },
        { label: t('dashboard.pendingOrders'), value: orders.filter((o) => o.status === 'PENDING').length },
      ];

  return (
    <AppLayout>
      <SectionHeader title={`${t('dashboard.welcome')}, ${user?.email ?? ''}`} />
      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {error && <ErrorState message={error} />}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {cards.map((c) => (
              <Card key={c.label}>
                <p className="text-xs text-slate-500">{c.label}</p>
                <p className={`mt-1 text-2xl font-bold ${c.label === t('analytics.gmv') ? 'text-wasit-700' : 'text-slate-900'}`}>{c.value}</p>
              </Card>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <SectionHeader title={t('order.myOrders')} action={<Link to="/dashboard/orders" className="text-sm text-wasit-700 hover:underline">{t('common.viewAll')}</Link>} />
              <table className="table-base">
                <thead><tr><th>#</th><th>{t('common.status')}</th><th>{t('common.date')}</th><th>{t('common.total')}</th></tr></thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr><td colSpan={4} className="text-center text-slate-400">{t('common.noData')}</td></tr>
                  ) : orders.slice(0, 5).map((o) => (
                    <tr key={o.id}>
                      <td><Link to={`/dashboard/orders/${o.id}`} className="text-wasit-700 hover:underline">{o.orderNumber}</Link></td>
                      <td>{o.status}</td>
                      <td>{String(o.createdAt ?? '').slice(0, 10)}</td>
                      <td>{formatMoney(o.itemsTotal, o.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card>
              <SectionHeader title={t('dashboard.products')} action={<Link to="/dashboard/products" className="text-sm text-wasit-700 hover:underline">{t('common.viewAll')}</Link>} />
              <table className="table-base">
                <thead><tr><th>{t('nav.products')}</th><th>{t('common.price')}</th><th>{t('common.status')}</th></tr></thead>
                <tbody>
                  {products.length === 0 ? (
                    <tr><td colSpan={3} className="text-center text-slate-400">{t('common.noData')}</td></tr>
                  ) : products.slice(0, 5).map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{formatMoney(p.basePrice, p.currencyCode)}</td>
                      <td>{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
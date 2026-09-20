import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminStats, Order, ProductSummary } from '@/lib/types';

export function DashboardOverviewPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isAdmin = user?.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r));
    Promise.all([
      apiCall(() => api.listMyOrders()),
      apiCall(() => api.listProducts({ pageSize: '5' })),
      isAdmin ? apiCall(() => api.adminStats()) : Promise.resolve({ data: null as AdminStats | null, error: null }),
    ]).then(([o, p, s]) => {
      if (o.error) setError(o.error);
      setOrders(o.data ?? []);
      setProducts(p.data?.items ?? []);
      setStats(s?.data ?? null);
      setLoading(false);
    });
  }, [user]);

  return (
    <AppLayout>
      <SectionHeader title={`${t('dashboard.welcome')}, ${user?.email ?? ''}`} />
      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {error && <ErrorState message={error} />}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Card><p className="text-xs text-slate-500">{t('home.stats.users')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{stats?.users ?? '—'}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('home.stats.products')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{stats?.products ?? '—'}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('home.stats.orders')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{stats?.orders ?? '—'}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('home.stats.gmv')}</p><p className="mt-1 text-2xl font-bold text-wasit-700">{stats ? formatMoney(stats.gmv) : '—'}</p></Card>
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
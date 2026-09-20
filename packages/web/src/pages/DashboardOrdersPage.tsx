import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { Order } from '@/lib/types';

export function DashboardOrdersPage() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.listMyOrders()).then((res) => {
      setOrders(res.data ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('order.myOrders')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : orders.length === 0 ? (
        <EmptyState title={t('common.noData')} hint={t('order.myOrders')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>#</th><th>{t('common.status')}</th><th>{t('common.date')}</th><th>{t('order.commission')}</th><th>{t('common.total')}</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/dashboard/orders/${o.id}`} className="text-wasit-700 hover:underline">{o.orderNumber}</Link></td>
                  <td>{o.status}</td>
                  <td>{String(o.createdAt ?? '').slice(0, 10)}</td>
                  <td>{formatMoney(o.commission, o.currencyCode)}</td>
                  <td>{formatMoney(o.itemsTotal, o.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function DashboardOrderDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiCall(() => api.getOrder(id)).then((res) => {
      setOrder(res.data);
      setError(res.error);
    });
  }, [id]);

  return (
    <AppLayout>
      <SectionHeader title={`${t('order.myOrders')} #${order?.orderNumber ?? id}`} />
      {error ? <ErrorState message={error} /> : !order ? <Spinner /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionHeader title={t('order.items')} />
            {order.items && order.items.length > 0 ? (
              <table className="table-base">
                <thead><tr><th>{t('nav.products')}</th><th>{t('common.quantity')}</th><th>{t('common.total')}</th></tr></thead>
                <tbody>
                  {order.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.productName ?? it.productId}</td>
                      <td>{it.quantity}</td>
                      <td>{formatMoney(it.lineTotal, order.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-500">{t('common.noData')}</p>
            )}
          </Card>
          <Card>
            <SectionHeader title={t('order.settlement')} />
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>{t('common.total')}</span><span>{formatMoney(order.itemsTotal, order.currencyCode)}</span></div>
              <div className="flex justify-between text-amber-700"><span>{t('order.commission')}</span><span>{formatMoney(order.commission, order.currencyCode)}</span></div>
              {order.buyerCommission ? (
                <div className="flex justify-between text-amber-700"><span>{t('order.buyerCommission')}</span><span>{formatMoney(order.buyerCommission, order.currencyCode)}</span></div>
              ) : null}
              <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold"><span>{t('order.grandTotal')}</span><span>{formatMoney(order.grandTotal, order.currencyCode)}</span></div>
              <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold"><span>{t('common.status')}</span><span>{order.status}</span></div>
            </div>
          </Card>
        </div>
      )}
    </AppLayout>
  );
}
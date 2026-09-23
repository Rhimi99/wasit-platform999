import { useEffect, useState } from 'react';
import { api, apiCall, apiErrorMessage, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminStats, CohortRow, ConversionSnapshot, DailyKpiRow, LedgerEntry, Order, PlatformOverview, RetentionSnapshot, RevenueBreakdown, Transaction, UnitEconomics } from '@/lib/types';

const LEDGER_ENTRY_KEYS: Record<string, string> = {
  TRANSACTION_VALUE: 'ledger.entry.transactionValue',
  COMMISSION: 'ledger.entry.commission',
  PAYMENT_FEE: 'ledger.entry.paymentFee',
  REFUND: 'ledger.entry.refund',
  SETTLEMENT: 'ledger.entry.settlement',
};

function ledgerEntryTypeKey(entryType: string): string {
  return LEDGER_ENTRY_KEYS[entryType] ?? entryType;
}

// Wrapper renders children only for admins (server also enforces /api/admin via requireRole).
export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isAdmin = user?.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r));
  if (user && !isAdmin) {
    return (
      <AppLayout>
        <ErrorState message="Forbidden: Admin area" />
      </AppLayout>
    );
  }
  return <>{children}</>;
}

// Wrapper for staff engine pages (verification/trust/risk/disputes).
// The server enforces granular permissions per endpoint (requirePermission).
export function StaffOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const allowed = user?.roles.some((r) => ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'RISK', 'DISPUTE'].includes(r));
  if (user && !allowed) {
    return (
      <AppLayout>
        <ErrorState message="Forbidden: Staff area" />
      </AppLayout>
    );
  }
  return <>{children}</>;
}

export function AdminDashboardPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.adminStats()).then((res) => {
      setStats(res.data);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('admin.kpis')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card><p className="text-xs text-slate-500">{t('admin.users')}</p><p className="mt-1 text-3xl font-bold text-slate-900">{stats?.users ?? '—'}</p></Card>
          <Card><p className="text-xs text-slate-500">{t('admin.products')}</p><p className="mt-1 text-3xl font-bold text-slate-900">{stats?.products ?? '—'}</p></Card>
          <Card><p className="text-xs text-slate-500">{t('admin.orders')}</p><p className="mt-1 text-3xl font-bold text-slate-900">{stats?.orders ?? '—'}</p></Card>
          <Card><p className="text-xs text-slate-500">{t('analytics.gmv')}</p><p className="mt-1 text-3xl font-bold text-wasit-700">{stats ? formatMoney(stats.gmv) : '—'}</p></Card>
        </div>
      )}
    </AppLayout>
  );
}

export function AdminAnalyticsPage() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [retention, setRetention] = useState<RetentionSnapshot | null>(null);
  const [conversion, setConversion] = useState<ConversionSnapshot | null>(null);
  const [revenue, setRevenue] = useState<RevenueBreakdown | null>(null);
  const [kpis, setKpis] = useState<DailyKpiRow[]>([]);
  const [unitEconomics, setUnitEconomics] = useState<UnitEconomics | null>(null);
  const [cohorts, setCohorts] = useState<CohortRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollupMsg, setRollupMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiCall(() => api.adminAnalyticsOverview()),
      apiCall(() => api.adminAnalyticsRetention()),
      apiCall(() => api.adminAnalyticsConversion()),
      apiCall(() => api.adminAnalyticsRevenue()),
      apiCall(() => api.adminAnalyticsDailyKpis(14)),
      apiCall(() => api.adminAnalyticsUnitEconomics({ windowDays: 30 })),
      apiCall(() => api.adminAnalyticsCohorts({ months: 6 })),
    ]).then(([ov, rt, cv, rv, kp, ue, co]) => {
      setOverview(ov.data);
      setRetention(rt.data);
      setConversion(cv.data);
      setRevenue(rv.data);
      setKpis(kp.data?.items ?? []);
      setUnitEconomics(ue.data);
      setCohorts(co.data?.items ?? []);
      setError(ov.error ?? rt.error ?? cv.error ?? rv.error ?? kp.error ?? ue.error ?? co.error);
      setLoading(false);
    });
  }, [reloadKey]);

  const handleRollup = async () => {
    setRolling(true);
    const res = await apiCall(() => api.adminAnalyticsRollup());
    if (res.data) {
      setKpis(res.data.items);
      setRollupMsg(`${t('analytics.rollupInserted')}: ${res.data.inserted}`);
    } else {
      setRollupMsg(res.error);
    }
    setRolling(false);
    setReloadKey((k) => k + 1);
  };

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  return (
    <AppLayout>
      <SectionHeader title={t('admin.analytics')} subtitle={t('analytics.adminSubtitle')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card><p className="text-xs text-slate-500">{t('analytics.gmv')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(overview?.gmv)}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.users')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{overview?.users ?? 0}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.orders')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{overview?.orders ?? 0}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.commission')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(overview?.commission)}</p></Card>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card><p className="text-xs text-slate-500">{t('analytics.activeUsers30d')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{overview?.activeUsers30d ?? 0}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.retentionRate30d')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{pct(retention?.retentionRate30d ?? 0)}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.conversionRate')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{pct(conversion?.conversionRate ?? 0)}</p></Card>
            <Card><p className="text-xs text-slate-500">{t('analytics.avgOrderValue')}</p><p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(overview?.avgOrderValue)}</p></Card>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">{t('analytics.revenueBreakdown')}</h3>
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.transactionValue')}</dt><dd className="font-semibold text-slate-800">{formatMoney(revenue?.transactionValue)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.commission')}</dt><dd className="font-semibold text-slate-800">{formatMoney(revenue?.commission)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.paymentFees')}</dt><dd className="font-semibold text-slate-800">{formatMoney(revenue?.paymentFees)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.refunds')}</dt><dd className="font-semibold text-slate-800">{formatMoney(revenue?.refunds)}</dd></div>
                <div className="flex justify-between border-t border-slate-100 pt-2"><dt className="font-medium text-slate-700">{t('analytics.netRevenue')}</dt><dd className="font-bold text-slate-900">{formatMoney(revenue?.netRevenue)}</dd></div>
              </dl>
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">{t('analytics.dailyKpis')}</h3>
                <button type="button" onClick={handleRollup} disabled={rolling} className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
                  {rolling ? '…' : t('analytics.rollup')}
                </button>
              </div>
              {rollupMsg && <p className="mt-2 text-xs text-slate-500">{rollupMsg}</p>}
              {kpis.length === 0 ? <p className="mt-3 text-sm text-slate-400">{t('common.noData')}</p> : (
                <div className="mt-3 max-h-64 overflow-y-auto">
                  {kpis.map((k) => (
                    <div key={k.id} className="flex justify-between border-b border-slate-50 py-1 text-sm">
                      <span className="text-slate-500" dir="ltr">{k.date.slice(0, 10)} · {k.metricName}</span>
                      <span className="font-semibold text-slate-800">{k.metricName === 'gmv' || k.metricName === 'commission' ? formatMoney(k.metricValue) : k.metricValue}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {unitEconomics && (
            <Card className="mt-6" testId="admin-unit-economics">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">{t('analytics.unitEconomics')}</h3>
                  <p className="mt-0.5 text-xs text-slate-500">{t('analytics.unitEconomicsSubtitle')}</p>
                </div>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600" dir="ltr">
                  {unitEconomics.currencyCode} · {t('analytics.windowDays')}: {unitEconomics.windowDays}
                </span>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded border border-slate-100 p-3">
                  <p className="text-xs text-slate-500">{t('analytics.cac')}</p>
                  <p className="mt-1 text-xl font-bold text-slate-900" data-testid="ue-cac">{formatMoney(unitEconomics.cac)}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{t('analytics.newCustomers')}: {unitEconomics.newCustomers}</p>
                </div>
                <div className="rounded border border-slate-100 p-3">
                  <p className="text-xs text-slate-500">{t('analytics.ltvRealized')}</p>
                  <p className="mt-1 text-xl font-bold text-slate-900" data-testid="ue-ltv-realized">{formatMoney(unitEconomics.ltvRealized)}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{t('analytics.customersWithOrders')}: {unitEconomics.customersWithOrders}</p>
                </div>
                <div className="rounded border border-slate-100 p-3">
                  <p className="text-xs text-slate-500">{t('analytics.ltvProjected')}</p>
                  <p className="mt-1 text-xl font-bold text-slate-900" data-testid="ue-ltv-projected">{formatMoney(unitEconomics.ltvProjected)}</p>
                  <p className="mt-0.5 text-xs text-amber-600">{t('analytics.projectedNotFact')}</p>
                </div>
                <div className="rounded border border-slate-100 p-3">
                  <p className="text-xs text-slate-500">{t('analytics.ltvCacRatio')}</p>
                  <p className="mt-1 text-xl font-bold text-slate-900" data-testid="ue-ltv-cac-ratio">{unitEconomics.ltvCacRatio ?? '—'}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{t('analytics.contributionMargin')}: {Number(unitEconomics.contributionMarginPct).toFixed(2)}%</p>
                </div>
              </div>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.grossMarginTotal')}</dt><dd className="font-semibold text-slate-800">{formatMoney(unitEconomics.grossMarginTotal)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.grossMarginPerOrder')}</dt><dd className="font-semibold text-slate-800">{formatMoney(unitEconomics.grossMarginPerOrder)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.marketingSpend')}</dt><dd className="font-semibold text-slate-800">{formatMoney(unitEconomics.marketingSpend)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">{t('analytics.paidOrders')}</dt><dd className="font-semibold text-slate-800">{unitEconomics.paidOrders}</dd></div>
              </dl>
              <div className="mt-4 rounded bg-amber-50 p-3" data-testid="ue-assumptions">
                <p className="text-xs font-medium text-amber-800">{t('analytics.assumptions')} — {t('analytics.assumptionsHint')}</p>
                <p className="mt-1 text-xs text-amber-700" dir="ltr">
                  {t('analytics.retentionMonths')}: {unitEconomics.assumptions.assumedRetentionMonths} · {t('analytics.ordersPerMonth')}: {unitEconomics.assumptions.assumedOrdersPerMonth}
                </p>
              </div>
              {unitEconomics.basedOn.length > 0 && (
                <details className="mt-3 text-xs text-slate-500">
                  <summary className="cursor-pointer">{t('analytics.basedOn')}</summary>
                  <ul className="mt-1 space-y-0.5">
                    {unitEconomics.basedOn.map((b) => <li key={b} dir="ltr">{b}</li>)}
                  </ul>
                </details>
              )}
            </Card>
          )}

          <Card className="mt-6" testId="admin-cohorts">
            <h3 className="text-sm font-semibold text-slate-700">{t('analytics.cohorts')}</h3>
            <p className="mt-0.5 text-xs text-slate-500">{t('analytics.cohortsSubtitle')}</p>
            {cohorts.length === 0 ? <p className="mt-3 text-sm text-slate-400">{t('analytics.noCohorts')}</p> : (
              <table className="table-base mt-3">
                <thead>
                  <tr>
                    <th>{t('analytics.cohortMonth')}</th>
                    <th>{t('analytics.cohortCustomers')}</th>
                    <th>{t('analytics.cohortGmv')}</th>
                    <th>{t('analytics.cohortMargin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cohorts.map((c) => (
                    <tr key={c.month}>
                      <td dir="ltr">{c.month}</td>
                      <td>{c.customers}</td>
                      <td>{formatMoney(c.gmv)}</td>
                      <td>{formatMoney(c.grossMargin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </AppLayout>
  );
}

export function AdminUsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState<Array<{ id: string; email: string; isActive: boolean; emailVerified: boolean; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    apiCall(() => api.adminUsers()).then((res) => {
      setUsers(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, [reloadKey]);

  const setStatus = async (id: string, isActive: boolean) => {
    setBusyId(id);
    setNotice(null);
    const res = await apiCall(() => api.adminSetUserStatus(id, isActive));
    if (res.error) {
      setError(res.error);
    } else {
      setUsers((rows) => rows.map((u) => (u.id === id ? { ...u, isActive } : u)));
      setNotice(isActive ? t('admin.users.activated') : t('admin.users.suspended'));
      setReloadKey((k) => k + 1);
    }
    setBusyId(null);
  };

  return (
    <AppLayout>
      <SectionHeader title={t('admin.users')} />
      {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-users-notice">{notice}</p>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : users.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('field.email')}</th><th>{t('field.verified')}</th><th>{t('field.active')}</th><th>{t('common.date')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td dir="ltr">{u.email}</td>
                  <td>{u.emailVerified ? <Badge color="green">✓</Badge> : <Badge>—</Badge>}</td>
                  <td data-testid={`admin-user-status-${u.id}`}>{u.isActive ? <Badge color="green">{t('field.on')}</Badge> : <Badge color="red">{t('field.off')}</Badge>}</td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      data-testid={`admin-user-toggle-${u.id}`}
                      disabled={busyId === u.id}
                      onClick={() => setStatus(u.id, !u.isActive)}
                      className={u.isActive ? 'text-xs font-medium text-red-600 hover:underline disabled:opacity-50' : 'text-xs font-medium text-green-700 hover:underline disabled:opacity-50'}
                    >
                      {busyId === u.id ? '…' : u.isActive ? t('admin.users.suspend') : t('admin.users.activate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function AdminOrdersPage() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refunds, setRefunds] = useState<Array<{ id: string; amount: string; currencyCode: string; status: string; reason: string | null; createdAt: string }>>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  useEffect(() => {
    apiCall(() => api.adminOrders()).then((res) => {
      setOrders(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, [reloadKey]);

  const refundable = (o: Order) => o.paymentStatus === 'PAID' || o.paymentStatus === 'PARTIALLY_REFUNDED';

  async function openRefund(order: Order) {
    setOpenId(order.id);
    setAmount('');
    setReason('');
    setNotice(null);
    setRefundError(null);
    const res = await apiCall(() => api.orderRefunds(order.id));
    setRefunds(res.data ?? []);
  }

  async function submitRefund(order: Order) {
    setBusy(true);
    setRefundError(null);
    // A fresh key per open form makes a double-click idempotent server-side
    // rather than issuing two refunds.
    try {
      const res = await api.createRefund(order.id, {
        amount: amount.trim() || undefined,
        reason: reason.trim() || undefined,
        idempotencyKey: `admin-ui-${order.id}-${Date.now()}`,
      });
      setNotice(`${t('admin.refund.done')}: ${formatMoney(res.refund.amount, res.refund.currencyCode)}`);
      setOpenId(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      // The service explains *why* (e.g. "Refund exceeds remaining refundable
      // amount …") in fieldErrors; showing only "Validation failed" would hide
      // the actionable reason from the operator.
      setRefundError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const active = orders.find((o) => o.id === openId) ?? null;

  return (
    <AppLayout>
      <SectionHeader title={t('admin.orders')} />
      {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-refund-notice">{notice}</p>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : orders.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>#</th><th>{t('common.status')}</th><th>{t('order.payment')}</th><th>{t('order.sellerCommission')}</th><th>{t('order.buyerCommission')}</th><th>{t('common.total')}</th><th>{t('common.date')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} data-testid={`admin-order-${o.id}`}>
                  <td>{o.orderNumber}</td>
                  <td>{o.status}</td>
                  <td>{o.refundStatus && o.refundStatus !== 'NONE' ? `${o.paymentStatus} · ${o.refundStatus}` : (o.paymentStatus ?? '—')}</td>
                  <td>{formatMoney(o.commission, o.currencyCode)}</td>
                  <td>{formatMoney(o.buyerCommission ?? '0', o.currencyCode)}</td>
                  <td>{formatMoney(o.grandTotal, o.currencyCode)}</td>
                  <td>{formatDate(o.createdAt)}</td>
                  <td>
                    {refundable(o) && (
                      <button
                        type="button"
                        data-testid={`admin-order-refund-${o.id}`}
                        onClick={() => openRefund(o)}
                        className="text-xs font-medium text-red-600 hover:underline"
                      >
                        {t('admin.refund.action')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {active && (
        <Card className="mt-4" testId="admin-refund-panel">
          <h3 className="text-sm font-bold text-slate-900">{t('admin.refund.title')} — {active.orderNumber}</h3>
          <p className="mt-1 text-xs text-slate-500">{t('admin.refund.hint')}</p>
          {refunds.length > 0 && (
            <ul className="mt-2 space-y-1" data-testid="admin-refund-history">
              {refunds.map((r) => (
                <li key={r.id} className="text-xs text-slate-600">
                  {formatMoney(r.amount, r.currencyCode)} · {r.status}{r.reason ? ` — ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-600">
              {t('admin.refund.amount')}
              <input
                type="text"
                data-testid="admin-refund-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t('admin.refund.amountPlaceholder')}
                className="ms-2 rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              {t('admin.refund.reason')}
              <input
                type="text"
                data-testid="admin-refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="ms-2 rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              data-testid="admin-refund-submit"
              disabled={busy}
              onClick={() => submitRefund(active)}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? '…' : t('admin.refund.submit')}
            </button>
            <button type="button" onClick={() => setOpenId(null)} className="text-xs text-slate-500 hover:underline">
              {t('common.cancel')}
            </button>
          </div>
          {refundError && <p className="mt-2 text-sm text-red-600" role="alert">{refundError}</p>}
        </Card>
      )}
    </AppLayout>
  );
}

export function AdminTransactionsPage() {
  const { t } = useI18n();
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.adminTransactions()).then((res) => {
      setTxs(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('admin.transactions')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : txs.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>#</th><th>{t('common.total')}</th><th>{t('order.sellerCommission')}</th><th>{t('order.buyerCommission')}</th><th>{t('field.fee')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>
              {txs.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.transactionNumber}</td>
                  <td>{formatMoney(tx.totalValue)}</td>
                  <td>{formatMoney(tx.commission)}</td>
                  <td>{formatMoney(tx.buyerCommission ?? '0')}</td>
                  <td>{formatMoney(tx.paymentFee)}</td>
                  <td>{tx.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function AdminLedgerPage() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.adminLedger()).then((res) => {
      setEntries(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('admin.ledger')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : entries.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('common.date')}</th><th>{t('field.type')}</th><th>{t('field.direction')}</th><th>{t('field.amount')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} data-testid={`admin-ledger-${e.entryType}-${e.direction}`}>
                  <td>{formatDate(e.createdAt)}</td>
                  <td>{t(ledgerEntryTypeKey(e.entryType))}</td>
                  <td>{e.direction === 'CREDIT' ? <Badge color="green">{t('ledger.credit')}</Badge> : <Badge color="red">{t('ledger.debit')}</Badge>}</td>
                  <td>{formatMoney(e.amount, e.currencyCode)}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function AdminProductsPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<Array<{ id: string; name: string; sku: string; status: string; sellerId: string; basePrice: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const res = await apiCall(() => api.adminProducts());
    setProducts(res.data?.items ?? []);
    setError(res.error);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  async function setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    setBusyId(id);
    const res = status === 'SUSPENDED'
      ? await apiCall(() => api.adminSuspendProduct(id))
      : await apiCall(() => api.adminSetProductStatus(id, 'ACTIVE'));
    if (res.error) setError(res.error);
    setBusyId(null);
    await load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('admin.products')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : products.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('nav.products')}</th><th>SKU</th><th>{t('field.seller')}</th><th>{t('common.price')}</th><th>{t('common.status')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} data-testid={`admin-product-${p.id}`}>
                  <td>{p.name}</td>
                  <td className="text-xs">{p.sku}</td>
                  <td className="text-xs" dir="ltr">{p.sellerId}</td>
                  <td>{formatMoney(p.basePrice)}</td>
                  <td><Badge color={p.status === 'ACTIVE' ? 'green' : p.status === 'SUSPENDED' ? 'red' : 'slate'}>{p.status}</Badge></td>
                  <td>
                    {p.status === 'SUSPENDED' ? (
                      <button
                        type="button"
                        data-testid={`admin-product-reactivate-${p.id}`}
                        disabled={busyId === p.id}
                        onClick={() => void setStatus(p.id, 'ACTIVE')}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-green-700 hover:border-green-400 disabled:opacity-50"
                      >
                        {t('admin.users.activate')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`admin-product-suspend-${p.id}`}
                        disabled={busyId === p.id}
                        onClick={() => void setStatus(p.id, 'SUSPENDED')}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                      >
                        {t('admin.suspend')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}

export function AdminAuditPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.adminAuditLogs()).then((res) => {
      setRows(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('admin.audit')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} /> : rows.length === 0 ? <EmptyState title={t('common.noData')} /> : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead><tr><th>{t('common.date')}</th><th>{t('field.actor')}</th><th>{t('field.action')}</th><th>{t('field.entity')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id ?? '')}>
                  <td>{String(r.createdAt ?? '').slice(0, 10)}</td>
                  <td className="text-xs" dir="ltr">{String(r.actorId ?? '')}</td>
                  <td>{String(r.action ?? '')}</td>
                  <td>{String(r.entityType ?? '')}:{String(r.entityId ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppLayout>
  );
}
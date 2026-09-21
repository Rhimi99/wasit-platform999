import { useEffect, useState } from 'react';
import { api, apiCall, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminSubscription, AdminSubscriptionInvoice, SubscriptionInvoice, SubscriptionPlan } from '@/lib/types';

type Tab = 'subscriptions' | 'plans' | 'invoices' | 'dunning';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate'> = {
  ACTIVE: 'green',
  TRIAL: 'teal',
  PAST_DUE: 'amber',
  CANCELLED: 'red',
  EXPIRED: 'red',
  PENDING: 'amber',
  PAID: 'green',
  FAILED: 'red',
};

function statusColor(s: string): 'green' | 'amber' | 'red' | 'teal' | 'slate' {
  return STATUS_COLOR[s] ?? 'slate';
}

function userLabel(row: { userName?: string | null; userEmail?: string | null; userId?: string | null }): string {
  return row.userEmail ?? row.userName ?? row.userId ?? '—';
}

export function AdminSubscriptionsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('subscriptions');
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([]);
  const [invoices, setInvoices] = useState<AdminSubscriptionInvoice[]>([]);
  const [pending, setPending] = useState<SubscriptionInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const [plansRes, subsRes, invRes, pendingRes] = await Promise.all([
      apiCall(() => api.adminSubscriptionPlans()),
      apiCall(() => api.adminSubscriptions()),
      apiCall(() => api.adminSubscriptionInvoices()),
      apiCall(() => api.adminPendingSubscriptionInvoices()),
    ]);
    setPlans(plansRes.data?.items ?? []);
    setSubscriptions(subsRes.data?.items ?? []);
    setInvoices(invRes.data?.items ?? []);
    setPending(pendingRes.data?.items ?? []);
    setError(plansRes.error ?? subsRes.error ?? invRes.error ?? pendingRes.error);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  async function run(key: string, fn: () => Promise<unknown>, noticeKey: string) {
    setBusy(key);
    setNotice(null);
    const res = await apiCall(() => fn());
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    setNotice(t(noticeKey));
    await load();
  }

  const togglePlan = (plan: SubscriptionPlan) =>
    run(`plan:${plan.id}`, () => api.adminSetPlanActive(plan.id, !plan.isActive), 'adminSub.planToggled');

  const collect = (invoice: SubscriptionInvoice | AdminSubscriptionInvoice) =>
    run(`collect:${invoice.id}`, () => api.adminCollectSubscriptionInvoice(invoice.id), 'adminSub.collected');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'subscriptions', label: t('adminSub.tab.subscriptions') },
    { id: 'plans', label: t('adminSub.tab.plans') },
    { id: 'invoices', label: t('adminSub.tab.invoices') },
    { id: 'dunning', label: t('adminSub.tab.dunning') },
  ];

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminSub.title')}
        subtitle={t('adminSub.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-sub-refresh"
            disabled={busy !== null}
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {t('common.refresh')}
          </button>
        )}
      />

      <div className="mb-4 flex flex-wrap gap-1 rounded-md border border-slate-200 p-0.5" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            data-testid={`admin-sub-tab-${x.id}`}
            onClick={() => setTab(x.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${tab === x.id ? 'bg-wasit-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {notice && <div role="status" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          {tab === 'subscriptions' && (
            subscriptions.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminSub.tab.subscriptions')} /> : (
              <Card className="overflow-x-auto" testId="admin-sub-list">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('adminSub.user')}</th>
                      <th>{t('adminSub.plan')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('adminSub.startsAt')}</th>
                      <th>{t('adminSub.endsAt')}</th>
                      <th>{t('adminSub.autoRenew')}</th>
                      <th>{t('adminSub.billingCycle')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.map((s) => (
                      <tr key={s.id} data-testid={`admin-sub-${s.id}`}>
                        <td className="text-xs" dir="ltr">{userLabel(s)}</td>
                        <td>
                          <span className="font-medium text-slate-700">{s.planName}</span>
                          <span className="ms-1 text-xs text-slate-400">{s.planCode}</span>
                        </td>
                        <td><Badge color={statusColor(s.status)}>{s.status}</Badge></td>
                        <td className="text-xs">{formatDate(s.startsAt)}</td>
                        <td className="text-xs">{formatDate(s.endsAt)}</td>
                        <td className="text-xs">{t(s.autoRenew ? 'adminSub.renew.on' : 'adminSub.renew.off')}</td>
                        <td className="text-xs">{t(s.billingCycle === 'YEARLY' ? 'sub.billing.yearly' : 'sub.billing.monthly')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'plans' && (
            plans.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminSub.tab.plans')} /> : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {plans.map((p) => (
                  <Card key={p.id} className="flex flex-col" testId={`admin-sub-plan-${p.code}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-800">{p.name}</h3>
                        <p className="text-xs text-slate-400">{p.code} · {t(`sub.target.${p.planTarget}`)}</p>
                      </div>
                      <Badge color={p.isActive ? 'green' : 'slate'}>{p.isActive ? t('common.active') : t('common.inactive')}</Badge>
                    </div>
                    <div className="mt-3 space-y-1 text-sm text-slate-700">
                      <p>
                        {formatMoney(p.priceMonthly, p.currencyCode)}
                        <span className="ms-1 text-xs text-slate-400">{t('sub.perMonth')}</span>
                      </p>
                      <p>
                        {formatMoney(p.priceYearly, p.currencyCode)}
                        <span className="ms-1 text-xs text-slate-400">{t('sub.perYear')}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid={`admin-sub-plan-toggle-${p.code}`}
                      disabled={busy !== null}
                      onClick={() => void togglePlan(p)}
                      className={`mt-3 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${p.isActive ? 'bg-red-600 hover:bg-red-700' : 'bg-wasit-600 hover:bg-wasit-700'}`}
                    >
                      {busy === `plan:${p.id}`
                        ? t('common.processing')
                        : p.isActive ? t('adminSub.deactivate') : t('adminSub.activate')}
                    </button>
                  </Card>
                ))}
              </div>
            )
          )}

          {tab === 'invoices' && (
            invoices.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminSub.tab.invoices')} /> : (
              <Card className="overflow-x-auto" testId="admin-sub-invoices">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('sub.invoices.number')}</th>
                      <th>{t('adminSub.user')}</th>
                      <th>{t('sub.invoices.amount')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('sub.invoices.dueAt')}</th>
                      <th>{t('sub.invoices.paidAt')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.id} data-testid={`admin-sub-invoice-${inv.id}`}>
                        <td className="text-xs" dir="ltr">{inv.invoiceNumber}</td>
                        <td className="text-xs" dir="ltr">{userLabel(inv)}</td>
                        <td>{formatMoney(inv.amount, inv.currencyCode)}</td>
                        <td><Badge color={statusColor(inv.status)}>{inv.status}</Badge></td>
                        <td className="text-xs">{formatDate(inv.dueAt)}</td>
                        <td className="text-xs">{formatDate(inv.paidAt)}</td>
                        <td>
                          {inv.status === 'PENDING' && (
                            <button
                              type="button"
                              data-testid={`admin-sub-collect-${inv.id}`}
                              disabled={busy !== null}
                              onClick={() => void collect(inv)}
                              className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                            >
                              {busy === `collect:${inv.id}` ? t('common.processing') : t('adminSub.collect')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'dunning' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="admin-sub-rollover"
                  disabled={busy !== null}
                  onClick={() => void run('rollover', () => api.adminRunSubscriptionRollover(), 'adminSub.rolloverDone')}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {busy === 'rollover' ? t('common.processing') : t('adminSub.runRollover')}
                </button>
                <button
                  type="button"
                  data-testid="admin-sub-expire"
                  disabled={busy !== null}
                  onClick={() => void run('expire', () => api.adminExpireLapsedSubscriptions(), 'adminSub.expireDone')}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {busy === 'expire' ? t('common.processing') : t('adminSub.runExpire')}
                </button>
              </div>
              {pending.length === 0 ? <EmptyState title={t('adminSub.noPending')} hint={t('adminSub.tab.dunning')} /> : (
                <Card className="overflow-x-auto" testId="admin-sub-pending">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('sub.invoices.number')}</th>
                        <th>{t('sub.invoices.amount')}</th>
                        <th>{t('sub.invoices.dueAt')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.map((inv) => (
                        <tr key={inv.id} data-testid={`admin-sub-pending-${inv.id}`}>
                          <td className="text-xs" dir="ltr">{inv.invoiceNumber}</td>
                          <td>{formatMoney(inv.amount, inv.currencyCode)}</td>
                          <td className="text-xs">{formatDate(inv.dueAt)}</td>
                          <td>
                            <button
                              type="button"
                              data-testid={`admin-sub-pending-collect-${inv.id}`}
                              disabled={busy !== null}
                              onClick={() => void collect(inv)}
                              className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                            >
                              {busy === `collect:${inv.id}` ? t('common.processing') : t('adminSub.collect')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </AppLayout>
  );
}

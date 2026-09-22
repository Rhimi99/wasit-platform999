import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminAdSummary, AdminCampaignRow } from '@/lib/types';

/** Next legal transitions per the server campaign state machine. */
const TRANSITIONS: Record<string, Array<'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'>> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'slate' | 'red' | 'teal'> = {
  ACTIVE: 'green',
  PAUSED: 'amber',
  DRAFT: 'slate',
  COMPLETED: 'teal',
  CANCELLED: 'red',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function AdminAdsPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<AdminAdSummary | null>(null);
  const [campaigns, setCampaigns] = useState<AdminCampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [sumRes, campRes] = await Promise.all([
      apiCall(() => api.adminAdsSummary()),
      apiCall(() => api.adminAdsCampaigns()),
    ]);
    setSummary(sumRes.data ?? null);
    setCampaigns(campRes.data?.items ?? []);
    setError(sumRes.error ?? campRes.error);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const moderate = async (row: AdminCampaignRow, status: string, labelKey: string) => {
    setBusyId(row.id);
    setNotice(null);
    const res = await apiCall(() => api.updateCampaign(row.id, { status }));
    setBusyId(null);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t(labelKey)} · ${row.title}`);
    await load();
  };

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminAds.title')}
        subtitle={t('adminAds.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-ads-refresh"
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('common.refresh')}
          </button>
        )}
      />

      {notice && <div role="status" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card testId="admin-ads-kpi-campaigns">
              <p className="text-xs text-slate-500">{t('adminAds.kpi.campaigns')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{summary?.campaigns ?? 0}</p>
            </Card>
            <Card testId="admin-ads-kpi-active">
              <p className="text-xs text-slate-500">{t('adminAds.kpi.active')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{summary?.activeCampaigns ?? 0}</p>
            </Card>
            <Card testId="admin-ads-kpi-spend">
              <p className="text-xs text-slate-500">{t('adminAds.kpi.spent')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(summary?.totalSpent ?? '0')}</p>
              <p className="text-[10px] text-slate-400">{t('adminAds.kpi.budget')}: {formatMoney(summary?.totalBudget ?? '0')}</p>
            </Card>
            <Card testId="admin-ads-kpi-ctr">
              <p className="text-xs text-slate-500">{t('adminAds.kpi.ctr')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{summary ? pct(summary.ctr) : '—'}</p>
              <p className="text-[10px] text-slate-400">
                {t('adminAds.kpi.impressions')}: {summary?.impressions ?? 0} · {t('adminAds.kpi.clicks')}: {summary?.clicks ?? 0} · {t('adminAds.kpi.conversions')}: {summary?.conversions ?? 0}
              </p>
            </Card>
          </div>

          {campaigns.length === 0 ? (
            <EmptyState title={t('adminAds.empty')} />
          ) : (
            <Card className="overflow-x-auto" testId="admin-ads-table">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('adminAds.col.campaign')}</th>
                    <th>{t('adminAds.col.advertiser')}</th>
                    <th>{t('adminAds.col.objective')}</th>
                    <th>{t('adminAds.col.budget')}</th>
                    <th>{t('adminAds.col.spent')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const transitions = TRANSITIONS[c.status] ?? [];
                    return (
                      <tr key={c.id} data-testid={`admin-ads-campaign-${c.id}`}>
                        <td>
                          <p className="font-medium text-slate-800">{c.title}</p>
                          <p className="text-[10px] text-slate-400">{formatDate(c.createdAt)}</p>
                        </td>
                        <td className="text-xs">
                          <p className="text-slate-700">{c.advertiserName ?? '—'}</p>
                          <p className="text-slate-400" dir="ltr">{c.advertiserType} · {c.ownerEmail ?? '—'}</p>
                        </td>
                        <td className="text-xs" dir="ltr">{c.objective}</td>
                        <td className="text-xs">{formatMoney(c.budget, c.currencyCode)}</td>
                        <td className="text-xs">{formatMoney(c.spent, c.currencyCode)}</td>
                        <td><Badge color={STATUS_COLOR[c.status] ?? 'slate'}>{c.status}</Badge></td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {transitions.length === 0 && <span className="text-xs text-slate-400">—</span>}
                            {transitions.map((status) => (
                              <button
                                key={status}
                                type="button"
                                data-testid={`admin-ads-${status.toLowerCase()}-${c.id}`}
                                disabled={busyId === c.id}
                                onClick={() => void moderate(c, status, `adminAds.done.${status.toLowerCase()}`)}
                                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700 disabled:opacity-50"
                              >
                                {t(`adminAds.action.${status.toLowerCase()}`)}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </AppLayout>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminTradeRow, TradeKind } from '@/lib/types';

const KINDS: TradeKind[] = ['suppliers', 'merchants', 'companies'];

const KIND_LABEL_KEY: Record<TradeKind, string> = {
  suppliers: 'admin.trade.suppliers',
  merchants: 'admin.trade.merchants',
  companies: 'admin.trade.companies',
};

const KIND_EMPTY_HINT_KEY: Record<TradeKind, string> = {
  suppliers: 'admin.trade.empty.suppliers',
  merchants: 'admin.trade.empty.merchants',
  companies: 'admin.trade.empty.companies',
};

/**
 * Admin trade desk — vetting of seller entities.
 *
 * The `verified` badge shown in the public directory and the `isActive` flag
 * that governs whether an entity is listed at all had no admin control until
 * this desk; both are now set here through `PATCH /api/admin/trade/:kind/:id`
 * (audited server-side). The role gate and the per-kind permission are enforced
 * by the server — this page only reflects them.
 */
export function AdminTradePage() {
  const { t } = useI18n();
  const [kind, setKind] = useState<TradeKind>('suppliers');
  const [rows, setRows] = useState<AdminTradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (k: TradeKind) => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.adminTradeList(k, { pageSize: 100 }));
    setRows(res.data?.items ?? []);
    setError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => { void load(kind); }, [kind, load]);

  const update = async (row: AdminTradeRow, patch: { verified?: boolean; isActive?: boolean }, noticeKey: string) => {
    setBusyId(row.id);
    setNotice(null);
    const res = await apiCall(() => api.adminTradeUpdate(row.kind, row.id, patch));
    setBusyId(null);
    if (res.error) {
      setError(res.error);
      return;
    }
    setRows((current) => current.map((r) => (r.id === row.id ? { ...r, ...res.data } : r)));
    setNotice(`${t(noticeKey)} · ${row.name}`);
  };

  return (
    <AppLayout>
      <SectionHeader title={t('admin.trade')} subtitle={t('admin.trade.hint')} />
      <div className="mb-3 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`admin-trade-tab-${k}`}
            onClick={() => setKind(k)}
            className={k === kind
              ? 'rounded border border-slate-400 bg-slate-100 px-3 py-1 text-sm font-medium'
              : 'rounded border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-400'}
          >
            {t(KIND_LABEL_KEY[k])}
          </button>
        ))}
      </div>
      {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-trade-notice">{notice}</p>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load(kind)} /> : rows.length === 0 ? (
        <EmptyState title={t('common.noData')} hint={t(KIND_EMPTY_HINT_KEY[kind])} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>{t('field.name')}</th>
                <th>{t('field.slug')}</th>
                <th>{t('field.verified')}</th>
                <th>{t('field.active')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`admin-trade-row-${row.id}`}>
                  <td>{row.name}</td>
                  <td className="text-xs" dir="ltr">{row.slug}</td>
                  <td data-testid={`admin-trade-verified-${row.id}`}>
                    {row.verified ? <Badge color="green">{t('admin.trade.verified')}</Badge> : <Badge>{t('admin.trade.unverified')}</Badge>}
                  </td>
                  <td data-testid={`admin-trade-active-${row.id}`}>
                    {row.isActive ? <Badge color="green">{t('field.on')}</Badge> : <Badge color="red">{t('field.off')}</Badge>}
                  </td>
                  <td className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid={`admin-trade-toggle-verified-${row.id}`}
                      disabled={busyId === row.id}
                      onClick={() => void update(row, { verified: !row.verified }, row.verified ? 'admin.trade.unverify' : 'admin.trade.verify')}
                      className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-green-400 hover:text-green-700 disabled:opacity-50"
                    >
                      {row.verified ? t('admin.trade.unverify') : t('admin.trade.verify')}
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-trade-toggle-active-${row.id}`}
                      disabled={busyId === row.id}
                      onClick={() => void update(row, { isActive: !row.isActive }, row.isActive ? 'admin.trade.suspend' : 'admin.trade.reactivate')}
                      className={row.isActive
                        ? 'rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-red-400 hover:text-red-600 disabled:opacity-50'
                        : 'rounded border border-slate-300 px-2 py-1 text-xs text-green-700 hover:border-green-400 disabled:opacity-50'}
                    >
                      {row.isActive ? t('admin.trade.suspend') : t('admin.trade.reactivate')}
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

import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { DeletionRequestRow, DeletionStage } from '@/lib/types';

/** Stages an operator can move a request to, with the risk each one carries. */
const ADVANCE_STAGES: DeletionStage[] = ['RETENTION', 'REVIEW', 'ELIGIBLE', 'ANONYMIZED', 'REJECTED'];

const STAGE_FILTERS: Array<DeletionStage | ''> = [
  '',
  'DEACTIVATED',
  'RETENTION',
  'REVIEW',
  'ELIGIBLE',
  'ANONYMIZED',
  'REJECTED',
];

function stageColor(stage: DeletionStage): 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo' {
  if (stage === 'ANONYMIZED') return 'green';
  if (stage === 'REJECTED') return 'red';
  if (stage === 'ELIGIBLE') return 'teal';
  if (stage === 'RETENTION' || stage === 'REVIEW') return 'amber';
  if (stage === 'DEACTIVATED') return 'indigo';
  return 'slate';
}

/**
 * The retention window is resolved from the Policy Engine when the request is
 * created, so the UI reads it back rather than assuming a duration.
 */
function retentionOpen(row: DeletionRequestRow): boolean {
  if (!row.retentionUntil) return false;
  const until = new Date(row.retentionUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

export function AdminPrivacyPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<DeletionRequestRow[]>([]);
  const [stage, setStage] = useState<DeletionStage | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (filter: DeletionStage | '' = stage) => {
    setError(null);
    const res = await apiCall(() => api.adminDeletionRequests({ stage: filter || undefined }));
    setRows(res.data ?? []);
    setError(res.error);
    setLoading(false);
  };

  useEffect(() => { void load(''); }, []);

  const applyFilter = async (next: DeletionStage | '') => {
    setStage(next);
    setLoading(true);
    await load(next);
  };

  const advance = async (row: DeletionRequestRow, target: DeletionStage, legalHoldOverride = false) => {
    setBusyId(row.requestId);
    setNotice(null);
    const res = await apiCall(() => api.adminAdvanceDeletion(row.requestId, target, { legalHoldOverride }));
    setBusyId(null);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t('adminPrivacy.advanced')} → ${target}`);
    await load();
  };

  /**
   * ANONYMIZED is irreversible. The server refuses it while the retention window
   * is open unless an explicit legal-hold override is sent, so the operator has
   * to confirm before we forward that flag.
   */
  const anonymize = async (row: DeletionRequestRow) => {
    const override = retentionOpen(row);
    if (override && !window.confirm(t('adminPrivacy.overrideConfirm'))) return;
    await advance(row, 'ANONYMIZED', override);
  };

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.stage] = (acc[r.stage] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminPrivacy.title')}
        subtitle={t('adminPrivacy.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-privacy-refresh"
            disabled={loading}
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {t('common.refresh')}
          </button>
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['DEACTIVATED', 'RETENTION', 'ELIGIBLE', 'ANONYMIZED'] as DeletionStage[]).map((s) => (
          <Card key={s} testId={`admin-privacy-kpi-${s}`}>
            <p className="text-xs font-medium text-slate-500">{t(`adminPrivacy.stage.${s}`)}</p>
            <p className="mt-1 text-xl font-bold text-slate-800">{counts[s] ?? 0}</p>
          </Card>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="admin-privacy-stage" className="text-xs font-medium text-slate-500">
          {t('adminPrivacy.filter')}
        </label>
        <select
          id="admin-privacy-stage"
          data-testid="admin-privacy-stage"
          value={stage}
          onChange={(e) => void applyFilter(e.target.value as DeletionStage | '')}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          {STAGE_FILTERS.map((s) => (
            <option key={s || 'ALL'} value={s}>
              {s ? t(`adminPrivacy.stage.${s}`) : t('adminPrivacy.allStages')}
            </option>
          ))}
        </select>
      </div>

      {notice && (
        <div className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" role="status">
          {notice}
        </div>
      )}
      {error && <div className="mb-3"><ErrorState message={error} onRetry={() => void load()} /></div>}

      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title={t('adminPrivacy.empty')} hint={t('adminPrivacy.emptyHint')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200" data-testid="admin-privacy-table">
          <table className="table-base w-full">
            <thead>
              <tr>
                <th>{t('adminPrivacy.account')}</th>
                <th>{t('adminPrivacy.stageLabel')}</th>
                <th>{t('adminPrivacy.reason')}</th>
                <th>{t('adminPrivacy.retentionUntil')}</th>
                <th>{t('adminPrivacy.createdAt')}</th>
                <th>{t('adminPrivacy.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.requestId} data-testid={`admin-privacy-row-${row.requestId}`}>
                  <td>
                    <div className="text-sm font-medium text-slate-700">{row.userEmail ?? row.userId}</div>
                    <div className="text-xs text-slate-400">
                      {row.userName ?? '—'}
                      {' · '}
                      {row.accountActive ? t('adminPrivacy.active') : t('adminPrivacy.inactive')}
                    </div>
                  </td>
                  <td>
                    <Badge color={stageColor(row.stage)} testId={`admin-privacy-stage-${row.requestId}`}>
                      {row.stage}
                    </Badge>
                  </td>
                  <td className="max-w-[16rem] text-xs text-slate-500">{row.reason ?? '—'}</td>
                  <td className="text-xs text-slate-500">
                    {row.retentionUntil ? formatDate(row.retentionUntil) : '—'}
                    {retentionOpen(row) && (
                      <span className="ms-1 text-amber-600">({t('adminPrivacy.windowOpen')})</span>
                    )}
                  </td>
                  <td className="text-xs text-slate-500">{formatDate(row.createdAt)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {ADVANCE_STAGES.filter((s) => s !== row.stage).map((s) => (
                        <button
                          key={s}
                          type="button"
                          data-testid={`admin-privacy-advance-${s}-${row.requestId}`}
                          disabled={busyId === row.requestId}
                          onClick={() => void (s === 'ANONYMIZED' ? anonymize(row) : advance(row, s))}
                          className="rounded border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {t(`adminPrivacy.stage.${s}`)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppLayout>
  );
}

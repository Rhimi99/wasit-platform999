import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { DashboardReportRow } from '@/lib/types';

/**
 * Admin reports desk — the saved-report surface documented in UI_SCREEN_MAP
 * ("Reports" under Admin) and API_SPECIFICATION (`GET/POST
 * /api/admin/analytics/reports`). The backend persisted these snapshots all
 * along but no screen consumed them, so a report could be written and never
 * read. This page lists saved reports with the payload the server now returns
 * and lets an operator save a new snapshot.
 */
export function AdminReportsPage() {
  const { t } = useI18n();
  const [reports, setReports] = useState<DashboardReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [reportCode, setReportCode] = useState('');
  const [title, setTitle] = useState('');
  const [reportData, setReportData] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.adminAnalyticsReports());
    setReports(res.data?.items ?? []);
    setError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportCode.trim() || !title.trim() || busy) return;

    let parsed: Record<string, unknown> | undefined;
    if (reportData.trim()) {
      try {
        parsed = JSON.parse(reportData) as Record<string, unknown>;
      } catch {
        setError(t('adminReports.invalidJson'));
        setNotice(null);
        return;
      }
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminCreateAnalyticsReport({
      reportCode: reportCode.trim(),
      title: title.trim(),
      reportData: parsed,
    }));
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t('adminReports.created')} · ${title.trim()}`);
    setReportCode('');
    setTitle('');
    setReportData('');
    await load();
  };

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminReports.title')}
        subtitle={t('adminReports.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-reports-refresh"
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('common.refresh')}
          </button>
        )}
      />

      <Card className="mb-6" testId="admin-reports-form">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-600">
            {t('adminReports.code')}
            <input
              className="input mt-1"
              data-testid="admin-report-code"
              value={reportCode}
              onChange={(e) => setReportCode(e.target.value)}
              placeholder="weekly-gmv"
            />
          </label>
          <label className="text-xs text-slate-600">
            {t('adminReports.reportTitle')}
            <input
              className="input mt-1"
              data-testid="admin-report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-600 sm:col-span-2">
            {t('adminReports.data')}
            <textarea
              className="input mt-1 font-mono text-xs"
              data-testid="admin-report-data"
              rows={3}
              dir="ltr"
              value={reportData}
              onChange={(e) => setReportData(e.target.value)}
              placeholder='{"period":"W"}'
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              data-testid="admin-report-submit"
              disabled={busy || !reportCode.trim() || !title.trim()}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? '…' : t('adminReports.save')}
            </button>
          </div>
        </form>
      </Card>

      {notice && <div role="status" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        reports.length === 0 ? <EmptyState title={t('adminReports.empty')} /> : (
          <Card className="overflow-x-auto" testId="admin-reports-table">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminReports.col.code')}</th>
                  <th>{t('adminReports.col.reportTitle')}</th>
                  <th>{t('adminReports.col.created')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} data-testid={`admin-report-row-${r.id}`}>
                    <td className="text-xs font-medium text-slate-700" dir="ltr">{r.reportCode}</td>
                    <td className="text-sm text-slate-700">{r.title}</td>
                    <td className="text-xs text-slate-500">{formatDate(r.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        data-testid={`admin-report-view-${r.id}`}
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700"
                      >
                        {expandedId === r.id ? t('adminReports.hide') : t('adminReports.view')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {expandedId && (() => {
              const row = reports.find((r) => r.id === expandedId);
              if (!row) return null;
              return (
                <pre
                  data-testid="admin-report-detail"
                  dir="ltr"
                  className="mt-3 overflow-x-auto rounded bg-slate-50 p-3 text-xs text-slate-700"
                >
                  {JSON.stringify(row.reportData ?? {}, null, 2)}
                </pre>
              );
            })()}
          </Card>
        )
      )}
    </AppLayout>
  );
}

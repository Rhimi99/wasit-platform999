import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  AlertEventRow,
  ObservabilityDashboard,
  ObservabilityLogRecord,
  ObservabilityMetricsSnapshot,
  ObservabilityMetricSeries,
} from '@/lib/types';

type Tab = 'overview' | 'metrics' | 'logs' | 'alerts';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function levelColor(level: string): 'slate' | 'teal' | 'amber' | 'red' {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'amber';
  if (level === 'info') return 'teal';
  return 'slate';
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

/** Flattens the registry snapshot into display rows (counters/gauges). */
function scalarRows(
  group: Record<string, Array<{ labels: Record<string, string>; value: number }>>,
): Array<{ name: string; labels: string; value: number }> {
  return Object.entries(group).flatMap(([name, series]) =>
    series.map((s) => ({ name, labels: renderLabels(s.labels), value: s.value })),
  );
}

function histogramRows(
  group: Record<string, ObservabilityMetricSeries[]>,
): Array<{ name: string; labels: string; count: number; sum: number; p50: number; p95: number; p99: number }> {
  return Object.entries(group).flatMap(([name, series]) =>
    series.map((s) => ({
      name,
      labels: renderLabels(s.labels),
      count: s.count,
      sum: s.sum,
      p50: s.quantiles.p50 ?? 0,
      p95: s.quantiles.p95 ?? 0,
      p99: s.quantiles.p99 ?? 0,
    })),
  );
}

function totalCounter(snapshot: ObservabilityMetricsSnapshot, name: string): number {
  return (snapshot.counters[name] ?? []).reduce((acc, s) => acc + s.value, 0);
}

function totalGauge(snapshot: ObservabilityMetricsSnapshot, name: string): number {
  return (snapshot.gauges[name] ?? []).reduce((acc, s) => acc + s.value, 0);
}

function latencySeries(snapshot: ObservabilityMetricsSnapshot): ObservabilityMetricSeries[] {
  const histograms = Object.entries(snapshot.histograms);
  const http = histograms.find(([name]) => /http.*duration|request.*duration|latency/i.test(name));
  return http ? http[1] : histograms[0]?.[1] ?? [];
}

export function AdminObservabilityPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('overview');
  const [dashboard, setDashboard] = useState<ObservabilityDashboard | null>(null);
  const [logs, setLogs] = useState<ObservabilityLogRecord[]>([]);
  const [alertEvents, setAlertEvents] = useState<AlertEventRow[]>([]);
  const [level, setLevel] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    const [metricsRes, logsRes, alertsRes] = await Promise.all([
      apiCall(() => api.adminObservabilityMetrics()),
      apiCall(() => api.adminObservabilityLogs({ level: level || undefined, limit: 100 })),
      apiCall(() => api.adminObservabilityAlerts({ limit: 50 })),
    ]);
    setDashboard(metricsRes.data ?? null);
    setLogs(logsRes.data ?? []);
    setAlertEvents(alertsRes.data?.items ?? []);
    setError(metricsRes.error ?? logsRes.error ?? alertsRes.error);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const evaluate = async () => {
    setBusy(true);
    setNotice(null);
    const res = await apiCall(() => api.adminEvaluateAlerts());
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t('adminObs.evaluated')} ${res.data?.evaluated ?? 0} · ${t('adminObs.firedCount')} ${res.data?.fired.length ?? 0} · ${t('adminObs.resolvedCount')} ${res.data?.resolved.length ?? 0}`);
    await load();
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('adminObs.tab.overview') },
    { id: 'metrics', label: t('adminObs.tab.metrics') },
    { id: 'logs', label: t('adminObs.tab.logs') },
    { id: 'alerts', label: t('adminObs.tab.alerts') },
  ];

  const snapshot = dashboard?.metrics ?? null;
  const counters = snapshot ? scalarRows(snapshot.counters) : [];
  const gauges = snapshot ? scalarRows(snapshot.gauges) : [];
  const histograms = snapshot ? histogramRows(snapshot.histograms) : [];
  const latency = snapshot ? latencySeries(snapshot) : [];

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminObs.title')}
        subtitle={t('adminObs.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-obs-refresh"
            disabled={busy}
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
            data-testid={`admin-obs-tab-${x.id}`}
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
          {tab === 'overview' && dashboard && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card testId="admin-obs-kpi-requests">
                  <p className="text-xs text-slate-500">{t('adminObs.kpi.requests')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{totalCounter(snapshot!, 'wasit_http_requests_total')}</p>
                </Card>
                <Card testId="admin-obs-kpi-errors">
                  <p className="text-xs text-slate-500">{t('adminObs.kpi.errors')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{totalCounter(snapshot!, 'wasit_http_errors_total')}</p>
                </Card>
                <Card testId="admin-obs-kpi-firing">
                  <p className="text-xs text-slate-500">{t('adminObs.kpi.firing')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">{dashboard.alerts.firing.length}</p>
                </Card>
                <Card testId="admin-obs-kpi-db">
                  <p className="text-xs text-slate-500">{t('adminObs.kpi.db')}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {totalGauge(snapshot!, 'wasit_db_up') === 1 ? t('adminObs.db.up') : dashboard.db}
                  </p>
                </Card>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Card testId="admin-obs-notifier">
                  <p className="text-xs text-slate-500">{t('adminObs.notifier')}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800" dir="ltr">{dashboard.alerts.notifier.notifier}</span>
                    <Badge color={dashboard.alerts.notifier.available ? 'green' : 'amber'}>
                      {dashboard.alerts.notifier.available ? t('adminObs.available') : t('adminObs.unavailable')}
                    </Badge>
                  </div>
                </Card>
                <Card testId="admin-obs-last-eval">
                  <p className="text-xs text-slate-500">{t('adminObs.lastEvaluated')}</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {dashboard.alerts.lastEvaluatedAt ? formatDate(dashboard.alerts.lastEvaluatedAt) : t('adminObs.neverEvaluated')}
                  </p>
                </Card>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-bold text-slate-800">{t('adminObs.firingAlerts')}</h3>
                {dashboard.alerts.firing.length === 0 ? (
                  <EmptyState title={t('adminObs.noFiring')} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {dashboard.alerts.firing.map((a) => (
                      <Badge key={a.rule} color="red" testId={`admin-obs-firing-${a.rule}`}>
                        {a.rule} · {a.firedAt ? formatDate(a.firedAt) : '—'}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <Card testId="admin-obs-latency" className="overflow-x-auto">
                <p className="mb-2 text-xs text-slate-500">{t('adminObs.latency')}</p>
                {latency.length === 0 ? <p className="text-sm text-slate-400">{t('common.noData')}</p> : (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminObs.metric.labels')}</th>
                        <th>{t('adminObs.metric.count')}</th>
                        <th>p50</th>
                        <th>p95</th>
                        <th>p99</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latency.map((s, i) => (
                        <tr key={i}>
                          <td className="text-xs" dir="ltr">{renderLabels(s.labels)}</td>
                          <td className="text-xs" dir="ltr">{s.count}</td>
                          <td className="text-xs" dir="ltr">{s.quantiles.p50 ?? 0}</td>
                          <td className="text-xs" dir="ltr">{s.quantiles.p95 ?? 0}</td>
                          <td className="text-xs" dir="ltr">{s.quantiles.p99 ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          )}

          {tab === 'metrics' && snapshot && (
            <div className="space-y-4">
              <Card className="overflow-x-auto" testId="admin-obs-counters">
                <p className="mb-2 text-xs text-slate-500">{t('adminObs.counters')}</p>
                {counters.length === 0 ? <p className="text-sm text-slate-400">{t('common.noData')}</p> : (
                  <table className="table-base">
                    <thead><tr><th>{t('adminObs.metric.name')}</th><th>{t('adminObs.metric.labels')}</th><th>{t('adminObs.metric.value')}</th></tr></thead>
                    <tbody>
                      {counters.map((r, i) => (
                        <tr key={i} data-testid={`admin-obs-counter-${r.name}`}>
                          <td className="text-xs" dir="ltr">{r.name}</td>
                          <td className="text-xs" dir="ltr">{r.labels}</td>
                          <td className="text-xs" dir="ltr">{r.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <Card className="overflow-x-auto" testId="admin-obs-gauges">
                <p className="mb-2 text-xs text-slate-500">{t('adminObs.gauges')}</p>
                {gauges.length === 0 ? <p className="text-sm text-slate-400">{t('common.noData')}</p> : (
                  <table className="table-base">
                    <thead><tr><th>{t('adminObs.metric.name')}</th><th>{t('adminObs.metric.labels')}</th><th>{t('adminObs.metric.value')}</th></tr></thead>
                    <tbody>
                      {gauges.map((r, i) => (
                        <tr key={i} data-testid={`admin-obs-gauge-${r.name}`}>
                          <td className="text-xs" dir="ltr">{r.name}</td>
                          <td className="text-xs" dir="ltr">{r.labels}</td>
                          <td className="text-xs" dir="ltr">{r.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <Card className="overflow-x-auto" testId="admin-obs-histograms">
                <p className="mb-2 text-xs text-slate-500">{t('adminObs.histograms')}</p>
                {histograms.length === 0 ? <p className="text-sm text-slate-400">{t('common.noData')}</p> : (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminObs.metric.name')}</th>
                        <th>{t('adminObs.metric.labels')}</th>
                        <th>{t('adminObs.metric.count')}</th>
                        <th>{t('adminObs.metric.sum')}</th>
                        <th>p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {histograms.map((r, i) => (
                        <tr key={i} data-testid={`admin-obs-histogram-${r.name}`}>
                          <td className="text-xs" dir="ltr">{r.name}</td>
                          <td className="text-xs" dir="ltr">{r.labels}</td>
                          <td className="text-xs" dir="ltr">{r.count}</td>
                          <td className="text-xs" dir="ltr">{r.sum}</td>
                          <td className="text-xs" dir="ltr">{r.p95}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          )}

          {tab === 'logs' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-medium text-slate-500" htmlFor="admin-obs-level">{t('adminObs.filterLevel')}</label>
                <select
                  id="admin-obs-level"
                  data-testid="admin-obs-level"
                  className="input w-40"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="">{t('adminObs.allLevels')}</option>
                  {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <button
                  type="button"
                  data-testid="admin-obs-apply-filter"
                  onClick={() => void load()}
                  className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700"
                >
                  {t('adminObs.applyFilter')}
                </button>
              </div>
              {logs.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminObs.tab.logs')} /> : (
                <Card className="overflow-x-auto" testId="admin-obs-logs">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminObs.log.time')}</th>
                        <th>{t('adminObs.log.level')}</th>
                        <th>{t('adminObs.log.message')}</th>
                        <th>{t('adminObs.log.trace')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((l, i) => (
                        <tr key={i} data-testid={`admin-obs-log-${i}`}>
                          <td className="text-xs">{formatDate(l.time)}</td>
                          <td><Badge color={levelColor(l.level)}>{l.level}</Badge></td>
                          <td className="text-xs" dir="ltr">{l.msg}</td>
                          <td className="text-xs" dir="ltr">{l.traceId ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
            </div>
          )}

          {tab === 'alerts' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500" data-testid="admin-obs-alert-count">
                  {t('adminObs.alertHistory')}: {alertEvents.length}
                </p>
                <button
                  type="button"
                  data-testid="admin-obs-evaluate"
                  disabled={busy}
                  onClick={() => void evaluate()}
                  className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                >
                  {busy ? t('common.processing') : t('adminObs.evaluateNow')}
                </button>
              </div>
              {alertEvents.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminObs.tab.alerts')} /> : (
                <Card className="overflow-x-auto" testId="admin-obs-alerts">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminObs.alert.rule')}</th>
                        <th>{t('adminObs.alert.severity')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('adminObs.alert.summary')}</th>
                        <th>{t('adminObs.alert.startedAt')}</th>
                        <th>{t('adminObs.alert.notified')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alertEvents.map((a) => (
                        <tr key={a.id} data-testid={`admin-obs-alert-${a.id}`}>
                          <td className="text-xs" dir="ltr">{a.rule}</td>
                          <td><Badge color={a.severity === 'critical' ? 'red' : 'amber'}>{a.severity}</Badge></td>
                          <td><Badge color={a.status === 'FIRING' ? 'red' : 'green'}>{a.status}</Badge></td>
                          <td className="text-xs">{a.summary}</td>
                          <td className="text-xs">{formatDate(a.startedAt)}</td>
                          <td className="text-xs" dir="ltr">{a.notifiedChannel ?? '—'}{a.notifiedResult ? ` · ${a.notifiedResult}` : ''}</td>
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

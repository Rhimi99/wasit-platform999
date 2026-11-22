import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, ReasonDialog, Spinner } from '@/components/ui';
import type { EscalationRow, OperationsSnapshot } from '@/lib/types';

/**
 * OBS-OPS-01 — the operational desk the General Manager reads.
 *
 * Read-only by default. The only actions are the two human decisions the
 * platform already models: acknowledge or resolve an escalation, and
 * acknowledge a firing platform alert. Nothing here can mute a live incident —
 * the server refuses to resolve a rule that is still firing.
 *
 * Reading the desk (`admin:system`) and deciding an AI escalation (`admin:ai`)
 * are separate capabilities. When the caller lacks the second, the section is
 * replaced by an explanation and no request is attempted — a guaranteed 403 is
 * not an error worth showing.
 */

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function Stat({ label, value, hint, testId, tone }: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
  tone?: 'red' | 'amber' | 'green';
}) {
  const color = tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-green-700' : 'text-slate-900';
  return (
    <Card testId={testId}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`} dir="ltr">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </Card>
  );
}

export function OperationsPanel() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [escalations, setEscalations] = useState<EscalationRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Fatal: the desk itself could not be read. */
  const [error, setError] = useState<string | null>(null);
  /** Local to the escalation card: the desk stays usable without it. */
  const [escalationError, setEscalationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<EscalationRow | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setEscalationError(null);
    const opsRes = await apiCall(() => api.adminObservabilityOperations());
    setSnapshot(opsRes.data ?? null);
    setError(opsRes.error ?? null);
    setLoading(false);
    // Only ask for escalations when the server said the caller may decide them.
    if (!opsRes.data?.capabilities.aiEscalations) {
      setEscalations([]);
      return;
    }
    const escRes = await apiCall(() => api.adminEscalations({ status: 'OPEN', limit: 20 }));
    setEscalations(escRes.data?.items ?? []);
    setEscalationError(escRes.error ?? null);
  };

  useEffect(() => { void load(); }, []);

  const acknowledge = async (row: EscalationRow) => {
    setBusyId(row.id);
    setNotice(null);
    setEscalationError(null);
    const res = await apiCall(() => api.adminAcknowledgeEscalation(row.id));
    setBusyId(null);
    if (res.error) { setEscalationError(res.error); return; }
    setNotice(t('adminObs.ops.escalationAcknowledged'));
    await load();
  };

  const submitResolve = async (reason: string) => {
    if (!resolving) return;
    setBusyId(resolving.id);
    setResolveError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminResolveEscalation(resolving.id, reason));
    setBusyId(null);
    if (res.error) { setResolveError(res.error); return; }
    setResolving(null);
    setNotice(t('adminObs.ops.escalationResolved'));
    await load();
  };

  const scanNow = async () => {
    setBusyId('scan');
    setNotice(null);
    setEscalationError(null);
    const res = await apiCall(() => api.adminScanEscalations());
    setBusyId(null);
    if (res.error) { setEscalationError(res.error); return; }
    setNotice(`${t('adminObs.ops.scanDone')} · ${res.data?.opened ?? 0}`);
    await load();
  };

  if (loading) return <Spinner />;
  if (error && !snapshot) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!snapshot) return <EmptyState title={t('common.noData')} />;

  const { platform, agents, scheduler, alerts, notifications } = snapshot;
  const stalled = agents.tasks.stalled;
  const decisions = agents.escalations.open + agents.tasks.pendingApprovals + alerts.firingCount;

  return (
    <div className="space-y-4">
      {notice && <div role="status" className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          testId="admin-ops-db"
          label={t('adminObs.ops.db')}
          value={platform.db.status === 'up' ? `${platform.db.latencyMs ?? 0} ms` : t('adminObs.ops.down')}
          tone={platform.db.status === 'up' ? 'green' : 'red'}
          hint={platform.db.error ?? undefined}
        />
        <Stat
          testId="admin-ops-error-ratio"
          label={t('adminObs.ops.errorRatio')}
          value={pct(platform.http.errorRatio)}
          tone={(platform.http.errorRatio ?? 0) > 0.05 ? 'red' : undefined}
          hint={`${platform.http.errors} / ${platform.http.requests}`}
        />
        <Stat
          testId="admin-ops-p95"
          label={t('adminObs.ops.p95')}
          value={platform.http.p95Seconds === null ? '—' : `${platform.http.p95Seconds.toFixed(3)} s`}
          hint={platform.http.slowestRoute ?? undefined}
        />
        <Stat
          testId="admin-ops-backup"
          label={t('adminObs.ops.backup')}
          value={platform.backup.ageHours === null ? t('adminObs.ops.unknown') : `${platform.backup.ageHours} h`}
          tone={platform.backup.ageHours !== null && platform.backup.ageHours > platform.backup.maxAgeHours ? 'red' : 'green'}
          hint={`${t('adminObs.ops.backupMax')}: ${platform.backup.maxAgeHours} h`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          testId="admin-ops-decisions"
          label={t('adminObs.ops.needsDecision')}
          value={String(decisions)}
          tone={decisions > 0 ? 'amber' : 'green'}
          hint={`${t('adminObs.ops.escalations')}: ${agents.escalations.open} · ${t('adminObs.ops.approvals')}: ${agents.tasks.pendingApprovals} · ${t('adminObs.ops.firing')}: ${alerts.firingCount}`}
        />
        <Stat
          testId="admin-ops-stalled"
          label={t('adminObs.ops.stalled')}
          value={String(stalled.count)}
          tone={stalled.count > 0 ? 'red' : 'green'}
          hint={`${t('adminObs.ops.threshold')}: ${stalled.thresholdMinutes} min${stalled.oldestAgeMinutes !== null ? ` · ${t('adminObs.ops.oldest')}: ${stalled.oldestAgeMinutes} min` : ''}`}
        />
        <Stat
          testId="admin-ops-runs"
          label={t('adminObs.ops.runs')}
          value={`${agents.runs.active}`}
          tone={agents.runs.stuck > 0 ? 'red' : undefined}
          hint={`${t('adminObs.ops.stuck')}: ${agents.runs.stuck} · ${t('adminObs.ops.failedSteps')}: ${agents.runs.failedSteps} · ${t('adminObs.ops.contained')}: ${agents.runs.contained}`}
        />
        <Stat
          testId="admin-ops-success"
          label={t('adminObs.ops.success24h')}
          value={pct(agents.performance24h.successRate)}
          tone={(agents.performance24h.successRate ?? 1) < 0.9 ? 'amber' : 'green'}
          hint={`${agents.performance24h.attempts} ${t('adminObs.ops.attempts')} · ${agents.performance24h.scopeFailures} ${t('adminObs.ops.scopeFailures')}`}
        />
      </div>

      <Card testId="admin-ops-escalations">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-slate-800">{t('adminObs.ops.escalationsTitle')}</p>
            <p className="text-xs text-slate-500">
              {t('adminObs.ops.lastScan')}: {scheduler.escalationsLastScanAt ? formatDate(scheduler.escalationsLastScanAt) : t('adminObs.neverEvaluated')}
              {' · '}
              {t('adminObs.ops.escalationsOpen')}: <span dir="ltr">{agents.escalations.open}</span>
            </p>
          </div>
          {snapshot.capabilities.aiEscalations && (
            <button
              type="button"
              data-testid="admin-ops-scan-escalations"
              disabled={busyId === 'scan'}
              onClick={() => void scanNow()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {busyId === 'scan' ? t('common.processing') : t('adminObs.ops.scanNow')}
            </button>
          )}
        </div>
        {!snapshot.capabilities.aiEscalations ? (
          <div
            role="note"
            data-testid="admin-ops-escalations-denied"
            className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
          >
            {t('adminObs.ops.escalationsDenied')}
          </div>
        ) : escalationError ? (
          <div role="alert" data-testid="admin-ops-escalations-error" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {escalationError}
          </div>
        ) : escalations.length === 0 ? <EmptyState title={t('adminObs.ops.noEscalations')} /> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminObs.ops.severity')}</th>
                  <th>{t('adminObs.ops.code')}</th>
                  <th>{t('adminObs.ops.agent')}</th>
                  <th>{t('adminObs.ops.recommendation')}</th>
                  <th>{t('adminObs.ops.occurrences')}</th>
                  <th>{t('adminObs.ops.since')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map((row) => (
                  <tr key={row.id} data-testid={`admin-ops-escalation-${row.id}`}>
                    <td><Badge color={row.severity === 'CRITICAL' || row.severity === 'HIGH' ? 'red' : 'amber'}>{row.severity}</Badge></td>
                    <td className="text-xs" dir="ltr">{row.code}</td>
                    <td className="text-xs" dir="ltr">{row.agentKey ?? '—'}</td>
                    <td className="text-xs">{row.recommendationKey || row.recommendation}</td>
                    <td className="text-xs" dir="ltr">{row.occurrences}</td>
                    <td className="text-xs">{formatDate(row.createdAt)}</td>
                    <td>
                      <div className="flex gap-2">
                        {row.status === 'OPEN' && (
                          <button
                            type="button"
                            data-testid={`admin-ops-escalation-ack-${row.id}`}
                            disabled={busyId === row.id}
                            onClick={() => void acknowledge(row)}
                            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {t('adminObs.ops.acknowledge')}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid={`admin-ops-escalation-resolve-${row.id}`}
                          disabled={busyId === row.id}
                          onClick={() => { setResolveError(null); setResolving(row); }}
                          className="rounded border border-red-300 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t('adminObs.ops.resolve')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="admin-ops-scheduler">
          <p className="mb-2 text-sm font-bold text-slate-800">
            {t('adminObs.ops.scheduler')}{' '}
            <Badge color={scheduler.running ? 'green' : 'slate'}>
              {scheduler.running ? t('adminObs.ops.running') : t('adminObs.ops.stopped')}
            </Badge>
          </p>
          {scheduler.jobs.length === 0 ? (
            <EmptyState title={t('adminObs.ops.noJobRuns')} hint={t('adminObs.ops.processLocal')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('adminObs.ops.job')}</th>
                    <th>{t('adminObs.ops.lastRun')}</th>
                    <th>{t('adminObs.ops.duration')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('adminObs.ops.failures')}</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduler.jobs.map((job) => (
                    <tr key={job.name} data-testid={`admin-ops-job-${job.name}`}>
                      <td className="text-xs" dir="ltr">{job.name}</td>
                      <td className="text-xs">{job.lastRunAt ? formatDate(job.lastRunAt) : '—'}</td>
                      <td className="text-xs" dir="ltr">{job.lastDurationMs === null ? '—' : `${job.lastDurationMs} ms`}</td>
                      <td>
                        <Badge color={job.lastOutcome === 'failed' ? 'red' : job.lastOutcome === 'ok' ? 'green' : 'slate'}>
                          {job.lastOutcome}
                        </Badge>
                      </td>
                      <td className="text-xs" dir="ltr" title={job.lastError ?? undefined}>
                        {job.consecutiveFailures}
                        {job.lastError ? ` · ${job.lastError.slice(0, 40)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card testId="admin-ops-agents">
          <p className="mb-2 text-sm font-bold text-slate-800">{t('adminObs.ops.agents')}</p>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <p>{t('adminObs.ops.catalogue')}: <span dir="ltr">{agents.catalogue.total}</span></p>
            <p>{t('adminObs.ops.executable')}: <span dir="ltr">{agents.catalogue.executable}</span></p>
            <p>{t('adminObs.ops.declaredOnly')}: <span dir="ltr">{agents.catalogue.declaredOnly}</span></p>
            <p>{t('adminObs.ops.registryActive')}: <span dir="ltr">{agents.catalogue.registryStatus.ACTIVE}/{agents.catalogue.registryStatus.total}</span></p>
          </div>
          <p className="mt-3 mb-1 text-xs font-medium text-slate-500">{t('adminObs.ops.worstAgents')}</p>
          {agents.performance24h.worstAgents.length === 0 ? <p className="text-xs text-slate-400">{t('common.noData')}</p> : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminObs.ops.agent')}</th>
                  <th>{t('adminObs.ops.attempts')}</th>
                  <th>{t('adminObs.ops.failed')}</th>
                  <th>{t('adminObs.ops.success')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.performance24h.worstAgents.map((row) => (
                  <tr key={row.agentKey} data-testid={`admin-ops-agent-${row.agentKey}`}>
                    <td className="text-xs" dir="ltr">{row.agentKey}</td>
                    <td className="text-xs" dir="ltr">{row.attempts}</td>
                    <td className="text-xs" dir="ltr">{row.failed}</td>
                    <td className="text-xs" dir="ltr">{pct(row.successRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-slate-600">
            {t('adminObs.ops.cost24h')}:{' '}
            {agents.cost24h.status === 'unavailable' ? (
              <span className="text-amber-700">{agents.cost24h.reason}</span>
            ) : (
              <span dir="ltr">
                {agents.cost24h.byCurrency.map((c) => `${c.cost} ${c.currencyCode} (${c.requests})`).join(' · ')}
              </span>
            )}
            {' · '}
            {t('adminObs.ops.coverage')}: <span dir="ltr">{agents.cost24h.metricCoveragePercent === null ? '—' : `${agents.cost24h.metricCoveragePercent}%`}</span>
          </p>
        </Card>
      </div>

      <Card testId="admin-ops-notifications">
        <p className="mb-2 text-sm font-bold text-slate-800">
          {t('adminObs.ops.notifications')}{' '}
          <Badge color={notifications.failedLast24h > 0 ? 'red' : 'green'}>
            {t('adminObs.ops.failed24h')}: {notifications.failedLast24h}
          </Badge>
        </p>
        <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-600" dir="ltr">
          {Object.entries(notifications.byStatus).map(([status, count]) => (
            <span key={status}>{status}: <strong>{count}</strong></span>
          ))}
        </div>
        {notifications.recentFailures.length === 0 ? <EmptyState title={t('adminObs.ops.noDeliveryFailures')} /> : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminObs.ops.eventType')}</th>
                  <th>{t('adminObs.ops.channel')}</th>
                  <th>{t('adminObs.ops.attempts')}</th>
                  <th>{t('adminObs.ops.lastError')}</th>
                  <th>{t('adminObs.ops.at')}</th>
                </tr>
              </thead>
              <tbody>
                {notifications.recentFailures.map((row) => (
                  <tr key={row.id} data-testid={`admin-ops-delivery-${row.id}`}>
                    <td className="text-xs" dir="ltr">{row.eventType}</td>
                    <td className="text-xs" dir="ltr">{row.channel}</td>
                    <td className="text-xs" dir="ltr">{row.attempts}</td>
                    <td className="text-xs" dir="ltr">{row.lastError ?? '—'}</td>
                    <td className="text-xs">{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {resolving && (
        <ReasonDialog
          key={resolving.id}
          testId="admin-ops-resolve-dialog"
          title={t('adminObs.ops.resolveDialogTitle')}
          description={`${resolving.code} · ${resolving.agentKey ?? '—'}`}
          label={t('adminObs.ops.resolveReason')}
          confirmLabel={t('adminObs.ops.resolveConfirm')}
          cancelLabel={t('common.cancel')}
          busy={busyId === resolving.id}
          error={resolveError}
          onSubmit={(reason) => void submitResolve(reason)}
          onCancel={() => { if (busyId !== resolving.id) setResolving(null); }}
        />
      )}

      <Card testId="admin-ops-unavailable">
          <p className="mb-2 text-sm font-bold text-slate-800">{t('adminObs.ops.unavailableTitle')}</p>
          {snapshot.unavailable.length === 0 ? (
            <p className="text-xs text-green-700">{t('adminObs.ops.allAvailable')}</p>
          ) : (
            <ul className="list-disc space-y-1 ps-5 text-xs text-amber-700">
              {snapshot.unavailable.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </Card>
        <Card testId="admin-ops-events">
          <p className="mb-2 text-sm font-bold text-slate-800">{t('adminObs.ops.recentEvents')}</p>
          {snapshot.recentEvents.length === 0 ? <p className="text-xs text-slate-400">{t('common.noData')}</p> : (
            <ul className="space-y-1 text-xs">
              {snapshot.recentEvents.map((event, i) => (
                <li key={`${event.action}-${i}`} className="flex justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-700" dir="ltr">{event.action}</span>
                  <span className="text-slate-400">{formatDate(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="text-[11px] text-slate-400" dir="ltr">
        {t('adminObs.ops.generatedAt')}: {formatDate(snapshot.generatedAt)} · {t('adminObs.ops.window')}: 24h
      </p>
    </div>
  );
}

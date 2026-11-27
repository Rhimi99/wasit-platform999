import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  GmAgentRow,
  GmApprovalItem,
  GmAuditRow,
  GmHealthState,
  GmOverview,
  GmSection,
  GmTaskRow,
  GmTasksData,
} from '@/lib/types';

/**
 * The GM command center (WASIT-GM-DASHBOARD-01).
 *
 * Every value comes from `/api/admin/gm/overview`, which reads the services that
 * already own the data. The page adds no business logic of its own:
 *  - a section that could not be read says so, and the rest still renders;
 *  - a `null` figure renders as "—" (unknown), never as 0;
 *  - an action button calls the endpoint that already owns the action, so the
 *    server decides whether this account may use it.
 */

type Color = 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo';

const HEALTH_COLOR: Record<GmHealthState, Color> = {
  HEALTHY: 'green',
  DEGRADED: 'amber',
  DOWN: 'red',
  UNKNOWN: 'slate',
};

const STATUS_COLOR: Record<string, Color> = {
  succeeded: 'green',
  completed: 'green',
  COMPLETED: 'green',
  approved: 'green',
  running: 'teal',
  RUNNING: 'teal',
  DISPATCHING: 'teal',
  PLANNING: 'teal',
  queued: 'amber',
  pending: 'amber',
  awaiting_approval: 'amber',
  AWAITING_APPROVAL: 'amber',
  failed: 'red',
  FAILED: 'red',
  rejected: 'red',
  cancelled: 'red',
  contained: 'red',
};

function statusColor(status: string): Color {
  return STATUS_COLOR[status] ?? 'slate';
}

/** `null` is unknown and must not read as zero. */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

function money(value: string | number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return `${parsed.toFixed(parsed === 0 ? 2 : 4)} ${currency}`;
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function ago(value: string | null, locale: string): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return value;
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return locale === 'ar' ? 'الآن' : 'now';
  if (minutes < 60) return locale === 'ar' ? `قبل ${minutes} د` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return locale === 'ar' ? `قبل ${hours} س` : `${hours}h ago`;
  return new Date(value).toLocaleDateString(locale === 'ar' ? 'ar-TN' : 'fr-TN');
}

const GENERATION_COLOR: Record<GmAgentRow['generation'], Color> = {
  llm: 'indigo',
  deterministic: 'teal',
  none: 'slate',
};

const TONE_TEXT: Partial<Record<Color, string>> = {
  red: 'text-red-700',
  amber: 'text-amber-700',
  green: 'text-green-700',
};

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Color }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ? TONE_TEXT[tone] ?? 'text-slate-900' : 'text-slate-900'}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

function SectionShell({
  title,
  subtitle,
  section,
  onRetry,
  children,
}: {
  title: string;
  subtitle?: string;
  section: GmSection<unknown>;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {subtitle ? `${subtitle} · ` : ''}
            {t('gm.source')}: <span dir="ltr">{section.source}</span>
          </p>
        </div>
        <Badge color={section.state === 'OK' ? 'green' : section.state === 'LOADING' ? 'slate' : 'amber'}>
          {t(
            section.state === 'OK'
              ? 'gm.state.ok'
              : section.state === 'LOADING'
                ? 'gm.state.loading'
                : 'gm.state.unavailable',
          )}
        </Badge>
      </div>
      {section.state === 'LOADING' ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : section.state === 'UNAVAILABLE' ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-medium">{t('gm.unavailableHint')}</p>
          <p className="mt-1" dir="ltr">{section.error ?? t('gm.state.unavailable')}</p>
          {onRetry ? (
            <button type="button" className="mt-2 underline" onClick={onRetry}>
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-3">{children}</div>
      )}
    </Card>
  );
}

export function AdminGmPage() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<GmOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [taskFilters, setTaskFilters] = useState<{ status: string; agentKey: string; severity: string }>({
    status: '',
    agentKey: '',
    severity: '',
  });
  const [taskPage, setTaskPage] = useState(1);
  const [tasks, setTasks] = useState<GmTasksData | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState('');
  const [audit, setAudit] = useState<GmAuditRow[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiCall(() => api.adminGmOverview(days));
    setOverview(res.data);
    setError(res.error);
    setLoading(false);
  }, [days]);

  const loadTasks = useCallback(async () => {
    const res = await apiCall(() =>
      api.adminGmTasks({
        status: taskFilters.status || undefined,
        agentKey: taskFilters.agentKey || undefined,
        severity: (taskFilters.severity || undefined) as 'high' | 'medium' | 'low' | undefined,
        page: taskPage,
        pageSize: 15,
      }),
    );
    setTasks(res.data ?? null);
    setTaskError(res.error);
  }, [taskFilters, taskPage]);

  const loadAudit = useCallback(async () => {
    const res = await apiCall(() => api.adminGmAudit({ action: auditFilter || undefined, pageSize: 20 }));
    setAudit(res.data?.items ?? null);
    setAuditError(res.error);
  }, [auditFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const sections = overview?.sections;
  const platform = sections?.platform.data ?? null;
  const agentOptions = useMemo(
    () => (sections?.agents.data?.items ?? []).map((agent) => agent.key).sort(),
    [sections],
  );

  async function decide(item: GmApprovalItem, decision: 'APPROVE' | 'REJECT') {
    const verb = decision === 'APPROVE' ? t('gm.action.approve') : t('gm.action.reject');
    if (!window.confirm(`${verb}: ${item.title}?`)) return;
    const reason =
      decision === 'REJECT'
        ? window.prompt(t('gm.action.rejectReason')) ?? null
        : null;
    if (decision === 'REJECT' && reason === null) return;
    setBusyId(item.id);
    setActionError(null);
    const res = await apiCall(() =>
      item.kind === 'agent_task'
        ? api.decideAgentTask(item.id, decision, reason ?? undefined)
        : api.adminApproveRunStep(item.runId!, item.stepKey!),
    );
    setBusyId(null);
    if (res.error) {
      setActionError(res.error);
      return;
    }
    await Promise.all([load(), loadTasks()]);
  }

  async function cancelRun(runId: string) {
    if (!window.confirm(t('gm.action.cancelRunConfirm'))) return;
    setBusyId(runId);
    setActionError(null);
    const res = await apiCall(() => api.adminCancelAgentRun(runId));
    setBusyId(null);
    if (res.error) {
      setActionError(res.error);
      return;
    }
    await Promise.all([load(), loadTasks()]);
  }

  if (loading && !overview) {
    return (
      <AppLayout>
        <SectionHeader title={t('gm.title')} />
        <Spinner />
      </AppLayout>
    );
  }

  if (error && !overview) {
    return (
      <AppLayout>
        <SectionHeader title={t('gm.title')} />
        <ErrorState message={error} onRetry={load} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <SectionHeader
        title={t('gm.title')}
        subtitle={t('gm.subtitle')}
        action={
          <div className="flex items-center gap-2">
            <select
              className="input-base"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              aria-label={t('gm.window')}
            >
              <option value={7}>{t('gm.window.days').replace('{n}', '7')}</option>
              <option value={30}>{t('gm.window.days').replace('{n}', '30')}</option>
              <option value={90}>{t('gm.window.days').replace('{n}', '90')}</option>
            </select>
            <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
              {loading ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
        }
      />

      <p className="mb-3 text-xs text-slate-500">
        {t('gm.environment')}: <span dir="ltr">{overview?.environment ?? '—'}</span> · {t('gm.generatedAt')}:{' '}
        <span dir="ltr">{overview ? new Date(overview.generatedAt).toLocaleString(locale === 'ar' ? 'ar-TN' : 'fr-TN') : '—'}</span>
      </p>

      {actionError ? <div className="mb-3"><ErrorState message={actionError} /></div> : null}

      {/* Executive strip — the numbers a GM reads first. */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label={t('gm.kpi.agents')}
          value={num(platform?.agents?.total)}
          hint={
            platform?.agents
              ? `${platform.agents.active} ${t('gm.kpi.active')} · ${platform.agents.generative} ${t('gm.kpi.generative')}`
              : t('gm.unknown')
          }
        />
        <Kpi
          label={t('gm.kpi.tasks')}
          value={num(platform?.tasks?.running)}
          hint={
            platform?.tasks
              ? `${platform.tasks.queued} ${t('gm.kpi.queued')} · ${platform.tasks.awaitingApproval} ${t('gm.kpi.awaiting')}`
              : t('gm.unknown')
          }
        />
        <Kpi
          label={t('gm.kpi.approvals')}
          value={num(platform?.approvalsPending)}
          hint={platform ? `${num(platform.approvalsBlocked)} ${t('gm.kpi.blocked')}` : t('gm.unknown')}
          tone={platform?.approvalsPending ? 'amber' : undefined}
        />
        <Kpi
          label={t('gm.kpi.alerts')}
          value={num(platform?.alertsFiring)}
          hint={t('gm.kpi.alertsHint')}
          tone={platform?.alertsFiring ? 'red' : undefined}
        />
        <Kpi
          label={t('gm.kpi.spend24h')}
          value={platform?.spend24h ? money(platform.spend24h.costUsd) : '—'}
          hint={platform?.spend24h ? `${platform.spend24h.requests} ${t('gm.kpi.requests')}` : t('gm.unknown')}
        />
        <Kpi
          label={t('gm.kpi.aiExecution')}
          value={platform ? (platform.killSwitch.enabled ? t('gm.kpi.open') : t('gm.kpi.stopped')) : '—'}
          hint={
            platform
              ? `${t('gm.kpi.aiExecutionHint')} · ${t(`gm.kpi.switchSource.${platform.killSwitch.source}`)}`
              : t('gm.kpi.aiExecutionHint')
          }
          tone={platform ? (platform.killSwitch.enabled ? 'green' : 'red') : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Health */}
        <SectionShell title={t('gm.section.health')} section={sections?.health ?? emptySection()}>
          {sections?.health.data ? (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-600">
                <span>{t('gm.overall')}</span>
                <Badge color={HEALTH_COLOR[sections.health.data.overall]}>{sections.health.data.overall}</Badge>
              </div>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('gm.col.component')}</th>
                    <th>{t('gm.col.state')}</th>
                    <th>{t('gm.col.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.health.data.items.map((item) => (
                    <tr key={item.key}>
                      <td className="font-medium">{item.key}</td>
                      <td>
                        <Badge color={HEALTH_COLOR[item.state]}>{item.state}</Badge>
                        {item.probed ? null : <span className="ms-1 text-xs text-slate-400">({t('gm.inferred')})</span>}
                      </td>
                      <td className="text-xs" dir="ltr">{item.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </SectionShell>

        {/* Supervisor */}
        <SectionShell title={t('gm.section.supervisor')} section={sections?.supervisor ?? emptySection()}>
          {sections?.supervisor.data ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                {[
                  ['activeRuns', sections.supervisor.data.overview.activeRuns],
                  ['stuckRuns', sections.supervisor.data.overview.stuckRuns],
                  ['failedSteps', sections.supervisor.data.overview.failedSteps],
                  ['awaitingRetrySteps', sections.supervisor.data.overview.awaitingRetrySteps],
                  ['containedRuns', sections.supervisor.data.overview.containedRuns],
                  ['budgetExceededRuns', sections.supervisor.data.overview.budgetExceededRuns],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-md bg-slate-50 p-2">
                    <p className="text-slate-500">{t(`gm.sup.${label}`)}</p>
                    <p className="text-lg font-semibold">{String(value)}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                {t('gm.sup.lastCycle')}: <span dir="ltr">{sections.supervisor.data.overview.lastCycleAt ?? '—'}</span>
              </p>
              {sections.supervisor.data.alerts.items.length === 0 ? (
                <EmptyState title={t('gm.sup.noAlerts')} />
              ) : (
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('gm.col.rule')}</th>
                      <th>{t('gm.col.severity')}</th>
                      <th>{t('gm.col.detail')}</th>
                      <th>{t('gm.col.started')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sections.supervisor.data.alerts.items.map((alert) => (
                      <tr key={alert.id}>
                        <td>{alert.rule}</td>
                        <td><Badge color={alert.severity === 'critical' ? 'red' : 'amber'}>{alert.severity}</Badge></td>
                        <td className="text-xs" dir="ltr">{alert.summary}</td>
                        <td className="text-xs">{ago(alert.startedAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </SectionShell>

        {/* Agents */}
        <div className="xl:col-span-2">
          <SectionShell
            title={t('gm.section.agents')}
            subtitle={
              sections?.agents.data
                ? `${sections.agents.data.counts.total} ${t('gm.kpi.agents')} · ${sections.agents.data.generativeAgents.length} ${t('gm.kpi.generative')} · ${sections.agents.data.counts.executable} ${t('gm.executable')}`
                : undefined
            }
            section={sections?.agents ?? emptySection()}
          >
            {sections?.agents.data ? (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('gm.col.agent')}</th>
                      <th>{t('gm.col.tier')}</th>
                      <th>{t('gm.col.generation')}</th>
                      <th>{t('gm.col.active')}</th>
                      <th>{t('gm.col.health')}</th>
                      <th>{t('gm.col.runs')}</th>
                      <th>{t('gm.col.success')}</th>
                      <th>{t('gm.col.cost')}</th>
                      <th>{t('gm.col.limit')}</th>
                      <th>{t('gm.col.lastActivity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sections.agents.data.items.map((agent) => (
                      <tr key={agent.key}>
                        <td>
                          <p className="font-medium">{locale === 'ar' ? (agent.nameAr ?? agent.name) : agent.name}</p>
                          <p className="text-xs text-slate-500" dir="ltr">{agent.key}</p>
                          {agent.mission ? (
                            <p className="mt-0.5 text-[11px] text-slate-500">{agent.mission}</p>
                          ) : null}
                        </td>
                        <td className="text-xs">
                          {agent.tier ?? '—'}
                          {agent.category ? (
                            <p className="text-[10px] text-slate-400" dir="ltr">{agent.category}</p>
                          ) : null}
                        </td>
                        <td>
                          <Badge color={GENERATION_COLOR[agent.generation]}>
                            {t(`gm.generation.${agent.generation}`)}
                          </Badge>
                          {agent.generationCapability ? (
                            <p className="mt-1 text-[10px] text-slate-500" dir="ltr">{agent.generationCapability}</p>
                          ) : null}
                        </td>
                        <td>
                          <Badge color={agent.active ? 'green' : 'slate'}>
                            {agent.active ? t('gm.yes') : t('gm.no')}
                          </Badge>
                          {agent.requiresHumanApproval ? (
                            <p className="mt-1 text-[10px] text-amber-700">{t('gm.gated')}</p>
                          ) : null}
                        </td>
                        <td>
                          <Badge color={HEALTH_COLOR[(agent.health as GmHealthState) ?? 'UNKNOWN'] ?? 'slate'}>
                            {agent.health ?? 'UNKNOWN'}
                          </Badge>
                        </td>
                        <td className="text-xs">
                          {agent.execution.total}
                          <span className="text-slate-400"> · {agent.execution.failed} ✗</span>
                        </td>
                        <td className="text-xs">{percent(agent.execution.successRate)}</td>
                        <td className="text-xs">
                          {agent.cost.available ? money(agent.cost.actualCostUsd) : t('gm.costUnknown')}
                          <p className="text-slate-400">{agent.cost.requests} {t('gm.kpi.requests')}</p>
                        </td>
                        <td className="text-xs">
                          {agent.limit.configured ? money(agent.limit.maxCost) : t('gm.noLimit')}
                        </td>
                        <td className="text-xs">{ago(agent.lastActivityAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sections.agents.data.company.notes.length > 0 ? (
                  <ul className="mt-3 list-disc space-y-1 ps-5 text-xs text-slate-600">
                    {sections.agents.data.company.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </SectionShell>
        </div>

        {/* Copilot */}
        <SectionShell
          title={t('gm.section.copilot')}
          subtitle={
            sections?.copilot.data
              ? `${sections.copilot.data.totals.total} ${t('gm.copilot.total')} · ${sections.copilot.data.totals.awaiting} ${t('gm.kpi.awaiting')} · ${sections.copilot.data.totals.failed} ✗`
              : undefined
          }
          section={sections?.copilot ?? emptySection()}
        >
          {sections?.copilot.data ? (
            sections.copilot.data.items.length === 0 ? (
              <EmptyState title={t('gm.copilot.empty')} hint={t('gm.copilot.emptyHint')} />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('gm.col.goal')}</th>
                    <th>{t('gm.col.status')}</th>
                    <th>{t('gm.col.steps')}</th>
                    <th>{t('gm.col.created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.copilot.data.items.map((report) => (
                    <tr key={report.runId}>
                      <td className="text-xs" dir="auto">{report.goal}</td>
                      <td><Badge color={statusColor(report.status)}>{report.status}</Badge></td>
                      <td className="text-xs">{report.plan.steps?.length ?? 0}</td>
                      <td className="text-xs">{ago(report.createdAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
        </SectionShell>

        {/* Approvals */}
        <SectionShell
          title={t('gm.section.approvals')}
          subtitle={
            sections?.approvals.data
              ? `${sections.approvals.data.items.length} ${t('gm.approvals.pending')} · ${sections.approvals.data.blocked} ${t('gm.kpi.blocked')}`
              : undefined
          }
          section={sections?.approvals ?? emptySection()}
        >
          {sections?.approvals.data ? (
            sections.approvals.data.items.length === 0 ? (
              <EmptyState title={t('gm.approvals.empty')} />
            ) : (
              <div className="space-y-2">
                {sections.approvals.data.items.map((item) => {
                  const blocked = item.state === 'BLOCKED_PENDING_INDEPENDENT_APPROVER';
                  const cannotDecide = item.selfApprovalBlocked || blocked || !overview?.viewer.canDecideApprovals;
                  return (
                    <div key={item.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{item.title}</p>
                          <p className="text-xs text-slate-500">
                            {item.kind} · {item.agentKey} · {t('gm.approvals.age')} {item.ageMinutes} min
                          </p>
                        </div>
                        <Badge color={item.risk === 'high' ? 'red' : 'amber'}>{item.risk}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{item.reason}</p>
                      <ul className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-500">
                        {item.evidence.map((entry) => (
                          <li key={entry} dir="ltr" className="rounded bg-slate-100 px-1.5 py-0.5">{entry}</li>
                        ))}
                      </ul>
                      {item.selfApprovalBlocked ? (
                        <p className="mt-1 text-xs text-amber-700">{t('gm.approvals.selfBlocked')}</p>
                      ) : null}
                      {blocked ? (
                        <p className="mt-1 text-xs text-red-700">{t('gm.approvals.noIndependent')}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={cannotDecide || busyId === item.id}
                          onClick={() => void decide(item, 'APPROVE')}
                        >
                          {t('gm.action.approve')}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={cannotDecide || busyId === item.id}
                          onClick={() => void decide(item, 'REJECT')}
                        >
                          {t('gm.action.reject')}
                        </button>
                        {item.runId ? (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busyId === item.runId}
                            onClick={() => void cancelRun(item.runId!)}
                          >
                            {t('gm.action.cancelRun')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <p className="text-[10px] text-slate-500">
                  {t('gm.approvals.approverRoles')}: <span dir="ltr">{sections.approvals.data.approverRoles.join(', ') || '—'}</span>
                </p>
              </div>
            )
          ) : null}
        </SectionShell>

        {/* Tasks */}
        <div className="xl:col-span-2">
          <SectionShell
            title={t('gm.section.tasks')}
            subtitle={
              tasks
                ? `${tasks.totals.total} ${t('gm.tasks.total')} · ${tasks.totals.overdue} ${t('gm.tasks.overdue')}`
                : undefined
            }
            section={sections?.tasks ?? emptySection()}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <select
                className="input-base"
                value={taskFilters.status}
                onChange={(event) => {
                  setTaskPage(1);
                  setTaskFilters((current) => ({ ...current, status: event.target.value }));
                }}
                aria-label={t('gm.col.status')}
              >
                <option value="">{t('gm.tasks.anyStatus')}</option>
                {['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'rejected', 'cancelled'].map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
              <select
                className="input-base"
                value={taskFilters.agentKey}
                onChange={(event) => {
                  setTaskPage(1);
                  setTaskFilters((current) => ({ ...current, agentKey: event.target.value }));
                }}
                aria-label={t('gm.col.agent')}
              >
                <option value="">{t('gm.tasks.anyAgent')}</option>
                {agentOptions.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
              <select
                className="input-base"
                value={taskFilters.severity}
                onChange={(event) => {
                  setTaskPage(1);
                  setTaskFilters((current) => ({ ...current, severity: event.target.value }));
                }}
                aria-label={t('gm.col.severity')}
              >
                <option value="">{t('gm.tasks.anySeverity')}</option>
                <option value="high">{t('gm.severity.high')}</option>
                <option value="medium">{t('gm.severity.medium')}</option>
                <option value="low">{t('gm.severity.low')}</option>
              </select>
              <button type="button" className="btn-secondary" onClick={() => void loadTasks()}>
                {t('common.refresh')}
              </button>
            </div>
            {taskError && !tasks ? (
              <ErrorState message={taskError} onRetry={loadTasks} />
            ) : !tasks ? (
              <Spinner />
            ) : tasks.items.length === 0 ? (
              <EmptyState title={t('common.noData')} />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('gm.col.task')}</th>
                        <th>{t('gm.col.status')}</th>
                        <th>{t('gm.col.severity')}</th>
                        <th>{t('gm.col.agent')}</th>
                        <th>{t('gm.col.duration')}</th>
                        <th>{t('gm.col.cost')}</th>
                        <th>{t('gm.col.created')}</th>
                        <th>{t('gm.col.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.items.map((task: GmTaskRow) => (
                        <tr key={task.id}>
                          <td className="text-xs">
                            <span dir="ltr">{task.id.slice(0, 8)}</span>
                            {task.taskType ? <p className="text-slate-500" dir="ltr">{task.taskType}</p> : null}
                            {task.errorMessage ? <p className="text-red-600">{task.errorMessage}</p> : null}
                          </td>
                          <td><Badge color={statusColor(task.status)}>{task.status}</Badge></td>
                          <td><Badge color={task.severity === 'high' ? 'red' : task.severity === 'medium' ? 'amber' : 'slate'}>{task.severity}</Badge></td>
                          <td className="text-xs" dir="ltr">{task.agentKey}</td>
                          <td className="text-xs">{duration(task.durationMs)}</td>
                          <td className="text-xs">{money(task.cost)}</td>
                          <td className="text-xs">{ago(task.createdAt, locale)}</td>
                          <td className="text-xs">
                            {task.runId && ['running', 'queued', 'awaiting_approval'].includes(task.status) ? (
                              <button
                                type="button"
                                className="text-red-600 underline"
                                disabled={busyId === task.runId}
                                onClick={() => void cancelRun(task.runId!)}
                              >
                                {t('gm.action.cancelRun')}
                              </button>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span>
                    {t('gm.page')} {tasks.page} · {tasks.pageSize} {t('gm.perPage')}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={tasks.page <= 1}
                      onClick={() => setTaskPage((current) => Math.max(1, current - 1))}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={tasks.items.length < tasks.pageSize}
                      onClick={() => setTaskPage((current) => current + 1)}
                    >
                      ›
                    </button>
                  </div>
                </div>
              </>
            )}
          </SectionShell>
        </div>

        {/* Spending */}
        <div className="xl:col-span-2">
          <SectionShell title={t('gm.section.spending')} section={sections?.spending ?? emptySection()}>
            {sections?.spending.data ? (
              <div className="space-y-3">
                {!sections.spending.data.guard.ready ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-medium">{t('gm.spend.guardNotReady')}</p>
                    <p className="mt-1" dir="ltr">
                      {t('gm.spend.missing')}: {sections.spending.data.guard.missing.join(', ') || '—'}
                    </p>
                    <p className="mt-1" dir="ltr">
                      {sections.spending.data.guard.fix.method} {sections.spending.data.guard.fix.path}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-green-700">{t('gm.spend.guardReady')}</p>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                  <div className="rounded-md bg-slate-50 p-2">
                    <p className="text-slate-500">{t('gm.spend.requests')}</p>
                    <p className="text-lg font-semibold">{sections.spending.data.overview.totals.requests}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-2">
                    <p className="text-slate-500">{t('gm.spend.vendorCost')}</p>
                    <p className="text-lg font-semibold">{money(sections.spending.data.overview.totals.vendorCost)}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-2">
                    <p className="text-slate-500">{t('gm.spend.estimatedCost')}</p>
                    <p className="text-lg font-semibold">{money(sections.spending.data.overview.totals.estimatedCost)}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-2">
                    <p className="text-slate-500">{t('gm.spend.unknownCost')}</p>
                    <p className="text-lg font-semibold">{sections.spending.data.overview.totals.unknownCostRequests}</p>
                  </div>
                </div>
                {sections.spending.data.overview.limits.length > 0 ? (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('gm.col.scope')}</th>
                        <th>{t('gm.col.target')}</th>
                        <th>{t('gm.col.period')}</th>
                        <th>{t('gm.col.spent')}</th>
                        <th>{t('gm.col.limit')}</th>
                        <th>{t('gm.col.state')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sections.spending.data.overview.limits.map((limit) => (
                        <tr key={limit.id}>
                          <td className="text-xs">{limit.scope}</td>
                          <td className="text-xs" dir="ltr">{limit.targetKey}</td>
                          <td className="text-xs">{limit.period}</td>
                          <td className="text-xs">{money(limit.spent)}</td>
                          <td className="text-xs">{limit.maxCost ? money(limit.maxCost) : '—'}</td>
                          <td>
                            <Badge color={limit.state === 'BLOCKED' ? 'red' : limit.state === 'WARNING' ? 'amber' : 'green'}>
                              {limit.state}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-slate-500">{t('gm.spend.noLimits')}</p>
                )}
              </div>
            ) : null}
          </SectionShell>
        </div>

        {/* Providers */}
        <SectionShell
          title={t('gm.section.providers')}
          subtitle={
            sections?.providers.data
              ? `${t('gm.env')}: ${sections.providers.data.environment} · ${t('gm.providers.liveTest')}: ${
                  sections.providers.data.liveTestAllowed ? t('gm.yes') : t('gm.no')
                }`
              : undefined
          }
          section={sections?.providers ?? emptySection()}
        >
          {sections?.providers.data ? (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('gm.col.provider')}</th>
                    <th>{t('gm.col.enabled')}</th>
                    <th>{t('gm.col.key')}</th>
                    <th>{t('gm.col.lastTest')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.providers.data.items.map((provider) => (
                    <tr key={provider.key}>
                      <td>
                        <p className="font-medium">{provider.displayName}</p>
                        <p className="text-xs text-slate-500" dir="ltr">{provider.key} · {provider.kind}</p>
                      </td>
                      <td>
                        <Badge color={provider.enabled ? 'green' : 'slate'}>
                          {provider.enabled ? t('gm.yes') : t('gm.no')}
                        </Badge>
                      </td>
                      <td className="text-xs">
                        {provider.keyState.present ? (
                          <Badge color="green">{provider.keyState.source}</Badge>
                        ) : (
                          <Badge color={provider.requiresKey ? 'red' : 'slate'}>
                            {provider.requiresKey ? t('gm.providers.keyMissing') : t('gm.providers.noKeyNeeded')}
                          </Badge>
                        )}
                      </td>
                      <td className="text-xs">
                        <span dir="ltr">{provider.lastTest.status ?? '—'}</span>
                        <p className="text-slate-400">{ago(provider.lastTest.testedAt, locale)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!sections.providers.data.secretStorage.available ? (
                <p className="mt-2 text-xs text-amber-700">
                  {t('gm.providers.secretStorage')}: {sections.providers.data.secretStorage.reason ?? '—'}
                </p>
              ) : null}
            </div>
          ) : null}
        </SectionShell>

        {/* Audit */}
        <SectionShell title={t('gm.section.audit')} section={sections?.audit ?? emptySection()}>
          <div className="mb-2 flex items-center gap-2">
            <input
              className="input-base"
              placeholder={t('gm.audit.actionPrefix')}
              value={auditFilter}
              onChange={(event) => setAuditFilter(event.target.value.toUpperCase())}
              dir="ltr"
            />
            <button type="button" className="btn-secondary" onClick={() => void loadAudit()}>
              {t('gm.audit.filter')}
            </button>
          </div>
          {auditError && !audit ? (
            <ErrorState message={auditError} onRetry={loadAudit} />
          ) : !audit ? (
            <Spinner />
          ) : audit.length === 0 ? (
            <EmptyState title={t('common.noData')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('gm.col.when')}</th>
                    <th>{t('gm.col.action')}</th>
                    <th>{t('gm.col.entity')}</th>
                    <th>{t('gm.col.actor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((row) => (
                    <tr key={row.id}>
                      <td className="text-xs">{ago(row.createdAt, locale)}</td>
                      <td className="text-xs" dir="ltr">{row.action}</td>
                      <td className="text-xs" dir="ltr">{row.entityType}{row.entityId ? `:${row.entityId.slice(0, 8)}` : ''}</td>
                      <td className="text-xs" dir="ltr">{row.actorId ?? 'SYSTEM'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[10px] text-slate-500">
            <Link className="underline" to="/admin/ai">{t('gm.audit.openAiDesk')}</Link>
          </p>
        </SectionShell>
      </div>
    </AppLayout>
  );
}

/** Placeholder used only while the overview is still loading: it claims nothing. */
function emptySection(): GmSection<unknown> {
  return { state: 'LOADING', source: '—', generatedAt: new Date().toISOString(), data: null, error: null };
}

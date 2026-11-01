import { useEffect, useState } from 'react';
import { api, apiCall, apiErrorMessage, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  AgentActivityRow,
  AgentMemoryRow,
  AgentPerformanceRow,
  MonitorAlert,
  SupervisorReportRow,
  TeamHealth,
} from '@/lib/types';

type Tab = 'overview' | 'performance' | 'activity' | 'memory' | 'supervisor';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo'> = {
  succeeded: 'green',
  approved: 'green',
  running: 'teal',
  queued: 'amber',
  awaiting_approval: 'amber',
  failed: 'red',
  blocked: 'red',
  rejected: 'red',
  refused: 'slate',
};

function statusColor(s: string): 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo' {
  return STATUS_COLOR[s] ?? 'slate';
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * AI-06.2 — Agent operations desk (`/admin/agent-ops`), ADMIN + SUPER_ADMIN.
 *
 * A read-only monitor over `agent-monitor.ts` (health, per-agent performance,
 * activity) and the supervisor report. Every figure is what the server returns
 * for the caller's own scope — the client never sends a scope, and a non-platform
 * caller can only ever see its own aggregates. Nothing here writes, mutates a
 * task, or moves money: the budget block is informational only.
 *
 * The scheduler's telemetry (`health.system`) is rendered in its own section and
 * never merged into the human-activity counts, mirroring the server contract.
 */
export function AdminAgentOpsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('overview');
  const [health, setHealth] = useState<TeamHealth | null>(null);
  const [perf, setPerf] = useState<AgentPerformanceRow[]>([]);
  const [activity, setActivity] = useState<AgentActivityRow[]>([]);
  const [supervisor, setSupervisor] = useState<SupervisorReportRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const [h, p, a, s] = await Promise.all([
      apiCall(() => api.adminAgentOpsHealth()),
      apiCall(() => api.adminAgentOpsPerformance()),
      apiCall(() => api.adminAgentOpsActivity({ limit: 50 })),
      apiCall(() => api.adminAiSupervisorReport()),
    ]);
    setHealth(h.data);
    setPerf(p.data?.items ?? []);
    setActivity(a.data?.items ?? []);
    setSupervisor(s.data);
    setError(h.error ?? p.error ?? a.error ?? s.error);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('adminAgentOps.tab.overview') },
    { id: 'performance', label: t('adminAgentOps.tab.performance') },
    { id: 'activity', label: t('adminAgentOps.tab.activity') },
    { id: 'memory', label: t('adminAgentOps.tab.memory') },
    { id: 'supervisor', label: t('adminAgentOps.tab.supervisor') },
  ];

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminAgentOps.title')}
        subtitle={t('adminAgentOps.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-agent-ops-refresh"
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('adminAgentOps.refresh')}
          </button>
        )}
      />

      {health && (
        <p className="mb-3 text-xs text-slate-400" data-testid="admin-agent-ops-scope">
          {health.scope === 'platform' ? t('adminAgentOps.scope.platform') : t('adminAgentOps.scope.owner')}
          {' · '}
          {t('adminAgentOps.generatedAt')}: {formatDate(health.generatedAt)}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-1 rounded-md border border-slate-200 p-0.5" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            data-testid={`admin-agent-ops-tab-${x.id}`}
            onClick={() => setTab(x.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${tab === x.id ? 'bg-wasit-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          {tab === 'overview' && health && <Overview health={health} />}
          {tab === 'performance' && <Performance rows={perf} />}
          {tab === 'activity' && <Activity rows={activity} />}
          {tab === 'memory' && <Memory />}
          {tab === 'supervisor' && supervisor && <Supervisor report={supervisor} />}
        </>
      )}
    </AppLayout>
  );
}

function Overview({ health }: { health: TeamHealth }) {
  const { t } = useI18n();
  const agentKpis: [string, number][] = [
    [t('adminAgentOps.agents.total'), health.agents.total],
    [t('adminAgentOps.agents.active'), health.agents.active],
    [t('adminAgentOps.agents.paused'), health.agents.paused],
    [t('adminAgentOps.agents.disabled'), health.agents.disabled],
    [t('adminAgentOps.agents.unhealthy'), health.agents.unhealthy],
  ];
  const taskKpis: [string, number][] = [
    [t('adminAgentOps.tasks.queued'), health.tasks.queued],
    [t('adminAgentOps.tasks.running'), health.tasks.running],
    [t('adminAgentOps.tasks.awaitingApproval'), health.tasks.awaitingApproval],
    [t('adminAgentOps.tasks.overdue'), health.tasks.overdue],
  ];
  const windowKpis: [string, number][] = [
    [t('adminAgentOps.tasks.succeeded24h'), health.tasks.succeeded24h],
    [t('adminAgentOps.tasks.failed24h'), health.tasks.failed24h],
    [t('adminAgentOps.tasks.refused24h'), health.tasks.refused24h],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {agentKpis.map(([label, value], i) => (
          <Card key={label} testId={`admin-agent-ops-agent-${i}`}>
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
          </Card>
        ))}
      </div>

      <Card testId="admin-agent-ops-live-tasks">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.tasks.title')}</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          {taskKpis.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs font-semibold text-slate-600">{t('adminAgentOps.window24h')}</p>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          {windowKpis.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card testId="admin-agent-ops-budget">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.budget.title')}</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-slate-500">{t('adminAgentOps.budget.spentUsd24h')}</p>
            <p className="mt-1 text-xl font-bold text-slate-900" dir="ltr">{health.budget.spentUsd24h} USD</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">{t('adminAgentOps.budget.runsOverCap24h')}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{health.budget.runsOverCap24h}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">{t('adminAgentOps.budget.readonlyHint')}</p>
      </Card>

      {health.system && (
        <Card testId="admin-agent-ops-system">
          <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.system.title')}</h3>
          <p className="mt-1 text-xs text-slate-500">{t('adminAgentOps.system.hint')}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-4">
            {([
              [t('adminAgentOps.tasks.succeeded24h'), health.system.succeeded24h],
              [t('adminAgentOps.tasks.failed24h'), health.system.failed24h],
              [t('adminAgentOps.tasks.refused24h'), health.system.refused24h],
              [t('adminAgentOps.tasks.overdue'), health.system.overdue],
            ] as [string, number][]).map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-slate-500">{label}</p>
                <p className="mt-1 text-lg font-bold text-slate-900" data-testid={`admin-agent-ops-system-${label}`}>{value}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card testId="admin-agent-ops-alerts">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.alerts.title')}</h3>
        {health.alerts.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.alerts.empty')}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {health.alerts.map((a: MonitorAlert, i) => (
              <li key={`${a.kind}-${a.agentKey ?? ''}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge color={a.severity === 'critical' ? 'red' : 'amber'}>
                  {a.severity === 'critical' ? t('adminAgentOps.severity.critical') : t('adminAgentOps.severity.warning')}
                </Badge>
                <span className="text-slate-600" dir="ltr">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card testId="admin-agent-ops-attention">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.attention.title')}</h3>
        {health.needsHumanAttention.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.attention.empty')}</p>
        ) : (
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>{t('adminAgentOps.perf.agent')}</th>
                <th>{t('adminAgentOps.attention.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {health.needsHumanAttention.map((n, i) => (
                <tr key={`${n.agentKey}-${i}`} data-testid={`admin-agent-ops-attention-${n.agentKey}-${i}`}>
                  <td className="text-xs" dir="ltr">{n.agentKey}</td>
                  <td className="text-xs">{n.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Performance({ rows }: { rows: AgentPerformanceRow[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return <EmptyState title={t('adminAgentOps.perf.empty')} />;
  return (
    <Card className="overflow-x-auto" testId="admin-agent-ops-performance">
      <table className="table-base">
        <thead>
          <tr>
            <th>{t('adminAgentOps.perf.agent')}</th>
            <th>{t('adminAgentOps.perf.total')}</th>
            <th>{t('adminAgentOps.perf.succeeded')}</th>
            <th>{t('adminAgentOps.perf.failed')}</th>
            <th>{t('adminAgentOps.perf.blocked')}</th>
            <th>{t('adminAgentOps.perf.refused')}</th>
            <th>{t('adminAgentOps.perf.successRate')}</th>
            <th>{t('adminAgentOps.perf.failureRate')}</th>
            <th>{t('adminAgentOps.perf.latency')}</th>
            <th>{t('adminAgentOps.perf.awaitingApproval')}</th>
            <th>{t('adminAgentOps.perf.running')}</th>
            <th>{t('adminAgentOps.perf.queued')}</th>
            <th>{t('adminAgentOps.perf.overdue')}</th>
            <th>{t('adminAgentOps.perf.cost')}</th>
            <th>{t('adminAgentOps.perf.tokens')}</th>
            <th>{t('adminAgentOps.perf.providerFailures')}</th>
            <th>{t('adminAgentOps.perf.localRuns')}</th>
            <th>{t('adminAgentOps.perf.toolCalls')}</th>
            <th>{t('adminAgentOps.perf.toolFailures')}</th>
            <th>{t('adminAgentOps.perf.lastActivity')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agentKey} data-testid={`admin-agent-ops-perf-${r.agentKey}`}>
              <td className="text-xs font-medium" dir="ltr">{r.agentKey}</td>
              <td className="text-xs">{r.total}</td>
              <td className="text-xs">{r.succeeded}</td>
              <td className="text-xs">{r.failed}</td>
              <td className="text-xs">{r.blocked}</td>
              <td className="text-xs">{r.refused}</td>
              <td className="text-xs">{pct(r.successRate)}</td>
              <td className="text-xs">{pct(r.failureRate)}</td>
              <td className="text-xs" dir="ltr">{r.avgLatencyMs} ms</td>
              <td className="text-xs">{r.awaitingApproval}</td>
              <td className="text-xs">{r.running}</td>
              <td className="text-xs">{r.queued}</td>
              <td className="text-xs">{r.overdue}</td>
              <td className="text-xs" dir="ltr">{r.costUsd} USD</td>
              <td className="text-xs" dir="ltr">{r.tokensInput} / {r.tokensOutput}</td>
              <td className="text-xs">{r.providerFailures}</td>
              <td className="text-xs">{r.localRuns}</td>
              <td className="text-xs">{r.toolCalls}</td>
              <td className="text-xs">{r.toolFailures}</td>
              <td className="text-xs">{r.lastActivityAt ? formatDate(r.lastActivityAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Activity({ rows }: { rows: AgentActivityRow[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return <EmptyState title={t('adminAgentOps.activity.empty')} />;
  return (
    <Card className="overflow-x-auto" testId="admin-agent-ops-activity">
      <table className="table-base">
        <thead>
          <tr>
            <th>{t('adminAgentOps.activity.agent')}</th>
            <th>{t('adminAgentOps.activity.taskType')}</th>
            <th>{t('adminAgentOps.activity.status')}</th>
            <th>{t('adminAgentOps.activity.requestedBy')}</th>
            <th>{t('adminAgentOps.activity.triggeredBy')}</th>
            <th>{t('adminAgentOps.activity.latency')}</th>
            <th>{t('adminAgentOps.activity.cost')}</th>
            <th>{t('adminAgentOps.activity.createdAt')}</th>
            <th>{t('adminAgentOps.activity.completedAt')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`admin-agent-ops-activity-${r.id}`}>
              <td className="text-xs font-medium" dir="ltr">{r.agentKey}</td>
              <td className="text-xs" dir="ltr">{r.taskType ?? '—'}</td>
              <td><Badge color={statusColor(r.status)}>{r.status}</Badge></td>
              <td className="text-xs" dir="ltr">{r.requestedBy}</td>
              <td className="text-xs" dir="ltr">{r.triggeredBy}</td>
              <td className="text-xs" dir="ltr">{r.latencyMs === null ? '—' : `${r.latencyMs} ms`}</td>
              <td className="text-xs" dir="ltr">{r.cost} USD</td>
              <td className="text-xs">{formatDate(r.createdAt)}</td>
              <td className="text-xs">{r.completedAt ? formatDate(r.completedAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * G7 — Operational memory (read-only).
 *
 * Fetches the caller's own memory notes from the server, which resolves the
 * scope from the session: the client never sends a scope and the filters only
 * narrow the caller's own notes. Every value is rendered as plain text (never
 * `dangerouslySetInnerHTML`), so a note's content cannot become markup. The view
 * is strictly read-only — there is no edit, delete or re-write control.
 */
function Memory() {
  const { t } = useI18n();
  const [items, setItems] = useState<AgentMemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [agentKey, setAgentKey] = useState('');
  const [taskId, setTaskId] = useState('');
  const [applied, setApplied] = useState<{ agentKey?: string; taskId?: string }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (filters: { agentKey?: string; taskId?: string } = {}) => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.adminAgentOpsMemory({ ...filters, limit: 50 }));
    if (res.error) {
      setError(res.error);
      setItems([]);
      setTotal(0);
    } else {
      setItems(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const onFilter = (e: React.FormEvent) => {
    e.preventDefault();
    const next: { agentKey?: string; taskId?: string } = {};
    if (agentKey.trim()) next.agentKey = agentKey.trim();
    if (taskId.trim()) next.taskId = taskId.trim();
    setApplied(next);
    void load(next);
  };

  const onClear = () => {
    setAgentKey('');
    setTaskId('');
    setApplied({});
    void load({});
  };

  return (
    <div className="space-y-4" data-testid="admin-agent-ops-memory">
      <Card testId="admin-agent-ops-memory-filters">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.memory.title')}</h3>
        <p className="mt-1 text-xs text-slate-500">{t('adminAgentOps.memory.hint')}</p>
        <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={onFilter}>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">{t('adminAgentOps.memory.filterAgent')}</span>
            <input
              type="text"
              dir="ltr"
              value={agentKey}
              data-testid="admin-agent-ops-memory-agent-input"
              onChange={(e) => setAgentKey(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              placeholder="support-agent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">{t('adminAgentOps.memory.filterTask')}</span>
            <input
              type="text"
              dir="ltr"
              value={taskId}
              data-testid="admin-agent-ops-memory-task-input"
              onChange={(e) => setTaskId(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="submit"
            data-testid="admin-agent-ops-memory-apply"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('adminAgentOps.memory.apply')}
          </button>
          <button
            type="button"
            data-testid="admin-agent-ops-memory-clear"
            onClick={onClear}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('adminAgentOps.memory.clear')}
          </button>
        </form>
        <p className="mt-3 text-xs text-slate-400" data-testid="admin-agent-ops-memory-total">
          {t('adminAgentOps.memory.total')}: {total}
        </p>
      </Card>

      {loading ? <Spinner /> : error ? (
        <ErrorState message={error} onRetry={() => void load(applied)} />
      ) : items.length === 0 ? (
        <EmptyState title={t('adminAgentOps.memory.empty')} />
      ) : (
        <Card className="overflow-x-auto" testId="admin-agent-ops-memory-table">
          <table className="table-base">
            <thead>
              <tr>
                <th>{t('adminAgentOps.memory.agent')}</th>
                <th>{t('adminAgentOps.memory.kind')}</th>
                <th>{t('adminAgentOps.memory.task')}</th>
                <th>{t('adminAgentOps.memory.source')}</th>
                <th>{t('adminAgentOps.memory.outcome')}</th>
                <th>{t('adminAgentOps.memory.tags')}</th>
                <th>{t('adminAgentOps.memory.latency')}</th>
                <th>{t('adminAgentOps.memory.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} data-testid={`admin-agent-ops-memory-${r.id}`}>
                  <td className="text-xs font-medium" dir="ltr">{r.agentKey}</td>
                  <td className="text-xs" dir="ltr">{r.kind}</td>
                  <td className="text-xs" dir="ltr">{r.taskId ?? '—'}</td>
                  <td className="text-xs" dir="ltr">{r.source ?? '—'}</td>
                  <td className="text-xs" dir="ltr">{r.outcome ?? '—'}</td>
                  <td className="text-xs" dir="ltr">{r.tags.length ? r.tags.join(', ') : '—'}</td>
                  <td className="text-xs" dir="ltr">{r.latencyMs === null ? '—' : `${r.latencyMs} ms`}</td>
                  <td className="text-xs">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Supervisor({ report }: { report: SupervisorReportRow }) {
  const { t } = useI18n();
  const flags: [string, boolean][] = [
    [t('adminAgentOps.sup.loop'), report.loopDetected],
    [t('adminAgentOps.sup.runaway'), report.runawayDetected],
    [t('adminAgentOps.sup.failureRateFlagged'), report.failureRateFlagged],
  ];
  const counts: [string, number][] = [
    [t('adminAgentOps.sup.total'), report.total],
    [t('adminAgentOps.sup.stuck'), report.stuckTasks],
    [t('adminAgentOps.sup.expiredQueued'), report.expiredQueued],
  ];
  return (
    <div className="space-y-4">
      <Card testId="admin-agent-ops-sup-summary">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.sup.title')}</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {counts.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {flags.map(([label, on]) => (
            <Badge key={label} color={on ? 'red' : 'green'}>
              {label}: {on ? t('adminAgentOps.yes') : t('adminAgentOps.no')}
            </Badge>
          ))}
        </div>
      </Card>

      <Card testId="admin-agent-ops-sup-halted">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.sup.halted')}</h3>
        {report.haltedAgents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.sup.halted.empty')}</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.haltedAgents.map((a) => (
              <li key={a.key} className="flex items-center gap-2 text-xs">
                <span dir="ltr">{a.key}</span>
                <Badge color={a.status === 'PAUSED' ? 'amber' : 'red'}>{a.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-x-auto" testId="admin-agent-ops-sup-alerts">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.sup.alerts')}</h3>
        {report.alerts.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.sup.alerts.empty')}</p>
        ) : (
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>{t('adminAgentOps.sup.agentKey')}</th>
                <th>{t('adminAgentOps.sup.taskId')}</th>
                <th>{t('adminAgentOps.sup.severity')}</th>
                <th>{t('adminAgentOps.sup.reason')}</th>
                <th>{t('adminAgentOps.sup.action')}</th>
              </tr>
            </thead>
            <tbody>
              {report.alerts.map((a, i) => (
                <tr key={`${a.agentKey}-${a.taskId ?? ''}-${i}`}>
                  <td className="text-xs" dir="ltr">{a.agentKey}</td>
                  <td className="text-xs" dir="ltr">{a.taskId ?? '—'}</td>
                  <td><Badge color={a.severity === 'CRITICAL' ? 'red' : 'amber'}>{a.severity}</Badge></td>
                  <td className="text-xs">{a.reason}</td>
                  <td className="text-xs" dir="ltr">{a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-x-auto" testId="admin-agent-ops-sup-contained">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.sup.contained')}</h3>
        {report.contained.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.sup.contained.empty')}</p>
        ) : (
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>{t('adminAgentOps.sup.taskId')}</th>
                <th>{t('adminAgentOps.sup.agentKey')}</th>
                <th>{t('adminAgentOps.activity.taskType')}</th>
                <th>{t('adminAgentOps.sup.status')}</th>
                <th>{t('adminAgentOps.sup.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {report.contained.map((c) => (
                <tr key={c.id} data-testid={`admin-agent-ops-contained-${c.id}`}>
                  <td className="text-xs" dir="ltr">{c.id}</td>
                  <td className="text-xs" dir="ltr">{c.agentKey}</td>
                  <td className="text-xs" dir="ltr">{c.taskType ?? '—'}</td>
                  <td><Badge color={statusColor(c.status)}>{c.status}</Badge></td>
                  <td className="text-xs">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-x-auto" testId="admin-agent-ops-sup-interventions">
        <h3 className="text-sm font-bold text-slate-800">{t('adminAgentOps.sup.interventions')}</h3>
        {report.interventions.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminAgentOps.sup.interventions.empty')}</p>
        ) : (
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>{t('adminAgentOps.sup.taskId')}</th>
                <th>{t('adminAgentOps.sup.agentKey')}</th>
                <th>{t('adminAgentOps.sup.reason')}</th>
                <th>{t('adminAgentOps.sup.action')}</th>
              </tr>
            </thead>
            <tbody>
              {report.interventions.map((iv, i) => (
                <tr key={`${iv.taskId}-${i}`}>
                  <td className="text-xs" dir="ltr">{iv.taskId}</td>
                  <td className="text-xs" dir="ltr">{iv.agentKey}</td>
                  <td className="text-xs">{iv.reason}</td>
                  <td className="text-xs" dir="ltr">{iv.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

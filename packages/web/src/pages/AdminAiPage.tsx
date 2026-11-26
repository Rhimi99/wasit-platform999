import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { AiProvidersPanel } from '@/components/AiProvidersPanel';
import { AiSpendPanel } from '@/components/AiSpendPanel';
import { CopilotPanel } from '@/components/CopilotPanel';
import type {
  AgentRegistryRow,
  AgentLayerCounts,
  AgentTaskRow,
  AiAdminBudget,
  AiAdminModel,
  AiAdminRequestRow,
  AiAdminUsage,
  AiKillSwitchState,
  CompanyMetrics,
  AgentHealth,
} from '@/lib/types';

type Tab =
  | 'overview'
  | 'copilot'
  | 'requests'
  | 'models'
  | 'providers'
  | 'spend'
  | 'budgets'
  | 'agents'
  | 'tasks';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo'> = {
  SUCCESS: 'green',
  succeeded: 'green',
  approved: 'green',
  running: 'teal',
  queued: 'amber',
  awaiting_approval: 'amber',
  failed: 'red',
  rejected: 'red',
};

function statusColor(s: string): 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo' {
  return STATUS_COLOR[s] ?? 'slate';
}

const HEALTH_COLOR: Record<AgentHealth, 'green' | 'amber' | 'red' | 'slate' | 'teal'> = {
  healthy: 'green',
  degraded: 'amber',
  failing: 'red',
  idle: 'slate',
  no_data: 'slate',
};

/** Formats a duration in ms for a non-technical reader. */
function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function AdminAiPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  // Lifting the global stop is reserved to SUPER_ADMIN on the server; the button
  // follows the same rule so an ADMIN is not offered an action it cannot take.
  const isSuperAdmin = (user?.roles ?? []).includes('SUPER_ADMIN');
  const [tab, setTab] = useState<Tab>('overview');
  const [usage, setUsage] = useState<AiAdminUsage | null>(null);
  const [requests, setRequests] = useState<AiAdminRequestRow[]>([]);
  const [models, setModels] = useState<AiAdminModel[]>([]);
  const [budgets, setBudgets] = useState<AiAdminBudget[]>([]);
  const [agents, setAgents] = useState<AgentRegistryRow[]>([]);
  const [agentCounts, setAgentCounts] = useState<AgentLayerCounts | null>(null);
  const [copilot, setCopilot] = useState<AgentRegistryRow | null>(null);
  const [tasks, setTasks] = useState<AgentTaskRow[]>([]);
  // A3 — AI Company metrics (read-only, from the trusted backend).
  const [companyMetrics, setCompanyMetrics] = useState<CompanyMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Central AI Kill Switch state (A1) — one central control for AI execution.
  const [killSwitch, setKillSwitch] = useState<AiKillSwitchState | null>(null);

  // Model catalogue form — POST /api/admin/ai/models is an upsert keyed by `key`.
  const [modelForm, setModelForm] = useState({
    key: '', displayName: '', provider: '', contextWindow: 0, maxOutputTokens: 0,
    inputPer1k: '0', outputPer1k: '0', currencyCode: 'USD', isActive: true,
  });
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);

  // Budget form — POST /api/admin/ai/budgets targets exactly one of userId|roleTarget.
  const [budgetForm, setBudgetForm] = useState({
    targetKind: 'ROLE' as 'ROLE' | 'USER', roleTarget: 'MERCHANT', userId: '',
    period: 'MONTHLY' as 'DAILY' | 'MONTHLY', maxRequests: '', maxCost: '', currencyCode: 'USD', isActive: true,
  });

  const load = async () => {
    setError(null);
    const [usageRes, reqRes, modelRes, budgetRes, agentRes, taskRes, killRes, metricsRes] = await Promise.all([
      apiCall(() => api.adminAiUsage()),
      apiCall(() => api.adminAiRequests()),
      apiCall(() => api.adminAiModels()),
      apiCall(() => api.adminAiBudgets()),
      apiCall(() => api.adminAiAgents()),
      apiCall(() => api.adminAiTasks()),
      apiCall(() => api.adminAiExecutionSwitch()),
      apiCall(() => api.adminAiCompanyMetrics()),
    ]);
    setUsage(usageRes.data ?? null);
    setRequests(reqRes.data?.items ?? []);
    setModels(modelRes.data?.items ?? []);
    setBudgets(budgetRes.data?.items ?? []);
    setAgents(agentRes.data?.items ?? []);
    setAgentCounts(agentRes.data?.counts ?? null);
    setCopilot(agentRes.data?.copilot ?? null);
    setTasks(taskRes.data?.items ?? []);
    setKillSwitch(killRes.data ?? null);
    setCompanyMetrics(metricsRes.data ?? null);
    setError(usageRes.error ?? reqRes.error ?? modelRes.error ?? budgetRes.error ?? agentRes.error ?? taskRes.error);
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

  const decide = (task: AgentTaskRow, decision: 'APPROVE' | 'REJECT') =>
    run(
      `task:${task.id}`,
      () => api.decideAgentTask(task.id, decision, undefined),
      decision === 'APPROVE' ? 'adminAi.taskApproved' : 'adminAi.taskRejected',
    );

  // Central AI Kill Switch (A1 / FLEET-01). Stopping is an emergency action, so
  // it asks for confirmation; resuming is safe and immediate — but lifting the
  // GLOBAL stop is a SUPER_ADMIN act, so an ADMIN is not offered it. The server
  // enforces the same rules and audits every change and every refusal.
  const toggleKillSwitch = () => {
    if (!killSwitch) return;
    const resume = killSwitch.globalStopped;
    if (!resume && !window.confirm(t('adminAi.killSwitch.confirmDisable'))) return;
    if (resume && !isSuperAdmin) return;
    return run(
      'kill-switch',
      () => api.adminSetGlobalAiExecutionSwitch(!resume),
      resume ? 'adminAi.killSwitch.enabledNotice' : 'adminAi.killSwitch.disabledNotice',
    );
  };

  // One agent at a time: the stop belongs to that agent only and never touches
  // the others, which is what the per-agent scope is for.
  const globalResume = killSwitch?.globalStopped ?? false;
  const globalResumeBlocked = globalResume && !isSuperAdmin;

  const toggleAgentSwitch = (agentKey: string) => {
    const stopped = (killSwitch?.stoppedAgents ?? []).includes(agentKey);
    if (!stopped && !window.confirm(t('adminAi.killSwitch.agentConfirmStop'))) return;
    return run(
      `agent-switch:${agentKey}`,
      () => api.adminSetAgentAiExecutionSwitch(agentKey, !stopped),
      stopped ? 'adminAi.killSwitch.agentResumedNotice' : 'adminAi.killSwitch.agentStoppedNotice',
    );
  };

  const editModel = (m: AiAdminModel) => {
    setEditingModelKey(m.key);
    setModelForm({
      key: m.key,
      displayName: m.displayName,
      provider: m.provider,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      inputPer1k: m.inputPer1k,
      outputPer1k: m.outputPer1k,
      currencyCode: m.currencyCode,
      isActive: m.isActive,
    });
  };

  const resetModelForm = () => {
    setEditingModelKey(null);
    setModelForm({
      key: '', displayName: '', provider: '', contextWindow: 0, maxOutputTokens: 0,
      inputPer1k: '0', outputPer1k: '0', currencyCode: 'USD', isActive: true,
    });
  };

  const submitModel = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = modelForm.key.trim();
    const displayName = modelForm.displayName.trim();
    const provider = modelForm.provider.trim();
    if (!key || !displayName || !provider) return;

    setBusy('model:save');
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminUpsertAiModel({
      key,
      displayName,
      provider,
      contextWindow: Number(modelForm.contextWindow) || 0,
      maxOutputTokens: Number(modelForm.maxOutputTokens) || 0,
      inputPer1k: modelForm.inputPer1k || '0',
      outputPer1k: modelForm.outputPer1k || '0',
      currencyCode: modelForm.currencyCode,
      isActive: modelForm.isActive,
    }));
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t('adminAi.modelSaved')} · ${key}`);
    resetModelForm();
    await load();
  };

  const toggleModel = (m: AiAdminModel) =>
    run(
      `model:${m.key}`,
      () => api.adminUpsertAiModel({
        key: m.key,
        displayName: m.displayName,
        provider: m.provider,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        inputPer1k: m.inputPer1k,
        outputPer1k: m.outputPer1k,
        currencyCode: m.currencyCode,
        isActive: !m.isActive,
      }),
      m.isActive ? 'adminAi.modelDeactivated' : 'adminAi.modelActivated',
    );

  const submitBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    const byUser = budgetForm.targetKind === 'USER';
    const userId = budgetForm.userId.trim();
    const roleTarget = budgetForm.roleTarget.trim();
    if (byUser ? !userId : !roleTarget) return;

    setBusy('budget:save');
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminUpsertAiBudget({
      userId: byUser ? userId : null,
      roleTarget: byUser ? null : roleTarget,
      period: budgetForm.period,
      maxRequests: budgetForm.maxRequests.trim() ? Number(budgetForm.maxRequests) : null,
      maxCost: budgetForm.maxCost.trim() ? budgetForm.maxCost.trim() : null,
      currencyCode: budgetForm.currencyCode,
      isActive: budgetForm.isActive,
    }));
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    setNotice(`${t('adminAi.budgetSaved')} · ${byUser ? userId : roleTarget}`);
    await load();
  };

  const toggleBudget = (b: AiAdminBudget) =>
    run(
      `budget:${b.id}`,
      () => api.adminUpsertAiBudget({
        userId: b.userId,
        roleTarget: b.roleTarget,
        period: b.period,
        maxRequests: b.maxRequests,
        maxCost: b.maxCost,
        currencyCode: b.currencyCode,
        isActive: !b.isActive,
      }),
      b.isActive ? 'adminAi.budgetDeactivated' : 'adminAi.budgetActivated',
    );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('adminAi.tab.overview') },
    { id: 'copilot', label: t('adminAi.tab.copilot') },
    { id: 'requests', label: t('adminAi.tab.requests') },
    { id: 'models', label: t('adminAi.tab.models') },
    { id: 'providers', label: t('adminAi.tab.providers') },
    { id: 'spend', label: t('adminAi.tab.spend') },
    { id: 'budgets', label: t('adminAi.tab.budgets') },
    { id: 'agents', label: t('adminAi.tab.agents') },
    { id: 'tasks', label: t('adminAi.tab.tasks') },
  ];

  const pendingApproval = tasks.filter((x) => x.status === 'awaiting_approval');

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminAi.title')}
        subtitle={t('adminAi.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-ai-refresh"
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
            data-testid={`admin-ai-tab-${x.id}`}
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
          {tab === 'overview' && (
            usage ? (
              <div className="space-y-4">
                {killSwitch && (
                  <Card
                    testId="admin-ai-kill-switch"
                    className={killSwitch.enabled ? 'border-green-200 bg-green-50' : 'border-red-300 bg-red-50'}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{t('adminAi.killSwitch.title')}</p>
                        <p className="mt-1 text-xs text-slate-600">{t('adminAi.killSwitch.hint')}</p>
                        <p className="mt-2 text-xs">
                          <span
                            data-testid="admin-ai-kill-switch-state"
                            className={`rounded px-2 py-0.5 font-medium ${killSwitch.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                          >
                            {killSwitch.enabled ? t('adminAi.killSwitch.stateEnabled') : t('adminAi.killSwitch.stateDisabled')}
                          </span>
                          <span className="ms-2 text-slate-500">
                            {killSwitch.source === 'database'
                              ? t('adminAi.killSwitch.sourceDatabase')
                              : killSwitch.source === 'env'
                                ? t('adminAi.killSwitch.sourceEnv')
                                : t('adminAi.killSwitch.sourceUnavailable')}
                          </span>
                        </p>
                        {killSwitch.failClosed && (
                          <p data-testid="admin-ai-kill-switch-failclosed" className="mt-2 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700">
                            {t('adminAi.killSwitch.failClosed')}
                          </p>
                        )}
                        {killSwitch.global?.reason && (
                          <p className="mt-2 text-xs text-slate-600">
                            {t('adminAi.killSwitch.reasonLabel')}: {killSwitch.global.reason}
                          </p>
                        )}
                        {killSwitch.stoppedAgents.length > 0 && (
                          <p className="mt-1 text-xs text-slate-600">
                            {t('adminAi.killSwitch.stoppedAgentsLabel')}: {killSwitch.stoppedAgents.join(', ')}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <button
                          type="button"
                          data-testid="admin-ai-kill-switch-toggle"
                          disabled={busy !== null || globalResumeBlocked}
                          title={globalResumeBlocked ? t('adminAi.killSwitch.resumeNeedsSuperAdmin') : undefined}
                          onClick={() => void toggleKillSwitch()}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${globalResume ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
                        >
                          {globalResume ? t('adminAi.killSwitch.enable') : t('adminAi.killSwitch.disable')}
                        </button>
                        {globalResumeBlocked && (
                          <p data-testid="admin-ai-kill-switch-resume-locked" className="max-w-[16rem] text-end text-[11px] text-slate-500">
                            {t('adminAi.killSwitch.resumeNeedsSuperAdmin')}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  <Card testId="admin-ai-kpi-requests">
                    <p className="text-xs text-slate-500">{t('adminAi.totals.requests')}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{usage.totals.requests}</p>
                  </Card>
                  <Card testId="admin-ai-kpi-users">
                    <p className="text-xs text-slate-500">{t('adminAi.totals.users')}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{usage.totals.distinctUsers}</p>
                  </Card>
                  <Card testId="admin-ai-kpi-tokens-in">
                    <p className="text-xs text-slate-500">{t('adminAi.totals.tokensIn')}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{usage.totals.tokensInput}</p>
                  </Card>
                  <Card testId="admin-ai-kpi-tokens-out">
                    <p className="text-xs text-slate-500">{t('adminAi.totals.tokensOut')}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{usage.totals.tokensOutput}</p>
                  </Card>
                  <Card testId="admin-ai-kpi-cost">
                    <p className="text-xs text-slate-500">{t('adminAi.totals.cost')}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{usage.totals.cost} USD</p>
                  </Card>
                </div>
                <Card testId="admin-ai-window">
                  <p className="text-xs text-slate-500">{t('adminAi.window')}</p>
                  <p className="mt-1 text-sm text-slate-700" dir="ltr">
                    {formatDate(usage.window.start)} → {formatDate(usage.window.end)}
                  </p>
                </Card>

                {/* A3 — AI Company health: real execution/performance/cost/outcome metrics. */}
                {companyMetrics && (
                  <div className="space-y-4" data-testid="admin-ai-company">
                    <Card className="border-wasit-200 bg-wasit-50/40">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{t('adminAi.company.title')}</p>
                          <p className="mt-1 text-xs text-slate-600">{t('adminAi.company.hint')}</p>
                        </div>
                        <p className="text-xs text-slate-500">
                          {t('adminAi.company.generatedAt')}: <span dir="ltr">{formatDate(companyMetrics.generatedAt)}</span>
                        </p>
                      </div>
                    </Card>

                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Card testId="admin-ai-company-runs">
                        <p className="text-xs text-slate-500">{t('adminAi.company.kpi.runs')}</p>
                        <p className="mt-1 text-2xl font-bold text-slate-900">{companyMetrics.overall.execution.totalRuns}</p>
                      </Card>
                      <Card testId="admin-ai-company-completion">
                        <p className="text-xs text-slate-500">{t('adminAi.company.kpi.completionRate')}</p>
                        <p className="mt-1 text-2xl font-bold text-slate-900">{formatPercent(companyMetrics.overall.execution.successRate)}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {t('adminAi.company.kpi.failed')}: {companyMetrics.overall.execution.failed} · {t('adminAi.company.kpi.open')}: {companyMetrics.overall.execution.pending + companyMetrics.overall.execution.running}
                        </p>
                      </Card>
                      <Card testId="admin-ai-company-duration">
                        <p className="text-xs text-slate-500">{t('adminAi.company.kpi.avgDuration')}</p>
                        <p className="mt-1 text-2xl font-bold text-slate-900" dir="ltr">{formatDuration(companyMetrics.overall.performance.avgDurationMs)}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {t('adminAi.company.kpi.medianDuration')}: <span dir="ltr">{formatDuration(companyMetrics.overall.performance.medianDurationMs)}</span> · {t('adminAi.company.kpi.slow')}: {companyMetrics.overall.performance.slowRuns}
                        </p>
                      </Card>
                      <Card testId="admin-ai-company-cost">
                        <p className="text-xs text-slate-500">{t('adminAi.company.kpi.cost')}</p>
                        {companyMetrics.overall.cost.available ? (
                          <>
                            <p className="mt-1 text-2xl font-bold text-slate-900" dir="ltr">
                              {companyMetrics.overall.cost.actualProviderCostUsd} {companyMetrics.overall.cost.currencyCode}
                            </p>
                            <p className="mt-1 text-xs text-slate-500" dir="ltr">
                              {t('adminAi.company.kpi.tokens')}: {companyMetrics.overall.cost.tokensInput} / {companyMetrics.overall.cost.tokensOutput}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-sm text-slate-500">{t('adminAi.company.kpi.costUnavailable')}</p>
                        )}
                      </Card>
                    </div>

                    <Card testId="admin-ai-company-attention">
                      <p className="text-sm font-semibold text-slate-900">{t('adminAi.company.attention.title')}</p>
                      {companyMetrics.attention.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">{t('adminAi.company.attention.empty')}</p>
                      ) : (
                        <ul className="mt-2 space-y-1">
                          {companyMetrics.attention.map((a) => (
                            <li key={a.agentKey} data-testid={`admin-ai-company-attention-${a.agentKey}`} className="text-xs">
                              <Badge color={HEALTH_COLOR[a.health]}>{t(`adminAi.company.health.${a.health}`)}</Badge>
                              <span className="ms-2 font-medium text-slate-700">{a.name}</span>
                              <span className="ms-2 text-slate-500">{a.reason}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>

                    <Card className="overflow-x-auto" testId="admin-ai-company-agents">
                      <p className="mb-2 text-sm font-semibold text-slate-900">{t('adminAi.company.agents.title')}</p>
                      {companyMetrics.agents.length === 0 ? (
                        <EmptyState title={t('common.noData')} />
                      ) : (
                        <table className="table-base">
                          <thead>
                            <tr>
                              <th>{t('adminAi.company.col.agent')}</th>
                              <th>{t('adminAi.company.col.health')}</th>
                              <th>{t('adminAi.company.col.runs')}</th>
                              <th>{t('adminAi.company.col.success')}</th>
                              <th>{t('adminAi.company.col.avg')}</th>
                              <th>{t('adminAi.company.col.retries')}</th>
                              <th>{t('adminAi.company.col.outcomes')}</th>
                              <th>{t('adminAi.company.col.cost')}</th>
                              <th>{t('adminAi.company.col.lastActivity')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {companyMetrics.agents.map((a) => (
                              <tr key={a.agentKey} data-testid={`admin-ai-company-agent-${a.agentKey}`}>
                                <td className="text-xs font-medium text-slate-700">{a.name}</td>
                                <td><Badge color={HEALTH_COLOR[a.health]}>{t(`adminAi.company.health.${a.health}`)}</Badge></td>
                                <td className="text-xs" dir="ltr">{a.execution.totalRuns}</td>
                                <td className="text-xs" dir="ltr">{formatPercent(a.execution.successRate)}</td>
                                <td className="text-xs" dir="ltr">{formatDuration(a.performance.avgDurationMs)}</td>
                                <td className="text-xs" dir="ltr">{a.performance.retriedSteps} · {a.performance.recoveredRuns}</td>
                                <td className="text-xs" dir="ltr">{a.outcomes.tasksWithStoredResult} / {a.outcomes.businessOutcomesAchieved}</td>
                                <td className="text-xs" dir="ltr">{a.cost.available ? `${a.cost.actualProviderCostUsd} ${a.cost.currencyCode}` : '—'}</td>
                                <td className="text-xs">{a.lastActivityAt ? formatDate(a.lastActivityAt) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </Card>

                    <Card testId="admin-ai-company-freshness">
                      <p className="text-sm font-semibold text-slate-900">{t('adminAi.company.freshness.title')}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {t('adminAi.company.freshness.latestActivity')}: <span dir="ltr">{companyMetrics.dataFreshness.latestActivityAt ? formatDate(companyMetrics.dataFreshness.latestActivityAt) : '—'}</span>
                        {' · '}
                        {t('adminAi.company.freshness.latestMetric')}: <span dir="ltr">{companyMetrics.dataFreshness.latestMetricAt ? formatDate(companyMetrics.dataFreshness.latestMetricAt) : '—'}</span>
                      </p>
                      <p className="mt-2 text-xs text-slate-500">{t('adminAi.company.outcomes.note')}</p>
                    </Card>
                  </div>
                )}
              </div>
            ) : <EmptyState title={t('common.noData')} />
          )}

          {tab === 'providers' && <AiProvidersPanel catalogue={models} />}

          {tab === 'spend' && <AiSpendPanel />}

          {tab === 'requests' && (
            requests.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.requests')} /> : (
              <Card className="overflow-x-auto" testId="admin-ai-requests">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('adminAi.req.type')}</th>
                      <th>{t('adminAi.req.model')}</th>
                      <th>{t('adminAi.req.tokens')}</th>
                      <th>{t('adminAi.req.cost')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('adminAi.req.latency')}</th>
                      <th>{t('adminAi.req.createdAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} data-testid={`admin-ai-request-${r.id}`}>
                        <td className="text-xs">{r.requestType}</td>
                        <td className="text-xs" dir="ltr">{r.model}</td>
                        <td className="text-xs" dir="ltr">{r.tokensInput} / {r.tokensOutput}</td>
                        <td className="text-xs" dir="ltr">{r.cost} {r.currencyCode}</td>
                        <td><Badge color={statusColor(r.status)}>{r.status}</Badge></td>
                        <td className="text-xs" dir="ltr">{r.latencyMs} ms</td>
                        <td className="text-xs">{formatDate(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'models' && (
            <div className="space-y-4">
              <Card testId="admin-ai-model-form">
                <form onSubmit={submitModel} className="grid gap-3 sm:grid-cols-3">
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.key')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-key"
                      dir="ltr"
                      value={modelForm.key}
                      onChange={(e) => setModelForm({ ...modelForm, key: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.name')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-name"
                      value={modelForm.displayName}
                      onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.provider')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-provider"
                      dir="ltr"
                      value={modelForm.provider}
                      onChange={(e) => setModelForm({ ...modelForm, provider: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.contextWindow')}
                    <input
                      type="number"
                      min={0}
                      className="input mt-1"
                      data-testid="admin-ai-model-context"
                      dir="ltr"
                      value={modelForm.contextWindow}
                      onChange={(e) => setModelForm({ ...modelForm, contextWindow: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.maxOutput')}
                    <input
                      type="number"
                      min={0}
                      className="input mt-1"
                      data-testid="admin-ai-model-maxout"
                      dir="ltr"
                      value={modelForm.maxOutputTokens}
                      onChange={(e) => setModelForm({ ...modelForm, maxOutputTokens: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.currency')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-currency"
                      dir="ltr"
                      maxLength={3}
                      value={modelForm.currencyCode}
                      onChange={(e) => setModelForm({ ...modelForm, currencyCode: e.target.value.toUpperCase() })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.inputPer1k')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-input"
                      dir="ltr"
                      value={modelForm.inputPer1k}
                      onChange={(e) => setModelForm({ ...modelForm, inputPer1k: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.outputPer1k')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-model-output"
                      dir="ltr"
                      value={modelForm.outputPer1k}
                      onChange={(e) => setModelForm({ ...modelForm, outputPer1k: e.target.value })}
                    />
                  </label>
                  <label className="flex items-end gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      data-testid="admin-ai-model-active"
                      checked={modelForm.isActive}
                      onChange={(e) => setModelForm({ ...modelForm, isActive: e.target.checked })}
                    />
                    {t('common.active')}
                  </label>
                  <div className="flex gap-2 sm:col-span-3">
                    <button
                      type="submit"
                      data-testid="admin-ai-model-submit"
                      disabled={busy !== null || !modelForm.key.trim() || !modelForm.displayName.trim() || !modelForm.provider.trim()}
                      className="btn-primary disabled:opacity-50"
                    >
                      {busy === 'model:save' ? '…' : editingModelKey ? t('adminAi.model.update') : t('adminAi.model.create')}
                    </button>
                    {editingModelKey && (
                      <button
                        type="button"
                        data-testid="admin-ai-model-cancel"
                        onClick={resetModelForm}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </form>
              </Card>

              {models.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.models')} /> : (
                <Card className="overflow-x-auto" testId="admin-ai-models">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminAi.model.key')}</th>
                        <th>{t('adminAi.model.name')}</th>
                        <th>{t('adminAi.model.provider')}</th>
                        <th>{t('adminAi.model.inputPer1k')}</th>
                        <th>{t('adminAi.model.outputPer1k')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.id} data-testid={`admin-ai-model-${m.key}`}>
                          <td className="text-xs" dir="ltr">{m.key}</td>
                          <td className="text-xs">{m.displayName}</td>
                          <td className="text-xs" dir="ltr">{m.provider}</td>
                          <td className="text-xs" dir="ltr">{m.inputPer1k} {m.currencyCode}</td>
                          <td className="text-xs" dir="ltr">{m.outputPer1k} {m.currencyCode}</td>
                          <td><Badge color={m.isActive ? 'green' : 'slate'}>{m.isActive ? t('common.active') : t('common.inactive')}</Badge></td>
                          <td className="whitespace-nowrap">
                            <button
                              type="button"
                              data-testid={`admin-ai-model-edit-${m.key}`}
                              onClick={() => editModel(m)}
                              className="me-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700"
                            >
                              {t('common.edit')}
                            </button>
                            <button
                              type="button"
                              data-testid={`admin-ai-model-toggle-${m.key}`}
                              disabled={busy !== null}
                              onClick={() => void toggleModel(m)}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700 disabled:opacity-50"
                            >
                              {m.isActive ? t('common.deactivate') : t('common.activate')}
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

          {tab === 'budgets' && (
            <div className="space-y-4">
              <Card testId="admin-ai-budget-form">
                <form onSubmit={submitBudget} className="grid gap-3 sm:grid-cols-3">
                  <label className="text-xs text-slate-600">
                    {t('adminAi.budget.target')}
                    <select
                      className="input mt-1"
                      data-testid="admin-ai-budget-kind"
                      value={budgetForm.targetKind}
                      onChange={(e) => setBudgetForm({ ...budgetForm, targetKind: e.target.value as 'ROLE' | 'USER' })}
                    >
                      <option value="ROLE">{t('adminAi.budget.byRole')}</option>
                      <option value="USER">{t('adminAi.budget.byUser')}</option>
                    </select>
                  </label>
                  {budgetForm.targetKind === 'ROLE' ? (
                    <label className="text-xs text-slate-600">
                      {t('adminAi.budget.roleTarget')}
                      <select
                        className="input mt-1"
                        data-testid="admin-ai-budget-role"
                        value={budgetForm.roleTarget}
                        onChange={(e) => setBudgetForm({ ...budgetForm, roleTarget: e.target.value })}
                      >
                        {['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'ADMIN'].map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="text-xs text-slate-600">
                      {t('adminAi.budget.userId')}
                      <input
                        className="input mt-1"
                        data-testid="admin-ai-budget-user"
                        dir="ltr"
                        value={budgetForm.userId}
                        onChange={(e) => setBudgetForm({ ...budgetForm, userId: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="text-xs text-slate-600">
                    {t('adminAi.budget.period')}
                    <select
                      className="input mt-1"
                      data-testid="admin-ai-budget-period"
                      value={budgetForm.period}
                      onChange={(e) => setBudgetForm({ ...budgetForm, period: e.target.value as 'DAILY' | 'MONTHLY' })}
                    >
                      <option value="DAILY">DAILY</option>
                      <option value="MONTHLY">MONTHLY</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.budget.maxRequests')}
                    <input
                      type="number"
                      min={1}
                      className="input mt-1"
                      data-testid="admin-ai-budget-maxreq"
                      dir="ltr"
                      value={budgetForm.maxRequests}
                      onChange={(e) => setBudgetForm({ ...budgetForm, maxRequests: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.budget.maxCost')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-budget-maxcost"
                      dir="ltr"
                      value={budgetForm.maxCost}
                      onChange={(e) => setBudgetForm({ ...budgetForm, maxCost: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t('adminAi.model.currency')}
                    <input
                      className="input mt-1"
                      data-testid="admin-ai-budget-currency"
                      dir="ltr"
                      maxLength={3}
                      value={budgetForm.currencyCode}
                      onChange={(e) => setBudgetForm({ ...budgetForm, currencyCode: e.target.value.toUpperCase() })}
                    />
                  </label>
                  <label className="flex items-end gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      data-testid="admin-ai-budget-active"
                      checked={budgetForm.isActive}
                      onChange={(e) => setBudgetForm({ ...budgetForm, isActive: e.target.checked })}
                    />
                    {t('common.active')}
                  </label>
                  <div className="sm:col-span-3">
                    <button
                      type="submit"
                      data-testid="admin-ai-budget-submit"
                      disabled={busy !== null || (budgetForm.targetKind === 'USER' && !budgetForm.userId.trim())}
                      className="btn-primary disabled:opacity-50"
                    >
                      {busy === 'budget:save' ? '…' : t('adminAi.budget.save')}
                    </button>
                  </div>
                </form>
              </Card>

              {budgets.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.budgets')} /> : (
                <Card className="overflow-x-auto" testId="admin-ai-budgets">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminAi.budget.target')}</th>
                        <th>{t('adminAi.budget.period')}</th>
                        <th>{t('adminAi.budget.maxRequests')}</th>
                        <th>{t('adminAi.budget.maxCost')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('adminAi.budget.updatedAt')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {budgets.map((b) => (
                        <tr key={b.id} data-testid={`admin-ai-budget-${b.id}`}>
                          <td className="text-xs" dir="ltr">{b.userId ?? b.roleTarget ?? '—'}</td>
                          <td className="text-xs">{b.period}</td>
                          <td className="text-xs">{b.maxRequests ?? '—'}</td>
                          <td className="text-xs" dir="ltr">{b.maxCost ?? '—'} {b.currencyCode}</td>
                          <td><Badge color={b.isActive ? 'green' : 'slate'}>{b.isActive ? t('common.active') : t('common.inactive')}</Badge></td>
                          <td className="text-xs">{formatDate(b.updatedAt)}</td>
                          <td>
                            <button
                              type="button"
                              data-testid={`admin-ai-budget-toggle-${b.id}`}
                              disabled={busy !== null}
                              onClick={() => void toggleBudget(b)}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700 disabled:opacity-50"
                            >
                              {b.isActive ? t('common.deactivate') : t('common.activate')}
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

          {tab === 'copilot' && <CopilotPanel />}

          {tab === 'agents' && (
            agents.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.agents')} /> : (
              <div className="space-y-4">
                {agentCounts && (
                  <p className="text-xs text-slate-500" data-testid="admin-ai-agent-counts">
                    {t('adminAi.agent.layerSummary')}: {agentCounts.total}
                    {' · '}{t('adminAi.agent.executableCount')}: {agentCounts.executable}
                    {' · '}{t('adminAi.agent.declaredCount')}: {agentCounts.declared}
                    {' · '}{t('adminAi.agent.supervisor')}: {agentCounts.supervisor}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {agents.map((a) => {
                    const badge = a.isSupervisor
                      ? { color: 'indigo' as const, label: t('adminAi.agent.supervisor') }
                      : a.executable === false
                        ? { color: 'slate' as const, label: t('adminAi.agent.declared') }
                        : a.requiresHumanApproval
                          ? { color: 'amber' as const, label: t('adminAi.agent.gated') }
                          : { color: 'teal' as const, label: t('adminAi.agent.auto') };
                    const agentStopped = (killSwitch?.stoppedAgents ?? []).includes(a.key);
                    return (
                      <Card key={a.id ?? a.key} testId={`admin-ai-agent-${a.key}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="font-bold text-slate-800">{a.name}</h3>
                            <p className="text-xs text-slate-400" dir="ltr">{a.key}</p>
                          </div>
                          <Badge color={badge.color} testId={`admin-ai-agent-status-${a.key}`}>{badge.label}</Badge>
                        </div>
                        {a.description && <p className="mt-2 text-xs text-slate-500">{a.description}</p>}
                        <div className="mt-3 flex items-center justify-between gap-2">
                          {agentStopped ? (
                            <Badge color="red" testId={`admin-ai-agent-stopped-${a.key}`}>
                              {t('adminAi.killSwitch.agentStopped')}
                            </Badge>
                          ) : (
                            <span />
                          )}
                          <button
                            type="button"
                            data-testid={`admin-ai-agent-switch-${a.key}`}
                            disabled={busy !== null}
                            onClick={() => void toggleAgentSwitch(a.key)}
                            className={`rounded border px-2 py-1 text-xs font-medium disabled:opacity-50 ${agentStopped ? 'border-green-300 text-green-700 hover:border-green-500' : 'border-red-300 text-red-700 hover:border-red-500'}`}
                          >
                            {agentStopped ? t('adminAi.killSwitch.agentResume') : t('adminAi.killSwitch.agentStop')}
                          </button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
                {copilot && (
                  <Card testId={`admin-ai-copilot-${copilot.key}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-800">{copilot.name}</h3>
                        <p className="text-xs text-slate-400" dir="ltr">{copilot.key}</p>
                      </div>
                      <Badge color="slate">{t('adminAi.agent.copilot')}</Badge>
                    </div>
                    {copilot.description && <p className="mt-2 text-xs text-slate-500">{copilot.description}</p>}
                  </Card>
                )}
              </div>
            )
          )}

          {tab === 'tasks' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-500" data-testid="admin-ai-pending-count">
                {t('adminAi.pendingApproval')}: {pendingApproval.length}
              </p>
              {tasks.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.tasks')} /> : (
                <Card className="overflow-x-auto" testId="admin-ai-tasks">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminAi.task.agent')}</th>
                        <th>{t('adminAi.task.requester')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('adminAi.task.model')}</th>
                        <th>{t('adminAi.task.cost')}</th>
                        <th>{t('adminAi.task.createdAt')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id} data-testid={`admin-ai-task-${task.id}`}>
                          <td className="text-xs" dir="ltr">{task.agentKey}</td>
                          <td className="text-xs" dir="ltr">{task.requestedBy}</td>
                          <td><Badge color={statusColor(task.status)}>{task.status}</Badge></td>
                          <td className="text-xs" dir="ltr">{task.model}</td>
                          <td className="text-xs" dir="ltr">{task.cost}</td>
                          <td className="text-xs">{formatDate(task.createdAt)}</td>
                          <td>
                            {task.status === 'awaiting_approval' && (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  data-testid={`admin-ai-approve-${task.id}`}
                                  disabled={busy !== null}
                                  onClick={() => void decide(task, 'APPROVE')}
                                  className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                                >
                                  {busy === `task:${task.id}` ? t('common.processing') : t('adminAi.task.approve')}
                                </button>
                                <button
                                  type="button"
                                  data-testid={`admin-ai-reject-${task.id}`}
                                  disabled={busy !== null}
                                  onClick={() => void decide(task, 'REJECT')}
                                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                >
                                  {t('adminAi.task.reject')}
                                </button>
                              </div>
                            )}
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

import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  AgentRegistryRow,
  AgentTaskRow,
  AiAdminBudget,
  AiAdminModel,
  AiAdminRequestRow,
  AiAdminUsage,
} from '@/lib/types';

type Tab = 'overview' | 'requests' | 'models' | 'budgets' | 'agents' | 'tasks';

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

export function AdminAiPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('overview');
  const [usage, setUsage] = useState<AiAdminUsage | null>(null);
  const [requests, setRequests] = useState<AiAdminRequestRow[]>([]);
  const [models, setModels] = useState<AiAdminModel[]>([]);
  const [budgets, setBudgets] = useState<AiAdminBudget[]>([]);
  const [agents, setAgents] = useState<AgentRegistryRow[]>([]);
  const [tasks, setTasks] = useState<AgentTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const [usageRes, reqRes, modelRes, budgetRes, agentRes, taskRes] = await Promise.all([
      apiCall(() => api.adminAiUsage()),
      apiCall(() => api.adminAiRequests()),
      apiCall(() => api.adminAiModels()),
      apiCall(() => api.adminAiBudgets()),
      apiCall(() => api.adminAiAgents()),
      apiCall(() => api.adminAiTasks()),
    ]);
    setUsage(usageRes.data ?? null);
    setRequests(reqRes.data?.items ?? []);
    setModels(modelRes.data?.items ?? []);
    setBudgets(budgetRes.data?.items ?? []);
    setAgents(agentRes.data?.items ?? []);
    setTasks(taskRes.data?.items ?? []);
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('adminAi.tab.overview') },
    { id: 'requests', label: t('adminAi.tab.requests') },
    { id: 'models', label: t('adminAi.tab.models') },
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
              </div>
            ) : <EmptyState title={t('common.noData')} />
          )}

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
            models.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.models')} /> : (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'budgets' && (
            budgets.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.budgets')} /> : (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'agents' && (
            agents.length === 0 ? <EmptyState title={t('common.noData')} hint={t('adminAi.tab.agents')} /> : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((a) => (
                  <Card key={a.id} testId={`admin-ai-agent-${a.key}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-800">{a.name}</h3>
                        <p className="text-xs text-slate-400" dir="ltr">{a.key}</p>
                      </div>
                      <Badge color={a.requiresHumanApproval ? 'amber' : 'teal'}>
                        {a.requiresHumanApproval ? t('adminAi.agent.gated') : t('adminAi.agent.auto')}
                      </Badge>
                    </div>
                    {a.description && <p className="mt-2 text-xs text-slate-500">{a.description}</p>}
                  </Card>
                ))}
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

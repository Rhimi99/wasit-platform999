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

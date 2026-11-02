import { useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  AgentRegistryRow,
  AgentTaskRow,
  CopilotAuditRow,
  CopilotRoutingPreview,
} from '@/lib/types';

type Tab = 'control' | 'tasks' | 'agents' | 'approvals' | 'audit';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo'> = {
  succeeded: 'green',
  approved: 'green',
  running: 'teal',
  queued: 'amber',
  awaiting_approval: 'amber',
  failed: 'red',
  rejected: 'red',
  blocked: 'red',
};

function statusColor(s: string): 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo' {
  return STATUS_COLOR[s] ?? 'slate';
}

/**
 * AI-02.2 — Admin Copilot desk (standalone page at `/admin/copilot`).
 *
 * Deliberately NOT merged into `AdminAiPage`: that desk is the ADMIN-level AI
 * governance surface, while this one is the SUPER_ADMIN operational control
 * centre. The access guard lives in the route (`SuperAdminOnly`) *and* on the
 * server (`requireRole('SUPER_ADMIN')`), so hiding this page is never the only
 * control.
 *
 * The routing tab is preview-first: an instruction is dry-run through
 * `POST /api/admin/copilot/route/preview` (which writes nothing) and only the
 * explicit "confirm" calls `POST /route`. Typing therefore never executes.
 */
export function AdminCopilotPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('control');
  const [agents, setAgents] = useState<AgentRegistryRow[]>([]);
  const [tasks, setTasks] = useState<AgentTaskRow[]>([]);
  const [audit, setAudit] = useState<CopilotAuditRow[]>([]);
  const [summary, setSummary] = useState<{ total: number; pendingApprovals: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Routing preview — an instruction string plus its dry-run result.
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<CopilotRoutingPreview[] | null>(null);

  const load = async () => {
    setError(null);
    const [agentRes, taskRes, auditRes, summaryRes] = await Promise.all([
      apiCall(() => api.adminCopilotAgents()),
      apiCall(() => api.adminCopilotTasks({ limit: 100 })),
      apiCall(() => api.adminCopilotAudit({ limit: 100 })),
      apiCall(() => api.adminCopilotAgentSummary()),
    ]);
    setAgents(agentRes.data?.items ?? []);
    setTasks(taskRes.data?.items ?? []);
    setAudit(auditRes.data?.items ?? []);
    setSummary(summaryRes.data ?? null);
    setError(agentRes.error ?? taskRes.error ?? auditRes.error ?? summaryRes.error);
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

  /** Parses the instruction box into the event list the preview endpoint wants. */
  function parseEvents(): string[] {
    return instruction
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const doPreview = async () => {
    const events = parseEvents();
    if (events.length === 0) return;
    setBusy('preview');
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminCopilotPreviewRoute(events));
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    setPreview(res.data?.preview ?? []);
  };

  const doConfirm = async () => {
    const events = parseEvents();
    if (events.length === 0) return;
    await run('confirm', () => api.adminCopilotConfirmRoute(events.map((event) => ({ event }))), 'adminCopilot.notice.routed');
    setPreview(null);
  };

  const decide = (task: AgentTaskRow, decision: 'APPROVE' | 'REJECT') =>
    run(
      `task:${task.id}`,
      () => api.adminCopilotDecideTask(task.id, decision),
      decision === 'APPROVE' ? 'adminCopilot.notice.approved' : 'adminCopilot.notice.rejected',
    );

  const runTask = (task: AgentTaskRow) =>
    run(`run:${task.id}`, () => api.adminCopilotRunTask(task.id), 'adminCopilot.notice.ran');

  const setAgentStatus = (agentKey: string, status: 'ACTIVE' | 'PAUSED' | 'DISABLED') =>
    run(
      `agent-status:${agentKey}`,
      () => api.adminCopilotSetAgentStatus(agentKey, status),
      'adminCopilot.notice.agentStatus',
    );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'control', label: t('adminCopilot.tab.control') },
    { id: 'tasks', label: t('adminCopilot.tab.tasks') },
    { id: 'agents', label: t('adminCopilot.tab.agents') },
    { id: 'approvals', label: t('adminCopilot.tab.approvals') },
    { id: 'audit', label: t('adminCopilot.tab.audit') },
  ];

  const pendingApproval = tasks.filter((x) => x.status === 'awaiting_approval');

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminCopilot.title')}
        subtitle={t('adminCopilot.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-copilot-refresh"
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
            data-testid={`admin-copilot-tab-${x.id}`}
            onClick={() => setTab(x.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${tab === x.id ? 'bg-wasit-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {notice && <div role="status" data-testid="admin-copilot-notice" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          {tab === 'control' && (
            <div className="space-y-4">
              <Card testId="admin-copilot-preview">
                <h3 className="text-sm font-bold text-slate-800">{t('adminCopilot.preview.title')}</h3>
                <p className="mt-1 text-xs text-slate-500">{t('adminCopilot.preview.hint')}</p>
                <label className="mt-3 block text-xs font-medium text-slate-600" htmlFor="copilot-events">
                  {t('adminCopilot.preview.event')}
                </label>
                <textarea
                  id="copilot-events"
                  data-testid="admin-copilot-events"
                  dir="ltr"
                  rows={3}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="order.placed, lead.created"
                  className="mt-1 w-full rounded-md border border-slate-300 p-2 text-xs"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="admin-copilot-preview-btn"
                    disabled={busy !== null || parseEvents().length === 0}
                    onClick={() => void doPreview()}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {t('adminCopilot.preview.button')}
                  </button>
                  <button
                    type="button"
                    data-testid="admin-copilot-confirm-btn"
                    disabled={busy !== null || preview === null || preview.every((p) => !p.runnable)}
                    onClick={() => void doConfirm()}
                    className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                  >
                    {t('adminCopilot.preview.confirm')}
                  </button>
                </div>
              </Card>

              {preview !== null && (
                preview.length === 0 ? <EmptyState title={t('adminCopilot.preview.empty')} /> : (
                  <Card className="overflow-x-auto" testId="admin-copilot-preview-result">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>{t('adminCopilot.preview.event')}</th>
                          <th>{t('adminCopilot.preview.agent')}</th>
                          <th>{t('adminCopilot.task.type')}</th>
                          <th>{t('adminCopilot.preview.runnable')}</th>
                          <th>{t('adminCopilot.preview.gated')}</th>
                          <th>{t('adminCopilot.preview.reason')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((p, i) => (
                          <tr key={`${p.event}-${i}`} data-testid={`admin-copilot-preview-row-${i}`}>
                            <td className="text-xs" dir="ltr">{p.event}</td>
                            <td className="text-xs" dir="ltr">{p.agentKey ?? '—'}</td>
                            <td className="text-xs" dir="ltr">{p.taskType ?? '—'}</td>
                            <td>
                              <Badge color={p.runnable ? 'green' : 'slate'}>
                                {p.runnable ? t('common.yes') : t('common.no')}
                              </Badge>
                            </td>
                            <td>
                              {p.requiresApproval
                                ? <Badge color="amber">{t('adminCopilot.preview.gated')}</Badge>
                                : <span className="text-xs text-slate-400">—</span>}
                            </td>
                            <td className="text-xs text-slate-500">{p.reason ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )
              )}
            </div>
          )}

          {tab === 'tasks' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-500" data-testid="admin-copilot-pending-count">
                {t('adminCopilot.approvals.count')}: {pendingApproval.length}
              </p>
              {tasks.length === 0 ? <EmptyState title={t('adminCopilot.tasks.empty')} /> : (
                <Card className="overflow-x-auto" testId="admin-copilot-tasks">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminCopilot.task.agent')}</th>
                        <th>{t('adminCopilot.task.type')}</th>
                        <th>{t('adminCopilot.task.status')}</th>
                        <th>{t('adminCopilot.task.cost')}</th>
                        <th>{t('adminCopilot.task.createdAt')}</th>
                        <th>{t('adminCopilot.task.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id} data-testid={`admin-copilot-task-${task.id}`}>
                          <td className="text-xs" dir="ltr">{task.agentKey}</td>
                          <td className="text-xs" dir="ltr">{task.taskType ?? '—'}</td>
                          <td><Badge color={statusColor(task.status)}>{task.status}</Badge></td>
                          <td className="text-xs" dir="ltr">{task.cost}</td>
                          <td className="text-xs">{formatDate(task.createdAt)}</td>
                          <td>
                            <div className="flex flex-wrap gap-2">
                              {task.status === 'awaiting_approval' && (
                                <>
                                  <button
                                    type="button"
                                    data-testid={`admin-copilot-approve-${task.id}`}
                                    disabled={busy !== null}
                                    onClick={() => void decide(task, 'APPROVE')}
                                    className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                                  >
                                    {t('adminCopilot.task.approve')}
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`admin-copilot-reject-${task.id}`}
                                    disabled={busy !== null}
                                    onClick={() => void decide(task, 'REJECT')}
                                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                  >
                                    {t('adminCopilot.task.reject')}
                                  </button>
                                </>
                              )}
                              {task.status === 'approved' && (
                                <button
                                  type="button"
                                  data-testid={`admin-copilot-run-${task.id}`}
                                  disabled={busy !== null}
                                  onClick={() => void runTask(task)}
                                  className="rounded-md border border-wasit-300 px-3 py-1.5 text-xs font-medium text-wasit-700 hover:bg-wasit-50 disabled:opacity-50"
                                >
                                  {t('adminCopilot.task.run')}
                                </button>
                              )}
                            </div>
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
            agents.length === 0 ? <EmptyState title={t('adminCopilot.agents.empty')} /> : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((a) => (
                  <Card key={a.id} testId={`admin-copilot-agent-${a.key}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-800">{a.name}</h3>
                        <p className="text-xs text-slate-400" dir="ltr">{a.key}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {a.isCopilot && <Badge color="indigo">{t('adminAi.agent.copilot')}</Badge>}
                        <Badge color={a.status === 'ACTIVE' ? 'green' : a.status === 'PAUSED' ? 'amber' : 'red'}>
                          {a.status}
                        </Badge>
                        <Badge color={a.requiresHumanApproval ? 'amber' : 'teal'}>
                          {a.requiresHumanApproval ? t('adminAi.agent.gated') : t('adminAi.agent.auto')}
                        </Badge>
                      </div>
                    </div>
                    {a.description && <p className="mt-2 text-xs text-slate-500">{a.description}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {a.status !== 'ACTIVE' && (
                        <button
                          type="button"
                          data-testid={`admin-copilot-agent-resume-${a.key}`}
                          disabled={busy !== null}
                          onClick={() => void setAgentStatus(a.key, 'ACTIVE')}
                          className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                        >
                          {t('adminCopilot.agent.resume')}
                        </button>
                      )}
                      {a.status === 'ACTIVE' && (
                        <button
                          type="button"
                          data-testid={`admin-copilot-agent-pause-${a.key}`}
                          disabled={busy !== null}
                          onClick={() => void setAgentStatus(a.key, 'PAUSED')}
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {t('adminCopilot.agent.pause')}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid={`admin-copilot-agent-disable-${a.key}`}
                        disabled={busy !== null}
                        onClick={() => void setAgentStatus(a.key, 'DISABLED')}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {t('adminCopilot.agent.disable')}
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            )
          )}

          {tab === 'approvals' && (
            pendingApproval.length === 0 ? <EmptyState title={t('adminCopilot.approvals.empty')} /> : (
              <Card className="overflow-x-auto" testId="admin-copilot-approvals">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('adminCopilot.task.agent')}</th>
                      <th>{t('adminCopilot.task.type')}</th>
                      <th>{t('adminCopilot.preview.gated')}</th>
                      <th>{t('adminCopilot.task.createdAt')}</th>
                      <th>{t('adminCopilot.task.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingApproval.map((task) => (
                      <tr key={task.id} data-testid={`admin-copilot-approval-${task.id}`}>
                        <td className="text-xs" dir="ltr">{task.agentKey}</td>
                        <td className="text-xs" dir="ltr">{task.taskType ?? '—'}</td>
                        <td className="text-xs" dir="ltr">{task.approvalAction ?? '—'}</td>
                        <td className="text-xs">{formatDate(task.createdAt)}</td>
                        <td>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              data-testid={`admin-copilot-approval-approve-${task.id}`}
                              disabled={busy !== null}
                              onClick={() => void decide(task, 'APPROVE')}
                              className="rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                            >
                              {t('adminCopilot.task.approve')}
                            </button>
                            <button
                              type="button"
                              data-testid={`admin-copilot-approval-reject-${task.id}`}
                              disabled={busy !== null}
                              onClick={() => void decide(task, 'REJECT')}
                              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {t('adminCopilot.task.reject')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}

          {tab === 'audit' && (
            audit.length === 0 ? <EmptyState title={t('adminCopilot.audit.empty')} /> : (
              <Card className="overflow-x-auto" testId="admin-copilot-audit">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('adminCopilot.audit.action')}</th>
                      <th>{t('adminCopilot.audit.actor')}</th>
                      <th>{t('adminCopilot.audit.entity')}</th>
                      <th>{t('adminCopilot.audit.time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((row) => (
                      <tr key={row.id} data-testid={`admin-copilot-audit-${row.id}`}>
                        <td className="text-xs" dir="ltr">{row.action}</td>
                        <td className="text-xs" dir="ltr">{row.actorId ?? '—'}</td>
                        <td className="text-xs" dir="ltr">{row.entityType ? `${row.entityType}:${row.entityId ?? ''}` : '—'}</td>
                        <td className="text-xs">{formatDate(row.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          )}
        </>
      )}
    </AppLayout>
  );
}

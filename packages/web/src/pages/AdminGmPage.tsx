import { useEffect, useState } from 'react';
import { api, apiCall, apiErrorMessage, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { GmPlaybookRow, GmRunRecord, GmRunSummaryRow, GmStepResultRow } from '@/lib/types';

type Tab = 'control' | 'runs';

const OUTCOME_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo'> = {
  succeeded: 'green',
  awaiting_approval: 'amber',
  blocked: 'red',
  failed: 'red',
  skipped: 'slate',
  not_run: 'slate',
};

function outcomeColor(s: string): 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo' {
  return OUTCOME_COLOR[s] ?? 'slate';
}

/**
 * AI-07.1 — General Manager operations desk (`/admin/gm`), SUPER_ADMIN only.
 *
 * A view + trigger over the GM orchestrator. "Run goal" is the only action that
 * mutates anything, and it goes through the real `POST /api/admin/gm/orchestrate`
 * — so the caller's RBAC, the kill switch, the approval gate and the budget guard
 * are exactly the server's, never re-implemented here. The run log and run detail
 * are read-only: the detail replays the persisted snapshot and never recomputes a
 * report from current state.
 *
 * The access guard lives in the route (`SuperAdminOnly`) *and* on the server
 * (`requireRole('SUPER_ADMIN')`), so hiding the page is never the only control.
 */
export function AdminGmPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('control');
  const [playbooks, setPlaybooks] = useState<GmPlaybookRow[]>([]);
  const [runs, setRuns] = useState<GmRunSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [goal, setGoal] = useState('');
  const [detail, setDetail] = useState<GmRunRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const [pb, rn] = await Promise.all([
      apiCall(() => api.adminGmPlaybooks()),
      apiCall(() => api.adminGmRuns({ limit: 100 })),
    ]);
    setPlaybooks(pb.data?.items ?? []);
    setRuns(rn.data?.items ?? []);
    setError(pb.error ?? rn.error);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const doRun = async () => {
    const g = goal.trim();
    if (g.length < 3) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    setDetailError(null);
    try {
      const run = await api.adminGmOrchestrate(g);
      setDetail(run);
      setNotice(t('adminGm.notice.ran'));
      await load();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openRun = async (runId: string) => {
    setDetail(null);
    setDetailError(null);
    setTab('runs');
    try {
      setDetail(await api.adminGmRun(runId));
    } catch (e) {
      setDetailError(apiErrorMessage(e));
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'control', label: t('adminGm.tab.control') },
    { id: 'runs', label: t('adminGm.tab.runs') },
  ];

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminGm.title')}
        subtitle={t('adminGm.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-gm-refresh"
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
            data-testid={`admin-gm-tab-${x.id}`}
            onClick={() => setTab(x.id)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${tab === x.id ? 'bg-wasit-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {notice && <div role="status" data-testid="admin-gm-notice" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          {tab === 'control' && (
            <div className="space-y-4">
              <Card testId="admin-gm-run-form">
                <label className="block text-sm font-bold text-slate-800" htmlFor="gm-goal">
                  {t('adminGm.goal.label')}
                </label>
                <p className="mt-1 text-xs text-slate-500">{t('adminGm.goal.hint')}</p>
                <textarea
                  id="gm-goal"
                  data-testid="admin-gm-goal"
                  rows={3}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={t('adminGm.goal.placeholder')}
                  className="mt-2 w-full rounded-md border border-slate-300 p-2 text-sm"
                />
                <button
                  type="button"
                  data-testid="admin-gm-run-btn"
                  disabled={busy || goal.trim().length < 3}
                  onClick={() => void doRun()}
                  className="mt-3 rounded-md bg-wasit-600 px-4 py-2 text-sm font-medium text-white hover:bg-wasit-700 disabled:opacity-50"
                >
                  {busy ? t('adminGm.running') : t('adminGm.run.button')}
                </button>
              </Card>

              <Card testId="admin-gm-playbooks">
                <h3 className="text-sm font-bold text-slate-800">{t('adminGm.playbooks.title')}</h3>
                <p className="mt-1 text-xs text-slate-500">{t('adminGm.playbooks.hint')}</p>
                {playbooks.length === 0 ? <EmptyState title={t('adminGm.runs.empty')} /> : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {playbooks.map((p) => (
                      <div key={p.id} data-testid={`admin-gm-playbook-${p.id}`} className="rounded-md border border-slate-200 p-3">
                        <p className="text-sm font-semibold text-slate-800">{p.labelAr}</p>
                        <p className="text-xs text-slate-400" dir="ltr">{p.label}</p>
                        <p className="mt-2 text-xs text-slate-500">
                          {t('adminGm.playbook.steps')}: {p.steps}
                        </p>
                        <p className="mt-1 text-xs text-slate-500" dir="ltr">
                          {t('adminGm.playbook.agents')}: {p.agents.join(', ')}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {detail && <RunDetail run={detail} onBack={() => setDetail(null)} />}
            </div>
          )}

          {tab === 'runs' && (
            <div className="space-y-4">
              {detailError && (
                <div role="alert" data-testid="admin-gm-detail-error" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  {detailError}
                </div>
              )}
              {detail ? <RunDetail run={detail} onBack={() => setDetail(null)} /> : (
                <>
                  <p className="text-xs text-slate-500">{t('adminGm.runs.hint')}</p>
                  {runs.length === 0 ? <EmptyState title={t('adminGm.runs.empty')} /> : (
                    <Card className="overflow-x-auto" testId="admin-gm-runs">
                      <table className="table-base">
                        <thead>
                          <tr>
                            <th>{t('adminGm.run.goal')}</th>
                            <th>{t('adminGm.run.playbook')}</th>
                            <th>{t('adminGm.run.createdAt')}</th>
                            <th>{t('adminGm.run.succeeded')}</th>
                            <th>{t('adminGm.run.failed')}</th>
                            <th>{t('adminGm.run.pending')}</th>
                            <th>{t('adminGm.run.skipped')}</th>
                            <th>{t('adminGm.run.view')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((r) => (
                            <tr key={r.runId} data-testid={`admin-gm-run-row-${r.runId}`}>
                              <td className="max-w-xs truncate text-xs">{r.goal ?? '—'}</td>
                              <td className="text-xs" dir="ltr">{r.playbookId ?? '—'}</td>
                              <td className="text-xs">{formatDate(r.createdAt)}</td>
                              <td><Badge color="green">{r.succeeded}</Badge></td>
                              <td><Badge color={r.failed > 0 ? 'red' : 'slate'}>{r.failed}</Badge></td>
                              <td><Badge color={r.pendingApproval > 0 ? 'amber' : 'slate'}>{r.pendingApproval}</Badge></td>
                              <td><Badge color="slate">{r.skipped}</Badge></td>
                              <td>
                                {r.hasSnapshot ? (
                                  <button
                                    type="button"
                                    data-testid={`admin-gm-run-view-${r.runId}`}
                                    onClick={() => void openRun(r.runId)}
                                    className="rounded-md border border-wasit-300 px-3 py-1.5 text-xs font-medium text-wasit-700 hover:bg-wasit-50"
                                  >
                                    {t('adminGm.run.view')}
                                  </button>
                                ) : (
                                  <Badge color="slate">{t('adminGm.run.legacy')}</Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </AppLayout>
  );
}

/** Read-only rendering of a retrieved run (the persisted snapshot, replayed). */
function RunDetail({ run, onBack }: { run: GmRunRecord; onBack: () => void }) {
  const { t } = useI18n();
  const review = run.review;
  const reviewGroups: { label: string; ids: string[] }[] = [
    { label: t('adminGm.review.failed'), ids: review.failed },
    { label: t('adminGm.review.blocked'), ids: review.blocked },
    { label: t('adminGm.review.notRun'), ids: review.notRun },
    { label: t('adminGm.review.pendingApproval'), ids: review.pendingApproval },
    { label: t('adminGm.review.insufficient'), ids: review.insufficientEvidence },
  ];
  const hasReview = reviewGroups.some((g) => g.ids.length > 0) || review.skipped.length > 0 || review.conflicts.length > 0;

  return (
    <div className="space-y-4" data-testid="admin-gm-detail">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-800">{t('adminGm.report.title')}</h2>
        <button
          type="button"
          data-testid="admin-gm-detail-back"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {t('adminGm.detail.back')}
        </button>
      </div>

      <Card testId="admin-gm-detail-meta">
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-slate-400">{t('adminGm.run.goal')}</dt><dd className="font-medium text-slate-700">{run.report.goal}</dd></div>
          <div><dt className="text-slate-400">{t('adminGm.run.playbook')}</dt><dd className="font-medium text-slate-700" dir="ltr">{run.playbookId}</dd></div>
          <div><dt className="text-slate-400">{t('adminGm.meta.requestedBy')}</dt><dd className="font-medium text-slate-700" dir="ltr">{run.requestedBy}</dd></div>
          <div><dt className="text-slate-400">{t('adminGm.meta.role')}</dt><dd className="font-medium text-slate-700" dir="ltr">{run.role.join(', ')}</dd></div>
          <div><dt className="text-slate-400">{t('adminGm.meta.matched')}</dt><dd className="font-medium text-slate-700">{run.matchedKeywords.join(', ') || '—'}</dd></div>
          <div><dt className="text-slate-400">{t('adminGm.meta.capturedAt')}</dt><dd className="font-medium text-slate-700">{formatDate(run.capturedAt ?? run.createdAt)}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-slate-500">{run.report.summaryAr}</p>
      </Card>

      <Card className="overflow-x-auto" testId="admin-gm-detail-steps">
        <h3 className="text-sm font-bold text-slate-800">{t('adminGm.steps.title')}</h3>
        <table className="table-base mt-2">
          <thead>
            <tr>
              <th>{t('adminGm.step.intent')}</th>
              <th>{t('adminGm.step.agent')}</th>
              <th>{t('adminGm.step.outcome')}</th>
              <th>{t('adminGm.step.evidence')}</th>
              <th>{t('adminGm.step.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((s) => (
              <StepRow key={s.stepId} step={s} />
            ))}
          </tbody>
        </table>
      </Card>

      <Card testId="admin-gm-detail-review">
        <h3 className="text-sm font-bold text-slate-800">{t('adminGm.review.title')}</h3>
        {!hasReview ? <p className="mt-2 text-xs text-slate-500">{t('adminGm.review.clean')}</p> : (
          <div className="mt-2 space-y-2 text-xs">
            {reviewGroups.filter((g) => g.ids.length > 0).map((g) => (
              <div key={g.label} className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500">{g.label}:</span>
                {g.ids.map((id) => <Badge key={id} color="amber">{id}</Badge>)}
              </div>
            ))}
            {review.skipped.length > 0 && (
              <div className="space-y-1">
                <span className="text-slate-500">{t('adminGm.review.skipped')}:</span>
                {review.skipped.map((s) => (
                  <p key={s.stepId} className="text-slate-600">{s.stepId} — {s.reason}</p>
                ))}
              </div>
            )}
            {review.conflicts.length > 0 && (
              <div className="space-y-1">
                <span className="text-slate-500">{t('adminGm.review.conflicts')}:</span>
                {review.conflicts.map((c) => (
                  <p key={c.key} className="text-slate-600">{c.key} — {c.values.map((v) => `${v.stepId}=${v.value}`).join(', ')}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card testId="admin-gm-detail-report">
        <h3 className="text-sm font-bold text-slate-800">{t('adminGm.report.title')}</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {([
            [t('adminGm.report.risks'), run.report.risks],
            [t('adminGm.report.priorities'), run.report.priorities],
            [t('adminGm.report.recommendations'), run.report.recommendations],
          ] as [string, string[]][]).map(([label, items]) => (
            <div key={label}>
              <p className="text-xs font-semibold text-slate-600">{label}</p>
              {items.length === 0 ? <p className="text-xs text-slate-400">—</p> : (
                <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-slate-500">
                  {items.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card testId="admin-gm-detail-plan">
        <h3 className="text-sm font-bold text-slate-800">{t('adminGm.plan.title')}</h3>
        <div className="mt-2 space-y-1 text-xs">
          {run.plan.waves.map((w, i) => (
            <p key={i} className="text-slate-600">
              {t('adminGm.plan.wave')} {i + 1}: <span dir="ltr">{w.join(', ') || '—'}</span>
            </p>
          ))}
          {run.plan.dropped.length > 0 && (
            <p className="text-slate-600">{t('adminGm.plan.dropped')}: <span dir="ltr">{run.plan.dropped.join(', ')}</span></p>
          )}
        </div>
      </Card>

      <Card className="overflow-x-auto" testId="admin-gm-detail-actions">
        <h3 className="text-sm font-bold text-slate-800">{t('adminGm.actions.title')}</h3>
        <p className="mt-1 text-xs text-slate-500">{t('adminGm.actions.hint')}</p>
        {run.proposedActions.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">{t('adminGm.actions.empty')}</p>
        ) : (
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>{t('adminGm.actions.action')}</th>
                <th>{t('adminGm.actions.description')}</th>
                <th>{t('adminGm.actions.agent')}</th>
                <th>{t('adminGm.actions.approval')}</th>
                <th>{t('adminGm.actions.notExecuted')}</th>
              </tr>
            </thead>
            <tbody>
              {run.proposedActions.map((a) => (
                <tr key={a.action} data-testid={`admin-gm-action-${a.action}`}>
                  <td className="text-xs" dir="ltr">{a.action}</td>
                  <td className="text-xs">{a.descriptionAr}</td>
                  <td className="text-xs" dir="ltr">{a.agentKey ?? '—'}</td>
                  <td>
                    {a.requiresApproval
                      ? <Badge color="amber">{t('common.yes')}</Badge>
                      : <Badge color="teal">{t('common.no')}</Badge>}
                  </td>
                  <td><Badge color="slate">{t('adminGm.actions.notExecuted')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function StepRow({ step }: { step: GmStepResultRow }) {
  const { t } = useI18n();
  const evidenceKeys = step.evidenceKeys ?? [];
  const reason = step.skippedReason ?? step.error;
  return (
    <tr data-testid={`admin-gm-step-${step.stepId}`}>
      <td className="text-xs">{step.intentAr}</td>
      <td className="text-xs" dir="ltr">{step.agentKey}</td>
      <td>
        <Badge color={outcomeColor(step.outcome)} testId={`admin-gm-step-outcome-${step.stepId}`}>
          {t(`adminGm.outcome.${step.outcome}`)}
        </Badge>
      </td>
      <td className="text-xs" dir="ltr">{evidenceKeys.length > 0 ? evidenceKeys.join(', ') : '—'}</td>
      <td className="text-xs text-slate-500">{reason ?? '—'}</td>
    </tr>
  );
}

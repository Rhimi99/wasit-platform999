import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { CopilotReport } from '@/lib/types';

/**
 * WASIT-COPILOT-01 — the General Manager's coordination panel.
 *
 * The panel is a view over the coordinator's API and nothing more: it submits a
 * request, shows the plan the coordinator produced, the status of every delegated
 * step and what still needs a human decision. It never shows a prompt, never
 * approves anything, and never claims a step succeeded — every status comes from
 * the server's stored run.
 */

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate' | 'indigo'> = {
  SUCCEEDED: 'green',
  RUNNING: 'teal',
  PARTIALLY_COMPLETED: 'amber',
  AWAITING_APPROVAL: 'amber',
  PENDING: 'slate',
  READY: 'slate',
  FAILED: 'red',
  CANCELLED: 'slate',
  SKIPPED: 'slate',
  COMPLETED: 'green',
  PLANNING: 'indigo',
  DISPATCHING: 'teal',
  PAUSED: 'amber',
};

function statusColor(status: string) {
  return STATUS_COLOR[status] ?? 'slate';
}

export function CopilotPanel() {
  const { t } = useI18n();
  const [request, setRequest] = useState('');
  const [items, setItems] = useState<CopilotReport[]>([]);
  const [selected, setSelected] = useState<CopilotReport | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiCall(() => api.copilotList());
    if (res.data) setItems(res.data.items);
    setError(res.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const text = request.trim();
    if (text.length < 8) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setClarification(null);
    const res = await apiCall(() => api.copilotCreate({ request: text }));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.data?.needsClarification) {
      setClarification(res.data.clarificationQuestion);
      return;
    }
    setRequest('');
    setNotice(t('adminAi.copilot.submitted'));
    if (res.data?.report) setSelected(res.data.report);
    await load();
  }

  async function advance(runId: string) {
    setBusy(true);
    setError(null);
    const res = await apiCall(() => api.copilotAdvance(runId));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.data?.report) setSelected(res.data.report);
    await load();
  }

  const report = selected;

  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader title={t('adminAi.copilot.title')} subtitle={t('adminAi.copilot.description')} />
        <div className="mt-4 space-y-3">
          <textarea
            className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:border-brand-500 focus:outline-none"
            rows={3}
            maxLength={2000}
            placeholder={t('adminAi.copilot.placeholder')}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={busy || request.trim().length < 8}
              onClick={() => void submit()}
            >
              {busy ? t('adminAi.copilot.working') : t('adminAi.copilot.submit')}
            </button>
            {busy && <Spinner />}
            <span className="text-xs text-slate-500">{t('adminAi.copilot.hint')}</span>
          </div>
          {clarification && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <strong className="block">{t('adminAi.copilot.clarification')}</strong>
              {clarification}
            </div>
          )}
          {notice && <p className="text-sm text-emerald-700">{notice}</p>}
          {error && <ErrorState message={error} />}
        </div>
      </Card>

      {report && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">{report.goal}</h3>
              <p className="mt-1 text-xs text-slate-500">
                {t('adminAi.copilot.createdAt')} {formatDate(report.createdAt)} ·{' '}
                {t('adminAi.copilot.planSource')} {report.plan.source}
                {report.plan.fallbackReason ? ` (${report.plan.fallbackReason})` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge color={statusColor(report.status)}>{report.status}</Badge>
              {report.governance.dispatchable && (
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void advance(report.runId)}
                >
                  {t('adminAi.copilot.advance')}
                </button>
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">{t('adminAi.copilot.progress.succeeded')}</dt>
              <dd className="font-semibold text-slate-900">{report.progress.succeeded}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t('adminAi.copilot.progress.failed')}</dt>
              <dd className="font-semibold text-slate-900">{report.progress.failed}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t('adminAi.copilot.progress.awaitingApproval')}</dt>
              <dd className="font-semibold text-slate-900">{report.progress.awaitingApproval}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t('adminAi.copilot.cost')}</dt>
              <dd className="font-semibold text-slate-900">
                {report.cost.totalUsd} {report.cost.complete ? '' : `(${t('adminAi.copilot.costIncomplete')})`}
              </dd>
            </div>
          </dl>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">{t('adminAi.copilot.step')}</th>
                  <th className="py-2 pr-3">{t('adminAi.copilot.agent')}</th>
                  <th className="py-2 pr-3">{t('adminAi.copilot.status')}</th>
                  <th className="py-2 pr-3">{t('adminAi.copilot.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {report.steps.map((step) => (
                  <tr key={step.stepKey} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600">{step.stepKey}</td>
                    <td className="py-2 pr-3">
                      <span className="text-slate-900">{step.agentName}</span>
                      {step.reason && <span className="block text-xs text-slate-500">{step.reason}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge color={statusColor(step.status)}>{step.status}</Badge>
                      {step.refused && (
                        <span className="mt-1 block text-xs text-amber-700">{t('adminAi.copilot.refused')}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-600">
                      {step.error ? (
                        <span className="text-rose-700">{step.error}</span>
                      ) : (
                        step.outcome ?? '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.escalations.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <h4 className="text-sm font-semibold text-amber-900">{t('adminAi.copilot.escalations')}</h4>
              <ul className="mt-2 space-y-1 text-xs text-amber-900">
                {report.escalations.map((esc, i) => (
                  <li key={`${esc.kind}-${esc.stepKey}-${i}`}>
                    <Badge color={esc.kind === 'failure' ? 'red' : 'amber'}>{esc.kind}</Badge>{' '}
                    {esc.agentKey ? `${esc.agentKey}: ` : ''}
                    {esc.message}
                  </li>
                ))}
              </ul>
              {report.governance.approvalsRequired > 0 && (
                <p className="mt-2 text-xs text-amber-800">{t('adminAi.copilot.approvalRule')}</p>
              )}
            </div>
          )}
        </Card>
      )}

      <Card>
        <SectionHeader title={t('adminAi.copilot.history')} />
        {loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title={t('adminAi.copilot.empty')} />
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.runId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <button
                    type="button"
                    className="text-left text-sm font-medium text-slate-900 hover:text-brand-700"
                    onClick={() => setSelected(item)}
                  >
                    {item.goal}
                  </button>
                  <p className="text-xs text-slate-500">
                    {formatDate(item.createdAt)} · {item.progress.total} {t('adminAi.copilot.steps')}
                  </p>
                </div>
                <Badge color={statusColor(item.status)}>{item.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

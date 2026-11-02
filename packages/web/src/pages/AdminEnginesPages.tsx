import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { DisputeDetail, DisputeSummary, RiskEventRow, RiskProfileRow, VerificationRequestRow, TrustScoreRow } from '@/lib/types';

type AdminVerificationRow = VerificationRequestRow & { userId: string; email: string | null };

/* ================= Admin: Verification ================= */

export function AdminVerificationPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<AdminVerificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.adminVerificationRequests());
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setItems(res.data!.items);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function review(id: string, decision: 'APPROVED' | 'REJECTED') {
    setInfo(null);
    const res = await apiCall(() => api.adminReviewVerification(id, decision, notes[id]?.trim() || undefined));
    if (res.error) { setError(res.error); return; }
    setInfo(res.error ?? `${decision} ✓`);
    load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('admin.verification')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">User</th>
                <th className="px-4 py-2 text-start">Level</th>
                <th className="px-4 py-2 text-start">{t('verification.status')}</th>
                <th className="px-4 py-2 text-start">{t('verification.submittedAt')}</th>
                <th className="px-4 py-2 text-start">Notes</th>
                <th className="px-4 py-2 text-start">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6"><EmptyState title={t('verification.noRequests')} /></td></tr>
              )}
              {items.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0" data-testid={`admin-verification-${r.id}`}>
                  <td className="px-4 py-2">
                    <div className="text-slate-700">{r.email ?? r.userId}</div>
                    <div className="text-xs text-slate-400" dir="ltr">{r.userId}</div>
                  </td>
                  <td className="px-4 py-2"><Badge color="teal">{t(`verification.level.${r.targetLevel}`)}</Badge></td>
                  <td className="px-4 py-2">
                    <Badge color={r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>
                      {t(`verification.status.${r.status}`)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(r.submittedAt ?? r.createdAt)}</td>
                  <td className="px-4 py-2">
                    <input
                      className="input px-2 py-1 text-xs"
                      placeholder={t('admin.reviewNotes')}
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes((s) => ({ ...s, [r.id]: e.target.value }))}
                    />
                  </td>
                  <td className="px-4 py-2">
                    {['SUBMITTED', 'PENDING', 'IN_REVIEW'].includes(r.status) ? (
                      <div className="flex gap-1">
                        <button className="btn-primary px-2 py-1 text-xs" data-testid={`admin-verification-approve-${r.id}`} onClick={() => review(r.id, 'APPROVED')}>{t('admin.approve')}</button>
                        <button className="btn-secondary px-2 py-1 text-xs" data-testid={`admin-verification-reject-${r.id}`} onClick={() => review(r.id, 'REJECTED')}>{t('admin.reject')}</button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {info && <p className="px-4 py-2 text-xs text-wasit-700">{info}</p>}
        </Card>
      )}
    </AppLayout>
  );
}

/* ================= Admin: Trust ================= */

type AdminTrustRow = TrustScoreRow & { email: string | null };

export function AdminTrustPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<AdminTrustRow[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; email: string }>>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The picker needs the user list only to create the first score, but the
    // empty/not-empty decision is not known until trust loads, so fetch both.
    const [trust, userList] = await Promise.all([apiCall(() => api.adminTrust()), apiCall(() => api.adminUsers())]);
    setLoading(false);
    if (trust.error) { setError(trust.error); return; }
    setItems(trust.data!.items);
    if (!userList.error) setUsers(userList.data!.items.map((u) => ({ id: u.id, email: u.email })));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function recompute(userId: string) {
    const res = await apiCall(() => api.adminTrustRecompute(userId));
    if (!res.error) load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('admin.trust')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <>
          {items.length === 0 && (
            // With no rows there is no per-row action, so the desk would show an
            // instruction it offers no way to follow. Give the operator a picker
            // to create the first score — same endpoint and permission as a row.
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                className="input max-w-xs"
                data-testid="admin-trust-user-select"
                aria-label={t('trust.recomputeUser')}
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
              >
                <option value="">{t('trust.recomputeUser')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.email}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn-secondary px-3 py-2 text-xs"
                data-testid="admin-trust-recompute"
                disabled={!selectedUser}
                onClick={() => selectedUser && recompute(selectedUser)}
              >
                {t('trust.recompute')}
              </button>
            </div>
          )}
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-start">User</th>
                  <th className="px-4 py-2 text-start">{t('trust.score')}</th>
                  <th className="px-4 py-2 text-start">{t('trust.explanationLabel')}</th>
                  <th className="px-4 py-2 text-start">{t('trust.effectiveAt')}</th>
                  <th className="px-4 py-2 text-start">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={5} className="px-4 py-6"><EmptyState title={t('trust.noSnapshot')} hint={t('trust.recomputeEmptyHint')} /></td></tr>}
                {items.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">
                      <div className="text-slate-700">{r.email ?? r.userId}</div>
                      <div className="text-xs text-slate-400" dir="ltr">{r.userId}</div>
                    </td>
                    <td className="px-4 py-2 font-semibold text-wasit-700">{r.score}</td>
                    <td className="max-w-56 px-4 py-2 text-xs text-slate-500">{r.summary ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-500">{formatDate(r.effectiveAt)}</td>
                    <td className="px-4 py-2">
                      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => recompute(r.userId)}>{t('trust.recompute')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </AppLayout>
  );
}

/* ================= Admin: Risk ================= */

const RISK_COLORS: Record<string, 'slate' | 'green' | 'amber' | 'red'> = { LOW: 'green', MEDIUM: 'amber', HIGH: 'red', SEVERE: 'red' };

export function AdminRiskPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<RiskProfileRow[]>([]);
  const [events, setEvents] = useState<RiskEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [p, e] = await Promise.all([apiCall(() => api.adminRiskProfiles()), apiCall(() => api.adminRiskEvents())]);
    setLoading(false);
    if (p.error) { setError(p.error); return; }
    setProfiles(p.data!.items);
    if (!e.error) setEvents(e.data!.items);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function reassess(userId: string) {
    const res = await apiCall(() => api.adminRiskReassess(userId));
    if (!res.error) load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('admin.risk')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <div className="space-y-4">
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-start">User</th>
                  <th className="px-4 py-2 text-start">{t('risk.overview')}</th>
                  <th className="px-4 py-2 text-start">{t('risk.reasonCodes')}</th>
                  <th className="px-4 py-2 text-start">{t('risk.recommendedAction')}</th>
                  <th className="px-4 py-2 text-start">{t('risk.reassess')}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.length === 0 && <tr><td colSpan={5} className="px-4 py-6"><EmptyState title={t('risk.events')} /></td></tr>}
                {profiles.map((p) => (
                  <tr key={p.userId} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">
                      <div className="text-slate-700">{p.email ?? p.userId}</div>
                      <div className="text-xs text-slate-400" dir="ltr">{p.userId}</div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800">{p.currentScore}</span>
                        <Badge color={RISK_COLORS[p.level] ?? 'slate'}>{t(`risk.level.${p.level}`)}</Badge>
                      </div>
                    </td>
                    <td className="max-w-60 px-4 py-2 text-xs text-slate-500">{JSON.stringify(p.flags)}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{formatDate(p.lastEvaluatedAt)}</td>
                    <td className="px-4 py-2">
                      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => reassess(p.userId)}>{t('risk.reassess')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('risk.events')}</h3>
            {events.length === 0 ? <EmptyState title={t('risk.events')} /> : (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-slate-600">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-400">{formatDate(e.createdAt)}</span>
                    <Badge color={RISK_COLORS[e.severity] ?? 'slate'}>{e.severity}</Badge>
                    <span>score {e.riskScore}</span>
                    <span dir="ltr">{e.reasonCode}</span>
                    <span className="text-slate-400">{e.recommendedAction}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </AppLayout>
  );
}

/* ================= Admin: Disputes ================= */

export function AdminDisputesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<DisputeSummary[]>([]);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewerId, setReviewerId] = useState('');
  const [statusValue, setStatusValue] = useState('UNDER_REVIEW');
  const [statusNote, setStatusNote] = useState('');
  const [decisionValue, setDecisionValue] = useState('IN_FAVOR_OF_BUYER');
  const [decisionNote, setDecisionNote] = useState('');
  const [decideNotice, setDecideNotice] = useState<string | null>(null);
  const [appealNote, setAppealNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.adminDisputes());
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setItems(res.data!.items);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function selectDetail(id: string) {
    setDetail(null);
    const res = await apiCall(() => api.adminDispute(id));
    if (res.error) { setError(res.error); return; }
    setDetail(res.data);
  }

  async function assign(id: string) {
    if (!reviewerId.trim()) return;
    const res = await apiCall(() => api.adminAssignDispute(id, reviewerId.trim()));
    if (res.error) { setError(res.error); return; }
    setReviewerId('');
    load();
    selectDetail(id);
  }

  async function updateStatus(id: string) {
    const res = await apiCall(() => api.adminUpdateDisputeStatus(id, statusValue, statusNote.trim() || undefined));
    if (res.error) { setError(res.error); return; }
    setStatusNote('');
    load();
    selectDetail(id);
  }

  async function decide(id: string) {
    setDecideNotice(null);
    const res = await apiCall(() => api.adminDecideDispute(id, decisionValue, decisionNote.trim() || undefined));
    if (res.error) { setError(res.error); return; }
    setDecisionNote('');
    // A decision that names a refund is not the same as a refund: an order that
    // never collected money is recorded as decided with nothing returned. Say
    // which happened instead of leaving staff to assume the buyer was paid.
    const effect = (res.data as { financialEffect?: { kind?: string } } | undefined)?.financialEffect;
    if (effect?.kind === 'REFUND_UNAVAILABLE') {
      setDecideNotice(t('disputes.admin.refundUnavailable'));
    } else if (effect?.kind === 'DECISION_REQUIRED') {
      setDecideNotice(t('disputes.admin.decisionRequired'));
    } else if (effect?.kind === 'REFUND_BUYER') {
      setDecideNotice(t('disputes.admin.refunded'));
    }
    load();
    selectDetail(id);
  }

  async function reviewAppeal(appealId: string, status: 'ACCEPTED' | 'REJECTED', disputeId: string) {
    const res = await apiCall(() => api.adminReviewDisputeAppeal(disputeId, appealId, status, appealNote.trim() || undefined));
    if (res.error) { setError(res.error); return; }
    setAppealNote('');
    load();
    selectDetail(disputeId);
  }

  return (
    <AppLayout>
      <SectionHeader title={t('admin.disputes')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-start">#</th>
                  <th className="px-4 py-2 text-start">Reason</th>
                  <th className="px-4 py-2 text-start">{t('disputes.status')}</th>
                  <th className="px-4 py-2 text-start">{t('disputes.decision')}</th>
                  <th className="px-4 py-2 text-start">{t('disputes.openedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={5} className="px-4 py-6"><EmptyState title={t('disputes.empty')} /></td></tr>}
                {items.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => selectDetail(d.id)}
                    data-testid={`admin-dispute-${d.id}`}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-4 py-2 font-mono text-xs" dir="ltr">{d.disputeNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{d.reasonCode}</td>
                    <td className="px-4 py-2"><Badge color="amber">{t(`disputes.status.${d.status}`)}</Badge></td>
                    <td className="px-4 py-2 text-slate-600">{d.decision !== 'NONE' ? t(`disputes.decision.${d.decision}`) : '—'}</td>
                    <td className="px-4 py-2 text-slate-500">{d.openedByEmail ?? d.openedById}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {detail && (
            <div className="space-y-3">
              <Card>
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm font-semibold" dir="ltr">{detail.disputeNumber}</p>
                    <p className="text-xs text-slate-500">{t('disputes.orderId')}: <span dir="ltr">{detail.orderId}</span></p>
                    <p className="mt-1 text-xs text-slate-500">{t('disputes.openedBy')}: {detail.openedByEmail ?? detail.openedById} • {t('disputes.assignedTo')}: {detail.assignedToEmail ?? detail.assignedToId ?? '—'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge color="amber">{t(`disputes.status.${detail.status}`)}</Badge>
                    {detail.decision !== 'NONE' && <Badge color="teal">{t(`disputes.decision.${detail.decision}`)}</Badge>}
                  </div>
                </div>
                <p className="mt-2 text-sm text-slate-600">{detail.description}</p>
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.admin.assign')}</h4>
                <div className="flex gap-2">
                  <input className="input flex-1" dir="ltr" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} placeholder={t('disputes.admin.reviewerUserId')} />
                  <button className="btn-primary" onClick={() => assign(detail.id)}>{t('disputes.admin.assign')}</button>
                </div>
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.admin.statusUpdate')}</h4>
                <div className="flex flex-wrap gap-2">
                  <select className="input" value={statusValue} onChange={(e) => setStatusValue(e.target.value)} data-testid="admin-dispute-status-select">
                    {['OPEN', 'UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED', 'DECIDED', 'CLOSED'].map((s) => <option key={s} value={s}>{t(`disputes.status.${s}`)}</option>)}
                  </select>
                  <input className="input flex-1" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} placeholder="Note" data-testid="admin-dispute-status-note" />
                  <button className="btn-secondary" onClick={() => updateStatus(detail.id)} data-testid="admin-dispute-status-submit">✓</button>
                </div>
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.admin.decide')}</h4>
                <div className="flex flex-wrap gap-2">
                  <select className="input" value={decisionValue} onChange={(e) => setDecisionValue(e.target.value)} data-testid="admin-dispute-decision-select">
                    {['IN_FAVOR_OF_BUYER', 'IN_FAVOR_OF_SELLER', 'SPLIT', 'REJECTED'].map((d) => <option key={d} value={d}>{t(`disputes.decision.${d}`)}</option>)}
                  </select>
                  <input className="input flex-1" value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Note" data-testid="admin-dispute-decision-note" />
                  <button className="btn-primary" onClick={() => decide(detail.id)} data-testid="admin-dispute-decide-submit">{t('disputes.admin.decide')}</button>
                </div>
                {decideNotice && (
                  <p className="mt-2 text-xs text-slate-600" role="status" data-testid="admin-dispute-decide-notice">{decideNotice}</p>
                )}
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.admin.appeals')}</h4>
                {detail.appeals.length === 0 ? <p className="text-xs text-slate-400">{t('disputes.appeal.empty')}</p> : (
                  <ul className="space-y-2" data-testid="admin-appeal-list">
                    {detail.appeals.map((a) => (
                      <li key={a.id} className="rounded-lg bg-slate-50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-slate-400">{t('disputes.appeal.by')}: {a.appealedByEmail ?? a.appealedById}</span>
                          <Badge color={a.status === 'ACCEPTED' ? 'green' : a.status === 'REJECTED' ? 'red' : 'amber'}>
                            {t(`disputes.appeal.status.${a.status}`)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-slate-700">{a.reason}</p>
                        {a.decisionNote && <p className="mt-1 text-xs text-slate-500">{t('disputes.appeal.decisionNote')}: {a.decisionNote}</p>}
                        {a.status === 'PENDING' && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <input className="input flex-1" value={appealNote} onChange={(e) => setAppealNote(e.target.value)} placeholder={t('disputes.admin.appealNote')} data-testid="admin-appeal-note" />
                            <button className="btn-primary" onClick={() => reviewAppeal(a.id, 'ACCEPTED', detail.id)} data-testid="appeal-accept">{t('disputes.admin.accept')}</button>
                            <button className="btn-secondary" onClick={() => reviewAppeal(a.id, 'REJECTED', detail.id)} data-testid="appeal-reject">{t('disputes.admin.reject')}</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.messages')}</h4>
                <div className="max-h-36 space-y-1 overflow-y-auto text-xs text-slate-600">
                  {detail.messages.map((m) => <p key={m.id}><span className="text-slate-400">{m.senderEmail ?? m.senderId}:</span> {m.body}</p>)}
                </div>
                <h4 className="mb-1 mt-3 text-sm font-semibold text-slate-700">{t('disputes.evidence')}</h4>
                <ul className="text-xs text-slate-500">
                  {detail.evidence.map((e) => <li key={e.id} dir="ltr">📎 {e.fileRef}</li>)}
                </ul>
                <h4 className="mb-1 mt-3 text-sm font-semibold text-slate-700">{t('disputes.events')}</h4>
                <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs text-slate-500">
                  {detail.events.map((e) => <li key={e.id}>[{formatDate(e.createdAt)}] {e.eventType}</li>)}
                </ul>
              </Card>
            </div>
          )}
        </div>
      )}
    </AppLayout>
  );
}
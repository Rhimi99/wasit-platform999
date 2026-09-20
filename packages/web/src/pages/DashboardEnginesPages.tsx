import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  DisputeDetail, DisputeSummary, Order, TrustScoreRow, VerificationPolicy, VerificationRequestRow,
  VerificationStatusOverview,
} from '@/lib/types';

/* ========================= Trust ========================= */

export function DashboardTrustPage() {
  const { t } = useI18n();
  const [latest, setLatest] = useState<TrustScoreRow | null>(null);
  const [history, setHistory] = useState<TrustScoreRow[]>([]);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.trustOverview());
    setLoading(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setLatest(res.data!.latest);
    setExplanation(res.data!.explanation);
    const hist = await apiCall(() => api.trustHistory());
    if (!hist.error) setHistory(hist.data!.items);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRecompute() {
    setRecomputing(true);
    const res = await apiCall(() => api.recomputeTrust());
    setRecomputing(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setLatest(res.data!.score);
    setHistory(res.data!.history);
    setExplanation(null);
    load();
  }

  return (
    <AppLayout>
      <SectionHeader title={t('trust.badge')} subtitle={t('trust.overview')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="text-center">
            <p className="text-5xl font-bold text-wasit-700">{latest ? latest.score : '—'}</p>
            <p className="mt-2 text-sm text-slate-500">{t('trust.score')}</p>
            {latest && (
              <div className="mt-2">
                <Badge color={latest.level === 'EXCELLENT' ? 'teal' : latest.level === 'GOOD' ? 'green' : latest.level === 'BASIC' ? 'amber' : 'red'}>
                  {t(`trust.level.${latest.level}`)}
                </Badge>
              </div>
            )}
            <button className="btn-primary mt-4" onClick={handleRecompute} disabled={recomputing}>
              {recomputing ? t('trust.recomputing') : t('trust.recompute')}
            </button>
          </Card>
          <Card className="sm:col-span-2">
            <h3 className="text-sm font-semibold text-slate-700">{t('trust.explanationLabel')}</h3>
            <p className="mt-2 text-sm text-slate-600">
              {latest ? (explanation ?? latest.summary ?? '—') : t('trust.noSnapshot')}
            </p>
            {latest && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500">
                <div>{String(latest.factors.emailVerified) === 'true' ? t('verification.emailVerified') : t('verification.emailNotVerified')}</div>
                <div>{String(latest.factors.phoneVerified) === 'true' ? t('verification.phoneVerified') : t('verification.phoneNotVerified')}</div>
                <div>{t('verification.currentLevel')}: {String(latest.factors.verificationLevel)}</div>
                <div>{t('trust.effectiveAt')}: {formatDate(latest.effectiveAt)}</div>
              </div>
            )}
          </Card>
          <div className="sm:col-span-3">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('trust.history')}</h3>
            {history.length === 0 ? (
              <EmptyState title={t('trust.noSnapshot')} hint={t('trust.recompute')} />
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2 text-start">{t('trust.score')}</th>
                      <th className="px-4 py-2 text-start">{t('trust.explanationLabel')}</th>
                      <th className="px-4 py-2 text-start">{t('trust.effectiveAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2 font-semibold text-wasit-700">{h.score}</td>
                        <td className="px-4 py-2 text-slate-600">{h.summary ?? '—'}</td>
                        <td className="px-4 py-2 text-slate-500">{formatDate(h.effectiveAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}

/* ========================= Verification ========================= */

export function DashboardVerificationPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<VerificationStatusOverview | null>(null);
  const [policies, setPolicies] = useState<VerificationPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<string>('BASIC');
  const [docType, setDocType] = useState('');
  const [docRef, setDocRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [st, pl] = await Promise.all([
      apiCall(() => api.verificationStatus()),
      apiCall(() => api.verificationPolicies()),
    ]);
    setLoading(false);
    if (st.error) { setError(st.error); return; }
    setStatus(st.data!);
    if (!pl.error) setPolicies(pl.data!);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit() {
    setFeedback(null);
    setSubmitting(true);
    const res = await apiCall(() => api.submitVerificationRequest({
      targetLevel: level,
      documentType: docType.trim() || undefined,
      documentRef: docRef.trim() || undefined,
    }));
    setSubmitting(false);
    if (res.error) { setFeedback(res.error); return; }
    setFeedback(t('verification.submitted'));
    setDocType('');
    setDocRef('');
    load();
  }

  const badges: Array<{ lvl: string; color: 'slate' | 'green' | 'teal' | 'indigo' }> = [
    { lvl: 'BASIC', color: 'slate' },
    { lvl: 'VERIFIED', color: 'green' },
    { lvl: 'BUSINESS_VERIFIED', color: 'teal' },
    { lvl: 'INTERNATIONAL_VERIFIED', color: 'indigo' },
  ];

  return (
    <AppLayout>
      <SectionHeader title={t('verification.badge')} subtitle={t('verification.subtitle')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            {badges.map(({ lvl, color }) => {
              const current = status?.currentLevel === lvl;
              return (
                <Card key={lvl} className={`text-center ${current ? 'ring-2 ring-wasit-500' : ''}`}>
                  <p className="text-sm font-semibold text-slate-700">{t(`verification.level.${lvl}`)}</p>
                  <Badge color={current ? 'teal' : color} className="mt-2">
                    {current ? t('verification.currentLevel') : '—'}
                  </Badge>
                </Card>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('verification.currentLevel')}</h3>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <Badge color="teal">{t(`verification.level.${status?.currentLevel ?? 'NONE'}`)}</Badge>
                <span className="text-xs">{status?.emailVerified ? t('verification.emailVerified') : t('verification.emailNotVerified')}</span>
                <span className="text-xs">{status?.phoneVerified ? t('verification.phoneVerified') : t('verification.phoneNotVerified')}</span>
              </div>
              {status?.nextStep && (
                <p className="mt-3 text-xs text-slate-500">{t('verification.nextStep')}: {t(`verification.level.${status.nextStep}`)}</p>
              )}
            </Card>

            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('verification.requestNew')}</h3>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">{t('verification.chooseLevel')}</label>
                  <select className="input w-full" value={level} onChange={(e) => setLevel(e.target.value)}>
                    {badges.map(({ lvl }) => <option key={lvl} value={lvl}>{t(`verification.level.${lvl}`)}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">{t('verification.docType')}</label>
                    <input className="input w-full" value={docType} onChange={(e) => setDocType(e.target.value)} placeholder="ID_CARD" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">{t('verification.docRef')}</label>
                    <input className="input w-full" dir="ltr" value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="TN-12345678" />
                  </div>
                </div>
                {feedback && <p className="text-xs text-wasit-700">{feedback}</p>}
                <button
                  className="btn-primary"
                  onClick={submit}
                  disabled={submitting || status?.activeRequest != null}
                >
                  {submitting
                    ? t('verification.submitting')
                    : status?.activeRequest
                      ? `${t('verification.status')}: ${t(`verification.status.${status.activeRequest.status}`)}`
                      : t('verification.submit')}
                </button>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('verification.recentRequests')}</h3>
              {status?.recentRequests.length === 0 ? (
                <EmptyState title={t('verification.noRequests')} />
              ) : (
                <div className="space-y-2">
                  {status?.recentRequests.map((r: VerificationRequestRow) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                      <div className="text-sm">
                        <span className="font-medium text-slate-700">{t(`verification.level.${r.targetLevel}`)}</span>
                        <span className="mx-2 text-slate-300">•</span>
                        <span className="text-xs text-slate-500">{formatDate(r.createdAt)}</span>
                      </div>
                      <Badge color={r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>
                        {t(`verification.status.${r.status}`)}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('verification.policies')}</h3>
              {policies.length === 0 ? (
                <EmptyState title={t('verification.noRequests')} />
              ) : (
                <div className="space-y-2">
                  {policies.map((p) => (
                    <div key={p.id} className="rounded-lg border border-slate-200 px-3 py-2">
                      <p className="text-sm font-medium text-slate-700">{p.name}</p>
                      {p.description && <p className="text-xs text-slate-500">{p.description}</p>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

/* ========================= Disputes ========================= */

const DISPUTE_STATUS_COLORS: Record<string, 'slate' | 'green' | 'teal' | 'amber' | 'red' | 'indigo'> = {
  OPEN: 'amber', UNDER_REVIEW: 'indigo', REQUESTED_FURTHER_EVIDENCE: 'amber',
  ESCALATED: 'red', DECIDED: 'teal', CLOSED: 'slate', ARCHIVED: 'slate',
};

/** Buyer-facing reason codes; the server stores the code, the UI localizes it. */
const DISPUTE_REASON_CODES = [
  'NOT_RECEIVED',
  'NOT_AS_DESCRIBED',
  'DAMAGED',
  'WRONG_ITEM',
  'LATE_DELIVERY',
  'QUALITY_ISSUE',
  'OTHER',
] as const;

export function DashboardDisputesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<DisputeSummary[]>([]);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [newOrderId, setNewOrderId] = useState('');
  const [newReasonCode, setNewReasonCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [appealReason, setAppealReason] = useState('');
  const [sending, setSending] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.listMyDisputes());
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setItems(res.data!.items);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    async function loadOrders() {
      const res = await apiCall(() => api.listMyOrders());
      if (!res.error) setOrders(res.data!);
    }
    loadOrders();
  }, []);

  async function submitCreate() {
    if (!newOrderId || !newReasonCode || newDescription.trim().length < 10) return;
    setCreating(true);
    const res = await apiCall(() => api.createDispute({
      orderId: newOrderId,
      reasonCode: newReasonCode,
      description: newDescription.trim(),
    }));
    setCreating(false);
    if (res.error) { setError(res.error); return; }
    setError(null);
    const createdId = res.data!.id;
    setNewOrderId('');
    setNewReasonCode('');
    setNewDescription('');
    await loadList();
    await openDetail(createdId);
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setError(null);
    const res = await apiCall(() => api.disputeDetail(id));
    if (res.error) { setError(res.error); return; }
    setDetail(res.data);
  }

  async function sendMessage() {
    if (!selectedId || !messageText.trim()) return;
    setSending(true);
    const res = await apiCall(() => api.addDisputeMessage(selectedId, messageText.trim()));
    setSending(false);
    setMessageText('');
    if (res.error) { setError(res.error); return; }
    setError(null);
    openDetail(selectedId);
  }

  async function sendEvidence() {
    if (!selectedId || !evidenceRef.trim()) return;
    setSending(true);
    const res = await apiCall(() => api.addDisputeEvidence(selectedId, { fileRef: evidenceRef.trim() }));
    setSending(false);
    setEvidenceRef('');
    if (res.error) { setError(res.error); return; }
    setError(null);
    openDetail(selectedId);
  }

  async function submitAppeal() {
    if (!selectedId || !appealReason.trim()) return;
    setSending(true);
    const res = await apiCall(() => api.createDisputeAppeal(selectedId, appealReason.trim()));
    setSending(false);
    if (res.error) { setError(res.error); return; }
    setAppealReason('');
    setError(null);
    openDetail(selectedId);
  }

  return (
    <AppLayout>
      <SectionHeader title={t('disputes.badge')} subtitle={t('disputes.subtitle')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={loadList} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.create')}</h3>
              {orders.length === 0 ? (
                <p className="text-xs text-slate-400">{t('disputes.create.noOrders')}</p>
              ) : (
                <div className="space-y-2">
                  <select className="input w-full" value={newOrderId} onChange={(e) => setNewOrderId(e.target.value)} data-testid="dispute-order">
                    <option value="">{t('disputes.create.selectOrder')}</option>
                    {orders.map((o) => (
                      <option key={o.id} value={o.id} dir="ltr">{o.orderNumber}</option>
                    ))}
                  </select>
                  <select className="input w-full" value={newReasonCode} onChange={(e) => setNewReasonCode(e.target.value)} data-testid="dispute-reason">
                    <option value="">{t('disputes.create.selectReason')}</option>
                    {DISPUTE_REASON_CODES.map((code) => (
                      <option key={code} value={code}>{t(`disputes.reason.${code}`)}</option>
                    ))}
                  </select>
                  <textarea
                    className="input w-full"
                    rows={3}
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder={t('disputes.description')}
                    data-testid="dispute-description"
                  />
                  <button
                    className="btn-primary"
                    onClick={submitCreate}
                    disabled={creating || !newOrderId || !newReasonCode || newDescription.trim().length < 10}
                    data-testid="dispute-create-submit"
                  >
                    {t('disputes.createSubmit')}
                  </button>
                </div>
              )}
            </Card>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.title')}</h3>
              {items.length === 0 ? (
                <EmptyState title={t('disputes.empty')} />
              ) : (
                <div className="space-y-2">
                  {items.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => openDetail(d.id)}
                      className={`w-full rounded-lg border px-4 py-3 text-start transition ${selectedId === d.id ? 'border-wasit-400 bg-wasit-50' : 'border-slate-200 bg-white hover:border-wasit-300'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-800" dir="ltr">{d.disputeNumber}</span>
                        <Badge color={DISPUTE_STATUS_COLORS[d.status] ?? 'slate'}>{t(`disputes.status.${d.status}`)}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{d.reasonCode} • {formatDate(d.createdAt)}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-600">{d.description}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            {!selectedId ? (
              <Card><p className="text-sm text-slate-500">{t('disputes.events')}</p></Card>
            ) : !detail ? <Spinner /> : (
              <div className="space-y-3">
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-800" dir="ltr">{detail.disputeNumber}</p>
                      <p className="text-xs text-slate-500">{t('disputes.orderId')}: <span dir="ltr">{detail.orderId}</span></p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge color={DISPUTE_STATUS_COLORS[detail.status] ?? 'slate'}>{t(`disputes.status.${detail.status}`)}</Badge>
                      {detail.decision !== 'NONE' && <Badge color="teal">{t(`disputes.decision.${detail.decision}`)}</Badge>}
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">{detail.description}</p>
                  <p className="mt-1 text-xs text-slate-500">{t('disputes.openedBy')}: {detail.openedByEmail ?? detail.openedById}</p>
                  {detail.decisionNote && <p className="mt-1 text-xs text-slate-500">{t('disputes.decisionNote')}: {detail.decisionNote}</p>}
                </Card>

                <Card>
                  <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.messages')}</h4>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {detail.messages.length === 0 ? <p className="text-xs text-slate-400">—</p> : detail.messages.map((m) => (
                      <div key={m.id} className="rounded-lg bg-slate-50 px-3 py-2">
                        <p className="text-xs text-slate-400">{m.senderEmail ?? m.senderId}</p>
                        <p className="text-sm text-slate-700">{m.body}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input className="input flex-1" value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder={t('disputes.messagePlaceholder')} />
                    <button className="btn-primary" onClick={sendMessage} disabled={sending || !messageText.trim()}>{t('disputes.addMessage')}</button>
                  </div>
                </Card>

                <Card>
                  <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.evidence')}</h4>
                  <div className="mb-2 flex gap-2">
                    <input className="input flex-1" dir="ltr" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder={t('disputes.evidenceRef')} />
                    <button className="btn-secondary" onClick={sendEvidence} disabled={sending || !evidenceRef.trim()}>{t('disputes.addEvidence')}</button>
                  </div>
                  {detail.evidence.length === 0 ? <p className="text-xs text-slate-400">—</p> : (
                    <ul className="space-y-1 text-xs text-slate-600">
                      {detail.evidence.map((e) => <li key={e.id} dir="ltr">📎 {e.fileRef} {e.contentType ? `(${e.contentType})` : ''}</li>)}
                    </ul>
                  )}
                </Card>

                <Card>
                  <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.events')}</h4>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-slate-500">
                    {detail.events.map((e) => <li key={e.id}>[{formatDate(e.createdAt)}] {e.eventType}</li>)}
                  </ul>
                </Card>

                <Card>
                  <h4 className="mb-2 text-sm font-semibold text-slate-700">{t('disputes.appeals')}</h4>
                  {detail.appeals.length === 0 ? <p className="text-xs text-slate-400">{t('disputes.appeal.empty')}</p> : (
                    <ul className="space-y-2" data-testid="appeal-list">
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
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.appealAllowed && (detail.status === 'DECIDED' || detail.status === 'CLOSED') && (
                    <div className="mt-3 flex gap-2">
                      <input className="input flex-1" value={appealReason} onChange={(e) => setAppealReason(e.target.value)} placeholder={t('disputes.appeal.reasonPlaceholder')} data-testid="appeal-reason" />
                      <button className="btn-secondary" onClick={submitAppeal} disabled={sending || !appealReason.trim()} data-testid="appeal-submit">{t('disputes.appeal.submit')}</button>
                    </div>
                  )}
                </Card>
              </div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
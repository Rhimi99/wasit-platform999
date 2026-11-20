import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, apiErrorMessage, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  ManualCompletionResult,
  ManualPaymentView,
  PayoutRecord,
  PayoutProvidersResponse,
  ReceiptResult,
  ReceiptSource,
  ReconciliationImportResult,
  SettlementResult,
  SuborderSettlementResult,
} from '@/lib/types';

/**
 * Admin Finance Desk (PS-01).
 *
 * Thin, honest surface over the money-movement routes that already exist under
 * `/api/admin/finance` (settlement / payout / reconciliation / receipts). It adds
 * no business rule of its own: every action calls the same service the backend
 * already trusts, and every result is read back from the server — nothing is
 * reported as done before the server says so.
 *
 * Two invariants the UI deliberately mirrors instead of hiding:
 *  - `dispatch`/`sync` can only ever reach PROCESSING; a payout becomes COMPLETED
 *    only from the rail's own transfer evidence, which the backend validates.
 *  - settlement needs a real transfer reference; the form refuses to submit one
 *    without it (and the server would answer 422 regardless).
 */

type Tab = 'settlement' | 'payouts' | 'reconciliation' | 'receipts' | 'providers' | 'manual';

const PAYOUT_STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'teal' | 'slate'> = {
  CREATED: 'slate',
  PROCESSING: 'amber',
  COMPLETED: 'green',
  FAILED: 'red',
  HELD: 'teal',
};

const RECEIPT_SOURCES: ReceiptSource[] = ['BANK_STATEMENT', 'ACQUIRER', 'PROVIDER'];

/** Parses a JSON textarea into an array, rejecting anything that is not a list. */
function parseLines(raw: string, field: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${field}: invalid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${field}: expected a JSON array`);
  return parsed as Record<string, unknown>[];
}

export function AdminFinancePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('settlement');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Providers
  const [providers, setProviders] = useState<PayoutProvidersResponse | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);

  // Settlement
  const [settlement, setSettlement] = useState({ externalRef: '', amount: '', currencyCode: 'TND', providerId: 'open-checkout', settlementRef: '', providerRef: '' });
  const [settlementResult, setSettlementResult] = useState<SettlementResult | null>(null);

  // M2.3 — seller suborder settlement re-processing
  const [reconcileOrderId, setReconcileOrderId] = useState('');
  const [reconcileResults, setReconcileResults] = useState<SuborderSettlementResult[] | null>(null);

  // Payouts
  const [payoutForm, setPayoutForm] = useState({ transactionId: '', sellerOrderId: '', providerId: 'sandbox' });
  const [payout, setPayout] = useState<PayoutRecord | null>(null);
  const [beneficiaryRef, setBeneficiaryRef] = useState('');
  const [lookupId, setLookupId] = useState('');

  // Reconciliation
  const [recon, setRecon] = useState({ source: 'PROVIDER' as 'PROVIDER' | 'BANK', currencyCode: 'TND', providerJson: '[]', bankJson: '[]', ledgerJson: '[]' });
  const [reconResult, setReconResult] = useState<ReconciliationImportResult | null>(null);

  // Receipts
  const [receipt, setReceipt] = useState({ transactionId: '', source: 'BANK_STATEMENT' as ReceiptSource, reference: '', amount: '', currencyCode: 'TND' });
  const [receiptResult, setReceiptResult] = useState<ReceiptResult | null>(null);

  // Manual payment completion (PS-02, DEMO only)
  const [manual, setManual] = useState({ orderId: '', paymentReference: '' });
  const [manualView, setManualView] = useState<ManualPaymentView | null>(null);
  const [manualResult, setManualResult] = useState<ManualCompletionResult | null>(null);
  const [manualAvailability, setManualAvailability] = useState<{ demoMode: boolean; provider: string } | null>(null);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    const res = await apiCall(() => api.financePayoutProviders());
    setProviders(res.data ?? null);
    setProvidersLoading(false);
    if (res.error) setError(res.error);
  }, []);

  const loadManualAvailability = useCallback(async () => {
    const res = await apiCall(() => api.financeManualPaymentAvailability());
    setManualAvailability(res.data ?? null);
  }, []);

  useEffect(() => { void loadProviders(); }, [loadProviders]);
  useEffect(() => { void loadManualAvailability(); }, [loadManualAvailability]);

  /** Runs a money-movement call; only surfaces success after the server replies. */
  async function run(key: string, fn: () => Promise<unknown>, successKey: string): Promise<unknown | null> {
    setBusy(key);
    setError(null);
    setNotice(null);
    const res = await apiCall(() => fn());
    setBusy(null);
    if (res.error) { setError(res.error); return null; }
    setNotice(t(successKey));
    return res.data ?? null;
  }

  const submitSettlement = async () => {
    // Only the fields the UI can meaningfully pre-check are validated here; the
    // mandatory transfer reference is left to the server, so its 422 is surfaced
    // rather than masked by a client-side guess.
    if (!settlement.externalRef.trim() || !settlement.amount.trim()) {
      setError(t('adminFin.err.required')); return;
    }
    if (settlement.currencyCode.trim().length !== 3) { setError(t('adminFin.err.currency')); return; }
    const data = await run('settlement', () => api.financeConfirmSettlement({
      externalRef: settlement.externalRef.trim(),
      amount: settlement.amount.trim(),
      currencyCode: settlement.currencyCode.trim().toUpperCase(),
      providerId: settlement.providerId.trim(),
      settlementRef: settlement.settlementRef.trim(),
      providerRef: settlement.providerRef.trim() || null,
    }), 'adminFin.notice.settlement');
    setSettlementResult((data as SettlementResult) ?? null);
  };

  const createPayout = async () => {
    if (!payoutForm.transactionId.trim()) { setError(t('adminFin.err.required')); return; }
    const data = await run('payout-create', () => api.financeCreatePayout({
      transactionId: payoutForm.transactionId.trim(),
      providerId: payoutForm.providerId.trim(),
      sellerOrderId: payoutForm.sellerOrderId.trim() || null,
    }), 'adminFin.notice.payoutCreated');
    setPayout((data as PayoutRecord) ?? null);
  };

  const reconcileSettlements = async () => {
    const data = await run(
      'reconcile-settlements',
      () => api.financeReconcileSettlements({ orderId: reconcileOrderId.trim() || null }),
      'adminFin.notice.reconciled',
    );
    setReconcileResults((data as SuborderSettlementResult[]) ?? null);
  };

  const lookupPayout = async () => {
    if (!lookupId.trim()) { setError(t('adminFin.err.required')); return; }
    const data = await run('payout-lookup', () => api.financeGetPayout(lookupId.trim()), 'adminFin.notice.payoutLoaded');
    setPayout((data as PayoutRecord) ?? null);
  };

  const dispatchPayout = async () => {
    if (!payout) return;
    if (!beneficiaryRef.trim()) { setError(t('adminFin.err.required')); return; }
    const data = await run('payout-dispatch', () => api.financeDispatchPayout(payout.id, { beneficiaryRef: beneficiaryRef.trim() }), 'adminFin.notice.dispatched');
    if (data) setPayout((data as { payout: PayoutRecord }).payout);
  };

  const syncPayout = async () => {
    if (!payout) return;
    const data = await run('payout-sync', () => api.financeSyncPayout(payout.id), 'adminFin.notice.synced');
    if (data) setPayout((data as { payout: PayoutRecord }).payout);
  };

  const importReconciliation = async () => {
    if (recon.currencyCode.trim().length !== 3) { setError(t('adminFin.err.currency')); return; }
    let provider: Record<string, unknown>[];
    let bank: Record<string, unknown>[];
    let ledger: Record<string, unknown>[];
    try {
      provider = parseLines(recon.providerJson, t('adminFin.recon.providerLines'));
      bank = parseLines(recon.bankJson, t('adminFin.recon.bankLines'));
      ledger = parseLines(recon.ledgerJson, t('adminFin.recon.ledgerLines'));
    } catch (e) {
      setError(apiErrorMessage(e)); return;
    }
    const data = await run('recon', () => api.financeImportReconciliation({
      source: recon.source,
      currencyCode: recon.currencyCode.trim().toUpperCase(),
      provider,
      bank,
      ledger,
    }), 'adminFin.notice.reconImported');
    setReconResult((data as ReconciliationImportResult) ?? null);
  };

  const submitReceipt = async () => {
    if (!receipt.transactionId.trim() || !receipt.reference.trim() || !receipt.amount.trim()) {
      setError(t('adminFin.err.required')); return;
    }
    if (receipt.currencyCode.trim().length !== 3) { setError(t('adminFin.err.currency')); return; }
    const data = await run('receipt', () => api.financeRecordReceipt({
      transactionId: receipt.transactionId.trim(),
      evidence: {
        source: receipt.source,
        reference: receipt.reference.trim(),
        amount: receipt.amount.trim(),
        currencyCode: receipt.currencyCode.trim().toUpperCase(),
      },
    }), 'adminFin.notice.receiptRecorded');
    setReceiptResult((data as ReceiptResult) ?? null);
  };

  const lookupManual = async () => {
    if (!manual.orderId.trim()) { setError(t('adminFin.err.required')); return; }
    const data = await run('manual-lookup', () => api.financeGetManualPaymentView(manual.orderId.trim()), 'adminFin.notice.manualLoaded');
    setManualView((data as ManualPaymentView) ?? null);
  };

  const completeManual = async () => {
    if (!manual.orderId.trim() || !manual.paymentReference.trim()) { setError(t('adminFin.err.required')); return; }
    // An irreversible money-state change is confirmed first: this records a payment.
    if (!window.confirm(t('adminFin.manual.confirm'))) return;
    const data = await run('manual-complete', () => api.financeCompleteManualPayment({
      orderId: manual.orderId.trim(),
      paymentReference: manual.paymentReference.trim(),
    }), 'adminFin.notice.manualCompleted');
    if (data) {
      setManualResult(data as ManualCompletionResult);
      // Re-read the server state so the panel shows PAID because the server says
      // so, not because the client assumed it.
      const refreshed = await apiCall(() => api.financeGetManualPaymentView(manual.orderId.trim()));
      setManualView(refreshed.data ?? null);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'settlement', label: t('adminFin.tab.settlement') },
    { id: 'payouts', label: t('adminFin.tab.payouts') },
    { id: 'reconciliation', label: t('adminFin.tab.reconciliation') },
    { id: 'receipts', label: t('adminFin.tab.receipts') },
    { id: 'providers', label: t('adminFin.tab.providers') },
    { id: 'manual', label: t('adminFin.tab.manual') },
  ];

  const inputCls = 'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-wasit-500 focus:outline-none';
  const labelCls = 'mb-1 block text-xs font-medium text-slate-600';
  const btnCls = 'rounded-md bg-wasit-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-wasit-700 disabled:opacity-50';

  return (
    <AppLayout>
      <SectionHeader
        title={t('adminFin.title')}
        subtitle={t('adminFin.subtitle')}
        action={(
          <button
            type="button"
            data-testid="admin-fin-refresh"
            onClick={() => void loadProviders()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t('common.refresh')}
          </button>
        )}
      />

      {notice && <div role="status" data-testid="admin-fin-notice" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      {error && <div role="alert" data-testid="admin-fin-error" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            data-testid={`admin-fin-tab-${x.id}`}
            onClick={() => { setTab(x.id); setNotice(null); setError(null); }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${tab === x.id ? 'bg-wasit-600 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'settlement' && (
        <Card testId="admin-fin-settlement">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.settlement.heading')}</h2>
          <p className="mb-4 text-xs text-slate-500">{t('adminFin.settlement.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="fin-ext">{t('adminFin.field.externalRef')}</label>
              <input id="fin-ext" data-testid="admin-fin-settlement-externalRef" dir="ltr" className={inputCls} value={settlement.externalRef} onChange={(e) => setSettlement({ ...settlement, externalRef: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-amt">{t('adminFin.field.amount')}</label>
              <input id="fin-amt" data-testid="admin-fin-settlement-amount" dir="ltr" className={inputCls} value={settlement.amount} onChange={(e) => setSettlement({ ...settlement, amount: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-cur">{t('adminFin.field.currency')}</label>
              <input id="fin-cur" data-testid="admin-fin-settlement-currency" dir="ltr" maxLength={3} className={inputCls} value={settlement.currencyCode} onChange={(e) => setSettlement({ ...settlement, currencyCode: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-prov">{t('adminFin.field.providerId')}</label>
              <input id="fin-prov" data-testid="admin-fin-settlement-providerId" dir="ltr" className={inputCls} value={settlement.providerId} onChange={(e) => setSettlement({ ...settlement, providerId: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-sref">{t('adminFin.field.settlementRef')}</label>
              <input id="fin-sref" data-testid="admin-fin-settlement-settlementRef" dir="ltr" className={inputCls} value={settlement.settlementRef} onChange={(e) => setSettlement({ ...settlement, settlementRef: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-pref">{t('adminFin.field.providerRef')}</label>
              <input id="fin-pref" data-testid="admin-fin-settlement-providerRef" dir="ltr" className={inputCls} value={settlement.providerRef} onChange={(e) => setSettlement({ ...settlement, providerRef: e.target.value })} />
            </div>
          </div>
          <div className="mt-4">
            <button type="button" data-testid="admin-fin-settlement-submit" className={btnCls} disabled={busy === 'settlement'} onClick={() => void submitSettlement()}>
              {busy === 'settlement' ? t('common.loading') : t('adminFin.submit.settlement')}
            </button>
          </div>
          {settlementResult && (
            <div data-testid="admin-fin-settlement-result" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p>{t('adminFin.result.applied')}: <strong>{String(settlementResult.applied)}</strong></p>
              <p>{t('adminFin.result.duplicate')}: <strong>{String(settlementResult.duplicate)}</strong></p>
              <p dir="ltr">{t('adminFin.result.settlementEntry')}: {settlementResult.settlementEntryId ?? '—'}</p>
            </div>
          )}

          <div className="mt-6 border-t border-slate-200 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-800">{t('adminFin.suborder.heading')}</h3>
            <p className="mb-3 text-xs text-slate-500">{t('adminFin.suborder.hint')}</p>
            <div>
              <label className={labelCls} htmlFor="fin-reconcile-order">{t('adminFin.suborder.orderId')}</label>
              <input id="fin-reconcile-order" data-testid="admin-fin-suborder-orderId" dir="ltr" className={inputCls} value={reconcileOrderId} onChange={(e) => setReconcileOrderId(e.target.value)} placeholder={t('adminFin.suborder.orderIdPlaceholder')} />
            </div>
            <div className="mt-3">
              <button type="button" data-testid="admin-fin-suborder-reconcile" className={btnCls} disabled={busy === 'reconcile-settlements'} onClick={() => void reconcileSettlements()}>
                {busy === 'reconcile-settlements' ? t('common.loading') : t('adminFin.submit.reconcile')}
              </button>
            </div>
            {reconcileResults && (
              <div data-testid="admin-fin-suborder-results" className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                {reconcileResults.length === 0 ? (
                  <p>{t('adminFin.suborder.none')}</p>
                ) : (
                  <ul className="space-y-1">
                    {reconcileResults.map((r) => (
                      <li key={r.sellerOrderId} dir="ltr" className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{r.sellerOrderId}</span>
                        <Badge color={r.settled ? 'green' : r.duplicate ? 'slate' : 'amber'}>
                          {r.settled ? 'SETTLED' : r.duplicate ? 'ALREADY_SETTLED' : (r.reason ?? 'REJECTED')}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === 'payouts' && (
        <div className="space-y-6">
          <Card testId="admin-fin-payout-create">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.payouts.createHeading')}</h2>
            <p className="mb-4 text-xs text-slate-500">{t('adminFin.payouts.createHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="fin-tx">{t('adminFin.field.transactionId')}</label>
                <input id="fin-tx" data-testid="admin-fin-payout-transactionId" dir="ltr" className={inputCls} value={payoutForm.transactionId} onChange={(e) => setPayoutForm({ ...payoutForm, transactionId: e.target.value })} />
              </div>
              <div>
                <label className={labelCls} htmlFor="fin-so">{t('adminFin.field.sellerOrderId')}</label>
                <input id="fin-so" data-testid="admin-fin-payout-sellerOrderId" dir="ltr" className={inputCls} value={payoutForm.sellerOrderId} onChange={(e) => setPayoutForm({ ...payoutForm, sellerOrderId: e.target.value })} />
                <p className="mt-1 text-[11px] text-slate-400">{t('adminFin.payouts.sellerOrderHint')}</p>
              </div>
              <div>
                <label className={labelCls} htmlFor="fin-pp">{t('adminFin.field.providerId')}</label>
                <input id="fin-pp" data-testid="admin-fin-payout-providerId" dir="ltr" className={inputCls} value={payoutForm.providerId} onChange={(e) => setPayoutForm({ ...payoutForm, providerId: e.target.value })} />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" data-testid="admin-fin-payout-create-submit" className={btnCls} disabled={busy === 'payout-create'} onClick={() => void createPayout()}>
                {busy === 'payout-create' ? t('common.loading') : t('adminFin.submit.payout')}
              </button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="fin-lookup">{t('adminFin.field.payoutId')}</label>
                <input id="fin-lookup" data-testid="admin-fin-payout-lookupId" dir="ltr" className={inputCls} value={lookupId} onChange={(e) => setLookupId(e.target.value)} />
              </div>
              <div className="flex items-end">
                <button type="button" data-testid="admin-fin-payout-lookup" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" disabled={busy === 'payout-lookup'} onClick={() => void lookupPayout()}>
                  {busy === 'payout-lookup' ? t('common.loading') : t('adminFin.submit.lookup')}
                </button>
              </div>
            </div>
          </Card>

          {payout && (
            <Card testId="admin-fin-payout-result">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.payouts.statusHeading')}</h2>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div><dt className="text-slate-500">{t('adminFin.field.payoutId')}</dt><dd dir="ltr" className="font-medium text-slate-800">{payout.id}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.result.status')}</dt><dd><Badge color={PAYOUT_STATUS_COLOR[payout.status] ?? 'slate'} testId="admin-fin-payout-status">{payout.status}</Badge></dd></div>
                <div><dt className="text-slate-500">{t('adminFin.field.amount')}</dt><dd className="font-medium text-slate-800">{formatMoney(payout.amount, payout.currencyCode)}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.field.providerId')}</dt><dd dir="ltr" className="text-slate-800">{payout.providerId}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.result.providerRef')}</dt><dd dir="ltr" className="text-slate-800">{payout.providerRef ?? '—'}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.result.payoutRef')}</dt><dd dir="ltr" className="text-slate-800">{payout.payoutRef ?? '—'}</dd></div>
              </dl>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="fin-ben">{t('adminFin.field.beneficiaryRef')}</label>
                  <input id="fin-ben" data-testid="admin-fin-payout-beneficiaryRef" dir="ltr" className={inputCls} value={beneficiaryRef} onChange={(e) => setBeneficiaryRef(e.target.value)} />
                </div>
                <div className="flex items-end gap-2">
                  <button type="button" data-testid="admin-fin-payout-dispatch" className={btnCls} disabled={busy === 'payout-dispatch'} onClick={() => void dispatchPayout()}>
                    {busy === 'payout-dispatch' ? t('common.loading') : t('adminFin.submit.dispatch')}
                  </button>
                  <button type="button" data-testid="admin-fin-payout-sync" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50" disabled={busy === 'payout-sync'} onClick={() => void syncPayout()}>
                    {busy === 'payout-sync' ? t('common.loading') : t('adminFin.submit.sync')}
                  </button>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-slate-400">{t('adminFin.payouts.completionNote')}</p>
            </Card>
          )}
        </div>
      )}

      {tab === 'reconciliation' && (
        <Card testId="admin-fin-reconciliation">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.recon.heading')}</h2>
          <p className="mb-4 text-xs text-slate-500">{t('adminFin.recon.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="fin-rsrc">{t('adminFin.recon.source')}</label>
              <select id="fin-rsrc" data-testid="admin-fin-recon-source" className={inputCls} value={recon.source} onChange={(e) => setRecon({ ...recon, source: e.target.value as 'PROVIDER' | 'BANK' })}>
                <option value="PROVIDER">PROVIDER</option>
                <option value="BANK">BANK</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-rcur">{t('adminFin.field.currency')}</label>
              <input id="fin-rcur" data-testid="admin-fin-recon-currency" dir="ltr" maxLength={3} className={inputCls} value={recon.currencyCode} onChange={(e) => setRecon({ ...recon, currencyCode: e.target.value })} />
            </div>
          </div>
          <div className="mt-3 space-y-3">
            {([['providerJson', 'adminFin.recon.providerLines', 'admin-fin-recon-provider'], ['bankJson', 'adminFin.recon.bankLines', 'admin-fin-recon-bank'], ['ledgerJson', 'adminFin.recon.ledgerLines', 'admin-fin-recon-ledger']] as const).map(([key, labelKey, testId]) => (
              <div key={key}>
                <label className={labelCls}>{t(labelKey)}</label>
                <textarea
                  data-testid={testId}
                  dir="ltr"
                  rows={3}
                  className={`${inputCls} font-mono`}
                  value={recon[key]}
                  onChange={(e) => setRecon({ ...recon, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="mt-4">
            <button type="button" data-testid="admin-fin-recon-submit" className={btnCls} disabled={busy === 'recon'} onClick={() => void importReconciliation()}>
              {busy === 'recon' ? t('common.loading') : t('adminFin.submit.import')}
            </button>
          </div>
          {reconResult && (
            <div data-testid="admin-fin-recon-result" className="mt-4">
              <div className="mb-2 flex flex-wrap gap-3 text-xs">
                <span data-testid="admin-fin-recon-matched">{t('adminFin.result.matched')}: <strong>{reconResult.report.matched}</strong></span>
                <span data-testid="admin-fin-recon-mismatched">{t('adminFin.result.mismatched')}: <strong>{reconResult.report.mismatched}</strong></span>
                <span dir="ltr">{t('adminFin.result.importId')}: {reconResult.importId}</span>
              </div>
              {reconResult.report.decisions.length === 0 ? (
                <EmptyState title={t('adminFin.recon.empty')} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>{t('adminFin.field.reference')}</th>
                        <th>{t('adminFin.result.status')}</th>
                        <th>{t('adminFin.recon.mismatches')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconResult.report.decisions.map((d) => (
                        <tr key={d.reference} data-testid={`admin-fin-recon-decision-${d.reference}`}>
                          <td dir="ltr" className="text-xs">{d.reference}</td>
                          <td><Badge color={d.status === 'MATCHED' ? 'green' : 'red'}>{d.status}</Badge></td>
                          <td dir="ltr" className="text-[11px] text-slate-500">{d.mismatches.length ? d.mismatches.join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'receipts' && (
        <Card testId="admin-fin-receipts">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.receipts.heading')}</h2>
          <p className="mb-4 text-xs text-slate-500">{t('adminFin.receipts.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="fin-rtx">{t('adminFin.field.transactionId')}</label>
              <input id="fin-rtx" data-testid="admin-fin-receipt-transactionId" dir="ltr" className={inputCls} value={receipt.transactionId} onChange={(e) => setReceipt({ ...receipt, transactionId: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-rsrc2">{t('adminFin.field.source')}</label>
              <select id="fin-rsrc2" data-testid="admin-fin-receipt-source" className={inputCls} value={receipt.source} onChange={(e) => setReceipt({ ...receipt, source: e.target.value as ReceiptSource })}>
                {RECEIPT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-rref">{t('adminFin.field.reference')}</label>
              <input id="fin-rref" data-testid="admin-fin-receipt-reference" dir="ltr" className={inputCls} value={receipt.reference} onChange={(e) => setReceipt({ ...receipt, reference: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-ramt">{t('adminFin.field.amount')}</label>
              <input id="fin-ramt" data-testid="admin-fin-receipt-amount" dir="ltr" className={inputCls} value={receipt.amount} onChange={(e) => setReceipt({ ...receipt, amount: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-rcur2">{t('adminFin.field.currency')}</label>
              <input id="fin-rcur2" data-testid="admin-fin-receipt-currency" dir="ltr" maxLength={3} className={inputCls} value={receipt.currencyCode} onChange={(e) => setReceipt({ ...receipt, currencyCode: e.target.value })} />
            </div>
          </div>
          <div className="mt-4">
            <button type="button" data-testid="admin-fin-receipt-submit" className={btnCls} disabled={busy === 'receipt'} onClick={() => void submitReceipt()}>
              {busy === 'receipt' ? t('common.loading') : t('adminFin.submit.receipt')}
            </button>
          </div>
          {receiptResult && (
            <div data-testid="admin-fin-receipt-result" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p>{t('adminFin.result.status')}: <strong>{receiptResult.status}</strong> · {t('adminFin.result.duplicate')}: <strong>{String(receiptResult.duplicate)}</strong></p>
              <p dir="ltr">{t('adminFin.field.reference')}: {receiptResult.reference} · {formatMoney(receiptResult.amount, receiptResult.currencyCode)} · {receiptResult.source}</p>
            </div>
          )}
        </Card>
      )}

      {tab === 'providers' && (
        <Card testId="admin-fin-providers">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.providers.heading')}</h2>
          {providersLoading ? <Spinner /> : !providers ? (
            <ErrorState message={t('common.error')} onRetry={() => void loadProviders()} />
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-500">{t('adminFin.providers.active')}: <strong dir="ltr">{providers.active}</strong></p>
              <div className="overflow-x-auto">
                <table className="table-base" data-testid="admin-fin-providers-table">
                  <thead>
                    <tr>
                      <th>{t('adminFin.providers.col.id')}</th>
                      <th>{t('adminFin.providers.col.functional')}</th>
                      <th>{t('adminFin.providers.col.available')}</th>
                      <th>{t('adminFin.providers.col.demo')}</th>
                      <th>{t('adminFin.providers.col.transferRef')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.providers.map((p) => (
                      <tr key={p.id} data-testid={`admin-fin-provider-${p.id}`}>
                        <td dir="ltr" className="text-xs font-medium text-slate-800">{p.id}</td>
                        <td><Badge color={p.functional ? 'green' : 'slate'}>{String(p.functional)}</Badge></td>
                        <td><Badge color={p.available ? 'green' : 'amber'}>{String(p.available)}</Badge></td>
                        <td><Badge color={p.demo ? 'teal' : 'slate'}>{String(p.demo)}</Badge></td>
                        <td><Badge color={p.transferReference ? 'green' : 'slate'}>{String(p.transferReference)}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'manual' && (
        <Card testId="admin-fin-manual">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t('adminFin.manual.heading')}</h2>
          <p className="mb-4 text-xs text-slate-500">{t('adminFin.manual.hint')}</p>

          {manualAvailability && !manualAvailability.demoMode && (
            <p data-testid="admin-fin-manual-demo-off" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{t('adminFin.manual.demoOff')}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="fin-manual-order">{t('adminFin.field.orderId')}</label>
              <input id="fin-manual-order" data-testid="admin-fin-manual-orderId" dir="ltr" className={inputCls} value={manual.orderId} onChange={(e) => setManual({ ...manual, orderId: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="fin-manual-ref">{t('adminFin.field.paymentReference')}</label>
              <input id="fin-manual-ref" data-testid="admin-fin-manual-paymentReference" dir="ltr" className={inputCls} value={manual.paymentReference} onChange={(e) => setManual({ ...manual, paymentReference: e.target.value })} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" data-testid="admin-fin-manual-lookup" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50" disabled={busy === 'manual-lookup'} onClick={() => void lookupManual()}>
              {busy === 'manual-lookup' ? t('common.loading') : t('adminFin.submit.lookup')}
            </button>
            <button type="button" data-testid="admin-fin-manual-submit" className={btnCls} disabled={busy === 'manual-complete' || !manualView?.eligible} onClick={() => void completeManual()}>
              {busy === 'manual-complete' ? t('common.loading') : t('adminFin.submit.manualComplete')}
            </button>
          </div>

          {manualView && (
            <div data-testid="admin-fin-manual-view" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <dl className="grid gap-2 sm:grid-cols-2">
                <div><dt className="text-slate-500">{t('adminFin.field.orderId')}</dt><dd dir="ltr" className="font-medium text-slate-800">{manualView.order.id}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.manual.paymentStatus')}</dt><dd><Badge color={manualView.order.paymentStatus === 'PAID' ? 'green' : 'amber'} testId="admin-fin-manual-paymentStatus">{manualView.order.paymentStatus}</Badge></dd></div>
                <div><dt className="text-slate-500">{t('adminFin.manual.settlementStatus')}</dt><dd dir="ltr" className="text-slate-800">{manualView.order.settlementStatus}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.field.amount')}</dt><dd className="font-medium text-slate-800">{formatMoney(manualView.order.grandTotal, manualView.order.currencyCode)}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.manual.intentProvider')}</dt><dd dir="ltr" className="text-slate-800">{manualView.intent?.provider ?? '—'}</dd></div>
                <div><dt className="text-slate-500">{t('adminFin.manual.intentStatus')}</dt><dd dir="ltr" className="text-slate-800">{manualView.intent?.status ?? '—'}</dd></div>
              </dl>
              {!manualView.demoMode && (
                <p data-testid="admin-fin-manual-demo-off" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-700">{t('adminFin.manual.demoOff')}</p>
              )}
            </div>
          )}

          {manualResult && (
            <div data-testid="admin-fin-manual-result" className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p>{t('adminFin.result.alreadyPaid')}: <strong>{String(manualResult.alreadyPaid)}</strong></p>
              <p dir="ltr">{t('adminFin.field.paymentReference')}: {manualResult.paymentReference} · {formatMoney(manualResult.amount, manualResult.currencyCode)}</p>
            </div>
          )}
        </Card>
      )}
    </AppLayout>
  );
}

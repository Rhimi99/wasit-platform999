import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiCall, apiErrorMessage, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { LedgerEntry, PayoutRail, PayoutRecord, PayoutRails, PayoutStatus, PayoutListResult, ReconciliationDecision, ReconciliationImportResult, ReceiptSource } from '@/lib/types';

/**
 * `/admin/finance` — the operator surface for the money-movement routes under
 * `/api/admin/finance/*` (settlement confirm, seller payouts, reconciliation
 * import and WASIT receipt).
 *
 * Scope is deliberately narrow: this page only calls endpoints that already
 * exist and only renders actions the server actually supports. It does not
 * derive money state — settlement is evidence-gated, a payout's amount is
 * computed server-side, reconciliation is classified by the engine, and a
 * receipt is proven by independent statement evidence. Access is guarded in the
 * SPA (AdminOnly) *and* on the server (the `/api/admin` mount requires
 * ADMIN/SUPER_ADMIN), so hiding a control here is never the only protection.
 */

const PAYOUT_STATUS_COLOR: Record<string, 'green' | 'amber' | 'slate' | 'red' | 'teal'> = {
  CREATED: 'slate',
  PROCESSING: 'amber',
  COMPLETED: 'green',
  FAILED: 'red',
  HELD: 'teal',
};

const PAYOUT_LIST_PAGE_SIZE = 10;

const PAYOUT_STATUSES: PayoutStatus[] = ['CREATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'HELD'];

/** A rail can be dispatched only while the payout is not terminal. */
function isDispatchable(status: string): boolean {
  return status === 'CREATED' || status === 'HELD';
}

/** Sync re-checks the rail; only meaningful once a payout is out for processing. */
function isSyncable(p: PayoutRecord): boolean {
  return p.status === 'PROCESSING';
}

export function AdminFinancePage() {
  const { t } = useI18n();

  const [rails, setRails] = useState<PayoutRails | null>(null);
  const [railsError, setRailsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Payout-capable rails come from the *payment* provider description, because the
  // payout create path resolves the provider through the payment resolver and
  // refuses any rail without the `payout` capability. Offering the payout-resolver
  // list here would surface rails (e.g. `manual`) that create then rejects.
  const [payoutRails, setPayoutRails] = useState<Array<{ id: string; available: boolean }>>([]);

  const [settlementEntries, setSettlementEntries] = useState<LedgerEntry[]>([]);

  // Settlement form
  const [externalRef, setExternalRef] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TND');
  const [settlementProvider, setSettlementProvider] = useState('open-checkout');
  const [settlementRef, setSettlementRef] = useState('');
  const [providerRef, setProviderRef] = useState('');
  const [settling, setSettling] = useState(false);
  const [settlementNotice, setSettlementNotice] = useState<string | null>(null);
  const [settlementError, setSettlementError] = useState<string | null>(null);

  // Payout form / detail
  const [transactionId, setTransactionId] = useState('');
  const [payoutProvider, setPayoutProvider] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutNotice, setPayoutNotice] = useState<string | null>(null);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payout, setPayout] = useState<PayoutRecord | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [beneficiaryRef, setBeneficiaryRef] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // Payout list (read-only desk): filter + pagination + its own load/error state.
  const [listStatus, setListStatus] = useState<'' | PayoutStatus>('');
  const [listPage, setListPage] = useState(1);
  const [payoutList, setPayoutList] = useState<PayoutListResult | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Reconciliation import (PS-04) — provider/bank feed -> three-way report.
  const [reconSource, setReconSource] = useState<'PROVIDER' | 'BANK'>('PROVIDER');
  const [reconCurrency, setReconCurrency] = useState('TND');
  const [reconProviderId, setReconProviderId] = useState('');
  const [reconLines, setReconLines] = useState('');
  const [reconBusy, setReconBusy] = useState(false);
  const [reconNotice, setReconNotice] = useState<string | null>(null);
  const [reconError, setReconError] = useState<string | null>(null);
  const [reconResult, setReconResult] = useState<ReconciliationImportResult | null>(null);

  // WASIT receipt — independent proof that commission funds landed.
  const [receiptTransactionId, setReceiptTransactionId] = useState('');
  const [receiptSource, setReceiptSource] = useState<ReceiptSource>('BANK_STATEMENT');
  const [receiptReference, setReceiptReference] = useState('');
  const [receiptAmount, setReceiptAmount] = useState('');
  const [receiptCurrency, setReceiptCurrency] = useState('TND');
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptNotice, setReceiptNotice] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const loadRails = useCallback(async () => {
    const res = await apiCall(() => api.adminPayoutRails());
    setRails(res.data ?? null);
    setRailsError(res.error);
  }, []);

  const loadLedger = useCallback(async () => {
    const res = await apiCall(() => api.adminLedger());
    setSettlementEntries((res.data?.items ?? []).filter((e) => e.entryType === 'SETTLEMENT'));
  }, []);

  const loadPayoutList = useCallback(async (page: number, status: '' | PayoutStatus) => {
    setListLoading(true);
    setListError(null);
    const res = await apiCall(() =>
      api.adminListPayouts({ page, pageSize: PAYOUT_LIST_PAGE_SIZE, ...(status ? { status } : {}) }),
    );
    if (res.error) {
      setListError(res.error);
      setPayoutList(null);
    } else {
      setPayoutList(res.data ?? null);
    }
    setListLoading(false);
  }, []);

  useEffect(() => {
    void loadPayoutList(listPage, listStatus);
  }, [loadPayoutList, listPage, listStatus]);

  useEffect(() => {
    void (async () => {
      const methods = await apiCall(() => api.getPaymentMethods());
      setPayoutRails(
        (methods.data?.providers ?? [])
          .filter((p) => p.payout === true && p.available === true)
          .map((p) => ({ id: p.id, available: p.available })),
      );
      await Promise.all([loadRails(), loadLedger()]);
      setLoading(false);
    })();
  }, [loadRails, loadLedger]);

  const availableRails = useMemo(() => payoutRails, [payoutRails]);

  const canConfirmSettlement =
    externalRef.trim() !== '' &&
    amount.trim() !== '' &&
    Number(amount) > 0 &&
    currency.trim().length === 3 &&
    settlementProvider.trim() !== '' &&
    settlementRef.trim() !== '';

  const canCreatePayout = transactionId.trim() !== '' && payoutProvider.trim() !== '';

  async function confirmSettlement() {
    if (!canConfirmSettlement) {
      setSettlementError(t('adminFinance.settlementRequired'));
      return;
    }
    setSettling(true);
    setSettlementError(null);
    setSettlementNotice(null);
    try {
      const result = await api.adminConfirmSettlement({
        externalRef: externalRef.trim(),
        amount: amount.trim(),
        currencyCode: currency.trim().toUpperCase(),
        providerId: settlementProvider.trim(),
        settlementRef: settlementRef.trim(),
        ...(providerRef.trim() ? { providerRef: providerRef.trim() } : {}),
      });
      setSettlementNotice(result.duplicate ? t('adminFinance.settlementDuplicate') : t('adminFinance.settlementApplied'));
      setSettlementRef('');
      setProviderRef('');
      await loadLedger();
    } catch (e) {
      setSettlementError(apiErrorMessage(e));
    } finally {
      setSettling(false);
    }
  }

  async function createPayout() {
    if (!canCreatePayout) {
      setPayoutError(t('adminFinance.payoutRequired'));
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    setPayoutNotice(null);
    try {
      const created = await api.adminCreatePayout({
        transactionId: transactionId.trim(),
        providerId: payoutProvider.trim(),
        idempotencyKey: `admin-finance-ui-${transactionId.trim()}`,
      });
      setPayout(created);
      setLookupId(created.id);
      setPayoutNotice(t('adminFinance.payoutCreated'));
      // Surface the new payout in the list without changing its state.
      await loadPayoutList(1, listStatus);
      setListPage(1);
    } catch (e) {
      setPayoutError(apiErrorMessage(e));
    } finally {
      setPayoutBusy(false);
    }
  }

  async function lookupPayout() {
    if (!lookupId.trim()) return;
    setPayoutBusy(true);
    setPayoutError(null);
    setPayoutNotice(null);
    try {
      setPayout(await api.adminGetPayout(lookupId.trim()));
    } catch (e) {
      setPayout(null);
      setPayoutError(apiErrorMessage(e));
    } finally {
      setPayoutBusy(false);
    }
  }

  async function dispatch() {
    if (!payout) return;
    setActionBusy(true);
    setPayoutError(null);
    try {
      const res = await api.adminDispatchPayout(payout.id, beneficiaryRef.trim());
      setPayout(res.payout);
      setPayoutNotice(`${t('adminFinance.payoutStatus')}: ${res.payout.status}`);
    } catch (e) {
      setPayoutError(apiErrorMessage(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function sync() {
    if (!payout) return;
    setActionBusy(true);
    setPayoutError(null);
    try {
      const res = await api.adminSyncPayout(payout.id);
      setPayout(res.payout);
      setPayoutNotice(`${t('adminFinance.payoutStatus')}: ${res.payout.status} · ${res.providerStatus}`);
    } catch (e) {
      setPayoutError(apiErrorMessage(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function importReconciliation() {
    let lines: unknown;
    try {
      lines = reconLines.trim() ? JSON.parse(reconLines) : [];
    } catch {
      setReconError(t('adminFinance.reconRequired'));
      return;
    }
    if (!Array.isArray(lines) || reconCurrency.trim().length !== 3) {
      setReconError(t('adminFinance.reconRequired'));
      return;
    }
    setReconBusy(true);
    setReconError(null);
    setReconNotice(null);
    try {
      const result = await api.adminImportReconciliation({
        source: reconSource,
        currencyCode: reconCurrency.trim().toUpperCase(),
        importKey: `admin-finance-ui-${Date.now()}`,
        ...(reconProviderId.trim() ? { providerId: reconProviderId.trim() } : {}),
        ...(reconSource === 'PROVIDER' ? { provider: lines } : { bank: lines }),
      });
      setReconResult(result);
      setReconNotice(result.duplicate ? t('adminFinance.reconDuplicate') : t('adminFinance.reconImported'));
    } catch (e) {
      setReconError(apiErrorMessage(e));
    } finally {
      setReconBusy(false);
    }
  }

  async function recordReceipt() {
    setReceiptBusy(true);
    setReceiptError(null);
    setReceiptNotice(null);
    try {
      const result = await api.adminRecordReceipt({
        transactionId: receiptTransactionId.trim(),
        evidence: {
          source: receiptSource,
          reference: receiptReference.trim(),
          amount: receiptAmount.trim(),
          currencyCode: receiptCurrency.trim().toUpperCase(),
        },
      });
      setReceiptNotice(result.duplicate ? t('adminFinance.receiptDuplicate') : t('adminFinance.receiptRecorded'));
    } catch (e) {
      setReceiptError(apiErrorMessage(e));
    } finally {
      setReceiptBusy(false);
    }
  }

  function flag(ok: boolean) {
    return ok
      ? <Badge color="green">{t('adminFinance.yes')}</Badge>
      : <Badge color="slate">{t('adminFinance.no')}</Badge>;
  }

  return (
    <AppLayout>
      <SectionHeader title={t('adminFinance.title')} subtitle={t('adminFinance.subtitle')} />

      {/* Payout rails — what the payout resolver knows, and what each rail can prove. */}
      <Card className="mb-6 overflow-x-auto" testId="admin-finance-rails">
        <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.rails')}</h3>
        <p className="mb-3 text-xs text-slate-500">{t('adminFinance.railsHint')}</p>
        {loading ? <Spinner /> : railsError ? <ErrorState message={railsError} onRetry={() => void loadRails()} /> : !rails ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-600">
              {t('adminFinance.activeRail')}: <span className="font-medium text-slate-800">{rails.active}</span>
            </p>
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('adminFinance.rail')}</th>
                  <th>{t('adminFinance.railFunctional')}</th>
                  <th>{t('adminFinance.railAvailable')}</th>
                  <th>{t('adminFinance.railTransferRef')}</th>
                  <th>{t('adminFinance.railDemo')}</th>
                </tr>
              </thead>
              <tbody>
                {rails.providers.map((r: PayoutRail) => (
                  <tr key={r.id} data-testid={`admin-finance-rail-${r.id}`}>
                    <td className="font-medium">{r.id}</td>
                    <td>{flag(r.functional)}</td>
                    <td>{r.available ? <Badge color="green">{t('adminFinance.railAvailable')}</Badge> : <Badge color="amber">{t('adminFinance.railUnavailable')}</Badge>}</td>
                    <td>{r.transferReference ? flag(true) : <Badge color="amber">{t('adminFinance.railNoTransferRef')}</Badge>}</td>
                    <td>{flag(r.demo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Confirm settlement */}
        <Card testId="admin-finance-settlement">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.settlement')}</h3>
          <p className="mb-3 text-xs text-slate-500">{t('adminFinance.settlementHint')}</p>

          {settlementNotice && (
            <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-finance-settlement-notice">{settlementNotice}</p>
          )}
          {settlementError && (
            <p className="mb-2 text-sm text-red-600" role="alert" data-testid="admin-finance-settlement-error">{settlementError}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.externalRef')}
              <input
                className="input mt-1"
                data-testid="admin-finance-external-ref"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.amount')}
              <input
                className="input mt-1"
                inputMode="decimal"
                data-testid="admin-finance-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.currency')}
              <input
                className="input mt-1"
                maxLength={3}
                data-testid="admin-finance-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.settlementProvider')}
              <input
                className="input mt-1"
                data-testid="admin-finance-settlement-provider"
                value={settlementProvider}
                onChange={(e) => setSettlementProvider(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.settlementRef')}
              <input
                className="input mt-1"
                data-testid="admin-finance-settlement-ref"
                value={settlementRef}
                onChange={(e) => setSettlementRef(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.providerRefOptional')}
              <input
                className="input mt-1"
                data-testid="admin-finance-provider-ref"
                value={providerRef}
                onChange={(e) => setProviderRef(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn-primary mt-3"
            data-testid="admin-finance-confirm-settlement"
            disabled={settling || !canConfirmSettlement}
            onClick={() => void confirmSettlement()}
          >
            {settling ? '…' : t('adminFinance.confirmSettlement')}
          </button>
        </Card>

        {/* Seller payouts */}
        <Card testId="admin-finance-payouts">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.payouts')}</h3>
          <p className="mb-3 text-xs text-slate-500">{t('adminFinance.payoutsHint')}</p>

          {payoutNotice && (
            <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-finance-payout-notice">{payoutNotice}</p>
          )}
          {payoutError && (
            <p className="mb-2 text-sm text-red-600" role="alert" data-testid="admin-finance-payout-error">{payoutError}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.transactionId')}
              <input
                className="input mt-1"
                data-testid="admin-finance-transaction-id"
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.payoutProvider')}
              <select
                className="input mt-1"
                data-testid="admin-finance-payout-provider"
                value={payoutProvider}
                onChange={(e) => setPayoutProvider(e.target.value)}
              >
                <option value="">—</option>
                {availableRails.map((r) => (
                  <option key={r.id} value={r.id}>{r.id}</option>
                ))}
              </select>
            </label>
          </div>
          {availableRails.length === 0 && (
            <p className="mt-2 text-xs text-amber-700" data-testid="admin-finance-no-rails">{t('adminFinance.railHint')}</p>
          )}
          <button
            type="button"
            className="btn-primary mt-3"
            data-testid="admin-finance-create-payout"
            disabled={payoutBusy || !canCreatePayout}
            onClick={() => void createPayout()}
          >
            {payoutBusy ? '…' : t('adminFinance.createPayout')}
          </button>

          <div className="mt-4 border-t border-slate-100 pt-3">
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.lookupPayout')}
              <div className="mt-1 flex gap-2">
                <input
                  className="input"
                  data-testid="admin-finance-lookup-id"
                  value={lookupId}
                  onChange={(e) => setLookupId(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="admin-finance-lookup-payout"
                  disabled={payoutBusy || !lookupId.trim()}
                  onClick={() => void lookupPayout()}
                >
                  {t('common.search')}
                </button>
              </div>
            </label>
          </div>

          {payout && (
            <div className="mt-4 rounded-md border border-slate-200 p-3" data-testid="admin-finance-payout-detail">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-800">{t('adminFinance.payoutDetail')}</h4>
                <Badge color={PAYOUT_STATUS_COLOR[payout.status] ?? 'slate'} testId="admin-finance-payout-status">{payout.status}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-slate-500">{t('field.id')}</dt>
                <dd className="truncate text-slate-700" data-testid="admin-finance-payout-id">{payout.id}</dd>
                <dt className="text-slate-500">{t('adminFinance.transactionId')}</dt>
                <dd className="truncate text-slate-700">{payout.transactionId}</dd>
                <dt className="text-slate-500">{t('adminFinance.payoutAmount')}</dt>
                <dd className="text-slate-700">{formatMoney(payout.amount, payout.currencyCode)}</dd>
                <dt className="text-slate-500">{t('adminFinance.payoutProvider')}</dt>
                <dd className="text-slate-700">{payout.providerId}</dd>
                <dt className="text-slate-500">{t('adminFinance.payoutRef')}</dt>
                <dd className="truncate text-slate-700">{payout.payoutRef ?? '—'}</dd>
                <dt className="text-slate-500">{t('adminFinance.providerRef')}</dt>
                <dd className="truncate text-slate-700">{payout.providerRef ?? '—'}</dd>
                {payout.failureReason && (
                  <>
                    <dt className="text-slate-500">{t('adminFinance.failureReason')}</dt>
                    <dd className="text-red-600">{payout.failureReason}</dd>
                  </>
                )}
              </dl>

              {isDispatchable(payout.status) && (
                <div className="mt-3">
                  <label className="text-xs font-medium text-slate-600">
                    {t('adminFinance.beneficiaryRef')}
                    <input
                      className="input mt-1"
                      data-testid="admin-finance-beneficiary-ref"
                      value={beneficiaryRef}
                      onChange={(e) => setBeneficiaryRef(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-primary mt-2"
                    data-testid="admin-finance-dispatch"
                    disabled={actionBusy || !beneficiaryRef.trim()}
                    onClick={() => void dispatch()}
                  >
                    {t('adminFinance.dispatch')}
                  </button>
                  <p className="mt-1 text-xs text-slate-400">{t('adminFinance.dispatchHint')}</p>
                </div>
              )}

              {isSyncable(payout) && (
                <div className="mt-3">
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="admin-finance-sync"
                    disabled={actionBusy}
                    onClick={() => void sync()}
                  >
                    {t('adminFinance.sync')}
                  </button>
                  <p className="mt-1 text-xs text-slate-400">{t('adminFinance.syncHint')}</p>
                </div>
              )}

              {(payout.status === 'COMPLETED' || payout.status === 'FAILED') && (
                <p className="mt-3 text-xs text-slate-400" data-testid="admin-finance-payout-terminal">{t('adminFinance.payoutTerminal')}</p>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Reconciliation + WASIT receipt — the two money-movement stages beyond
          settlement. Both are evidence-driven; the UI renders the server's
          classification and never reinterprets a MISMATCH as a match. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card testId="admin-finance-reconciliation">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.reconciliation')}</h3>
          <p className="mb-3 text-xs text-slate-500">{t('adminFinance.reconciliationHint')}</p>

          {reconNotice && (
            <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-finance-recon-notice">{reconNotice}</p>
          )}
          {reconError && (
            <p className="mb-2 text-sm text-red-600" role="alert" data-testid="admin-finance-recon-error">{reconError}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.reconSource')}
              <select
                className="input mt-1"
                data-testid="admin-finance-recon-source"
                value={reconSource}
                onChange={(e) => setReconSource(e.target.value as 'PROVIDER' | 'BANK')}
              >
                <option value="PROVIDER">PROVIDER</option>
                <option value="BANK">BANK</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.reconCurrency')}
              <input
                className="input mt-1"
                maxLength={3}
                data-testid="admin-finance-recon-currency"
                value={reconCurrency}
                onChange={(e) => setReconCurrency(e.target.value.toUpperCase())}
              />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.reconProviderId')}
              <input
                className="input mt-1"
                data-testid="admin-finance-recon-provider-id"
                value={reconProviderId}
                onChange={(e) => setReconProviderId(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.reconLines')}
              <textarea
                className="input mt-1 font-mono text-xs"
                rows={4}
                data-testid="admin-finance-recon-lines"
                value={reconLines}
                onChange={(e) => setReconLines(e.target.value)}
              />
            </label>
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('adminFinance.reconLinesHint')}</p>
          <button
            type="button"
            className="btn-primary mt-3"
            data-testid="admin-finance-recon-import"
            disabled={reconBusy || reconCurrency.trim().length !== 3}
            onClick={() => void importReconciliation()}
          >
            {reconBusy ? '…' : t('adminFinance.reconImport')}
          </button>

          {reconResult && (
            <div className="mt-4 border-t border-slate-100 pt-3" data-testid="admin-finance-recon-report">
              <div className="mb-2 flex items-center gap-3">
                <h4 className="text-sm font-semibold text-slate-800">{t('adminFinance.reconReport')}</h4>
                <Badge color="green" testId="admin-finance-recon-matched">{t('adminFinance.reconMatched')}: {reconResult.report.matched}</Badge>
                <Badge color="red" testId="admin-finance-recon-mismatched">{t('adminFinance.reconMismatched')}: {reconResult.report.mismatched}</Badge>
              </div>
              {reconResult.report.decisions.length === 0 ? (
                <EmptyState title={t('adminFinance.reconNoDecisions')} />
              ) : (
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('adminFinance.reconReference')}</th>
                      <th>{t('adminFinance.reconStatus')}</th>
                      <th>{t('adminFinance.reconMismatches')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconResult.report.decisions.map((d: ReconciliationDecision) => (
                      <tr key={d.reference} data-testid={`admin-finance-recon-decision-${d.reference}`}>
                        <td className="font-medium">{d.reference}</td>
                        <td>{d.status === 'MATCHED' ? <Badge color="green">{d.status}</Badge> : <Badge color="red">{d.status}</Badge>}</td>
                        <td className="text-xs text-slate-500">{d.mismatches.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Card>

        <Card testId="admin-finance-receipt">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.receipt')}</h3>
          <p className="mb-3 text-xs text-slate-500">{t('adminFinance.receiptHint')}</p>

          {receiptNotice && (
            <p className="mb-2 text-sm text-green-700" role="status" data-testid="admin-finance-receipt-notice">{receiptNotice}</p>
          )}
          {receiptError && (
            <p className="mb-2 text-sm text-red-600" role="alert" data-testid="admin-finance-receipt-error">{receiptError}</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              {t('adminFinance.receiptTransactionId')}
              <input
                className="input mt-1"
                data-testid="admin-finance-receipt-transaction-id"
                value={receiptTransactionId}
                onChange={(e) => setReceiptTransactionId(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.receiptSource')}
              <select
                className="input mt-1"
                data-testid="admin-finance-receipt-source"
                value={receiptSource}
                onChange={(e) => setReceiptSource(e.target.value as ReceiptSource)}
              >
                <option value="BANK_STATEMENT">BANK_STATEMENT</option>
                <option value="ACQUIRER">ACQUIRER</option>
                <option value="PROVIDER">PROVIDER</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.receiptReference')}
              <input
                className="input mt-1"
                data-testid="admin-finance-receipt-reference"
                value={receiptReference}
                onChange={(e) => setReceiptReference(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.receiptAmount')}
              <input
                className="input mt-1"
                inputMode="decimal"
                data-testid="admin-finance-receipt-amount"
                value={receiptAmount}
                onChange={(e) => setReceiptAmount(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              {t('adminFinance.receiptCurrency')}
              <input
                className="input mt-1"
                maxLength={3}
                data-testid="admin-finance-receipt-currency"
                value={receiptCurrency}
                onChange={(e) => setReceiptCurrency(e.target.value.toUpperCase())}
              />
            </label>
          </div>
          <button
            type="button"
            className="btn-primary mt-3"
            data-testid="admin-finance-receipt-record"
            disabled={
              receiptBusy ||
              !receiptTransactionId.trim() ||
              !receiptReference.trim() ||
              !(Number(receiptAmount) > 0) ||
              receiptCurrency.trim().length !== 3
            }
            onClick={() => void recordReceipt()}
          >
            {receiptBusy ? '…' : t('adminFinance.receiptRecord')}
          </button>
          <p className="mt-1 text-xs text-slate-400">{t('adminFinance.receiptNote')}</p>
        </Card>
      </div>

      {/* Payout list — read-only desk over the existing payouts table. It renders
          exactly what the server stores; it never dispatches, syncs or advances a
          status, so PROCESSING cannot become COMPLETED from here. */}
      <Card className="mt-6 overflow-x-auto" testId="admin-finance-payout-list">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">{t('adminFinance.payoutList')}</h3>
            <p className="text-xs text-slate-500">{t('adminFinance.payoutListHint')}</p>
          </div>
          <label className="text-xs font-medium text-slate-600">
            {t('adminFinance.payoutListFilter')}
            <select
              className="input mt-1"
              data-testid="admin-finance-payout-list-status"
              value={listStatus}
              onChange={(e) => {
                setListStatus(e.target.value as '' | PayoutStatus);
                setListPage(1);
              }}
            >
              <option value="">{t('adminFinance.payoutListAll')}</option>
              {PAYOUT_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>

        {listLoading ? (
          <Spinner />
        ) : listError ? (
          <ErrorState message={listError} onRetry={() => void loadPayoutList(listPage, listStatus)} />
        ) : !payoutList || payoutList.items.length === 0 ? (
          <EmptyState title={t('adminFinance.payoutListEmpty')} />
        ) : (
          <>
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('field.id')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('field.amount')}</th>
                  <th>{t('adminFinance.payoutProvider')}</th>
                  <th>{t('adminFinance.transactionId')}</th>
                  <th>{t('common.date')}</th>
                </tr>
              </thead>
              <tbody>
                {payoutList.items.map((p) => (
                  <tr key={p.id} data-testid={`admin-finance-payout-row-${p.id}`}>
                    <td className="truncate font-medium" data-testid="admin-finance-payout-row-id">{p.id}</td>
                    <td>
                      <Badge color={PAYOUT_STATUS_COLOR[p.status] ?? 'slate'} testId="admin-finance-payout-row-status">{p.status}</Badge>
                    </td>
                    <td data-testid="admin-finance-payout-row-amount">{formatMoney(p.amount, p.currencyCode)}</td>
                    <td>{p.providerId}</td>
                    <td className="truncate text-xs text-slate-500">{p.transactionId}</td>
                    <td>{formatDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-500">
              <span data-testid="admin-finance-payout-list-total">
                {t('adminFinance.payoutListTotal')}: {payoutList.pagination.total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="admin-finance-payout-list-prev"
                  disabled={listPage <= 1 || listLoading}
                  onClick={() => setListPage((n) => Math.max(1, n - 1))}
                >
                  {t('adminFinance.payoutListPrev')}
                </button>
                <span data-testid="admin-finance-payout-list-page">
                  {payoutList.pagination.page} / {Math.max(1, Math.ceil(payoutList.pagination.total / payoutList.pagination.pageSize))}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="admin-finance-payout-list-next"
                  disabled={
                    listLoading ||
                    listPage >= Math.max(1, Math.ceil(payoutList.pagination.total / payoutList.pagination.pageSize))
                  }
                  onClick={() => setListPage((n) => n + 1)}
                >
                  {t('adminFinance.payoutListNext')}
                </button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Settlement ledger entries — read-only proof that a settlement landed. */}
      <Card className="mt-6 overflow-x-auto" testId="admin-finance-settlement-history">
        <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('adminFinance.settlementHistory')}</h3>
        <p className="mb-3 text-xs text-slate-500">{t('adminFinance.settlementHistoryHint')}</p>
        {loading ? <Spinner /> : settlementEntries.length === 0 ? (
          <EmptyState title={t('adminFinance.noSettlements')} />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('field.type')}</th>
                <th>{t('field.direction')}</th>
                <th>{t('field.amount')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {settlementEntries.map((e) => (
                <tr key={e.id} data-testid={`admin-finance-settlement-${e.id}`}>
                  <td>{formatDate(e.createdAt)}</td>
                  <td>{t('ledger.entry.settlement')}</td>
                  <td>{e.direction === 'CREDIT' ? <Badge color="green">{t('ledger.credit')}</Badge> : <Badge color="red">{t('ledger.debit')}</Badge>}</td>
                  <td>{formatMoney(e.amount, e.currencyCode)}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </AppLayout>
  );
}

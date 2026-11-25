import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, apiCall, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type {
  BuyerRfq,
  CreateRfqPayload,
  RfqComparison,
  RfqQuote,
  RfqQuoteStatus,
  RfqRecipientStatus,
  RfqStatus,
  RfqTimelineEntry,
  RfqView,
  SellerRfq,
} from '@/lib/types';

/**
 * B2B-01 — the RFQ surface.
 *
 * Everything the screens show is the server's projection: prices are read from
 * `quotes.lines[].lineTotal`, never recomputed here, and no screen sends a
 * company or seller id — the server derives the caller's side from the session.
 * When the server refuses an action the message is shown as-is, so a 409 (state
 * machine) or 422 (validation) reaches the user with its real reason.
 */

const RFQ_STATUS_COLOR: Record<RfqStatus, 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo'> = {
  DRAFT: 'slate',
  OPEN: 'teal',
  AWARDED: 'green',
  CANCELLED: 'red',
  EXPIRED: 'amber',
  CLOSED: 'indigo',
};

const RECIPIENT_STATUS_COLOR: Record<RfqRecipientStatus, 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo'> = {
  INVITED: 'slate',
  VIEWED: 'indigo',
  QUOTED: 'teal',
  DECLINED: 'red',
  WITHDRAWN: 'amber',
};

const QUOTE_STATUS_COLOR: Record<RfqQuoteStatus, 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo'> = {
  SUBMITTED: 'teal',
  SUPERSEDED: 'slate',
  ACCEPTED: 'green',
  REJECTED: 'red',
  WITHDRAWN: 'amber',
  EXPIRED: 'amber',
};

function StatusBadge({ status }: { status: RfqStatus | RfqRecipientStatus | RfqQuoteStatus }) {
  const { t } = useI18n();
  const colors = { ...RFQ_STATUS_COLOR, ...RECIPIENT_STATUS_COLOR, ...QUOTE_STATUS_COLOR } as Record<string, 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo'>;
  return <Badge color={colors[status] ?? 'slate'}>{t(`rfq.status.${status}`)}</Badge>;
}

function isBuyerView(view: RfqView): view is BuyerRfq {
  return 'recipients' in view;
}

/* ------------------------------------------------------------------------- */
/* Buyer: list + creation                                                    */
/* ------------------------------------------------------------------------- */

interface DraftLine {
  freeTextName: string;
  productId: string;
  quantity: string;
  unit: string;
  targetPrice: string;
}

function emptyLine(): DraftLine {
  return { freeTextName: '', productId: '', quantity: '1', unit: '', targetPrice: '' };
}

export function DashboardRfqListPage() {
  const { t } = useI18n();
  const [rfqs, setRfqs] = useState<BuyerRfq[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [currencyCode, setCurrencyCode] = useState('TND');
  const [neededBy, setNeededBy] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; rfqNumber: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiCall(() => api.rfqs()).then((res) => {
      if (!active) return;
      setLoading(false);
      if (res.error) setError(res.error);
      else setRfqs(res.data ?? []);
    });
    return () => { active = false; };
  }, [reloadKey]);

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    const items = lines
      .map((line) => ({
        freeTextName: line.freeTextName.trim() || null,
        productId: line.productId.trim() || null,
        quantity: line.quantity.trim(),
        unit: line.unit.trim() || null,
        targetPrice: line.targetPrice.trim() || null,
      }))
      .filter((line) => line.freeTextName || line.productId);

    if (items.length === 0) {
      setFormError(t('rfq.form.noItems'));
      return;
    }

    const payload: CreateRfqPayload = {
      title: title.trim(),
      description: description.trim() || null,
      currencyCode: currencyCode.trim().toUpperCase(),
      neededBy: neededBy ? new Date(neededBy).toISOString() : null,
      items,
    };

    setSaving(true);
    const res = await apiCall(() => api.createRfq(payload));
    setSaving(false);
    if (res.error) {
      setFormError(res.error);
      return;
    }
    setCreated(res.data ?? null);
    setTitle('');
    setDescription('');
    setLines([emptyLine()]);
    setNeededBy('');
    setCreating(false);
    setReloadKey((k) => k + 1);
  }

  return (
    <AppLayout>
      <SectionHeader
        title={t('rfq.title')}
        subtitle={t('rfq.subtitle')}
        action={
          <button type="button" className="btn btn-primary" onClick={() => setCreating((v) => !v)} data-testid="rfq-new">
            {creating ? t('common.cancel') : t('rfq.newRequest')}
          </button>
        }
      />

      {created && (
        <Card className="mb-4" testId="rfq-created">
          <p className="text-sm text-emerald-700" role="status">
            {t('rfq.created').replace('{number}', created.rfqNumber)}{' '}
            <Link className="underline" to={`/dashboard/rfqs/${created.id}`}>
              {t('rfq.openDetail')}
            </Link>
          </p>
        </Card>
      )}

      {creating && (
        <Card className="mb-4">
          <form onSubmit={submit} className="grid gap-3" data-testid="rfq-create-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label" htmlFor="rfq-title">{t('rfq.form.title')} *</label>
                <input id="rfq-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} />
              </div>
              <div>
                <label className="label" htmlFor="rfq-currency">{t('rfq.form.currency')}</label>
                <select id="rfq-currency" className="input" value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
                  {['TND', 'EUR', 'USD', 'GBP'].map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="rfq-needed">{t('rfq.form.neededBy')}</label>
                <input id="rfq-needed" className="input" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="rfq-description">{t('rfq.form.description')}</label>
                <textarea id="rfq-description" className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
              </div>
            </div>

            <fieldset className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-sm font-semibold text-slate-700">{t('rfq.form.items')}</legend>
              <div className="space-y-3">
                {lines.map((line, index) => (
                  <div key={index} className="grid gap-2 sm:grid-cols-12" data-testid={`rfq-line-${index}`}>
                    <div className="sm:col-span-4">
                      <input
                        className="input"
                        placeholder={t('rfq.form.itemName')}
                        value={line.freeTextName}
                        onChange={(e) => updateLine(index, { freeTextName: e.target.value })}
                        maxLength={200}
                        aria-label={t('rfq.form.itemName')}
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <input
                        className="input"
                        placeholder={t('rfq.form.productId')}
                        value={line.productId}
                        onChange={(e) => updateLine(index, { productId: e.target.value })}
                        maxLength={36}
                        dir="ltr"
                        aria-label={t('rfq.form.productId')}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <input
                        className="input"
                        placeholder={t('rfq.form.quantity')}
                        value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })}
                        inputMode="decimal"
                        aria-label={t('rfq.form.quantity')}
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <input
                        className="input"
                        placeholder={t('rfq.form.unit')}
                        value={line.unit}
                        onChange={(e) => updateLine(index, { unit: e.target.value })}
                        maxLength={40}
                        aria-label={t('rfq.form.unit')}
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <input
                        className="input"
                        placeholder={t('rfq.form.targetPrice')}
                        value={line.targetPrice}
                        onChange={(e) => updateLine(index, { targetPrice: e.target.value })}
                        inputMode="decimal"
                        aria-label={t('rfq.form.targetPrice')}
                      />
                    </div>
                    <div className="sm:col-span-1 flex items-center">
                      <button
                        type="button"
                        className="text-xs text-red-600 underline"
                        onClick={() => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-secondary mt-3" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                {t('rfq.form.addLine')}
              </button>
            </fieldset>

            <p className="text-xs text-slate-500">{t('rfq.form.draftNote')}</p>
            {formError && <p className="text-sm text-red-600" role="alert">{formError}</p>}
            <div>
              <button type="submit" className="btn btn-primary" disabled={saving} data-testid="rfq-create">
                {saving ? t('common.saving') : t('rfq.form.saveDraft')}
              </button>
            </div>
          </form>
        </Card>
      )}

      {loading && <Spinner />}
      {!loading && error && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}
      {!loading && !error && rfqs && rfqs.length === 0 && (
        <EmptyState title={t('rfq.empty')} hint={t('rfq.emptyHint')} />
      )}

      {!loading && !error && rfqs && rfqs.length > 0 && (
        <div className="grid gap-3" data-testid="rfq-list">
          {rfqs.map((rfq) => (
            <Card key={rfq.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link to={`/dashboard/rfqs/${rfq.id}`} className="text-sm font-semibold text-wasit-700 hover:underline">
                    {rfq.title}
                  </Link>
                  <p className="text-xs text-slate-500" dir="ltr">{rfq.rfqNumber}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={rfq.status} />
                  <span className="text-xs text-slate-500">
                    {t('rfq.meta.counts')
                      .replace('{items}', String(rfq.items.length))
                      .replace('{sellers}', String(rfq.recipients.length))
                      .replace('{quotes}', String(rfq.quoteCount))}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {t('rfq.meta.currency')}: {rfq.currencyCode}
                {rfq.expiresAt ? ` · ${t('rfq.meta.expiresAt')}: ${formatDate(rfq.expiresAt)}` : ''}
              </p>
            </Card>
          ))}
        </div>
      )}
    </AppLayout>
  );
}

/* ------------------------------------------------------------------------- */
/* Seller: invitation inbox                                                  */
/* ------------------------------------------------------------------------- */

export function DashboardRfqInboxPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<SellerRfq[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiCall(() => api.rfqInbox()).then((res) => {
      if (!active) return;
      setLoading(false);
      if (res.error) setError(res.error);
      else setItems(res.data ?? []);
    });
    return () => { active = false; };
  }, [reloadKey]);

  return (
    <AppLayout>
      <SectionHeader title={t('rfq.inbox.title')} subtitle={t('rfq.inbox.subtitle')} />
      {loading && <Spinner />}
      {!loading && error && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}
      {!loading && !error && items && items.length === 0 && (
        <EmptyState title={t('rfq.inbox.empty')} hint={t('rfq.inbox.emptyHint')} />
      )}
      {!loading && !error && items && items.length > 0 && (
        <div className="grid gap-3" data-testid="rfq-inbox">
          {items.map((rfq) => (
            <Card key={rfq.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link to={`/dashboard/rfqs/${rfq.id}`} className="text-sm font-semibold text-wasit-700 hover:underline">
                    {rfq.title}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {rfq.buyer.legalName}
                    {rfq.buyer.verified && <span className="ms-1 text-emerald-600">✓</span>}
                    {' · '}
                    <span dir="ltr">{rfq.rfqNumber}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={rfq.status} />
                  <StatusBadge status={rfq.myInvitation.status} />
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {t('rfq.meta.currency')}: {rfq.currencyCode}
                {rfq.expiresAt ? ` · ${t('rfq.meta.expiresAt')}: ${formatDate(rfq.expiresAt)}` : ''}
              </p>
            </Card>
          ))}
        </div>
      )}
    </AppLayout>
  );
}

/* ------------------------------------------------------------------------- */
/* Detail: buyer and seller in one screen, decided by the server projection  */
/* ------------------------------------------------------------------------- */

export function DashboardRfqDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [view, setView] = useState<RfqView | null>(null);
  const [quotes, setQuotes] = useState<RfqQuote[]>([]);
  const [timeline, setTimeline] = useState<RfqTimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiCall(() => api.rfq(id)).then(async (res) => {
      if (!active) return;
      if (res.error || !res.data) {
        setLoading(false);
        setError(res.error ?? 'RFQ');
        return;
      }
      setView(res.data);
      const [q, tl] = await Promise.all([apiCall(() => api.rfqQuotes(id)), apiCall(() => api.rfqTimeline(id))]);
      if (!active) return;
      setQuotes(q.data ?? []);
      setTimeline(tl.data ?? []);
      setLoading(false);
    });
    return () => { active = false; };
  }, [id, reloadKey]);

  if (loading) {
    return (
      <AppLayout>
        <SectionHeader title={t('rfq.detail.title')} />
        <Spinner />
      </AppLayout>
    );
  }
  if (error || !view) {
    return (
      <AppLayout>
        <SectionHeader title={t('rfq.detail.title')} />
        <ErrorState message={error ?? t('rfq.detail.notFound')} onRetry={reload} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <SectionHeader
        title={view.title}
        subtitle={`${view.rfqNumber} · ${view.currencyCode}`}
        action={
          <Link to={isBuyerView(view) ? '/dashboard/rfqs' : '/dashboard/rfq-inbox'} className="btn btn-secondary">
            {t('rfq.detail.back')}
          </Link>
        }
      />
      {notice && <p className="mb-3 text-sm text-emerald-700" role="status">{notice}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={view.status} />
            {view.neededBy && <span className="text-xs text-slate-500">{t('rfq.form.neededBy')}: {formatDate(view.neededBy)}</span>}
            {view.expiresAt && <span className="text-xs text-slate-500">{t('rfq.meta.expiresAt')}: {formatDate(view.expiresAt)}</span>}
          </div>
          {view.description && <p className="mb-3 text-sm text-slate-600">{view.description}</p>}
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('rfq.detail.items')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="rfq-items">
              <thead>
                <tr className="text-start text-xs uppercase text-slate-400">
                  <th className="py-1 text-start">{t('rfq.form.itemName')}</th>
                  <th className="py-1 text-start">{t('rfq.form.quantity')}</th>
                  <th className="py-1 text-start">{t('rfq.form.unit')}</th>
                  <th className="py-1 text-start">{t('rfq.form.targetPrice')}</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((item) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="py-1">{item.freeTextName ?? item.productId}</td>
                    <td className="py-1" dir="ltr">{item.quantity}</td>
                    <td className="py-1">{item.unit ?? '—'}</td>
                    <td className="py-1" dir="ltr">{item.targetPrice ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            {isBuyerView(view) ? t('rfq.detail.buyerSide') : t('rfq.detail.sellerSide')}
          </h3>
          {isBuyerView(view) ? (
            <BuyerPanel view={view} quotes={quotes} onChanged={reload} busy={busy} setBusy={setBusy} setNotice={setNotice} />
          ) : (
            <SellerPanel view={view} quotes={quotes} onChanged={reload} busy={busy} setBusy={setBusy} setNotice={setNotice} />
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('rfq.detail.timeline')}</h3>
        {timeline.length === 0 ? (
          <p className="text-xs text-slate-500">{t('rfq.detail.noTimeline')}</p>
        ) : (
          <ol className="space-y-2" data-testid="rfq-timeline">
            {timeline.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <Badge color={entry.actorType === 'SYSTEM' ? 'amber' : 'slate'}>{t(`rfq.event.${entry.eventType}`)}</Badge>
                {entry.quoteRevision && <span dir="ltr">rev {entry.quoteRevision}</span>}
                <span className="text-slate-400">{formatDate(entry.createdAt)}</span>
                {typeof entry.payload?.reason === 'string' && <span>· {entry.payload.reason}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </AppLayout>
  );
}

interface PanelProps {
  view: RfqView;
  quotes: RfqQuote[];
  onChanged: () => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setNotice: (value: string | null) => void;
}

/* -------------------------------- buyer ---------------------------------- */

/**
 * Offer comparison. Read-only, and rendered only from the server's ranking: the
 * component never sorts or sums prices itself, so what the buyer sees is exactly
 * what the API decided was comparable.
 */
function ComparisonPanel({ rfqId, currencyCode }: { rfqId: string; currencyCode: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RfqComparison | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.rfqComparison(rfqId));
    setLoading(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setData(res.data ?? null);
  }, [rfqId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) void load();
  }

  return (
    <div className="rounded-lg border border-slate-200 p-2" data-testid="rfq-comparison">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase text-slate-400">{t('rfq.compare.title')}</h4>
        <button type="button" className="text-[11px] text-wasit-700 underline" onClick={toggle}>
          {open ? t('rfq.compare.hide') : t('rfq.compare.show')}
        </button>
      </div>

      {open && loading && <Spinner />}
      {open && error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}

      {open && data && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-slate-500">{t('rfq.compare.subtitle')}</p>

          {data.rows.length === 0 ? (
            <p className="text-xs text-slate-500">{t('rfq.compare.empty')}</p>
          ) : (
            <>
              <p className="text-[11px] text-slate-600" data-testid="rfq-comparison-summary">
                {t('rfq.compare.summary').replace('{count}', String(data.summary.comparableQuotes))}
                {' · '}
                {t('rfq.compare.lowest')}:{' '}
                <span dir="ltr">{formatMoney(data.summary.lowestTotal ?? '0', currencyCode)}</span>
                {' · '}
                {t('rfq.compare.average')}:{' '}
                <span dir="ltr">{formatMoney(data.summary.averageTotal ?? '0', currencyCode)}</span>
                {data.summary.fastestLeadTimeDays !== null && (
                  <>
                    {' · '}
                    {t('rfq.compare.fastest')}: {data.summary.fastestLeadTimeDays} {t('rfq.compare.days')}
                  </>
                )}
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-[11px]" data-testid="rfq-comparison-table">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="text-start font-medium">{t('rfq.compare.rank')}</th>
                      <th className="text-start font-medium">{t('rfq.compare.seller')}</th>
                      <th className="text-start font-medium">{t('rfq.compare.total')}</th>
                      <th className="text-start font-medium">{t('rfq.compare.lead')}</th>
                      <th className="text-start font-medium">{t('rfq.compare.validity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.quoteId} className="border-t border-slate-100 align-top">
                        <td className="py-1" dir="ltr">
                          {row.priceRank}
                          {row.priceRank === 1 && (
                            <span className="ms-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                              {t('rfq.compare.best')}
                            </span>
                          )}
                        </td>
                        <td className="py-1">
                          {row.sellerName}
                          <span className="ms-1 text-[10px] uppercase text-slate-400">{row.sellerType}</span>
                          <span className="ms-1 text-[10px] text-slate-400" dir="ltr">rev {row.revision}</span>
                        </td>
                        <td className="py-1 font-semibold" dir="ltr">
                          {formatMoney(row.itemsTotal, row.currencyCode)}
                        </td>
                        <td className="py-1" dir="ltr">
                          {row.leadTimeDays === null ? '—' : `${row.leadTimeDays} ${t('rfq.compare.days')}`}
                        </td>
                        <td className="py-1" dir="ltr">{formatDate(row.validUntil)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(data.rows.some((r) => r.paymentTerms || r.notes)) && (
                <ul className="space-y-1">
                  {data.rows
                    .filter((r) => r.paymentTerms || r.notes)
                    .map((r) => (
                      <li key={r.quoteId} className="text-[11px] text-slate-600">
                        <span className="font-medium">{r.sellerName}</span>
                        {r.paymentTerms && <span> — {r.paymentTerms}</span>}
                        {r.notes && <span> — {r.notes}</span>}
                      </li>
                    ))}
                </ul>
              )}

              <div>
                <h5 className="mb-1 text-[11px] font-semibold text-slate-500">{t('rfq.compare.unitPrices')}</h5>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]" data-testid="rfq-comparison-lines">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="text-start font-medium">{t('rfq.compare.item')}</th>
                        {data.rows.map((row) => (
                          <th key={row.quoteId} className="text-start font-medium">{row.sellerName}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.id} className="border-t border-slate-100">
                          <td className="py-1">
                            {item.freeTextName ?? item.id}
                            <span className="ms-1 text-[10px] text-slate-400" dir="ltr">
                              × {item.quantity}
                            </span>
                          </td>
                          {data.rows.map((row) => {
                            const line = row.lines.find((l) => l.rfqItemId === item.id);
                            return (
                              <td key={`${row.quoteId}-${item.id}`} className="py-1" dir="ltr">
                                {line ? formatMoney(line.unitPrice, row.currencyCode) : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {data.summary.currencyMixed && (
                <p className="text-[11px] text-amber-700">{t('rfq.compare.currencyMixed')}</p>
              )}
            </>
          )}

          {data.excluded.length > 0 && (
            <div>
              <h5 className="mb-1 text-[11px] font-semibold text-slate-500">{t('rfq.compare.excluded')}</h5>
              <ul className="space-y-1" data-testid="rfq-comparison-excluded">
                {data.excluded.map((entry) => (
                  <li key={entry.quoteId} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>{entry.sellerName}</span>
                    <span className="text-slate-400" dir="ltr">rev {entry.revision}</span>
                    <Badge color="slate">
                      {t(`rfq.compare.reason.${entry.reason}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BuyerPanel({ view, quotes, onChanged, busy, setBusy, setNotice }: PanelProps) {
  const { t } = useI18n();
  const buyerView = view as BuyerRfq;
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<RfqQuote | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<RfqQuote | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [revisionsFor, setRevisionsFor] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RfqQuote[]>([]);
  const [panelError, setPanelError] = useState<string | null>(null);

  const sellerName = useMemo(() => {
    const map = new Map(buyerView.recipients.map((r) => [r.sellerId, r.sellerName]));
    return (sellerId: string) => map.get(sellerId) ?? sellerId;
  }, [buyerView.recipients]);

  const isOpen = view.status === 'OPEN';
  const canCancel = view.status === 'DRAFT' || view.status === 'OPEN';

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setPanelError(null);
    const res = await apiCall(action);
    setBusy(false);
    if (res.error) {
      setPanelError(res.error);
      return;
    }
    setNotice(done);
    onChanged();
  }

  async function loadRevisions(quote: RfqQuote) {
    setPanelError(null);
    const res = await apiCall(() => api.rfqQuoteRevisions(view.id, quote.id));
    if (res.error) {
      setPanelError(res.error);
      return;
    }
    setRevisions(res.data ?? []);
    setRevisionsFor(quote.id);
  }

  return (
    <div className="space-y-3">
      {view.status === 'DRAFT' && <SendPanel rfqId={view.id} onChanged={onChanged} setNotice={setNotice} />}

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">{t('rfq.detail.recipients')}</h4>
        <ul className="space-y-1 text-sm" data-testid="rfq-recipients">
          {buyerView.recipients.map((recipient) => (
            <li key={recipient.sellerId} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-1">
              <span>
                {recipient.sellerName}{' '}
                <span className="text-[10px] uppercase text-slate-400">{recipient.sellerType}</span>
              </span>
              <StatusBadge status={recipient.status} />
              {recipient.declineReason && <span className="w-full text-[11px] text-slate-500">“{recipient.declineReason}”</span>}
            </li>
          ))}
          {buyerView.recipients.length === 0 && <li className="text-xs text-slate-500">{t('rfq.detail.notSent')}</li>}
        </ul>
      </div>

      {buyerView.status === 'AWARDED' && buyerView.orderId && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs" data-testid="rfq-awarded">
          <p className="font-semibold text-emerald-900">{t('rfq.accept.awarded')}</p>
          <Link to={`/dashboard/orders/${buyerView.orderId}`} className="mt-1 inline-block text-emerald-800 underline">
            {t('rfq.accept.viewOrder')}
          </Link>
        </div>
      )}

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase text-slate-400">{t('rfq.detail.quotes')}</h4>
        {quotes.length === 0 && <p className="text-xs text-slate-500">{t('rfq.detail.noQuotes')}</p>}
        <ul className="space-y-2">
          {quotes.map((quote) => (
            <li key={quote.id} className="rounded-lg border border-slate-200 p-2" data-testid={`rfq-quote-${quote.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{sellerName(quote.sellerId)}</span>
                <span className="text-sm font-semibold" dir="ltr">{formatMoney(quote.itemsTotal, quote.currencyCode)}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <StatusBadge status={quote.status} />
                <span dir="ltr">rev {quote.revision}</span>
                {quote.leadTimeDays !== null && <span>{t('rfq.quote.leadTime')}: {quote.leadTimeDays}</span>}
                <span>{t('rfq.quote.validUntil')}: {formatDate(quote.validUntil)}</span>
              </div>
              {quote.paymentTerms && <p className="mt-1 text-[11px] text-slate-500">{quote.paymentTerms}</p>}
              {quote.decisionReason && (
                <p className="mt-1 text-[11px] text-red-600">{t('rfq.quote.reason')}: {quote.decisionReason}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" className="text-[11px] text-wasit-700 underline" onClick={() => loadRevisions(quote)}>
                  {t('rfq.quote.history')}
                </button>
                {isOpen && quote.status === 'SUBMITTED' && (
                  <>
                    <button
                      type="button"
                      className="text-[11px] font-semibold text-emerald-700 underline"
                      data-testid={`rfq-accept-${quote.id}`}
                      onClick={() => setAcceptTarget(quote)}
                    >
                      {t('rfq.quote.accept')}
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-red-600 underline"
                      onClick={() => { setRejectTarget(quote); setRejectReason(''); }}
                    >
                      {t('rfq.quote.reject')}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <ComparisonPanel rfqId={view.id} currencyCode={view.currencyCode} />

      {revisionsFor && (
        <div className="rounded-lg bg-slate-50 p-2 text-xs" data-testid="rfq-revisions">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold text-slate-700">{t('rfq.quote.history')}</span>
            <button type="button" className="text-slate-500 underline" onClick={() => setRevisionsFor(null)}>{t('common.close')}</button>
          </div>
          <ul className="space-y-1">
            {revisions.map((rev) => (
              <li key={rev.id} className="flex flex-wrap items-center gap-2">
                <span dir="ltr">rev {rev.revision}</span>
                <StatusBadge status={rev.status} />
                <span dir="ltr">{formatMoney(rev.itemsTotal, rev.currencyCode)}</span>
                <span className="text-slate-400">{formatDate(rev.submittedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {acceptTarget && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs" data-testid="rfq-accept-confirm">
          <p className="font-semibold text-emerald-900">{t('rfq.accept.title')}</p>
          <p className="mt-1 text-emerald-800">{t('rfq.accept.warning')}</p>
          <ul className="mt-1 space-y-1 text-emerald-900" dir="ltr">
            <li>{sellerName(acceptTarget.sellerId)}</li>
            <li>
              {formatMoney(acceptTarget.itemsTotal, acceptTarget.currencyCode)} · rev {acceptTarget.revision}
            </li>
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              data-testid="rfq-accept-confirm-button"
              onClick={() => {
                const target = acceptTarget;
                setAcceptTarget(null);
                void run(() => api.rfqAcceptQuote(view.id, target.id), t('rfq.accept.done'));
              }}
            >
              {t('rfq.accept.confirm')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setAcceptTarget(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {rejectTarget && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-2" data-testid="rfq-reject-form">
          <label className="label" htmlFor="rfq-reject-reason">{t('rfq.quote.rejectReason')} *</label>
          <textarea
            id="rfq-reject-reason"
            className="input min-h-16"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            maxLength={1000}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || rejectReason.trim().length < 3}
              onClick={() => {
                const target = rejectTarget;
                setRejectTarget(null);
                void run(() => api.rejectRfqQuote(view.id, target.id, rejectReason.trim()), t('rfq.quote.rejected'));
              }}
              data-testid="rfq-reject-submit"
            >
              {t('rfq.quote.confirmReject')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setRejectTarget(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {canCancel && (
        <div className="border-t border-slate-100 pt-2">
          {cancelling ? (
            <div className="space-y-2" data-testid="rfq-cancel-form">
              <label className="label" htmlFor="rfq-cancel-reason">{t('rfq.cancelReason')}</label>
              <input id="rfq-cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => { setCancelling(false); void run(() => api.cancelRfq(view.id, reason), t('rfq.cancelled')); }}
                  data-testid="rfq-cancel-submit"
                >
                  {t('rfq.confirmCancel')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setCancelling(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-sm text-red-600 underline" onClick={() => setCancelling(true)}>
              {t('rfq.cancel')}
            </button>
          )}
        </div>
      )}

      {panelError && <p className="text-sm text-red-600" role="alert">{panelError}</p>}
    </div>
  );
}

function SendPanel({ rfqId, onChanged, setNotice }: { rfqId: string; onChanged: () => void; setNotice: (v: string | null) => void }) {
  const { t } = useI18n();
  const [sellers, setSellers] = useState<Array<{ id: string; name: string; type: 'SUPPLIER' | 'MERCHANT' }>>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      apiCall(() => api.directorySuppliers({ q: search || undefined, pageSize: 20 })),
      apiCall(() => api.directoryMerchants({ q: search || undefined, pageSize: 20 })),
    ]).then(([sup, mer]) => {
      if (!active) return;
      setLoading(false);
      setSellers([
        ...(sup.data?.items ?? []).map((s) => ({ id: s.id, name: s.companyName, type: 'SUPPLIER' as const })),
        ...(mer.data?.items ?? []).map((m) => ({ id: m.id, name: m.storeName, type: 'MERCHANT' as const })),
      ]);
    });
    return () => { active = false; };
  }, [search]);

  return (
    <div className="rounded-lg border border-wasit-200 bg-wasit-50/40 p-2" data-testid="rfq-send-panel">
      <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">{t('rfq.send.title')}</h4>
      <input
        className="input mb-2"
        placeholder={t('rfq.send.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label={t('rfq.send.search')}
      />
      {loading && <p className="text-xs text-slate-500">{t('common.loading')}</p>}
      <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
        {sellers.map((seller) => (
          <li key={seller.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(seller.id)}
                onChange={(e) =>
                  setSelected((prev) => (e.target.checked ? [...prev, seller.id] : prev.filter((x) => x !== seller.id)))
                }
              />
              <span>{seller.name}</span>
              <span className="text-[10px] uppercase text-slate-400">{seller.type}</span>
            </label>
          </li>
        ))}
        {!loading && sellers.length === 0 && <li className="text-xs text-slate-500">{t('rfq.send.noSellers')}</li>}
      </ul>
      <label className="mt-2 flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        <span>{t('rfq.send.disclosure')}</span>
      </label>
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
      <button
        type="button"
        className="btn btn-primary mt-2"
        disabled={busy || selected.length === 0 || !ack}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await apiCall(() => api.sendRfq(rfqId, selected, ack));
          setBusy(false);
          if (res.error) {
            setError(res.error);
            return;
          }
          setNotice(t('rfq.sent').replace('{count}', String(res.data?.recipientCount ?? selected.length)));
          onChanged();
        }}
        data-testid="rfq-send"
      >
        {busy ? t('common.saving') : t('rfq.send.action')}
      </button>
      <p className="mt-1 text-[11px] text-slate-500">{t('rfq.send.consentNote')}</p>
    </div>
  );
}

/* -------------------------------- seller --------------------------------- */

function SellerPanel({ view, quotes, onChanged, busy, setBusy, setNotice }: PanelProps) {
  const { t } = useI18n();
  const sellerView = view as SellerRfq;
  const items = sellerView.items;
  const mine = quotes[0] ?? null;

  const [prices, setPrices] = useState<Record<string, string>>({});
  const [leadTime, setLeadTime] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [panelError, setPanelError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  useEffect(() => {
    if (!mine) return;
    const next: Record<string, string> = {};
    for (const line of mine.lines) next[line.rfqItemId] = line.unitPrice;
    setPrices(next);
    setLeadTime(mine.leadTimeDays !== null ? String(mine.leadTimeDays) : '');
    setPaymentTerms(mine.paymentTerms ?? '');
    setNotes(mine.notes ?? '');
  }, [mine?.id]);

  const invitationStatus = sellerView.myInvitation.status;
  const canQuote = view.status === 'OPEN' && invitationStatus !== 'DECLINED';

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setPanelError(null);
    const res = await apiCall(action);
    setBusy(false);
    if (res.error) {
      setPanelError(res.error);
      return;
    }
    setNotice(done);
    onChanged();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">{t('rfq.detail.myInvitation')}</span>
        <StatusBadge status={invitationStatus} />
      </div>
      <p className="text-xs text-slate-500">
        {t('rfq.detail.buyer')}: {sellerView.buyer.legalName}
        {sellerView.buyer.verified && <span className="ms-1 text-emerald-600">✓</span>}
      </p>

      {mine && (
        <div className="rounded-lg border border-slate-200 p-2" data-testid="rfq-my-quote">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold" dir="ltr">{formatMoney(mine.itemsTotal, mine.currencyCode)}</span>
            <StatusBadge status={mine.status} />
          </div>
          <p className="mt-1 text-[11px] text-slate-500" dir="ltr">
            rev {mine.revision} · {t('rfq.quote.validUntil')}: {formatDate(mine.validUntil)}
          </p>
          {mine.decisionReason && (
            <p className="mt-1 text-[11px] text-red-600">{t('rfq.quote.reason')}: {mine.decisionReason}</p>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {mine.status === 'SUBMITTED' && (
              <button
                type="button"
                className="text-[11px] text-red-600 underline"
                disabled={busy}
                onClick={() => void run(() => api.withdrawRfqQuote(view.id, mine.id), t('rfq.quote.withdrawn'))}
                data-testid="rfq-withdraw"
              >
                {t('rfq.quote.withdraw')}
              </button>
            )}
          </div>
        </div>
      )}

      {canQuote && (
        <form
          className="space-y-2"
          data-testid="rfq-quote-form"
          onSubmit={(event) => {
            event.preventDefault();
            const lines = items.map((item) => ({
              rfqItemId: item.id,
              unitPrice: (prices[item.id] ?? '').trim(),
              quantity: item.quantity,
            }));
            if (lines.some((line) => !line.unitPrice)) {
              setPanelError(t('rfq.quote.missingPrices'));
              return;
            }
            void run(
              () =>
                api.submitRfqQuote(view.id, {
                  currencyCode: view.currencyCode,
                  leadTimeDays: leadTime.trim() ? Number(leadTime) : null,
                  paymentTerms: paymentTerms.trim() || null,
                  notes: notes.trim() || null,
                  lines,
                }),
              t('rfq.quote.submitted'),
            );
          }}
        >
          <h4 className="text-xs font-semibold uppercase text-slate-400">
            {mine ? t('rfq.quote.revise') : t('rfq.quote.submit')}
          </h4>
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="flex-1 text-xs text-slate-600">
                {item.freeTextName ?? item.productId}
                <span className="ms-1 text-slate-400" dir="ltr">× {item.quantity}</span>
              </span>
              <input
                className="input w-28"
                inputMode="decimal"
                placeholder={t('rfq.quote.unitPrice')}
                aria-label={`${t('rfq.quote.unitPrice')} ${item.freeTextName ?? item.id}`}
                value={prices[item.id] ?? ''}
                onChange={(e) => setPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
              />
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="input"
              inputMode="numeric"
              placeholder={t('rfq.quote.leadTime')}
              aria-label={t('rfq.quote.leadTime')}
              value={leadTime}
              onChange={(e) => setLeadTime(e.target.value)}
            />
            <input
              className="input"
              placeholder={t('rfq.quote.paymentTerms')}
              aria-label={t('rfq.quote.paymentTerms')}
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              maxLength={200}
            />
          </div>
          <textarea
            className="input min-h-16"
            placeholder={t('rfq.quote.notes')}
            aria-label={t('rfq.quote.notes')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={5000}
          />
          <p className="text-[11px] text-slate-500">{t('rfq.quote.priceNote')}</p>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="rfq-quote-submit">
            {busy ? t('common.saving') : t('rfq.quote.send')}
          </button>
        </form>
      )}

      {(invitationStatus === 'INVITED' || invitationStatus === 'VIEWED') && view.status === 'OPEN' && (
        <div className="border-t border-slate-100 pt-2">
          {declining ? (
            <div className="space-y-2" data-testid="rfq-decline-form">
              <label className="label" htmlFor="rfq-decline-reason">{t('rfq.declineReason')}</label>
              <input
                id="rfq-decline-reason"
                className="input"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                maxLength={1000}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => { setDeclining(false); void run(() => api.declineRfq(view.id, declineReason), t('rfq.declined')); }}
                  data-testid="rfq-decline-submit"
                >
                  {t('rfq.confirmDecline')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setDeclining(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-sm text-red-600 underline" onClick={() => setDeclining(true)}>
              {t('rfq.decline')}
            </button>
          )}
        </div>
      )}

      {panelError && <p className="text-sm text-red-600" role="alert">{panelError}</p>}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, formatDate, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { ComparisonGroup, InventoryItem, InventoryMovement } from '@/lib/types';

type StockFilter = 'ALL' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'IN_STOCK';

interface MovementModalState {
  item: InventoryItem;
  mode: 'add' | 'remove' | 'set';
}

export function DashboardInventoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StockFilter>('ALL');
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [movementsOpen, setMovementsOpen] = useState(false);
  const [modal, setModal] = useState<MovementModalState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.listMyInventory({ q, status: filter }));
    setItems(res.data?.items ?? []);
    setTotal(res.data?.total ?? 0);
    setError(res.error);
    setLoading(false);
  }, [q, filter]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const summary = {
    inStock: items.filter((i) => !i.lowStock && !i.outOfStock).length,
    low: items.filter((i) => i.lowStock).length,
    out: items.filter((i) => i.outOfStock).length,
  };

  async function openMovements(item: InventoryItem) {
    setSelected(item);
    setMovementsOpen(true);
    const res = await apiCall(() => api.inventoryMovements(item.id));
    setMovements(res.data?.items ?? []);
  }

  async function refresh() {
    await load();
  }

  return (
    <AppLayout>
      <SectionHeader
        title={t('dashboard.inventory')}
        subtitle={t('inventory.subtitle')}
        action={
          <button className="btn-primary" onClick={refresh} type="button">
            {t('common.refresh')}
          </button>
        }
      />

      {notice && (
        <div className="mb-3 rounded-md border border-wasit-200 bg-wasit-50 px-4 py-2 text-sm text-wasit-700">{notice}</div>
      )}

      {/* KPI cards */}
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <p className="text-xs text-slate-500">{t('inventory.totalSkus')}</p>
          <p className="mt-1 text-3xl font-bold text-slate-900">{total}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('inventory.inStock')}</p>
          <p className="mt-1 text-3xl font-bold text-wasit-700">{summary.inStock}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('inventory.lowStock')}</p>
          <p className="mt-1 text-3xl font-bold text-amber-600">{summary.low}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('inventory.outOfStock')}</p>
          <p className="mt-1 text-3xl font-bold text-red-600">{summary.out}</p>
        </Card>
      </div>

      {/* Search + filter */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          className="input max-w-sm"
          placeholder={t('inventory.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {(['ALL', 'LOW_STOCK', 'OUT_OF_STOCK', 'IN_STOCK'] as StockFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                filter === f
                  ? 'border-wasit-600 bg-wasit-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-wasit-500 hover:text-wasit-700'
              }`}
            >
              {t(`inventory.filter.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={load} /> : items.length === 0 ? (
        <EmptyState title={t('inventory.empty')} hint={t('inventory.emptyHint')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>{t('nav.products')}</th>
                <th>{t('field.sku')}</th>
                <th>{t('inventory.variant')}</th>
                <th className="text-end">{t('inventory.quantity')}</th>
                <th className="text-end">{t('inventory.reserved')}</th>
                <th className="text-end">{t('inventory.available')}</th>
                <th className="text-end">{t('inventory.threshold')}</th>
                <th>{t('common.status')}</th>
                <th className="text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div className="text-sm font-semibold text-slate-800">{it.productName}</div>
                    <div className="text-xs text-slate-400">{formatDate(it.updatedAt)}</div>
                  </td>
                  <td className="text-xs">{it.variantSku ?? it.productSku}</td>
                  <td>{it.variantSku ? it.variantName ?? it.variantSku : '—'}</td>
                  <td className="text-end font-semibold text-slate-800">{it.quantity}</td>
                  <td className="text-end text-slate-600">{it.reservedQuantity > 0 ? it.reservedQuantity : '—'}</td>
                  <td className="text-end font-medium text-wasit-700">{it.availableQuantity}</td>
                  <td className="text-end text-slate-500">{it.lowStockThreshold}</td>
                  <td>
                    {it.outOfStock ? <Badge color="red">{t('inventory.out')}</Badge>
                      : it.lowStock ? <Badge color="amber">{t('inventory.low')}</Badge>
                      : <Badge color="green">{t('inventory.in')}</Badge>}
                  </td>
                  <td className="text-end whitespace-nowrap">
                    <button className="text-sm font-medium text-wasit-700 hover:underline" type="button" onClick={() => openMovements(it)}>
                      {t('inventory.history')}
                    </button>
                    <span className="mx-1 text-slate-300">|</span>
                    <button className="text-sm font-medium text-wasit-700 hover:underline" type="button" onClick={() => setModal({ item: it, mode: 'add' })}>
                      {t('inventory.addStock')}
                    </button>
                    <span className="mx-1 text-slate-300">|</span>
                    <button className="text-sm font-medium text-red-600 hover:underline" type="button" onClick={() => setModal({ item: it, mode: 'remove' })}>
                      {t('inventory.removeStock')}
                    </button>
                    <span className="mx-1 text-slate-300">|</span>
                    <button className="text-sm font-medium text-slate-600 hover:underline" type="button" onClick={() => setModal({ item: it, mode: 'set' })}>
                      {t('inventory.settings')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Stock adjustment modal */}
      {modal && (
        <StockModal
          item={modal.item}
          mode={modal.mode}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setModal(null);
            setNotice(msg);
            load();
            setTimeout(() => setNotice(null), 5000);
          }}
        />
      )}

      {/* Movements drawer */}
      {movementsOpen && selected && (
        <MovementsPanel
          item={selected}
          movements={movements}
          onClose={() => setMovementsOpen(false)}
        />
      )}
    </AppLayout>
  );
}

function StockModal({ item, mode, onClose, onDone }: { item: InventoryItem; mode: MovementModalState['mode']; onClose: () => void; onDone: (msg: string) => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [threshold, setThreshold] = useState(String(item.lowStockThreshold));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSet = mode === 'set';
  const qty = Math.trunc(Number(amount) || 0);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      if (isSet) {
        const res = await apiCall(() => api.updateInventory(item.id, { lowStockThreshold: Math.max(0, Math.trunc(Number(threshold) || 0)), quantity: qty }));
        if (res.error) throw new Error(res.error);
        onDone(t('inventory.updated'));
      } else {
        const change = mode === 'add' ? qty : -qty;
        const movementType = mode === 'add' ? 'PURCHASE' : 'SALE';
        const res = await apiCall(() => api.adjustInventory(item.id, { quantityChange: change, movementType, reason }));
        if (res.error) throw new Error(res.error);
        onDone(`${mode === 'add' ? t('inventory.added') : t('inventory.removed')} (${change > 0 ? '+' : ''}${change})`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h3 className="text-base font-bold text-slate-900">
          {isSet ? t('inventory.setStock') : mode === 'add' ? t('inventory.addStock') : t('inventory.removeStock')}
          <span className="ml-2 text-sm font-normal text-slate-500">{item.productName}</span>
        </h3>

        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">{t('inventory.current')}</span>
            <span className="font-semibold text-slate-800">{item.quantity} ({t('inventory.available')}: {item.availableQuantity})</span>
          </div>

          {!isSet && (
            <div>
              <label className="label">{mode === 'add' ? t('inventory.addQty') : t('inventory.removeQty')}</label>
              <input className="input" type="number" min={mode === 'remove' ? 1 : 0} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          {isSet && (
            <>
              <div>
                <label className="label">{t('inventory.newQty')}</label>
                <input className="input" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div>
                <label className="label">{t('inventory.threshold')}</label>
                <input className="input" type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </div>
            </>
          )}

          <div>
            <label className="label">{t('inventory.reason')}</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isSet ? '—' : t('inventory.reasonPlaceholder')} />
          </div>

          {err && <p className="text-sm font-medium text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={onClose} type="button">{t('common.cancel')}</button>
            <button className="btn-primary" onClick={submit} disabled={busy || (!isSet && qty <= 0) || (isSet && amount === '')} type="button">
              {busy ? t('common.loading') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MovementsPanel({ item, movements, onClose }: { item: InventoryItem; movements: InventoryMovement[]; onClose: () => void }) {
  const { t } = useI18n();
  const colorFor = (mt: string) =>
    mt === 'SALE' || mt === 'RELEASE' ? 'red' : mt === 'PURCHASE' || mt === 'RETURN' ? 'green' : 'slate';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/40 sm:items-stretch" role="dialog" aria-modal="true">
      <div className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-base font-bold text-slate-900">{t('inventory.historyOf')} {item.productName}</h3>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} type="button" aria-label="close">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {movements.length === 0 ? <EmptyState title={t('common.noData')} /> : (
            <ul className="space-y-3">
              {movements.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 p-3">
                  <div>
                    <Badge color={colorFor(m.movementType)}>{m.movementType}</Badge>
                    <p className="mt-1 text-sm font-semibold text-slate-800">
                      {m.quantityChange > 0 ? '+' : ''}{m.quantityChange}
                    </p>
                    {m.reason && <p className="mt-0.5 text-xs text-slate-500">{m.reason}</p>}
                  </div>
                  <div className="text-end text-xs text-slate-400">
                    <div>{formatDate(m.createdAt)}</div>
                    <div dir="ltr">{m.referenceId ? m.referenceId.slice(0, 12) : ''}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// Price Comparison Engine compares product/price/qty/conditions across sellers.
export function DashboardComparisonPage() {
  const { t, locale } = useI18n();
  const [groups, setGroups] = useState<ComparisonGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiCall(() => api.comparePrices({ query, pageSize: 20 })).then((res) => {
      setGroups(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, [query]);

  useEffect(() => load(), [load]);

  return (
    <AppLayout>
      <SectionHeader
        title={t('dashboard.priceComparison')}
        subtitle={t('comparison.subtitle')}
        action={
          <Link to="/price-comparison" className="text-sm font-medium text-wasit-700 hover:underline">
            {t('comparison.title')} →
          </Link>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('comparison.searchPlaceholder')}
          className="input max-w-md"
          aria-label={t('comparison.searchPlaceholder')}
          data-testid="dashboard-comparison-search-input"
        />
        <button type="submit" className="btn-primary shrink-0" data-testid="dashboard-comparison-search-button">
          {t('comparison.compare')}
        </button>
      </form>
      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : groups.length === 0 ? (
        <EmptyState title={t('comparison.empty')} hint={t('comparison.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <Card key={group.key} testId="dashboard-comparison-group" className="overflow-x-auto">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">
                  {locale === 'ar' && group.nameAr ? group.nameAr : group.name}
                </span>
                <Badge color="teal">
                  {group.sellerCount} {t('comparison.sellers')} · {t('comparison.spread')}{' '}
                  {formatMoney(group.priceSpread, group.currencyCode)}
                </Badge>
              </div>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{t('comparison.seller')}</th>
                    <th className="text-end">{t('common.price')}</th>
                    <th className="text-end">{t('field.moq')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.offers.map((offer) => (
                    <tr key={offer.productId}>
                      <td>{offer.seller.name ?? t('comparison.unknownSeller')}</td>
                      <td className="text-end font-semibold text-wasit-700">
                        {formatMoney(offer.basePrice, offer.currencyCode)}
                      </td>
                      <td className="text-end">{offer.moq}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </AppLayout>
  );
}

export function DashboardSalesPage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.sales')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs text-slate-500">{t('dashboard.sales')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('dashboard.expenses')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('dashboard.profit')}</p><p className="text-2xl font-bold text-wasit-700">—</p></Card>
      </div>
    </AppLayout>
  );
}
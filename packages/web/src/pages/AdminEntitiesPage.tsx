import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminEntityDetail, AdminEntityRow, AdminEntitySummary, AdminEntityType } from '@/lib/types';

/**
 * PR-02 slice 1 — Entities Desk.
 *
 * The console could list users and products but never the businesses behind
 * them. This page answers the three questions a GM actually asks: how many
 * businesses exist per type, which of them are active/verified, and what does a
 * single one actually sell.
 *
 * Read-only on purpose: nothing here can suspend a merchant or grant
 * verification, because those decisions belong to a desk this slice does not own.
 */

const TYPES: AdminEntityType[] = ['merchant', 'supplier', 'company'];

type StatusFilter = 'all' | 'active' | 'inactive';
type VerifiedFilter = 'all' | 'yes' | 'no';

export function AdminEntitiesPage() {
  const { t } = useI18n();
  const [type, setType] = useState<AdminEntityType>('merchant');
  const [summary, setSummary] = useState<AdminEntitySummary[]>([]);
  const [rows, setRows] = useState<AdminEntityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [verified, setVerified] = useState<VerifiedFilter>('all');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminEntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    const res = await apiCall(() => api.adminEntitySummary());
    if (res.data) setSummary(res.data.items);
    if (res.error) setError(res.error);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    const res = await apiCall(() =>
      api.adminEntities({ type, q: appliedQuery || undefined, status, verified, page, pageSize }),
    );
    setLoading(false);
    if (res.error) {
      setError(res.error);
      setRows([]);
      return;
    }
    setError(null);
    setRows(res.data?.items ?? []);
    setTotal(res.data?.total ?? 0);
  }, [type, appliedQuery, status, verified, page]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = async (row: AdminEntityRow) => {
    setDetailLoading(true);
    setDetailError(null);
    setSelected(null);
    const res = await apiCall(() => api.adminEntityDetail(row.type, row.id));
    setDetailLoading(false);
    if (res.error) {
      setDetailError(res.error);
      return;
    }
    setSelected(res.data);
  };

  const currentSummary = useMemo(() => summary.find((s) => s.type === type), [summary, type]);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setAppliedQuery(query.trim());
  };

  return (
    <AppLayout>
      <SectionHeader title={t('admin.entities.title')} subtitle={t('admin.entities.subtitle')} />

      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={t('admin.entities.title')}>
        {TYPES.map((entityType) => {
          const block = summary.find((s) => s.type === entityType);
          const active = type === entityType;
          return (
            <button
              key={entityType}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`admin-entities-tab-${entityType}`}
              onClick={() => {
                setType(entityType);
                setPage(1);
                setSelected(null);
              }}
              className={
                active
                  ? 'rounded-lg border border-brand-600 bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800'
                  : 'rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50'
              }
            >
              {t(`admin.entities.type.${entityType}`)}
              {block ? (
                <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700" data-testid={`admin-entities-count-${entityType}`}>
                  {block.total}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {currentSummary ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="admin-entities-summary">
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.entities.summary.total')}</p>
            <p className="text-xl font-semibold" data-testid="admin-entities-summary-total">{currentSummary.total}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.entities.summary.active')}</p>
            <p className="text-xl font-semibold text-green-700" data-testid="admin-entities-summary-active">{currentSummary.active}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.entities.summary.inactive')}</p>
            <p className="text-xl font-semibold text-red-600" data-testid="admin-entities-summary-inactive">{currentSummary.inactive}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.entities.summary.verified')}</p>
            <p className="text-xl font-semibold" data-testid="admin-entities-summary-verified">{currentSummary.verified}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.entities.summary.new30')}</p>
            <p className="text-xl font-semibold" data-testid="admin-entities-summary-new">{currentSummary.newLast30Days}</p>
          </Card>
        </div>
      ) : null}

      <Card className="mb-4 p-3">
        <form className="flex flex-wrap items-end gap-3" onSubmit={submitSearch}>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.entities.search')}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('admin.entities.searchPlaceholder')}
              className="input-base w-full"
              data-testid="admin-entities-search"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.entities.filter.status')}</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusFilter);
                setPage(1);
              }}
              className="input-base"
              data-testid="admin-entities-filter-status"
            >
              <option value="all">{t('admin.entities.filter.all')}</option>
              <option value="active">{t('admin.entities.filter.active')}</option>
              <option value="inactive">{t('admin.entities.filter.inactive')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.entities.filter.verified')}</span>
            <select
              value={verified}
              onChange={(e) => {
                setVerified(e.target.value as VerifiedFilter);
                setPage(1);
              }}
              className="input-base"
              data-testid="admin-entities-filter-verified"
            >
              <option value="all">{t('admin.entities.filter.all')}</option>
              <option value="yes">{t('admin.entities.filter.verifiedYes')}</option>
              <option value="no">{t('admin.entities.filter.verifiedNo')}</option>
            </select>
          </label>
          <button type="submit" className="btn-primary" data-testid="admin-entities-apply">
            {t('admin.entities.apply')}
          </button>
        </form>
      </Card>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('admin.entities.empty')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base" data-testid="admin-entities-table">
            <thead>
              <tr>
                <th>{t('admin.entities.col.name')}</th>
                <th>{t('admin.entities.col.owner')}</th>
                <th>{t('admin.entities.col.country')}</th>
                <th>{t('admin.entities.col.status')}</th>
                <th>{t('admin.entities.col.products')}</th>
                <th>{t('admin.entities.col.orders')}</th>
                <th>{t('admin.entities.col.gmv')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`admin-entities-row-${row.id}`}>
                  <td>
                    <span className="font-medium">{row.name}</span>
                    <span className="ms-2 text-xs text-slate-400" dir="ltr">{row.slug}</span>
                  </td>
                  <td dir="ltr" className="text-xs">{row.ownerEmail ?? '—'}</td>
                  <td>{row.countryCode ?? '—'}</td>
                  <td className="space-x-1">
                    {row.isActive ? (
                      <Badge color="green">{t('admin.entities.filter.active')}</Badge>
                    ) : (
                      <Badge color="red">{t('admin.entities.filter.inactive')}</Badge>
                    )}
                    {row.verified ? <Badge color="indigo">{t('admin.entities.verifiedBadge')}</Badge> : null}
                  </td>
                  <td>{row.productCount}</td>
                  <td>{row.orderCount}</td>
                  <td dir="ltr">{row.gmv}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void openDetail(row)}
                      className="text-xs font-medium text-brand-700 hover:underline"
                      data-testid={`admin-entities-open-${row.id}`}
                    >
                      {t('admin.entities.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
            <span data-testid="admin-entities-total">{t('admin.entities.totalRows')}: {total}</span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="admin-entities-prev"
              >
                {t('admin.entities.prev')}
              </button>
              <span data-testid="admin-entities-page">{page} / {lastPage}</span>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= lastPage}
                onClick={() => setPage((p) => p + 1)}
                data-testid="admin-entities-next"
              >
                {t('admin.entities.next')}
              </button>
            </span>
          </div>
        </Card>
      )}

      {detailLoading ? <Spinner /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}
      {selected ? (
        <Card className="mt-4 p-4" data-testid="admin-entities-detail">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">{selected.entity.name}</h3>
            <button
              type="button"
              className="text-xs text-slate-500 hover:underline"
              onClick={() => setSelected(null)}
              data-testid="admin-entities-detail-close"
            >
              {t('common.close')}
            </button>
          </div>

          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.owner')}</dt><dd dir="ltr">{selected.owner?.email ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.country')}</dt><dd>{selected.entity.countryName ?? selected.entity.countryCode ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.created')}</dt><dd>{formatDate(selected.entity.createdAt)}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.products')}</dt><dd data-testid="admin-entities-detail-products">{selected.metrics.publishedProducts} / {selected.metrics.products}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.orders')}</dt><dd data-testid="admin-entities-detail-orders">{selected.metrics.orders}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.gmv')}</dt><dd dir="ltr" data-testid="admin-entities-detail-gmv">{selected.metrics.gmv}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.openDisputes')}</dt><dd data-testid="admin-entities-detail-disputes">{selected.metrics.openDisputes}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.trust')}</dt><dd data-testid="admin-entities-detail-trust">{selected.trust ? `${selected.trust.score} · ${selected.trust.level}` : '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.verification')}</dt><dd data-testid="admin-entities-detail-verification">{selected.verification ? `${selected.verification.status} · ${selected.verification.targetLevel}` : '—'}</dd></div>
            {selected.type === 'company' ? (
              <>
                <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.registration')}</dt><dd dir="ltr">{selected.entity.registrationNumber ?? '—'}</dd></div>
                <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.taxId')}</dt><dd dir="ltr">{selected.entity.taxId ?? '—'}</dd></div>
                <div><dt className="text-xs text-slate-500">{t('admin.entities.detail.industry')}</dt><dd>{selected.entity.industry ?? '—'}</dd></div>
              </>
            ) : null}
          </dl>

          <h4 className="mt-4 mb-2 text-sm font-semibold">{t('admin.entities.detail.recentOrders')}</h4>
          {selected.recentOrders.length === 0 ? (
            <p className="text-xs text-slate-500">{t('admin.entities.detail.noOrders')}</p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('admin.entities.col.orderNumber')}</th>
                  <th>{t('admin.entities.col.status')}</th>
                  <th>{t('admin.entities.col.gmv')}</th>
                  <th>{t('common.date')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td dir="ltr">{order.orderNumber}</td>
                    <td>{order.status}</td>
                    <td dir="ltr">{order.grandTotal} {order.currencyCode}</td>
                    <td>{formatDate(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}
    </AppLayout>
  );
}

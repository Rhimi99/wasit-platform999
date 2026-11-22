import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AdminCategoryDetail, AdminCategoryRow, AdminCategorySummary } from '@/lib/types';

/**
 * PR-02 slice 2 — Categories Desk.
 *
 * The public category endpoint hides inactive nodes and flattens the tree, so an
 * admin could not see an empty branch, a deactivated sub-tree, or how many
 * products a branch really carries. This page renders the tree the way it is
 * stored — parent pointers, depth and path derived server-side — with the direct
 * and sub-tree product counts side by side.
 *
 * Read-only: renaming or deactivating a category changes how every seller files
 * their catalogue, and that decision needs its own permission and audit.
 */

type StatusFilter = 'all' | 'active' | 'inactive';
type LevelFilter = 'all' | 'root' | 'child' | 'leaf';
type ProductsFilter = 'all' | 'yes' | 'no';

export function AdminCategoriesPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<AdminCategorySummary | null>(null);
  const [rows, setRows] = useState<AdminCategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [hasProducts, setHasProducts] = useState<ProductsFilter>('all');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminCategoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    const res = await apiCall(() => api.adminCategorySummary());
    if (res.data) setSummary(res.data);
    if (res.error) setError(res.error);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    const res = await apiCall(() =>
      api.adminCategories({ q: appliedQuery || undefined, status, level, hasProducts, page, pageSize }),
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
  }, [appliedQuery, status, level, hasProducts, page]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    const res = await apiCall(() => api.adminCategoryDetail(id));
    setDetailLoading(false);
    if (res.error) {
      setDetailError(res.error);
      return;
    }
    setSelected(res.data);
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setAppliedQuery(query.trim());
  };

  return (
    <AppLayout>
      <SectionHeader title={t('admin.categories.title')} subtitle={t('admin.categories.subtitle')} />

      {summary ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="admin-categories-summary">
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.categories.summary.total')}</p>
            <p className="text-xl font-semibold" data-testid="admin-categories-summary-total">{summary.total}</p>
            <p className="text-xs text-slate-500">
              {t('admin.categories.summary.roots')}: {summary.roots} · {t('admin.categories.summary.children')}: {summary.children}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.categories.summary.active')}</p>
            <p className="text-xl font-semibold text-green-700" data-testid="admin-categories-summary-active">{summary.active}</p>
            <p className="text-xs text-slate-500">
              {t('admin.categories.summary.inactive')}: <span data-testid="admin-categories-summary-inactive">{summary.inactive}</span>
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.categories.summary.withProducts')}</p>
            <p className="text-xl font-semibold" data-testid="admin-categories-summary-with-products">{summary.withProducts}</p>
            <p className="text-xs text-slate-500">
              {t('admin.categories.summary.empty')}: <span data-testid="admin-categories-summary-empty">{summary.empty}</span>
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500">{t('admin.categories.summary.products')}</p>
            <p className="text-xl font-semibold" data-testid="admin-categories-summary-products">{summary.totalProducts}</p>
            <p className="text-xs text-slate-500">
              {t('admin.categories.summary.published')}: <span data-testid="admin-categories-summary-published">{summary.publishedProducts}</span>
              {' · '}{t('admin.categories.summary.maxDepth')}: <span data-testid="admin-categories-summary-depth">{summary.maxDepth}</span>
            </p>
          </Card>
        </div>
      ) : null}

      <Card className="mb-4 p-3">
        <form className="flex flex-wrap items-end gap-3" onSubmit={submitSearch}>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.categories.search')}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('admin.categories.searchPlaceholder')}
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              data-testid="admin-categories-search"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.categories.filter.status')}</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusFilter);
                setPage(1);
              }}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              data-testid="admin-categories-filter-status"
            >
              <option value="all">{t('admin.categories.filter.all')}</option>
              <option value="active">{t('admin.categories.filter.active')}</option>
              <option value="inactive">{t('admin.categories.filter.inactive')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.categories.filter.level')}</span>
            <select
              value={level}
              onChange={(e) => {
                setLevel(e.target.value as LevelFilter);
                setPage(1);
              }}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              data-testid="admin-categories-filter-level"
            >
              <option value="all">{t('admin.categories.filter.all')}</option>
              <option value="root">{t('admin.categories.filter.root')}</option>
              <option value="child">{t('admin.categories.filter.child')}</option>
              <option value="leaf">{t('admin.categories.filter.leaf')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">{t('admin.categories.filter.products')}</span>
            <select
              value={hasProducts}
              onChange={(e) => {
                setHasProducts(e.target.value as ProductsFilter);
                setPage(1);
              }}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              data-testid="admin-categories-filter-products"
            >
              <option value="all">{t('admin.categories.filter.all')}</option>
              <option value="yes">{t('admin.categories.filter.withProducts')}</option>
              <option value="no">{t('admin.categories.filter.withoutProducts')}</option>
            </select>
          </label>
          <button type="submit" className="btn-primary" data-testid="admin-categories-apply">
            {t('admin.categories.apply')}
          </button>
        </form>
      </Card>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('admin.categories.empty')} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="table-base" data-testid="admin-categories-table">
            <thead>
              <tr>
                <th>{t('admin.categories.col.name')}</th>
                <th>{t('admin.categories.col.path')}</th>
                <th>{t('admin.categories.col.status')}</th>
                <th>{t('admin.categories.col.children')}</th>
                <th>{t('admin.categories.col.products')}</th>
                <th>{t('admin.categories.col.published')}</th>
                <th>{t('admin.categories.col.subtree')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`admin-categories-row-${row.id}`}>
                  <td>
                    <span style={{ paddingInlineStart: `${row.depth * 16}px` }} className="font-medium">
                      {row.name}
                    </span>
                    <span className="ms-2 text-xs text-slate-400" dir="ltr">{row.slug}</span>
                  </td>
                  <td className="text-xs text-slate-600">{row.path}</td>
                  <td>
                    {row.isActive ? (
                      <Badge color="green">{t('admin.categories.filter.active')}</Badge>
                    ) : (
                      <Badge color="red">{t('admin.categories.filter.inactive')}</Badge>
                    )}
                  </td>
                  <td data-testid={`admin-categories-children-${row.id}`}>{row.childrenCount}</td>
                  <td data-testid={`admin-categories-products-${row.id}`}>{row.productCount}</td>
                  <td>{row.publishedProductCount}</td>
                  <td data-testid={`admin-categories-subtree-${row.id}`}>{row.subtreeProductCount}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void openDetail(row.id)}
                      className="text-xs font-medium text-brand-700 hover:underline"
                      data-testid={`admin-categories-open-${row.id}`}
                    >
                      {t('admin.categories.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
            <span data-testid="admin-categories-total">{t('admin.categories.totalRows')}: {total}</span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="admin-categories-prev"
              >
                {t('admin.categories.prev')}
              </button>
              <span data-testid="admin-categories-page">{page} / {lastPage}</span>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= lastPage}
                onClick={() => setPage((p) => p + 1)}
                data-testid="admin-categories-next"
              >
                {t('admin.categories.next')}
              </button>
            </span>
          </div>
        </Card>
      )}

      {detailLoading ? <Spinner /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}
      {selected ? (
        <Card className="mt-4 p-4" data-testid="admin-categories-detail">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">{selected.category.name}</h3>
            <button
              type="button"
              className="text-xs text-slate-500 hover:underline"
              onClick={() => setSelected(null)}
              data-testid="admin-categories-detail-close"
            >
              {t('common.close')}
            </button>
          </div>

          <p className="mb-3 text-xs text-slate-600" data-testid="admin-categories-detail-path">
            {selected.category.path}
          </p>

          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.status')}</dt><dd>{selected.category.isActive ? t('admin.categories.filter.active') : t('admin.categories.filter.inactive')}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.depth')}</dt><dd data-testid="admin-categories-detail-depth">{selected.category.depth}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.parent')}</dt><dd>{selected.category.parentName ?? '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.created')}</dt><dd>{formatDate(selected.category.createdAt)}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.directProducts')}</dt><dd data-testid="admin-categories-detail-direct">{selected.metrics.directProducts}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.published')}</dt><dd>{selected.metrics.publishedProducts}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.draft')}</dt><dd>{selected.metrics.draftProducts}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.subtree')}</dt><dd data-testid="admin-categories-detail-subtree">{selected.metrics.subtreeProducts}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.children')}</dt><dd data-testid="admin-categories-detail-children">{selected.metrics.children}</dd></div>
            <div><dt className="text-xs text-slate-500">{t('admin.categories.detail.descendants')}</dt><dd data-testid="admin-categories-detail-descendants">{selected.metrics.descendants}</dd></div>
          </dl>

          <h4 className="mt-4 mb-2 text-sm font-semibold">{t('admin.categories.detail.childrenTitle')}</h4>
          {selected.children.length === 0 ? (
            <p className="text-xs text-slate-500" data-testid="admin-categories-detail-no-children">
              {t('admin.categories.detail.noChildren')}
            </p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('admin.categories.col.name')}</th>
                  <th>{t('admin.categories.col.status')}</th>
                  <th>{t('admin.categories.col.products')}</th>
                  <th>{t('admin.categories.col.children')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.children.map((child) => (
                  <tr key={child.id} data-testid={`admin-categories-child-${child.id}`}>
                    <td>{child.name}</td>
                    <td>{child.isActive ? t('admin.categories.filter.active') : t('admin.categories.filter.inactive')}</td>
                    <td>{child.productCount}</td>
                    <td>{child.childrenCount}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => void openDetail(child.id)}
                        className="text-xs font-medium text-brand-700 hover:underline"
                      >
                        {t('admin.categories.open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 className="mt-4 mb-2 text-sm font-semibold">{t('admin.categories.detail.recentProducts')}</h4>
          {selected.recentProducts.length === 0 ? (
            <p className="text-xs text-slate-500" data-testid="admin-categories-detail-no-products">
              {t('admin.categories.detail.noProducts')}
            </p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('admin.categories.col.productName')}</th>
                  <th>{t('admin.categories.col.status')}</th>
                  <th>{t('admin.categories.col.price')}</th>
                  <th>{t('common.date')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.recentProducts.map((product) => (
                  <tr key={product.id}>
                    <td>{product.name}</td>
                    <td>{product.status}{product.isPublished ? ` · ${t('admin.categories.detail.publishedBadge')}` : ''}</td>
                    <td dir="ltr">{product.basePrice} {product.currencyCode}</td>
                    <td>{formatDate(product.createdAt)}</td>
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

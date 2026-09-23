import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layouts/AppLayout';
import { useI18n } from '@/lib/i18n-context';
import { api, apiCall, formatDate } from '@/lib/api';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { BuyerRelation, DirectoryListResponse, DirectoryMerchantRow, DirectorySupplierRow, PartnerRelation, PaginationInfo } from '@/lib/types';

const PAGE_SIZE = 20;

interface DirectoryColumn<T> {
  header: string;
  render: (row: T) => React.ReactNode;
  align?: 'start' | 'end';
}

/**
 * Generic, data-backed directory table with real server-side search and paging.
 * The fetch returns `{ items, pagination }` from the backend; nothing is derived
 * or padded locally, so the table always reflects the database.
 */
function useDirectoryPage<T>(fetcher: (params: { q?: string; page: number }) => Promise<{ data: DirectoryListResponse<T> | null; error: string | null }>) {
  const [items, setItems] = useState<T[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, pageSize: PAGE_SIZE, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    let mounted = true;
    setLoading(true);
    fetcher({ q: search || undefined, page }).then((res) => {
      if (!mounted) return;
      setItems(res.data?.items ?? []);
      if (res.data?.pagination) setPagination(res.data.pagination);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [fetcher, search, page]);

  useEffect(() => load(), [load]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearch(query.trim());
  };

  return { items, pagination, loading, error, query, setQuery, submitSearch, page, setPage, reload: load };
}

function PaginationBar({ pagination, page, setPage }: { pagination: PaginationInfo; page: number; setPage: (p: number) => void }) {
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-500" data-testid="directory-pagination">
      <span>{t('directory.total')}: <strong data-testid="directory-total">{pagination.total}</strong></span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
          data-testid="directory-prev"
        >
          {t('directory.prev')}
        </button>
        <span data-testid="directory-page">{t('directory.page')} {page} / {totalPages}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
          data-testid="directory-next"
        >
          {t('directory.next')}
        </button>
      </div>
    </div>
  );
}

function DirectoryTable<T>({
  title,
  subtitle,
  columns,
  fetcher,
  emptyHint,
  testId,
  rowKey,
}: {
  title: string;
  subtitle: string;
  columns: DirectoryColumn<T>[];
  fetcher: (params: { q?: string; page: number }) => Promise<{ data: DirectoryListResponse<T> | null; error: string | null }>;
  emptyHint: string;
  testId: string;
  rowKey: (row: T) => string;
}) {
  const { t } = useI18n();
  const { items, pagination, loading, error, query, setQuery, submitSearch, page, setPage, reload } = useDirectoryPage<T>(fetcher);

  return (
    <AppLayout>
      <SectionHeader title={title} subtitle={subtitle} />
      <form onSubmit={submitSearch} className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('directory.searchPlaceholder')}
          className="input max-w-md"
          aria-label={t('common.search')}
          data-testid={`${testId}-search`}
        />
        <button type="submit" className="btn-primary" data-testid={`${testId}-search-button`}>
          {t('common.search')}
        </button>
      </form>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : items.length === 0 ? (
        <EmptyState title={t('directory.empty')} hint={emptyHint} />
      ) : (
        <Card className="overflow-x-auto" testId={testId}>
          <table className="table-base">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i} className={c.align === 'end' ? 'text-end' : ''}>{c.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={rowKey(row)} data-testid={`${testId}-row`}>
                  {columns.map((c, i) => (
                    <td key={i} className={c.align === 'end' ? 'text-end' : ''}>{c.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar pagination={pagination} page={page} setPage={setPage} />
        </Card>
      )}
    </AppLayout>
  );
}

function BuyerTable({
  title,
  subtitle,
  buyerType,
  testId,
}: {
  title: string;
  subtitle: string;
  buyerType?: 'CUSTOMER' | 'MERCHANT' | 'COMPANY';
  testId: string;
}) {
  const { t } = useI18n();
  const fetcher = useCallback(
    (params: { q?: string; page: number }) =>
      apiCall(() => api.directoryBuyers({ q: params.q, page: params.page, pageSize: PAGE_SIZE, buyerType })),
    [buyerType],
  );
  return (
    <DirectoryTable<BuyerRelation>
      title={title}
      subtitle={subtitle}
      fetcher={fetcher}
      testId={testId}
      emptyHint={t('directory.emptyHint')}
      rowKey={(r) => r.userId}
      columns={[
        { header: t('directory.party'), render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-800" data-testid={`${testId}-name`}>{r.name}</p>
            <p className="truncate text-xs text-slate-400">{r.email ?? '—'}</p>
          </div>
        ) },
        { header: t('field.type'), render: (r) => <Badge color="teal">{t(`role.${r.buyerType}`)}</Badge> },
        { header: t('directory.orderCount'), render: (r) => <span data-testid={`${testId}-orders`}>{r.orderCount}</span>, align: 'end' },
        { header: t('directory.lastOrder'), render: (r) => formatDate(r.lastOrderAt), align: 'end' },
      ]}
    />
  );
}

function PartnerTable({
  title,
  subtitle,
  kind,
  testId,
}: {
  title: string;
  subtitle: string;
  kind: 'suppliers' | 'merchants';
  testId: string;
}) {
  const { t } = useI18n();
  const fetcher = useCallback(
    (params: { q?: string; page: number }) =>
      apiCall(() => api.mySellerPartners(kind, { q: params.q, page: params.page, pageSize: PAGE_SIZE })),
    [kind],
  );
  return (
    <DirectoryTable<PartnerRelation>
      title={title}
      subtitle={subtitle}
      fetcher={fetcher}
      testId={testId}
      emptyHint={t('directory.emptyHint')}
      rowKey={(r) => r.sellerId}
      columns={[
        { header: t('directory.party'), render: (r) => (
          <Link to={`/${kind}/${r.sellerId}`} className="font-medium text-wasit-700 hover:underline" data-testid={`${testId}-name`}>
            {r.name || '—'}
          </Link>
        ) },
        { header: t('field.type'), render: (r) => <Badge color="indigo">{t(`role.${r.sellerType}`)}</Badge> },
        { header: t('directory.orderCount'), render: (r) => <span data-testid={`${testId}-orders`}>{r.orderCount}</span>, align: 'end' },
        { header: t('directory.lastOrder'), render: (r) => formatDate(r.lastOrderAt), align: 'end' },
      ]}
    />
  );
}

function SupplierDirectoryTable({ title, subtitle, testId }: { title: string; subtitle: string; testId: string }) {
  const { t } = useI18n();
  const fetcher = useCallback(
    (params: { q?: string; page: number }) =>
      apiCall(() => api.directorySuppliers({ q: params.q, page: params.page, pageSize: PAGE_SIZE })),
    [],
  );
  return (
    <DirectoryTable<DirectorySupplierRow>
      title={title}
      subtitle={subtitle}
      fetcher={fetcher}
      testId={testId}
      emptyHint={t('directory.emptyHint')}
      rowKey={(r) => r.id}
      columns={[
        { header: t('field.name'), render: (r) => (
          <Link to={`/suppliers/${r.id}`} className="font-medium text-wasit-700 hover:underline" data-testid={`${testId}-name`}>
            {r.companyName}
          </Link>
        ) },
        { header: t('field.verified'), render: (r) => r.verified ? <Badge color="green">✓</Badge> : <Badge>{t('common.inactive')}</Badge> },
        { header: t('field.email'), render: (r) => r.contactEmail ?? '—' },
        { header: t('field.city'), render: (r) => r.cityId ?? '—' },
      ]}
    />
  );
}

// شاشات لوحات التجار/الموردين/الشركات: دليل أطراف مبني على بيانات حقيقية
// (طلبات، موردون، تجار) وتُديره صلاحيات RBAC ونطاق الملكية في الـ Backend.
export function DashboardCustomersPage() {
  const { t } = useI18n();
  return (
    <BuyerTable
      title={t('directory.customersTitle')}
      subtitle={t('directory.customersSubtitle')}
      buyerType="CUSTOMER"
      testId="directory-customers"
    />
  );
}

export function DashboardBuyersPage({ buyerType }: { buyerType?: 'CUSTOMER' | 'MERCHANT' | 'COMPANY' }) {
  const { t } = useI18n();
  return (
    <BuyerTable
      title={t('directory.buyersTitle')}
      subtitle={t('directory.buyersSubtitle')}
      buyerType={buyerType}
      testId="directory-buyers"
    />
  );
}

export function DashboardSuppliersPage() {
  const { t } = useI18n();
  return <SupplierDirectoryTable title={t('directory.suppliersTitle')} subtitle={t('directory.suppliersSubtitle')} testId="directory-suppliers" />;
}

// "التجار" في لوحة المورد = التجار الذين اشتروا فعليًا من كيانات المورد
// (فلترة على نوع المشتري من نفس مصدر الطلبات الحقيقي).
export function DashboardMerchantsListPage() {
  const { t } = useI18n();
  return (
    <BuyerTable
      title={t('directory.merchantBuyersTitle')}
      subtitle={t('directory.merchantBuyersSubtitle')}
      buyerType="MERCHANT"
      testId="directory-merchant-buyers"
    />
  );
}

export function DashboardMySuppliersPage() {
  const { t } = useI18n();
  return <PartnerTable title={t('directory.mySuppliersTitle')} subtitle={t('directory.mySuppliersSubtitle')} kind="suppliers" testId="directory-my-suppliers" />;
}

export function DashboardMyMerchantsPage() {
  const { t } = useI18n();
  return <PartnerTable title={t('directory.myMerchantsTitle')} subtitle={t('directory.myMerchantsSubtitle')} kind="merchants" testId="directory-my-merchants" />;
}

// شاشات لم تُنفَّذ بعد (الفروع/الموظفون) — تُعرض كحالة فارغة صريحة، لا بيانات وهمية.
export function DashboardListPage({ kind }: { kind: 'branches' | 'employees' }) {
  const { t } = useI18n();
  const titles: Record<string, string> = {
    branches: t('dashboard.branches'),
    employees: t('dashboard.employees'),
  };
  return (
    <AppLayout>
      <SectionHeader title={titles[kind]} />
      <Card>
        <EmptyState title={t('common.noData')} hint={titles[kind]} />
      </Card>
    </AppLayout>
  );
}

export function DashboardFinancePage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.finance')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs text-slate-500">{t('order.items')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('order.commission')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('order.settlement')}</p><p className="text-2xl font-bold text-wasit-700">—</p></Card>
      </div>
    </AppLayout>
  );
}

export function DashboardReportsPage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.reports')} />
      <Card>
        <p className="text-sm text-slate-600">{t('reports.roadmap')}</p>
      </Card>
    </AppLayout>
  );
}
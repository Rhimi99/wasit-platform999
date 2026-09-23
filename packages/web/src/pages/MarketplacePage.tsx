import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { ProductCard } from '@/components/ProductCard';
import { AdSlot } from '@/components/AdSlot';
import { EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import type { Category, ProductSummary } from '@/lib/types';
import { PublicLayout } from '@/components/layouts/PublicLayout';

const SORT_OPTIONS = [
  { value: '', key: 'marketplace.sort.newest' },
  { value: 'price_asc', key: 'marketplace.sort.price_asc' },
  { value: 'price_desc', key: 'marketplace.sort.price_desc' },
  { value: 'popular', key: 'marketplace.sort.popular' },
];

export function MarketplacePage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const categoryId = params.get('category') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      apiCall(() => api.listProducts({ categoryId: categoryId || undefined, sort: sort || undefined, page, pageSize: '12' })),
      apiCall(() => api.listCategories()),
    ]).then(([p, c]) => {
      if (!mounted) return;
      setProducts(p.data?.items ?? []);
      setTotal(p.data?.pagination.total ?? 0);
      setCategories(c.data ?? ([] as Category[]));
      setError(p.error);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [categoryId, sort, page]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };

  return (
    <PublicLayout>
      <SeoHead
        title={`${t('marketplace.title')} — LE WASSIT`}
        description={t('marketplace.desc')}
        canonicalPath="/marketplace"
        noindex={Boolean(categoryId || sort) || page > 1}
      />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <SectionHeader title={t('marketplace.title')} subtitle={t('marketplace.desc')} />

        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={categoryId}
            onChange={(e) => setParam('category', e.target.value)}
            className="input w-full sm:w-56"
            aria-label={t('nav.categories')}
          >
            <option value="">{t('nav.categories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.nameAr ?? c.name}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value)}
            className="input w-full sm:w-52"
            aria-label={t('common.sort')}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.key)}</option>
            ))}
          </select>
          <p className="text-sm text-slate-500 ms-auto">{total} {t('nav.products')}</p>
        </div>

        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={() => window.location.reload()} />
        ) : products.length === 0 ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        )}

        <AdSlot placement="MARKETPLACE" className="mt-10" />
      </div>
    </PublicLayout>
  );
}
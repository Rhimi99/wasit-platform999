import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { ProductCard } from '@/components/ProductCard';
import { EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import type { Country, JsonLd, ProductSummary } from '@/lib/types';

export function CategoryPage() {
  const { slug = '' } = useParams();
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [categoryName, setCategoryName] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [jsonLd, setJsonLd] = useState<JsonLd | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiCall(() => api.listCategories()).then(async (res) => {
      const match = (res.data ?? []).find((c) => c.slug === slug);
      if (!mounted) return;
      setCategoryId(match?.id ?? null);
      setCategoryName(match ? match.nameAr ?? match.name : null);
      if (!match) {
        setError(res.error);
        setLoading(false);
        return;
      }
      const productsRes = await apiCall(() => api.listProducts({ categoryId: match.id, pageSize: '12' }));
      if (!mounted) return;
      setProducts(productsRes.data?.items ?? []);
      setError(res.error ?? productsRes.error);
      setLoading(false);
    });
    apiCall(() => api.getStructuredData('CATEGORY', slug)).then((res) => {
      if (mounted) setJsonLd(res.data ?? null);
    });
    return () => {
      mounted = false;
    };
  }, [slug]);

  return (
    <PublicLayout>
      <SeoHead
        title={`${categoryName ?? slug} — ${t('nav.categories')} | LE WASSIT`}
        canonicalPath={`/categories/${slug}`}
        jsonLd={jsonLd}
        noindex={!categoryId}
      />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <SectionHeader title={categoryName ?? slug} subtitle={t('marketplace.desc')} />
        {loading ? (
          <Spinner />
        ) : !categoryId ? (
          <EmptyState title={t('common.noData')} />
        ) : error ? (
          <ErrorState message={error} />
        ) : products.length === 0 ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}

export function MarketPage() {
  const { code = '' } = useParams();
  const { t } = useI18n();
  const [country, setCountry] = useState<Country | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [jsonLd, setJsonLd] = useState<JsonLd | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiCall(() => api.getCountryByCode(code)).then(async (res) => {
      if (!mounted) return;
      setCountry(res.data ?? null);
      if (res.data) {
        const productsRes = await apiCall(() => api.listProducts({ countryId: res.data!.id, pageSize: '12' }));
        if (!mounted) return;
        setProducts(productsRes.data?.items ?? []);
      }
      setError(res.error);
      setLoading(false);
    });
    apiCall(() => api.getStructuredData('COUNTRY', code)).then((res) => {
      if (mounted) setJsonLd(res.data ?? null);
    });
    return () => {
      mounted = false;
    };
  }, [code]);

  const name = country?.nameAr ?? country?.name ?? code;

  return (
    <PublicLayout>
      <SeoHead
        title={`${name} — LE WASSIT`}
        canonicalPath={`/markets/${code}`}
        jsonLd={jsonLd}
        noindex={!country}
      />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <SectionHeader title={name} subtitle={t('marketplace.desc')} />
        {loading ? (
          <Spinner />
        ) : !country ? (
          <EmptyState title={t('common.noData')} />
        ) : error ? (
          <ErrorState message={error} />
        ) : products.length === 0 ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
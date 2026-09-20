import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import type { Category } from '@/lib/types';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function CategoriesPage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.listCategories()).then((res) => {
      setCategories(res.data ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <PublicLayout>
      <SeoHead title={`${t('nav.categories')} — LE WASSIT`} canonicalPath="/categories" />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <SectionHeader title={t('nav.categories')} />
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} />
        ) : categories.length === 0 ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {categories.map((c) => (
              <Link key={c.id} to={`/categories/${c.slug}`} className="card group p-4 hover:shadow-md">
                <div className="text-3xl" aria-hidden>{c.icon ?? '📂'}</div>
                <p className="mt-2 font-medium text-slate-800 group-hover:text-wasit-700">{c.nameAr ?? c.name}</p>
                {c.description && <p className="mt-1 line-clamp-2 text-xs text-slate-400">{c.description}</p>}
              </Link>
            ))}
          </div>
        )}

        {/* Category display helper for localize */}
        <Card className="mt-8 p-4">
          <p className="text-xs text-slate-400">WASIT Category Catalog — {categories.length} {t('nav.categories')}</p>
        </Card>
      </div>
    </PublicLayout>
  );
}
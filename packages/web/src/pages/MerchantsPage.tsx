import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import type { JsonLd, MerchantSummary } from '@/lib/types';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function MerchantsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<MerchantSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.listMerchants()).then((res) => {
      setItems(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-7xl px-4 py-8">
        <SectionHeader title={t('merchants.title')} />
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} />
        ) : items.length === 0 ? (
          <EmptyState title={t('common.noData')} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((m) => (
              <Link key={m.id} to={`/merchants/${m.id}`} className="card flex min-w-0 items-center gap-4 p-4 hover:shadow-md">
                {m.logoUrl ? (
                  <img src={m.logoUrl} alt={m.storeName} className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-2xl text-slate-400">🏪</div>
                )}
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-800">{m.storeName}</p>
                  {m.verified ? <Badge color="green">✓ {t('suppliers.verified')}</Badge> : <Badge>unverified</Badge>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}

export function MerchantsDetailPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonLd, setJsonLd] = useState<JsonLd | null>(null);

  useEffect(() => {
    apiCall(() => api.getMerchant(id)).then((res) => {
      setData(res.data);
      setError(res.error);
    });
    apiCall(() => api.getStructuredData('MERCHANT', id)).then((res) => setJsonLd(res.data ?? null));
  }, [id]);

  return (
    <PublicLayout>
      <SeoHead
        title={`${String(data?.storeName ?? t('nav.merchants'))} — LE WASSIT`}
        description={typeof data?.description === 'string' ? data.description : undefined}
        canonicalPath={`/merchants/${id}`}
        jsonLd={jsonLd}
      />
      <div className="mx-auto max-w-3xl px-4 py-8">
        {error ? <ErrorState message={error} /> : !data ? <Spinner /> : (
          <Card>
            <h1 className="text-2xl font-bold text-slate-900">{String(data.storeName ?? '')}</h1>
            <p className="mt-2 text-sm text-slate-600">{String(data.description ?? '')}</p>
            {data.verified ? <Badge color="green">✓ {t('suppliers.verified')}</Badge> : <Badge>unverified</Badge>}
          </Card>
        )}
      </div>
    </PublicLayout>
  );
}
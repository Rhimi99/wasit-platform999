import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import type { AvailabilityBand, ComparisonGroup, ComparisonOffer } from '@/lib/types';

const AVAILABILITY_KEY: Record<AvailabilityBand, string> = {
  IN_STOCK: 'comparison.inStock',
  LOW_STOCK: 'comparison.lowStock',
  OUT_OF_STOCK: 'comparison.outOfStock',
  UNKNOWN: 'comparison.unknownStock',
};

const AVAILABILITY_COLOR: Record<AvailabilityBand, 'green' | 'amber' | 'red' | 'slate'> = {
  IN_STOCK: 'green',
  LOW_STOCK: 'amber',
  OUT_OF_STOCK: 'red',
  UNKNOWN: 'slate',
};

function localizedName(group: ComparisonGroup, locale: string): string {
  if (locale === 'ar' && group.nameAr) return group.nameAr;
  if (locale === 'fr' && group.nameFr) return group.nameFr;
  return group.name;
}

function localizedCategory(group: ComparisonGroup, locale: string): string | null {
  if (locale === 'ar' && group.categoryNameAr) return group.categoryNameAr;
  return group.categoryName;
}

function OfferRow({ offer, lowestPrice, t }: { offer: ComparisonOffer; lowestPrice: string; t: (k: string) => string }) {
  return (
    <tr data-testid="comparison-offer" className={offer.isLowestPrice ? 'bg-green-50/60' : undefined}>
      <td>
        <div className="flex items-center gap-2">
          {offer.seller.logoUrl ? (
            <img src={offer.seller.logoUrl} alt={offer.seller.name ?? ''} className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">🏢</span>
          )}
          <div className="min-w-0">
            {offer.seller.slug ? (
              <Link
                to={offer.seller.type === 'SUPPLIER' ? `/suppliers/${offer.seller.id}` : offer.seller.type === 'MERCHANT' ? `/merchants/${offer.seller.id}` : `/companies/${offer.seller.id}`}
                className="truncate font-medium text-wasit-700 hover:underline"
              >
                {offer.seller.name ?? t('comparison.unknownSeller')}
              </Link>
            ) : (
              <span className="truncate font-medium text-slate-700">{offer.seller.name ?? t('comparison.unknownSeller')}</span>
            )}
            <div className="mt-0.5 flex items-center gap-1">
              <Badge color="slate">{t(`comparison.sellerType.${offer.seller.type}`)}</Badge>
              {offer.seller.verified && <Badge color="green">✓ {t('suppliers.verified')}</Badge>}
            </div>
          </div>
        </div>
      </td>
      <td className="text-end">
        <span data-testid="offer-price" className={`font-semibold ${offer.isLowestPrice ? 'text-green-700' : 'text-slate-800'}`}>
          {formatMoney(offer.basePrice, offer.currencyCode)}
        </span>
        {offer.isLowestPrice ? (
          <Badge color="green" className="ms-2" testId="lowest-price-badge">{t('comparison.lowest')}</Badge>
        ) : (
          <span className="ms-2 text-xs text-slate-500">+{formatMoney(offer.priceDeltaFromLowest, offer.currencyCode)}</span>
        )}
      </td>
      <td className="text-end text-slate-600">{offer.moq} {offer.unit}</td>
      <td className="text-end">
        <Badge color={AVAILABILITY_COLOR[offer.availability]} testId="offer-availability">
          {t(AVAILABILITY_KEY[offer.availability])}
        </Badge>
      </td>
      <td className="text-end">
        <Link to={`/products/${offer.productId}`} className="text-sm font-medium text-wasit-700 hover:underline">
          {t('comparison.viewProduct')}
        </Link>
      </td>
    </tr>
  );
}

function GroupCard({ group, locale, t }: { group: ComparisonGroup; locale: string; t: (k: string) => string }) {
  return (
    <Card testId="comparison-group" className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div className="min-w-0">
          <h2 data-testid="group-title" className="text-base font-bold text-slate-900">{localizedName(group, locale)}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {localizedCategory(group, locale)}
            {group.brand ? ` · ${group.brand}` : ''}
            {group.barcode ? ` · ${t('comparison.barcode')}: ${group.barcode}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="teal">{group.sellerCount} {t('comparison.sellers')}</Badge>
          <Badge color="indigo">{group.offerCount} {t('comparison.offers')}</Badge>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 border-b border-slate-100 bg-slate-50/60 px-4 py-3 text-sm">
        <div>
          <span className="text-slate-500">{t('comparison.lowest')}: </span>
          <span className="font-semibold text-green-700">{formatMoney(group.lowestPrice, group.currencyCode)}</span>
        </div>
        <div>
          <span className="text-slate-500">{t('comparison.highest')}: </span>
          <span className="font-semibold text-slate-700">{formatMoney(group.highestPrice, group.currencyCode)}</span>
        </div>
        <div>
          <span className="text-slate-500">{t('comparison.spread')}: </span>
          <span data-testid="price-spread" className="font-semibold text-slate-800">{formatMoney(group.priceSpread, group.currencyCode)}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>{t('comparison.seller')}</th>
              <th className="text-end">{t('common.price')}</th>
              <th className="text-end">{t('comparison.moq')}</th>
              <th className="text-end">{t('comparison.availability')}</th>
              <th className="text-end">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {group.offers.map((offer) => (
              <OfferRow key={offer.productId} offer={offer} lowestPrice={group.lowestPrice} t={t} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PriceComparisonPage() {
  const { t, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const query = params.get('query') ?? '';
  const categoryId = params.get('categoryId') ?? '';
  const [input, setInput] = useState(query);
  const [groups, setGroups] = useState<ComparisonGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string; nameAr: string | null }>>([]);

  useEffect(() => setInput(query), [query]);

  useEffect(() => {
    apiCall(() => api.listCategories()).then((res) => {
      if (res.data) setCategories(res.data);
    });
  }, []);

  const load = useCallback(() => {
    let mounted = true;
    setLoading(true);
    apiCall(() => api.comparePrices({ query, categoryId, pageSize: 20 })).then((res) => {
      if (!mounted) return;
      setGroups(res.data?.items ?? []);
      setTotal(res.data?.pagination.total ?? 0);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [query, categoryId]);

  useEffect(() => load(), [load]);

  const applyFilters = (nextQuery: string, nextCategory: string) => {
    const next = new URLSearchParams();
    if (nextQuery.trim()) next.set('query', nextQuery.trim());
    if (nextCategory) next.set('categoryId', nextCategory);
    setParams(next);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    applyFilters(input, categoryId);
  };

  const heading = useMemo(() => (query ? `${t('comparison.title')}: «${query}»` : t('comparison.title')), [query, t]);

  return (
    <PublicLayout>
      <SeoHead
        title={`${heading} | LE WASSIT`}
        description={t('comparison.subtitle')}
        canonicalPath="/price-comparison"
      />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-bold text-slate-900">{t('comparison.title')}</h1>
        <p className="mb-6 text-sm text-slate-500">{t('comparison.subtitle')}</p>

        <form onSubmit={submit} className="mb-6 flex flex-wrap items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('comparison.searchPlaceholder')}
            className="input max-w-md"
            aria-label={t('comparison.searchPlaceholder')}
            data-testid="comparison-search-input"
          />
          <select
            value={categoryId}
            onChange={(e) => applyFilters(input, e.target.value)}
            className="input w-auto"
            aria-label={t('comparison.category')}
            data-testid="comparison-category-select"
          >
            <option value="">{t('comparison.allCategories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{locale === 'ar' && c.nameAr ? c.nameAr : c.name}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary shrink-0" data-testid="comparison-search-button">
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
          <>
            <p className="mb-4 text-sm text-slate-500" data-testid="comparison-count">
              {total} {t('comparison.comparableItems')}
            </p>
            <div className="flex flex-col gap-6">
              {groups.map((group) => (
                <GroupCard key={group.key} group={group} locale={locale} t={t} />
              ))}
            </div>
          </>
        )}
      </div>
    </PublicLayout>
  );
}

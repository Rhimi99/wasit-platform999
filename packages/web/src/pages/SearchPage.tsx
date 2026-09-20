import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiCall, formatMoney } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { Badge, Card, ErrorState, Spinner } from '@/components/ui';
import type { SearchResultGroup } from '@/lib/types';
import { SeoHead } from '@/components/SeoHead';
import { PublicLayout } from '@/components/layouts/PublicLayout';

const TABS = [
  { value: 'all', key: 'search.all' },
  { value: 'products', key: 'search.products' },
  { value: 'suppliers', key: 'search.suppliers' },
  { value: 'merchants', key: 'search.merchants' },
  { value: 'companies', key: 'search.companies' },
  { value: 'categories', key: 'search.categories' },
];

function renderGroup(group: SearchResultGroup, t: (k: string) => string) {
  switch (group.type) {
    case 'products':
      return (
        <div key={group.type} className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-slate-600">
            {t('search.products')} <span className="text-slate-400">({group.count})</span>
          </h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {group.items.slice(0, 4).map((p) => (
              <ProductCard key={String(p.id)} product={{
                id: String(p.id), name: String(p.name ?? p.nameAr ?? ''), nameAr: p.nameAr ? String(p.nameAr) : null,
                nameFr: null, slug: String(p.slug ?? ''), brand: p.brand ? String(p.brand) : null, sku: '',
                basePrice: String(p.basePrice ?? '0'), currencyCode: String(p.currencyCode ?? 'TND'), moq: p.moq ? Number(p.moq) : null,
                unit: p.unit ? String(p.unit) : null, sellerId: String(p.sellerId ?? ''), sellerType: (p.sellerType as never) ?? 'MERCHANT',
                categoryId: '', countryId: p.countryId ? String(p.countryId) : null, purchaseIntent: null, status: 'ACTIVE',
                createdAt: '', image: null,
              }} />
            ))}
          </div>
        </div>
      );
    case 'suppliers':
    case 'merchants':
    case 'companies': {
      const label = t(`search.${group.type}`);
      return (
        <div key={group.type} className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-slate-600">{label} <span className="text-slate-400">({group.count})</span></h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.slice(0, 6).map((item) => {
              const name = String(item.storeName ?? item.companyName ?? item.legalName ?? item.name ?? '');
              const logo = item.logoUrl ? String(item.logoUrl) : null;
              const verified = Boolean(item.verified);
              const id = String(item.id);
              const to = group.type === 'suppliers' ? `/suppliers/${id}` : group.type === 'merchants' ? `/merchants/${id}` : `/companies/${id}`;
              return (
                <Link key={id} to={to} className="card flex items-center gap-3 p-4 hover:shadow-md">
                  {logo ? <img src={logo} className="h-10 w-10 rounded-full object-cover" alt={name} /> : <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200 text-slate-500">🏢</div>}
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{name}</p>
                    {verified && <Badge color="green">✓ {t('suppliers.verified')}</Badge>}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      );
    }
    case 'categories':
      return (
        <div key="categories" className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-slate-600">{t('search.categories')} <span className="text-slate-400">({group.count})</span></h3>
          <div className="flex flex-wrap gap-2">
            {group.items.slice(0, 8).map((c) => (
              <Link key={String(c.id)} to={`/marketplace?category=${String(c.id)}`} className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-wasit-400 hover:text-wasit-700">
                {String(c.nameAr ?? c.name ?? '')}
              </Link>
            ))}
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function SearchPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? 'all';
  const [groups, setGroups] = useState<SearchResultGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setGroups([]);
      return;
    }
    let mounted = true;
    setLoading(true);
    apiCall(() => api.search({ q, type, pageSize: 8 })).then((res) => {
      if (!mounted) return;
      setGroups(res.data?.results ?? []);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [q, type]);

  const selectType = (v: string) => {
    const next = new URLSearchParams(params);
    next.set('type', v);
    setParams(next);
  };

  return (
    <PublicLayout>
      <SeoHead
        title={q ? `${q} — ${t('search.title')} | LE WASSIT` : `${t('search.title')} — LE WASSIT`}
        canonicalPath="/search"
        noindex
      />
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex justify-center">
          <SearchBar initial={q} />
        </div>
        <h1 className="mb-4 text-xl font-bold text-slate-900">{t('search.title')}: «{q}»</h1>

        <div className="mb-6 flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => selectType(tab.value)}
              className={`rounded-full px-3 py-1 text-sm font-medium ${type === tab.value ? 'bg-wasit-700 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
            >
              {t(tab.key)}
            </button>
          ))}
        </div>

        {loading ? <Spinner /> : error ? <ErrorState message={error} /> : groups.length === 0 ? (
          <p className="text-slate-500">{t('common.noData')}</p>
        ) : groups.map((g) => renderGroup(g, t))}

        {!q && <p className="text-slate-400">{t('nav.search')}</p>}
      </div>
    </PublicLayout>
  );
}
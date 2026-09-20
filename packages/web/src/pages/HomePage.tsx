import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { Card, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { WMonogram } from '@/components/brand/WMonogram';
import { GlobalNetwork } from '@/components/brand/GlobalNetwork';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { SeoHead } from '@/components/SeoHead';
import type { Category, ProductSummary, SupplierSummary } from '@/lib/types';

const ORG_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'LE WASSIT',
  alternateName: 'WASIT Business Global',
  description: 'Plateforme de commerce numérique B2B/B2C reliant fournisseurs, entreprises et commerçants.',
  url: typeof window !== 'undefined' ? window.location.origin : undefined,
};

function Container({ children, id, className = '' }: { children: React.ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={`mx-auto max-w-7xl px-4 sm:px-6 ${className}`}>
      {children}
    </section>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      <h2 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
      {sub ? <p className="mt-3 text-sm leading-relaxed text-slate-500 sm:text-base">{sub}</p> : null}
    </div>
  );
}

const SOLUTIONS = [
  { icon: '🛒', key: 'home.solutions.marketplace', desc: 'home.solutions.marketplace.desc', to: '/marketplace' },
  { icon: '⚖️', key: 'home.solutions.compare', desc: 'home.solutions.compare.desc', to: '/marketplace' },
  { icon: '🛡️', key: 'home.solutions.secure', desc: 'home.solutions.secure.desc', to: '#' },
  { icon: '🤖', key: 'home.solutions.ai', desc: 'home.solutions.ai.desc', to: '#' },
];

const FEATURES = [
  { icon: '🛒', key: 'home.features.b2b', desc: 'home.features.b2b.desc' },
  { icon: '🌐', key: 'home.features.network', desc: 'home.features.network.desc' },
  { icon: '🛡️', key: 'home.features.secure', desc: 'home.features.secure.desc' },
  { icon: '🤖', key: 'home.features.ai', desc: 'home.features.ai.desc' },
];

export function HomePage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      apiCall(() => api.listCategories()),
      apiCall(() => api.listProducts({ pageSize: '8' })),
      apiCall(() => api.listSuppliers()),
    ]).then(([c, p, sup]) => {
      if (!mounted) return;
      setCategories(c.data ?? []);
      setProducts(p.data?.items ?? []);
      setSuppliers(sup.data?.items ?? []);
      if (c.error || p.error || sup.error) setDataError(c.error ?? p.error ?? sup.error ?? null);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) return <Spinner />;

  return (
    <PublicLayout>
      <SeoHead
        title="LE WASSIT — Business Global | منصة الوساطة التجارية"
        description="WASIT relie fournisseurs, entreprises et commerçants : marketplace B2B/B2C, comparaison de prix, confiance et croissance."
        canonicalPath="/"
        jsonLd={ORG_JSON_LD}
      />
      {/* ═══════════ HERO ═══════════ */}
      <section className="relative overflow-hidden bg-gradient-to-br from-wasit-50 via-white to-wasit-100">
        <div className="pointer-events-none absolute -end-24 -top-24 h-96 w-96 rounded-full bg-wasit-200/40 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 -start-24 h-96 w-96 rounded-full bg-indigo-100/40 blur-3xl" aria-hidden />
        <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:gap-8 lg:py-20">
          {/* النص */}
          <div className="text-center lg:text-start">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-wasit-200 bg-white/70 px-4 py-1.5 text-xs font-semibold tracking-wide text-wasit-700 shadow-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-wasit-600" aria-hidden />
              {t('home.hero.badge')}
            </div>
            <div className="relative">
              {/* حرف W كبير بشكل خفيف — عنصر هوية */}
              <WMonogram variant="hero" size={120} className="absolute -top-7 start-1/2 -translate-x-1/2 opacity-[0.14] lg:start-0 lg:-translate-x-0 lg:-top-9" aria-hidden />
              <h1 className="relative text-4xl font-black tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">{t('home.hero.title')}</h1>
            </div>
            <p className="mt-3 text-xl font-semibold text-wasit-700 sm:text-2xl">{t('home.hero.titleTag')}</p>
            <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base lg:mx-0">
              {t('home.hero.subtitle')}
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link to="/marketplace" className="btn-primary w-full sm:w-auto sm:px-6 sm:py-3 sm:text-base">{t('home.hero.cta')}</Link>
              <Link to="/#solutions" className="btn-secondary w-full sm:w-auto sm:px-6 sm:py-3 sm:text-base">{t('home.hero.cta2')}</Link>
            </div>
            <div className="mt-8 flex items-center justify-center gap-2 text-xs font-medium text-slate-500 lg:justify-start">
              <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden />
              {t('home.hero.trust')}
            </div>
          </div>

          {/* البصري: شبكة عالمية */}
          <div className="relative">
            <div className="rounded-2xl bg-white/60 p-2 shadow-card ring-1 ring-slate-200/60">
              <GlobalNetwork className="w-full" />
            </div>
          </div>
        </div>
      </section>

      {/* شريط البحث (وظيفة حقيقية) */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6">
        <div className="-mt-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
          <SearchBar />
        </div>
      </section>

      {/* شريط مزايا وصفية (لا أرقام وهمية) */}
      <section className="border-y border-slate-100 bg-white">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.key} className="flex items-start gap-3">
              <span className="text-2xl" aria-hidden>{f.icon}</span>
              <div>
                <p className="text-sm font-bold text-slate-800">{t(f.key)}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{t(f.desc)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ SOLUTIONS ═══════════ */}
      <Container id="solutions" className="py-16">
        <SectionTitle title={t('home.solutions.title')} sub={t('home.solutions.sub')} />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {SOLUTIONS.map((s) => (
            <Link key={s.key} to={s.to} className="group card p-6 transition-all hover:-translate-y-1 hover:shadow-soft">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-wasit-100 text-2xl transition-colors group-hover:bg-wasit-200" aria-hidden>
                {s.icon}
              </div>
              <h3 className="mt-4 text-base font-bold text-slate-900">{t(s.key)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(s.desc)}</p>
            </Link>
          ))}
        </div>
      </Container>

      {/* ═══════════ MARKETS ═══════════ */}
      <section className="bg-wasit-900 py-16">
        <Container className="py-0">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('home.markets.title')}</h2>
            <p className="mt-3 text-sm leading-relaxed text-wasit-300 sm:text-base">{t('home.markets.sub')}</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: '🏭', key: 'home.markets.suppliers', desc: 'home.markets.suppliers.desc', to: '/suppliers' },
              { icon: '🏪', key: 'home.markets.merchants', desc: 'home.markets.merchants.desc', to: '/merchants' },
              { icon: '🏢', key: 'home.markets.companies', desc: 'home.markets.companies.desc', to: '/companies' },
              { icon: '📂', key: 'home.markets.categories', desc: 'home.markets.categories.desc', to: '/categories' },
            ].map((m) => (
              <Link
                key={m.key}
                to={m.to}
                className="group rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur transition-all hover:-translate-y-1 hover:border-wasit-400/40 hover:bg-white/10"
              >
                <span className="text-3xl" aria-hidden>{m.icon}</span>
                <h3 className="mt-4 text-base font-bold text-white">{t(m.key)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-wasit-300">{t(m.desc)}</p>
                <span className="mt-4 inline-block text-sm font-semibold text-wasit-300 transition-colors group-hover:text-white">→</span>
              </Link>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link to="/marketplace" className="inline-flex rounded-md bg-white px-6 py-3 text-sm font-bold text-wasit-800 shadow-soft transition-transform hover:-translate-y-0.5">
              {t('home.markets.cta')}
            </Link>
          </div>
        </Container>
      </section>

      {/* ═══════════ CATEGORIES (بيانات حقيقية) ═══════════ */}
      <Container className="py-16">
        <SectionHeader
          title={t('home.categories')}
          action={<Link to="/categories" className="text-sm font-semibold text-wasit-700 hover:underline">{t('common.viewAll')}</Link>}
        />
        {categories.length === 0 ? (
          <ErrorState message={dataError ?? t('common.noData')} onRetry={() => window.location.reload()} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => (
              <Link
                key={c.id}
                to={`/search?q=${encodeURIComponent('')}&type=categories`}
                className="card flex items-center gap-3 p-4 transition-all hover:-translate-y-0.5 hover:shadow-soft"
              >
                <span className="text-2xl" aria-hidden>{c.icon ?? '📂'}</span>
                <span className="font-medium text-slate-800">{c.nameAr ?? c.name}</span>
              </Link>
            ))}
          </div>
        )}
      </Container>

      {/* ═══════════ LATEST PRODUCTS (بيانات حقيقية) ═══════════ */}
      <section className="bg-slate-50/70 py-16">
        <Container className="py-0">
          <SectionHeader
            title={t('home.latestProducts')}
            subtitle={t('home.latestProducts.sub')}
            action={<Link to="/marketplace" className="text-sm font-semibold text-wasit-700 hover:underline">{t('common.viewAll')}</Link>}
          />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {products.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        </Container>
      </section>

      {/* ═══════════ TRUSTED SUPPLIERS (بيانات حقيقية) ═══════════ */}
      <Container className="py-16">
        <SectionHeader
          title={t('home.topSuppliers')}
          action={<Link to="/suppliers" className="text-sm font-semibold text-wasit-700 hover:underline">{t('common.viewAll')}</Link>}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {suppliers.map((s) => (
            <Card key={s.id} className="flex items-center gap-3 transition-all hover:-translate-y-0.5 hover:shadow-soft">
              {s.logoUrl ? (
                <img src={s.logoUrl} alt={s.companyName} className="h-11 w-11 rounded-full object-cover" />
              ) : (
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-wasit-100 text-xl">🏭</div>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-800">{s.companyName}</p>
                {s.verified ? (
                  <p className="text-xs font-semibold text-green-600">✓ {t('suppliers.verified')}</p>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </Container>

      {/* ═══════════ À PROPOS ═══════════ */}
      <Container id="a-propos" className="pb-16">
        <div className="grid items-center gap-10 rounded-2xl border border-slate-100 bg-gradient-to-br from-white to-wasit-50 p-8 shadow-card sm:p-12 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{t('home.about.title')}</h2>
            <p className="mt-2 text-sm font-semibold text-wasit-700">{t('home.about.sub')}</p>
            <p className="mt-5 text-sm leading-relaxed text-slate-600">{t('home.about.p1')}</p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('home.about.p2')}</p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <WMonogram size={180} className="opacity-90" />
          </div>
        </div>
      </Container>

      {/* ═══════════ RESSOURCES ═══════════ */}
      <Container id="ressources" className="pb-16">
        <SectionTitle title={t('home.resources.title')} sub={t('home.resources.sub')} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Link to="/search?q=&type=products" className="card p-6 text-center transition-all hover:-translate-y-1 hover:shadow-soft">
            <span className="text-3xl" aria-hidden>🔍</span>
            <h3 className="mt-3 font-bold text-slate-900">{t('home.resources.search')}</h3>
          </Link>
          <Link to="/marketplace" className="card p-6 text-center transition-all hover:-translate-y-1 hover:shadow-soft">
            <span className="text-3xl" aria-hidden>📦</span>
            <h3 className="mt-3 font-bold text-slate-900">{t('home.resources.products')}</h3>
          </Link>
          <Link to="/categories" className="card p-6 text-center transition-all hover:-translate-y-1 hover:shadow-soft">
            <span className="text-3xl" aria-hidden>📂</span>
            <h3 className="mt-3 font-bold text-slate-900">{t('home.resources.categories')}</h3>
          </Link>
        </div>
      </Container>

      {/* ═══════════ CTA + CONTACT ═══════════ */}
      <section id="contact" className="border-t border-slate-100 bg-gradient-to-r from-wasit-800 to-wasit-900 py-14">
        <Container className="py-0">
          <div className="flex flex-col items-center justify-between gap-6 text-center lg:flex-row lg:text-start">
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('home.ctaBand.title')}</h2>
              <p className="mt-2 text-sm text-wasit-300 sm:text-base">{t('home.ctaBand.sub')}</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link to="/register" className="btn-primary bg-white px-6 py-3 text-wasit-800 hover:bg-wasit-50">{t('home.ctaBand.primary')}</Link>
              <Link to="/marketplace" className="px-6 py-3 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/10">
                {t('home.ctaBand.secondary')}
              </Link>
            </div>
          </div>
        </Container>
      </section>
    </PublicLayout>
  );
}
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { Card, SectionHeader, Spinner } from '@/components/ui';
import { WMonogram } from '@/components/brand/WMonogram';
import { GlobalCommerceHero } from '@/components/brand/GlobalCommerceHero';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { Icon, type IconName } from '@/components/Icon';
import { SeoHead } from '@/components/SeoHead';
import type { Category, Country, ProductSummary, SupplierSummary } from '@/lib/types';

const ORG_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'LE WASSIT',
  alternateName: 'WASIT Business Global',
  description:
    'Plateforme de commerce numérique B2B/B2C reliant acheteurs, fournisseurs, commerçants et entreprises.',
  url: typeof window !== 'undefined' ? window.location.origin : undefined,
};

/** Descriptive capability indicators — no invented figures, no counts. */
const INDICATORS: Array<{ icon: IconName; key: string }> = [
  { icon: 'globe', key: 'global' },
  { icon: 'sparkles', key: 'ai' },
  { icon: 'buildings', key: 'b2b' },
  { icon: 'shield', key: 'secure' },
];

const VALUE_CARDS: Array<{ icon: IconName; key: string; tone: string }> = [
  { icon: 'globe', key: 'global', tone: 'text-ink-700 bg-ink-50' },
  { icon: 'sparkles', key: 'ai', tone: 'text-teal-600 bg-teal-50' },
  { icon: 'buildings', key: 'b2b', tone: 'text-slate-700 bg-slate-100' },
  { icon: 'shield', key: 'trust', tone: 'text-emerald-600 bg-emerald-50' },
];

const AUDIENCES: Array<{ icon: IconName; to: string; key: string }> = [
  { icon: 'search', to: '/marketplace', key: 'buyers' },
  { icon: 'tag', to: '/suppliers', key: 'suppliers' },
  { icon: 'buildings', to: '/companies', key: 'companies' },
];

const AI_AGENTS: Array<{ icon: IconName; key: string; live: boolean }> = [
  { icon: 'tag', key: 'product', live: true },
  { icon: 'megaphone', key: 'marketing', live: true },
  { icon: 'chart', key: 'sales', live: true },
  { icon: 'chart', key: 'analytics', live: true },
  { icon: 'search', key: 'marketResearch', live: true },
  { icon: 'headset', key: 'support', live: true },
];

const TRUST_ITEMS: Array<{ icon: IconName; key: string }> = [
  { icon: 'verified', key: 'verification' },
  { icon: 'shield', key: 'trust' },
  { icon: 'alert', key: 'risk' },
  { icon: 'scale', key: 'disputes' },
  { icon: 'clipboard', key: 'audit' },
  { icon: 'lock', key: 'payments' },
];

const HOW_STEPS: Array<{ icon: IconName; key: string }> = [
  { icon: 'user', key: 'account' },
  { icon: 'search', key: 'discover' },
  { icon: 'cart', key: 'order' },
  { icon: 'route', key: 'followup' },
];

function Container({ children, id, className = '' }: { children: React.ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-7xl scroll-mt-24 px-4 sm:px-6 ${className}`}>
      {children}
    </section>
  );
}

function SectionTitle({ title, sub, id }: { title: string; sub?: string; id?: string }) {
  return (
    <div id={id} className="mx-auto mb-12 max-w-2xl scroll-mt-24 text-center">
      <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">{title}</h2>
      {sub ? <p className="mt-4 text-sm leading-relaxed text-slate-500 sm:text-base">{sub}</p> : null}
    </div>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [supplierTotal, setSupplierTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      apiCall(() => api.listCategories()),
      apiCall(() => api.listProducts({ pageSize: '8' })),
      apiCall(() => api.listSuppliers()),
      apiCall(() => api.listCountries()),
    ]).then(([c, p, sup, co]) => {
      if (!mounted) return;
      setCategories(c.data ?? []);
      setProducts(p.data?.items ?? []);
      setProductTotal(p.data?.pagination?.total ?? p.data?.items?.length ?? 0);
      setSuppliers(sup.data?.items ?? []);
      setSupplierTotal(sup.data?.items?.length ?? 0);
      setCountries(co.data?.items ?? []);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) return <Spinner />;

  const activeCountries = countries.filter((c) => c.isActive);
  // Real figures only: every tile is rendered from live platform data and simply
  // omitted when the value is zero — no invented numbers, ever.
  const stats = [
    productTotal > 0 ? { icon: 'tag' as IconName, value: productTotal, key: 'home.stats.products' } : null,
    supplierTotal > 0 ? { icon: 'buildings' as IconName, value: supplierTotal, key: 'home.stats.suppliers' } : null,
    activeCountries.length > 0 ? { icon: 'globe' as IconName, value: activeCountries.length, key: 'home.stats.countries' } : null,
    categories.length > 0 ? { icon: 'clipboard' as IconName, value: categories.length, key: 'home.stats.categories' } : null,
  ].filter(Boolean) as Array<{ icon: IconName; value: number; key: string }>;

  return (
    <PublicLayout>
      <SeoHead
        title="LE WASSIT — Business Global | منصة الوساطة التجارية"
        description="LE WASSIT relie acheteurs, fournisseurs et entreprises : marketplace B2B/B2C, comparaison de prix, confiance et croissance."
        canonicalPath="/"
        jsonLd={ORG_JSON_LD}
      />

      {/* ═══════════ HERO ═══════════ */}
      <section className="relative overflow-hidden bg-ink-900">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(58% 58% at 78% 8%, rgba(61,89,214,0.42), transparent 70%), radial-gradient(48% 48% at 4% 92%, rgba(56,189,248,0.16), transparent 70%), linear-gradient(180deg, #081335 0%, #0b1a45 55%, #081335 100%)',
          }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(143,168,247,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(143,168,247,0.35) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
            maskImage: 'radial-gradient(70% 70% at 50% 40%, black, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(70% 70% at 50% 40%, black, transparent 100%)',
          }}
          aria-hidden
        />

        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:py-24">
          <div className="text-center lg:text-start">
            <span className="lp-eyebrow rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-ink-200 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-400" aria-hidden />
              {t('lp.hero.badge')}
            </span>

            <h1 className="mt-6 text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              LE WASSIT
            </h1>
            <p className="mt-3 text-xl font-semibold leading-snug text-ink-200 sm:text-2xl">
              {t('lp.hero.tagline')}
            </p>
            <p className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base lg:mx-0">
              {t('lp.hero.subtitle')}
            </p>

            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link
                to="/register"
                className="btn btn-lg w-full rounded-xl bg-white text-ink-900 shadow-glow hover:bg-ink-50 sm:w-auto"
              >
                {t('lp.hero.ctaPrimary')}
                <Icon name="arrow" className="h-4 w-4 rtl:rotate-180" />
              </Link>
              <Link to="/marketplace" className="lp-btn-light btn-lg w-full sm:w-auto">
                {t('lp.hero.ctaSecondary')}
              </Link>
            </div>

            {/* Descriptive capability indicators — no figures claimed. */}
            <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5 lg:justify-start">
              {INDICATORS.map((i) => (
                <span
                  key={i.key}
                  className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-3 py-1.5 text-[11px] font-semibold text-slate-200 backdrop-blur-sm"
                >
                  <Icon name={i.icon} className="h-3.5 w-3.5 text-teal-300" />
                  {t(`lp.ind.${i.key}`)}
                </span>
              ))}
            </div>
          </div>

          <GlobalCommerceHero className="animate-fade-up" />
        </div>
      </section>

      {/* ═══════════ SEARCH (real function) ═══════════ */}
      <Container className="-mt-8 sm:-mt-9">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-panel sm:p-5">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-ink-500">{t('lp.hero.searchLabel')}</p>
          <SearchBar />
        </div>
      </Container>

      {/* ═══════════ STATISTICS BAR (live data + descriptors) ═══════════ */}
      <Container className="py-14">
        <div className="grid gap-6 rounded-3xl border border-slate-200/80 bg-white p-7 shadow-card sm:p-8 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          <div>
            {stats.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                  {stats.map((s) => (
                    <div key={s.key}>
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-ink-50 text-ink-700">
                        <Icon name={s.icon} className="h-5 w-5" />
                      </span>
                      <p className="mt-3 text-2xl font-black tracking-tight text-ink-900 sm:text-3xl">{s.value}</p>
                      <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">{t(s.key)}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-[11px] text-slate-400">{t('home.stats.note')}</p>
              </>
            ) : (
              <p className="text-sm font-semibold text-slate-500">{t('lp.stats.pending')}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2.5 lg:justify-end">
            {INDICATORS.map((i) => (
              <span
                key={i.key}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs font-semibold text-slate-600"
              >
                <Icon name={i.icon} className="h-4 w-4 text-ink-600" />
                {t(`lp.ind.${i.key}`)}
              </span>
            ))}
          </div>
        </div>
      </Container>

      {/* ═══════════ WHY LE WASSIT / SOLUTIONS ═══════════ */}
      <Container id="solutions" className="pb-16">
        <SectionTitle title={t('lp.why.title')} sub={t('lp.why.sub')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VALUE_CARDS.map((v) => (
            <div key={v.key} className="lp-card lp-card-hover p-6">
              <span className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${v.tone}`}>
                <Icon name={v.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-bold text-ink-900">{t(`home.value.${v.key}`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.value.${v.key}.desc`)}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ AUDIENCES: BUYERS · SUPPLIERS & MERCHANTS · COMPANIES ═══════════ */}
      <Container className="pb-16">
        <SectionTitle title={t('lp.audience.title')} sub={t('lp.audience.sub')} />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {AUDIENCES.map((a) => (
            <Link key={a.key} to={a.to} className="lp-card lp-card-hover group flex flex-col p-7">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-ink-800 text-white shadow-soft">
                <Icon name={a.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-lg font-bold text-ink-900">{t(`lp.audience.${a.key}`)}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-500">{t(`lp.audience.${a.key}.desc`)}</p>
              <span className="lp-link-arrow mt-5">
                {t(`lp.audience.${a.key}.cta`)}
                <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" />
              </span>
            </Link>
          ))}
        </div>
      </Container>

      {/* ═══════════ GLOBAL MARKETS (real data) ═══════════ */}
      <section id="markets" className="lp-dark-band scroll-mt-24 py-16">
        <div
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            backgroundImage:
              'radial-gradient(50% 60% at 85% 12%, rgba(61,89,214,0.35), transparent 70%), radial-gradient(45% 55% at 4% 95%, rgba(56,189,248,0.12), transparent 70%)',
          }}
          aria-hidden
        />
        <Container className="relative">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('lp.markets.title')}</h2>
            <p className="mt-4 text-sm leading-relaxed text-slate-300 sm:text-base">{t('lp.markets.sub')}</p>
          </div>

          {/* Active countries — real data only. Inactive markets are never claimed. */}
          {activeCountries.length > 0 ? (
            <div className="mb-10">
              <p className="mb-4 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                {t('home.global.activeMarkets')}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                {countries.slice(0, 12).map((c) => (
                  <span
                    key={c.id}
                    className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${
                      c.isActive ? 'border-white/15 bg-white/10 text-white' : 'border-white/10 bg-transparent text-slate-400'
                    }`}
                  >
                    <span aria-hidden>{c.flag ?? '🌐'}</span>
                    {c.name}
                    {c.isActive ? <span className="h-1.5 w-1.5 rounded-full bg-teal-400" aria-hidden /> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { icon: 'globe' as IconName, to: '/suppliers', k: 'suppliers' },
              { icon: 'buildings' as IconName, to: '/merchants', k: 'merchants' },
              { icon: 'buildings' as IconName, to: '/companies', k: 'companies' },
            ].map((x) => (
              <Link
                key={x.k}
                to={x.to}
                className="group rounded-2xl border border-white/10 bg-white/[0.06] p-6 transition-all hover:-translate-y-1 hover:border-teal-400/40 hover:bg-white/10"
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300">
                  <Icon name={x.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-bold text-white">{t(`home.global.${x.k}`)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{t(`home.global.${x.k}.desc`)}</p>
                <Icon name="arrow" className="mt-4 h-4 w-4 text-teal-300 transition-transform group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" />
              </Link>
            ))}
          </div>

          <div className="mt-10 text-center">
            <Link to="/marketplace" className="btn btn-lg rounded-xl bg-white text-ink-900 hover:bg-ink-50">
              {t('home.global.cta')}
            </Link>
          </div>
        </Container>
      </section>

      {/* ═══════════ AI-POWERED COMMERCE ═══════════ */}
      <section id="ai" className="scroll-mt-24 border-b border-slate-200/70 bg-gradient-to-b from-ink-50/60 to-white py-16">
        <Container>
          <SectionTitle title={t('home.ai.title')} sub={t('home.ai.sub')} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AI_AGENTS.map((a) => (
              <div key={a.key} className="lp-card lp-card-hover p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                    <Icon name={a.icon} className="h-5 w-5" />
                  </span>
                  {a.live ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                      {t('home.ai.live')}
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      {t('home.ai.soon')}
                    </span>
                  )}
                </div>
                <h3 className="mt-4 text-base font-bold text-ink-900">{t(`home.ai.${a.key}`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.ai.${a.key}.desc`)}</p>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-relaxed text-slate-400">{t('home.ai.note')}</p>
        </Container>
      </section>

      {/* ═══════════ HOW IT WORKS ═══════════ */}
      <Container id="how-it-works" className="py-16">
        <SectionTitle title={t('home.how.title')} sub={t('home.how.sub')} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map((s, i) => (
            <div key={s.key} className="lp-card relative p-6">
              <span className="absolute end-4 top-4 z-0 text-3xl font-black text-slate-100" aria-hidden>
                0{i + 1}
              </span>
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink-800 text-white shadow-soft">
                <Icon name={s.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-ink-900">{t(`home.how.${s.key}`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.how.${s.key}.desc`)}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ TRUST & VERIFICATION ═══════════ */}
      <Container id="trust" className="pb-16">
        <SectionTitle title={t('home.trust.title')} sub={t('home.trust.sub')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST_ITEMS.map((item) => (
            <div key={item.key} className="lp-card flex items-start gap-4 p-5">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                <Icon name={item.icon} className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-ink-900">{t(`home.trust.${item.key}`)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{t(`home.trust.${item.key}.desc`)}</p>
              </div>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ RESOURCES: DISCOVERY FROM REAL DATA ═══════════ */}
      <section id="resources" className="scroll-mt-24 border-y border-slate-200/70 bg-white py-16">
        <Container>
          <SectionHeader
            title={t('home.discover.title')}
            subtitle={t('home.discover.sub')}
            action={<Link to="/marketplace" className="lp-link-arrow">{t('common.viewAll')}</Link>}
          />
          {products.length === 0 ? (
            <Card className="text-center text-sm text-slate-500">{t('common.noData')}</Card>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {products.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>
          )}

          {categories.length > 0 ? (
            <div className="mt-12">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-lg font-bold text-ink-900">{t('home.categories')}</h3>
                <Link to="/categories" className="lp-link-arrow">{t('common.viewAll')}</Link>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {categories.slice(0, 8).map((c) => (
                  <Link key={c.id} to="/marketplace" className="lp-card lp-card-hover flex items-center gap-3 p-4">
                    <span className="text-2xl" aria-hidden>{c.icon ?? '📦'}</span>
                    <span className="font-medium text-slate-800">{c.nameAr ?? c.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {suppliers.length > 0 ? (
            <div className="mt-12">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-lg font-bold text-ink-900">{t('home.topSuppliers')}</h3>
                <Link to="/suppliers" className="lp-link-arrow">{t('common.viewAll')}</Link>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {suppliers.slice(0, 8).map((s) => (
                  <Link key={s.id} to={`/suppliers/${s.id}`} className="lp-card lp-card-hover flex items-center gap-3 p-4">
                    {s.logoUrl ? (
                      <img src={s.logoUrl} alt={s.companyName} className="h-11 w-11 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink-50 text-ink-700">
                        <Icon name="buildings" className="h-5 w-5" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-800">{s.companyName}</p>
                      {s.verified ? (
                        <p className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                          <Icon name="check" className="h-3.5 w-3.5" />
                          {t('suppliers.verified')}
                        </p>
                      ) : null}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </Container>
      </section>

      {/* ═══════════ ABOUT ═══════════ */}
      <Container id="about" className="py-16">
        <div className="grid items-center gap-10 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white to-ink-50/60 p-8 shadow-card sm:p-12 lg:grid-cols-2">
          <div>
            <span className="lp-eyebrow text-ink-500">{t('lp.about.eyebrow')}</span>
            <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">{t('home.about.title')}</h2>
            <p className="mt-2 text-sm font-semibold text-ink-700">{t('home.about.sub')}</p>
            <p className="mt-5 text-sm leading-relaxed text-slate-600">{t('home.about.p1')}</p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('home.about.p2')}</p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <WMonogram size={180} className="opacity-90" />
          </div>
        </div>
      </Container>

      {/* ═══════════ FINAL CTA ═══════════ */}
      <section id="contact" className="lp-dark-band scroll-mt-24 py-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(55% 70% at 82% 20%, rgba(61,89,214,0.42), transparent 72%), linear-gradient(180deg, #0b1a45 0%, #081335 100%)',
          }}
          aria-hidden
        />
        <Container className="relative">
          <div className="flex flex-col items-center justify-between gap-8 text-center lg:flex-row lg:text-start">
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('lp.cta.title')}</h2>
              <p className="mt-3 text-sm text-slate-300 sm:text-base">{t('lp.cta.sub')}</p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Link to="/register" className="btn btn-lg rounded-xl bg-white text-ink-900 hover:bg-ink-50">
                {t('lp.hero.ctaPrimary')}
              </Link>
              <Link to="/login" className="lp-btn-light btn-lg">{t('lp.nav.login')}</Link>
            </div>
          </div>
        </Container>
      </section>
    </PublicLayout>
  );
}

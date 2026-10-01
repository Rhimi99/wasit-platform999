import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { Card, SectionHeader, Spinner } from '@/components/ui';
import { AxisMark } from '@/components/brand/AxisMark';
import { Brand } from '@/components/brand/Brand';
import { CorporateHero } from '@/components/brand/CorporateHero';
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

/** The four headline capabilities shown directly under the hero. */
const FEATURES: Array<{ icon: IconName; key: string }> = [
  { icon: 'globe', key: 'global' },
  { icon: 'sparkles', key: 'ai' },
  { icon: 'buildings', key: 'b2b' },
  { icon: 'shield', key: 'secure' },
];

const VALUE_CARDS: Array<{ icon: IconName; key: string; tone: string }> = [
  { icon: 'globe', key: 'global', tone: 'text-brand-700 text-brand-50' },
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
    <section id={id} className={`mx-auto w-full max-w-7xl scroll-mt-[var(--public-chrome-h)] px-4 sm:px-6 ${className}`}>
      {children}
    </section>
  );
}

function SectionTitle({ title, sub, id }: { title: string; sub?: string; id?: string }) {
  return (
    <div id={id} className="mx-auto mb-12 max-w-2xl scroll-mt-[var(--public-chrome-h)] text-center">
      <h2 className="lp-h2">{title}</h2>
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
    <PublicLayout darkHeader>
      <SeoHead
        title="LE WASSIT — Business Global | منصة الوساطة التجارية"
        description="LE WASSIT relie acheteurs, fournisseurs et entreprises : marketplace B2B/B2C, comparaison de prix, confiance et croissance."
        canonicalPath="/"
        jsonLd={ORG_JSON_LD}
      />

      {/* ═══════════ HERO — dark navy global commerce ═══════════
          Layering contract: the section isolates its own stacking context; the
          decorative layers (map, veil, skyline, scrim) sit at z-0 and the copy
          at z-10. The skyline is the *only* layer placed in normal flow (with a
          negative margin) rather than absolutely, so it is laid out as a band
          below the copy and can never paint over the headline or the CTA. */}
      <section className="lp-dark-section isolate bg-ink-950">
        {/* Dotted world map + global trade network behind the headline. */}
        <CorporateHero part="map" className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[62%] opacity-90" />
        {/* Soft electric-blue lighting and a navy veil so the copy always reads. */}
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage:
              'radial-gradient(75% 60% at 50% 0%, rgba(37,99,235,0.28), transparent 70%), linear-gradient(180deg, rgba(5,12,36,0.55) 0%, rgba(5,12,36,0.86) 62%, #050c24 100%)',
          }}
          aria-hidden
        />

        <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-4 pb-24 pt-10 text-center sm:px-6 sm:pb-28 sm:pt-14 lg:pb-32 lg:pt-20">
          {/* The lockup carries the page's single H1 (W / LE WASSIT / rule / BUSINESS GLOBAL). */}
          <Brand presentation as="h1" light className="justify-center" />

          <h2 className="mt-8 whitespace-pre-line font-serif text-[28px] font-bold leading-[1.3] text-white sm:text-4xl lg:text-[46px] lg:leading-[1.25]">
            {t('lp.hero.headline')}
          </h2>
          <p className="mx-auto mt-6 max-w-2xl whitespace-pre-line text-base leading-relaxed text-brand-100 sm:text-lg lg:text-xl">
            {t('lp.hero.subtitle')}
          </p>

          <div className="relative z-10 mt-9 flex w-full flex-col items-stretch gap-3.5 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
            <Link
              to="/register"
              className="relative z-10 inline-flex h-[56px] w-full items-center justify-center gap-2.5 rounded-[10px] bg-brand-600 px-7 text-base font-semibold text-white shadow-glow transition-colors hover:bg-brand-500 sm:w-[270px]"
            >
              {t('lp.hero.ctaPrimary')}
              <Icon name="arrow" className="h-4 w-4 rtl:rotate-180" />
            </Link>
            <Link
              to="/marketplace"
              className="lp-btn-ghost-dark relative z-10 inline-flex h-[56px] w-full items-center justify-center gap-2.5 px-7 text-base font-semibold sm:w-[270px]"
            >
              {t('lp.hero.ctaSecondary')}
              <svg viewBox="0 0 12 12" className="h-3 w-3 rtl:rotate-180" aria-hidden>
                <path d="M3.5 1.8 9 6l-5.5 4.2z" fill="currentColor" />
              </svg>
            </Link>
          </div>

          {/* Descriptive capability indicators — no invented figures. */}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5">
            {INDICATORS.map((i) => (
              <span key={i.key} className="inline-flex items-center gap-2 text-[13px] font-semibold text-brand-100">
                <Icon name={i.icon} className="h-4 w-4 text-brand-300" />
                {t(`lp.ind.${i.key}`)}
              </span>
            ))}
          </div>
        </div>

        {/* Illuminated skyline: in normal flow at a fixed aspect ratio, pulled up
            so it starts at the copy's baseline band and never overlaps it. Its
            height comes from the ratio (not a viewport percentage), so `slice`
            always shows the same slice of the city on every screen width. */}
        <div className="relative z-0 -mt-16 w-full aspect-[1000/310] sm:-mt-20">
          <CorporateHero part="skyline" className="pointer-events-none absolute inset-0" />
          <div
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: 'linear-gradient(180deg, rgba(5,12,36,0.9), rgba(5,12,36,0) 45%)' }}
            aria-hidden
          />
        </div>
      </section>

      {/* ═══════════ FEATURES — four premium capabilities ═══════════ */}
      <section className="lp-dark-section bg-ink-950 pb-16 pt-14 sm:pt-16">
        <Container>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.key} className="lp-dark-card p-6 text-center sm:text-start">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-brand-400/30 bg-brand-500/15 text-brand-300">
                  <Icon name={f.icon} className="h-6 w-6" />
                </span>
                <h3 className="mt-4 text-base font-bold text-white">{t(`lp.ind.${f.key}`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-brand-100/75">{t(`home.value.${f.key}.desc`)}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* ═══════════ STATISTICS — real platform data only ═══════════ */}
      <section className="lp-dark-section bg-ink-950 pb-16">
        <Container>
          <div className="rounded-[26px] border border-brand-400/25 bg-gradient-to-br from-brand-900/70 via-ink-900 to-ink-950 px-6 py-9 shadow-glow sm:px-10 sm:py-11">
            {stats.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-4">
                  {stats.map((s) => (
                    <div key={s.key} className="flex flex-col items-center text-center">
                      <span className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-brand-400/40 bg-brand-500/15 text-brand-300">
                        <Icon name={s.icon} className="h-6 w-6" />
                      </span>
                      <p className="mt-4 font-serif text-4xl font-bold leading-none text-white sm:text-[42px]">{s.value}</p>
                      <p className="mt-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-200">
                        {t(s.key)}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-8 text-center text-[11px] text-brand-200/70">{t('home.stats.note')}</p>
              </>
            ) : (
              <p className="text-center text-sm font-semibold text-brand-200">{t('lp.stats.pending')}</p>
            )}
          </div>
        </Container>
      </section>

      {/* Light surface begins here — everything below the dark hero block. */}
        <div className="bg-white">
        {/* ═══════════ SEARCH (real function) ═══════════ */}
        <Container className="pb-14 pt-14">
          <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-panel sm:p-5">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-brand-600">{t('lp.hero.searchLabel')}</p>
            <SearchBar />
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
                <h3 className="mt-4 text-base font-bold text-slate-900">{t(`home.value.${v.key}`)}</h3>
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
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-soft">
                  <Icon name={a.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-5 text-lg font-bold text-slate-900">{t(`lp.audience.${a.key}`)}</h3>
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
        <section id="markets" className="lp-dark-band scroll-mt-[var(--public-chrome-h)] py-16">
          <Container className="relative">
            <div className="mx-auto mb-12 max-w-2xl text-center">
              <h2 className="lp-h2">{t('lp.markets.title')}</h2>
              <p className="mt-4 text-sm leading-relaxed text-slate-500 sm:text-base">{t('lp.markets.sub')}</p>
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
                        c.isActive ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-400'
                      }`}
                    >
                      <span aria-hidden>{c.flag ?? '🌐'}</span>
                      {c.name}
                      {c.isActive ? <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden /> : null}
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
                  className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-card transition-all hover:-translate-y-1 hover:border-brand-200 hover:shadow-lift"
                >
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon name={x.icon} className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-base font-bold text-slate-900">{t(`home.global.${x.k}`)}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{t(`home.global.${x.k}.desc`)}</p>
                  <Icon name="arrow" className="mt-4 h-4 w-4 text-brand-600 transition-transform group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" />
                </Link>
              ))}
            </div>

            <div className="mt-10 text-center">
              <Link to="/marketplace" className="lp-btn-primary btn-lg">
                {t('home.global.cta')}
              </Link>
            </div>
          </Container>
        </section>

        {/* ═══════════ AI-POWERED COMMERCE ═══════════ */}
        <section id="ai" className="scroll-mt-[var(--public-chrome-h)] border-b border-slate-200/70 bg-gradient-to-b from-brand-50/60 to-white py-16">
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
                  <h3 className="mt-4 text-base font-bold text-slate-900">{t(`home.ai.${a.key}`)}</h3>
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
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-soft">
                  <Icon name={s.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-bold text-slate-900">{t(`home.how.${s.key}`)}</h3>
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
                  <h3 className="text-sm font-bold text-slate-900">{t(`home.trust.${item.key}`)}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-500">{t(`home.trust.${item.key}.desc`)}</p>
                </div>
              </div>
            ))}
          </div>
        </Container>

        {/* ═══════════ RESOURCES: DISCOVERY FROM REAL DATA ═══════════ */}
        <section id="resources" className="scroll-mt-[var(--public-chrome-h)] border-y border-slate-200/70 bg-white py-16">
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
                  <h3 className="text-lg font-bold text-slate-900">{t('home.categories')}</h3>
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
                  <h3 className="text-lg font-bold text-slate-900">{t('home.topSuppliers')}</h3>
                  <Link to="/suppliers" className="lp-link-arrow">{t('common.viewAll')}</Link>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {suppliers.slice(0, 8).map((s) => (
                    <Link key={s.id} to={`/suppliers/${s.id}`} className="lp-card lp-card-hover flex items-center gap-3 p-4">
                      {s.logoUrl ? (
                        <img src={s.logoUrl} alt={s.companyName} className="h-11 w-11 shrink-0 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
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
          <div className="grid items-center gap-10 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white to-brand-50/60 p-8 shadow-card sm:p-12 lg:grid-cols-2">
            <div>
              <span className="lp-eyebrow text-brand-600">{t('lp.about.eyebrow')}</span>
              <h2 className="lp-h2 mt-3">{t('home.about.title')}</h2>
              <p className="mt-2 text-sm font-semibold text-brand-700">{t('home.about.sub')}</p>
              <p className="mt-5 text-sm leading-relaxed text-slate-600">{t('home.about.p1')}</p>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('home.about.p2')}</p>
            </div>
            <div className="flex justify-center lg:justify-end">
              <AxisMark size={180} title="" className="opacity-95" />
            </div>
          </div>
        </Container>

        {/* ═══════════ FINAL CTA ═══════════ */}
        <section id="contact" className="scroll-mt-[var(--public-chrome-h)] border-t border-slate-200 bg-gradient-to-b from-white to-brand-50/60 py-16">
          <Container className="relative">
            <div className="flex flex-col items-center justify-between gap-8 text-center lg:flex-row lg:text-start">
              <div>
                <h2 className="lp-h2">{t('lp.cta.title')}</h2>
                <p className="mt-3 text-sm text-slate-500 sm:text-base">{t('lp.cta.sub')}</p>
              </div>
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <Link to="/register" className="lp-btn-primary btn-lg">
                  {t('lp.hero.ctaPrimary')}
                </Link>
                <Link to="/login" className="lp-btn-outline btn-lg">{t('lp.nav.login')}</Link>
              </div>
            </div>
          </Container>
        </section>
      </div>
    </PublicLayout>
  );
}

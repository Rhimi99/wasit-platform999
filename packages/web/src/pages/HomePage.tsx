import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { SearchBar } from '@/components/SearchBar';
import { ProductCard } from '@/components/ProductCard';
import { Card, SectionHeader, Spinner } from '@/components/ui';
import { WMonogram } from '@/components/brand/WMonogram';
import { TradeNetwork } from '@/components/brand/TradeNetwork';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { Icon, type IconName } from '@/components/Icon';
import { SeoHead } from '@/components/SeoHead';
import type { Category, Country, ProductSummary, SupplierSummary } from '@/lib/types';

const ORG_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'LE WASSIT',
  alternateName: 'WASIT Business Global',
  description: 'Plateforme de commerce numérique B2B/B2C reliant fournisseurs, entreprises et commerçants.',
  url: typeof window !== 'undefined' ? window.location.origin : undefined,
};

const VALUE_CARDS: Array<{ icon: IconName; key: string; tone: string }> = [
  { icon: 'globe', key: 'global', tone: 'text-brand-600 bg-brand-50' },
  { icon: 'sparkles', key: 'ai', tone: 'text-teal-600 bg-teal-50' },
  { icon: 'buildings', key: 'b2b', tone: 'text-slate-700 bg-slate-100' },
  { icon: 'shield', key: 'trust', tone: 'text-emerald-600 bg-emerald-50' },
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
    <section id={id} className={`mx-auto w-full max-w-7xl px-4 sm:px-6 ${className}`}>
      {children}
    </section>
  );
}

function SectionTitle({ title, sub, id }: { title: string; sub?: string; id?: string }) {
  return (
    <div id={id} className="mx-auto mb-10 max-w-2xl scroll-mt-24 text-center">
      <h2 className="text-2xl font-extrabold tracking-tight text-navy sm:text-3xl">{title}</h2>
      {sub ? <p className="mt-3 text-sm leading-relaxed text-slate-500 sm:text-base">{sub}</p> : null}
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
  const hasStats = productTotal > 0;

  return (
    <PublicLayout>
      <SeoHead
        title="LE WASSIT — Business Global | منصة الوساطة التجارية"
        description="WASIT relie fournisseurs, entreprises et commerçants : marketplace B2B/B2C, comparaison de prix, confiance et croissance."
        canonicalPath="/"
        jsonLd={ORG_JSON_LD}
      />

      {/* ═══════════ HERO ═══════════ */}
      <section className="relative overflow-hidden border-b border-slate-200/70 bg-gradient-to-b from-white to-canvas">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(60% 60% at 85% 15%, rgba(37,99,235,0.10), transparent 70%), radial-gradient(50% 50% at 5% 90%, rgba(20,184,166,0.10), transparent 70%)',
          }}
          aria-hidden
        />
        <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:gap-12 lg:py-20">
          <div className="text-center lg:text-start">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/80 px-4 py-1.5 text-xs font-semibold tracking-wide text-brand-700 shadow-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500" aria-hidden />
              {t('home.hero.badge')}
            </div>
            <div className="relative">
              <WMonogram variant="hero" size={130} className="absolute -top-8 start-0 opacity-[0.10] lg:-top-10" aria-hidden />
              <h1 className="relative text-4xl font-black leading-[1.1] tracking-tight text-navy sm:text-5xl lg:text-6xl">
                {t('home.hero.titleNew')}
              </h1>
            </div>
            <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base lg:mx-0">
              {t('home.hero.subtitleNew')}
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link to="/marketplace" className="btn-primary btn-lg w-full sm:w-auto">{t('home.hero.cta')}</Link>
              <Link to="/register" className="btn-secondary btn-lg w-full sm:w-auto">{t('home.hero.cta3')}</Link>
            </div>

            {/* honest coverage chips — real data only (no invented numbers) */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
              {productTotal > 0 ? (
                <span className="chip">
                  <Icon name="tag" className="h-3.5 w-3.5 text-brand-600" />
                  <strong className="font-extrabold text-navy">{productTotal}</strong>
                  <span className="text-slate-500">{t('home.stats.products')}</span>
                </span>
              ) : null}
              {supplierTotal > 0 ? (
                <span className="chip">
                  <Icon name="buildings" className="h-3.5 w-3.5 text-brand-600" />
                  <strong className="font-extrabold text-navy">{supplierTotal}</strong>
                  <span className="text-slate-500">{t('home.stats.suppliers')}</span>
                </span>
              ) : null}
              {activeCountries.length > 0 ? (
                <span className="chip">
                  <Icon name="globe" className="h-3.5 w-3.5 text-brand-600" />
                  <strong className="font-extrabold text-navy">{activeCountries.length}</strong>
                  <span className="text-slate-500">{t('home.stats.countries')}</span>
                </span>
              ) : null}
            </div>
          </div>

          <div className="animate-fade-up">
            <TradeNetwork />
          </div>
        </div>
      </section>

      {/* ═══════════ SEARCH (real function) ═══════════ */}
      <Container className="-mt-6 sm:-mt-7">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card sm:p-5">
          <SearchBar />
        </div>
      </Container>

      {/* ═══════════ QUICK VALUE CARDS ═══════════ */}
      <Container className="py-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VALUE_CARDS.map((v) => (
            <div key={v.key} className="card card-hover p-6">
              <span className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${v.tone}`}>
                <Icon name={v.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-bold text-navy">{t(`home.value.${v.key}`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.value.${v.key}.desc`)}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ PRODUCT DISCOVERY (real data) ═══════════ */}
      <section className="border-y border-slate-200/70 bg-white py-16">
        <Container>
          <SectionHeader
            title={t('home.discover.title')}
            subtitle={t('home.discover.sub')}
            action={<Link to="/marketplace" className="text-sm font-semibold text-brand-700 hover:underline">{t('common.viewAll')}</Link>}
          />
          {products.length === 0 ? (
            <Card className="text-center text-sm text-slate-500">{t('common.noData')}</Card>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {products.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>
          )}
        </Container>
      </section>

      {/* ═══════════ CATEGORIES (real data) ═══════════ */}
      {categories.length > 0 ? (
        <Container className="py-16">
          <SectionHeader
            title={t('home.categories')}
            action={<Link to="/categories" className="text-sm font-semibold text-brand-700 hover:underline">{t('common.viewAll')}</Link>}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {categories.slice(0, 8).map((c) => (
              <Link key={c.id} to="/marketplace" className="card card-hover flex items-center gap-3 p-4">
                <span className="text-2xl" aria-hidden>{c.icon ?? '📦'}</span>
                <span className="font-medium text-slate-800">{c.nameAr ?? c.name}</span>
              </Link>
            ))}
          </div>
        </Container>
      ) : null}

      {/* ═══════════ GLOBAL MARKET ═══════════ */}
      <section className="bg-navy py-16">
        <Container>
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="scroll-mt-24 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('home.global.title')}</h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-300 sm:text-base">{t('home.global.sub')}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Link
              to="/marketplace"
              className="group rounded-2xl border border-white/10 bg-white/[0.06] p-6 transition-all hover:-translate-y-1 hover:border-teal-400/40 hover:bg-white/10"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300">
                <Icon name="globe" className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-white">{t('home.global.suppliers')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{t('home.global.suppliers.desc')}</p>
              <Icon name="arrow" className="mt-4 h-4 w-4 text-teal-300 transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />
            </Link>
            <Link
              to="/merchants"
              className="group rounded-2xl border border-white/10 bg-white/[0.06] p-6 transition-all hover:-translate-y-1 hover:border-teal-400/40 hover:bg-white/10"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300">
                <Icon name="buildings" className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-white">{t('home.global.merchants')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{t('home.global.merchants.desc')}</p>
              <Icon name="arrow" className="mt-4 h-4 w-4 text-teal-300 transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />
            </Link>
            <Link
              to="/companies"
              className="group rounded-2xl border border-white/10 bg-white/[0.06] p-6 transition-all hover:-translate-y-1 hover:border-teal-400/40 hover:bg-white/10"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300">
                <Icon name="buildings" className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-white">{t('home.global.companies')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{t('home.global.companies.desc')}</p>
              <Icon name="arrow" className="mt-4 h-4 w-4 text-teal-300 transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />
            </Link>
            <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-6">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300">
                <Icon name="sparkles" className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-white">{t('home.global.ai')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{t('home.global.ai.desc')}</p>
            </div>
          </div>

          {/* Active countries — real data only. Inactive markets are never claimed. */}
          {activeCountries.length > 0 ? (
            <div className="mt-10">
              <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">{t('home.global.activeMarkets')}</p>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                {countries.slice(0, 12).map((c) => (
                  <span
                    key={c.id}
                    className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${
                      c.isActive
                        ? 'border-white/15 bg-white/10 text-white'
                        : 'border-white/10 bg-transparent text-slate-400'
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

          <div className="mt-10 text-center">
            <Link to="/marketplace" className="btn btn-lg bg-white text-navy hover:bg-slate-100">
              {t('home.global.cta')}
            </Link>
          </div>
        </Container>
      </section>

      {/* ═══════════ HOW IT WORKS ═══════════ */}
      <Container id="how-it-works" className="py-16">
        <SectionTitle title={t('home.how.title')} sub={t('home.how.sub')} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map((s, i) => (
            <div key={s.key} className="card relative p-6">
              <span className="absolute end-4 top-4 z-0 text-3xl font-black text-slate-100" aria-hidden>
                0{i + 1}
              </span>
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-soft">
                <Icon name={s.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-navy">{t(`home.how.${s.key}`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.how.${s.key}.desc`)}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ AI ═══════════ */}
      <section id="ai" className="scroll-mt-24 border-y border-slate-200/70 bg-gradient-to-b from-brand-50/50 to-white py-16">
        <Container>
          <SectionTitle title={t('home.ai.title')} sub={t('home.ai.sub')} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AI_AGENTS.map((a) => (
              <div key={a.key} className="card card-hover p-5">
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
                <h3 className="mt-4 text-base font-bold text-navy">{t(`home.ai.${a.key}`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{t(`home.ai.${a.key}.desc`)}</p>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-relaxed text-slate-400">{t('home.ai.note')}</p>
        </Container>
      </section>

      {/* ═══════════ TRUST ═══════════ */}
      <Container id="trust" className="py-16">
        <SectionTitle title={t('home.trust.title')} sub={t('home.trust.sub')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST_ITEMS.map((item) => (
            <div key={item.key} className="card flex items-start gap-4 p-5">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                <Icon name={item.icon} className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-navy">{t(`home.trust.${item.key}`)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{t(`home.trust.${item.key}.desc`)}</p>
              </div>
            </div>
          ))}
        </div>
      </Container>

      {/* ═══════════ SUPPLIERS (real data) ═══════════ */}
      {suppliers.length > 0 ? (
        <section className="border-t border-slate-200/70 bg-white py-16">
          <Container>
            <SectionHeader
              title={t('home.topSuppliers')}
              action={<Link to="/suppliers" className="text-sm font-semibold text-brand-700 hover:underline">{t('common.viewAll')}</Link>}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {suppliers.slice(0, 8).map((s) => (
                <Link key={s.id} to={`/suppliers/${s.id}`} className="card card-hover flex items-center gap-3 p-4">
                  {s.logoUrl ? (
                    <img src={s.logoUrl} alt={s.companyName} className="h-11 w-11 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
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
          </Container>
        </section>
      ) : null}

      {/* ═══════════ STATS (real data only) ═══════════ */}
      {hasStats ? (
        <section className="bg-navy py-14">
          <Container>
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              {[
                { icon: 'tag' as IconName, value: productTotal, key: 'home.stats.products' },
                { icon: 'buildings' as IconName, value: supplierTotal, key: 'home.stats.suppliers' },
                { icon: 'globe' as IconName, value: activeCountries.length, key: 'home.stats.countries' },
                { icon: 'clipboard' as IconName, value: categories.length, key: 'home.stats.categories' },
              ].map((s) => (
                <div key={s.key} className="text-center">
                  <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-teal-300">
                    <Icon name={s.icon} className="h-5 w-5" />
                  </span>
                  <p className="mt-3 text-3xl font-black tracking-tight text-white">{s.value}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t(s.key)}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-[11px] text-slate-500">{t('home.stats.note')}</p>
          </Container>
        </section>
      ) : null}

      {/* ═══════════ ABOUT ═══════════ */}
      <Container id="about" className="py-16">
        <div className="grid items-center gap-10 rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white to-brand-50/50 p-8 shadow-card sm:p-12 lg:grid-cols-2">
          <div>
            <h2 className="scroll-mt-24 text-2xl font-extrabold tracking-tight text-navy sm:text-3xl">{t('home.about.title')}</h2>
            <p className="mt-2 text-sm font-semibold text-brand-700">{t('home.about.sub')}</p>
            <p className="mt-5 text-sm leading-relaxed text-slate-600">{t('home.about.p1')}</p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('home.about.p2')}</p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <WMonogram size={180} className="opacity-90" />
          </div>
        </div>
      </Container>

      {/* ═══════════ FINAL CTA ═══════════ */}
      <section id="contact" className="scroll-mt-24 bg-gradient-to-br from-brand-700 via-navy to-navy py-16">
        <Container>
          <div className="flex flex-col items-center justify-between gap-8 text-center lg:flex-row lg:text-start">
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{t('home.ctaBand.titleNew')}</h2>
              <p className="mt-3 text-sm text-slate-300 sm:text-base">{t('home.ctaBand.subNew')}</p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Link to="/marketplace" className="btn btn-lg bg-white text-navy hover:bg-slate-100">{t('home.hero.cta')}</Link>
              <Link to="/register" className="btn btn-lg border border-white/30 text-white hover:bg-white/10">{t('nav.register')}</Link>
            </div>
          </div>
        </Container>
      </section>
    </PublicLayout>
  );
}

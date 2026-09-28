import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Brand } from '@/components/brand/Brand';

/** Enabled only on the public demo build; production builds leave it unset. */
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

/**
 * Primary desktop navigation. Anchors target landing sections by id; the
 * commercial routes stay reachable from the marketplace entry and the footer.
 */
const NAV_LINKS: Array<{ key: string; to: string }> = [
  { key: 'nav.home', to: '/' },
  { key: 'lp.nav.about', to: '/#about' },
  { key: 'lp.nav.solutions', to: '/#solutions' },
  { key: 'lp.nav.markets', to: '/#markets' },
  { key: 'lp.nav.resources', to: '/#resources' },
  { key: 'lp.nav.contact', to: '/#contact' },
];

export function PublicHeader({ dark = false }: { dark?: boolean }) {
  const { t } = useI18n();
  const { user, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /** Jump to a landing section: navigate home first when we are elsewhere. */
  const goToSection = (hash: string) => {
    setMenuOpen(false);
    if (!hash) {
      navigate('/');
      return;
    }
    const scroll = () => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (window.location.pathname !== '/') {
      navigate('/');
      window.setTimeout(scroll, 80);
    } else {
      scroll();
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/');
    setMenuOpen(false);
  };

  const navItemClass = dark
    ? 'relative inline-flex h-full items-center text-[15px] font-medium text-white/85 transition-colors after:absolute after:bottom-0 after:start-0 after:h-[2.5px] after:w-0 after:rounded-full after:bg-brand-400 after:transition-all hover:text-white hover:after:w-full'
    : 'relative inline-flex h-full items-center text-[15px] font-medium text-ink-1000/85 transition-colors after:absolute after:bottom-0 after:start-0 after:h-[2.5px] after:w-0 after:rounded-full after:bg-brand-600 after:transition-all hover:text-brand-700 hover:after:w-full';

  const shellClass = dark
    ? `sticky top-[var(--demo-banner-h,0px)] z-40 border-b border-white/10 bg-ink-950/95 backdrop-blur transition-shadow duration-300 ${scrolled ? 'shadow-panel' : ''}`
    : `sticky top-[var(--demo-banner-h,0px)] z-40 border-b bg-white transition-shadow duration-300 ${scrolled ? 'border-slate-200 shadow-soft' : 'border-slate-100'}`;

  const menuBtnClass = dark
    ? 'flex h-10 w-10 items-center justify-center rounded-lg border border-white/25 text-white transition-colors hover:border-brand-400 hover:text-brand-300 xl:hidden'
    : 'flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:border-brand-300 hover:text-brand-700 xl:hidden';

  return (
    <header className={shellClass}>
      <div
        className={`mx-auto flex max-w-[1400px] items-center gap-2 px-3 transition-all duration-300 sm:gap-3 sm:px-6 lg:px-8 ${
          scrolled ? 'h-[64px] lg:h-[76px]' : 'h-[72px] sm:h-[80px] lg:h-[100px]'
        }`}
      >
        <div className="min-w-0 shrink">
          <Brand compact light={dark} />
        </div>

        <nav className="mx-auto hidden h-full items-center gap-9 xl:flex" aria-label={t('nav.home')}>
          {NAV_LINKS.map((l) => {
            const isActive = l.to === '/';
            return (
              <a
                key={l.key}
                href={l.to}
                aria-current={isActive ? 'page' : undefined}
                className={`${navItemClass} ${isActive ? 'text-brand-700 after:w-full' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  goToSection(l.to.startsWith('/#') ? l.to.slice(2) : '');
                }}
              >
                {t(l.key)}
              </a>
            );
          })}
        </nav>

        <div className="ms-auto flex shrink-0 items-center gap-2 sm:gap-3 xl:ms-0">
          <LanguageSwitcher dark={dark} />
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className={`${dark ? 'lp-btn-ghost-dark' : 'lp-btn-outline'} hidden !py-2 text-sm sm:inline-flex`}>{t('nav.myDashboard')}</Link>
              <button
                onClick={handleLogout}
                className={`hidden text-sm font-semibold transition-colors sm:block ${dark ? 'text-white/70 hover:text-red-300' : 'text-slate-500 hover:text-red-600'}`}
              >
                {t('nav.logout')}
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="hidden h-[48px] items-center rounded-[10px] bg-brand-600 px-6 text-sm font-semibold text-white shadow-soft transition-colors hover:bg-brand-700 sm:inline-flex"
              >
                {t('lp.nav.login')}
              </Link>
              <Link
                to="/register"
                className={`hidden text-sm font-semibold transition-colors lg:block ${dark ? 'text-white/75 hover:text-white' : 'text-slate-600 hover:text-brand-700'}`}
              >
                {t('lp.nav.start')}
              </Link>
            </>
          )}
          {user?.roles.includes('ADMIN') || user?.roles.includes('SUPER_ADMIN') ? (
            <Link to="/admin" className={`hidden text-sm font-semibold hover:underline lg:block ${dark ? 'text-brand-300' : 'text-brand-700'}`}>{t('nav.admin')}</Link>
          ) : null}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className={menuBtnClass}
          >
            <span className="text-xl leading-none">{menuOpen ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>

      {menuOpen ? (
        <nav
          className={`border-t px-4 pb-4 pt-2 xl:hidden ${
            dark ? 'border-white/10 bg-ink-950 shadow-panel' : 'border-slate-100 bg-white shadow-card'
          }`}
          aria-label="Mobile navigation"
        >
          <div className="flex flex-col">
            {NAV_LINKS.map((l) => (
              <a
                key={l.key}
                href={l.to}
                onClick={(e) => {
                  e.preventDefault();
                  goToSection(l.to.startsWith('/#') ? l.to.slice(2) : '');
                }}
                className={`border-b py-3 text-sm font-semibold last:border-0 ${
                  dark ? 'border-white/10 text-white/85 hover:text-white' : 'border-slate-100 text-slate-700 hover:text-brand-700'
                }`}
              >
                {t(l.key)}
              </a>
            ))}
            <Link
              to="/marketplace"
              onClick={() => setMenuOpen(false)}
              className={`border-b py-3 text-sm font-semibold ${dark ? 'border-white/10 text-white/85 hover:text-white' : 'border-slate-100 text-slate-700 hover:text-brand-700'}`}
            >
              {t('nav.marketplace')}
            </Link>
            <Link
              to="/price-comparison"
              onClick={() => setMenuOpen(false)}
              className={`border-b py-3 text-sm font-semibold ${dark ? 'border-white/10 text-white/85 hover:text-white' : 'border-slate-100 text-slate-700 hover:text-brand-700'}`}
            >
              {t('nav.priceComparison')}
            </Link>
            {!isAuthenticated ? (
              <div className="mt-4 flex gap-2">
                <Link to="/login" onClick={() => setMenuOpen(false)} className={dark ? 'lp-btn-ghost-dark flex-1' : 'lp-btn-outline flex-1'}>{t('lp.nav.login')}</Link>
                <Link to="/register" onClick={() => setMenuOpen(false)} className="lp-btn-primary flex-1">{t('lp.nav.start')}</Link>
              </div>
            ) : (
              <button onClick={handleLogout} className={dark ? 'lp-btn-ghost-dark mt-4' : 'lp-btn-outline mt-4'}>{t('nav.logout')}</button>
            )}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

export function Footer() {
  const { t } = useI18n();
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-slate-200 bg-slate-50 text-slate-600">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <Brand />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-500">{t('lp.footer.tagline')}</p>
            <p className="mt-4 text-sm text-slate-500">
              {t('lp.nav.contact')}:{' '}
              <a href="mailto:contact@lewassit.com" className="font-medium text-brand-700 hover:text-brand-800">
                contact@lewassit.com
              </a>
            </p>
            {DEMO_MODE ? (
              <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-500" aria-hidden />
                {t('footer.demoEnv')}
              </span>
            ) : null}
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('lp.footer.marketplace')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-500">
              <li><Link to="/marketplace" className="transition-colors hover:text-brand-700">{t('nav.marketplace')}</Link></li>
              <li><Link to="/categories" className="transition-colors hover:text-brand-700">{t('nav.categories')}</Link></li>
              <li><Link to="/suppliers" className="transition-colors hover:text-brand-700">{t('nav.suppliers')}</Link></li>
              <li><Link to="/merchants" className="transition-colors hover:text-brand-700">{t('nav.merchants')}</Link></li>
              <li><Link to="/companies" className="transition-colors hover:text-brand-700">{t('nav.companies')}</Link></li>
            </ul>
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('lp.footer.platform')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-500">
              <li><Link to="/price-comparison" className="transition-colors hover:text-brand-700">{t('nav.priceComparison')}</Link></li>
              <li><Link to="/#ai" className="transition-colors hover:text-brand-700">{t('nav.ai')}</Link></li>
              <li><Link to="/#how-it-works" className="transition-colors hover:text-brand-700">{t('nav.howItWorks')}</Link></li>
              <li><Link to="/#trust" className="transition-colors hover:text-brand-700">{t('home.trust.title')}</Link></li>
            </ul>
          </div>

          <div className="md:col-span-3">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('lp.footer.company')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-500">
              <li><Link to="/#about" className="transition-colors hover:text-brand-700">{t('nav.about')}</Link></li>
              <li><a href="mailto:contact@lewassit.com" className="transition-colors hover:text-brand-700">{t('lp.nav.contact')}</a></li>
              <li><Link to="/register" className="transition-colors hover:text-brand-700">{t('nav.register')}</Link></li>
            </ul>
            <div className="mt-5">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">{t('footer.language')}</p>
              <LanguageSwitcher />
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-slate-200 pt-6 text-xs text-slate-400 sm:flex-row">
          <span>© {year} · {t('footer.rights')}</span>
          <span className="font-semibold tracking-[0.2em] text-brand-700">BUSINESS GLOBAL</span>
        </div>
      </div>
    </footer>
  );
}

export function PublicLayout({ children, darkHeader = false }: { children: ReactNode; darkHeader?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <PublicHeader dark={darkHeader} />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

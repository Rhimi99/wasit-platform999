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

export function PublicHeader() {
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

  const navItemClass =
    'relative inline-flex h-full items-center text-[15px] font-medium text-ink-1000/85 transition-colors after:absolute after:bottom-0 after:start-0 after:h-[2.5px] after:w-0 after:rounded-full after:bg-brand-600 after:transition-all hover:text-brand-700 hover:after:w-full';

  return (
    <header
      className={`sticky top-0 z-40 border-b bg-white transition-shadow duration-300 ${
        scrolled ? 'border-slate-200 shadow-soft' : 'border-slate-100'
      }`}
    >
      <div
        className={`mx-auto flex max-w-[1400px] items-center gap-3 px-4 transition-all duration-300 sm:px-6 lg:px-8 ${
          scrolled ? 'h-[76px]' : 'h-[92px] lg:h-[116px]'
        }`}
      >
        <div className="min-w-0 shrink-0">
          <Brand compact />
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
          <LanguageSwitcher />
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className="lp-btn-outline hidden !py-2 text-sm sm:inline-flex">{t('nav.myDashboard')}</Link>
              <button
                onClick={handleLogout}
                className="hidden text-sm font-semibold text-slate-500 transition-colors hover:text-red-600 sm:block"
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
                className="hidden text-sm font-semibold text-slate-600 transition-colors hover:text-brand-700 lg:block"
              >
                {t('lp.nav.start')}
              </Link>
            </>
          )}
          {user?.roles.includes('ADMIN') || user?.roles.includes('SUPER_ADMIN') ? (
            <Link to="/admin" className="hidden text-sm font-semibold text-brand-700 hover:underline lg:block">{t('nav.admin')}</Link>
          ) : null}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:border-brand-300 hover:text-brand-700 xl:hidden"
          >
            <span className="text-xl leading-none">{menuOpen ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>

      {menuOpen ? (
        <nav
          className="border-t border-slate-100 bg-white px-4 pb-4 pt-2 shadow-card xl:hidden"
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
                className="border-b border-slate-100 py-3 text-sm font-semibold text-slate-700 last:border-0 hover:text-brand-700"
              >
                {t(l.key)}
              </a>
            ))}
            <Link
              to="/marketplace"
              onClick={() => setMenuOpen(false)}
              className="border-b border-slate-100 py-3 text-sm font-semibold text-slate-700 hover:text-brand-700"
            >
              {t('nav.marketplace')}
            </Link>
            <Link
              to="/price-comparison"
              onClick={() => setMenuOpen(false)}
              className="border-b border-slate-100 py-3 text-sm font-semibold text-slate-700 hover:text-brand-700"
            >
              {t('nav.priceComparison')}
            </Link>
            {!isAuthenticated ? (
              <div className="mt-4 flex gap-2">
                <Link to="/login" onClick={() => setMenuOpen(false)} className="lp-btn-outline flex-1">{t('lp.nav.login')}</Link>
                <Link to="/register" onClick={() => setMenuOpen(false)} className="lp-btn-primary flex-1">{t('lp.nav.start')}</Link>
              </div>
            ) : (
              <button onClick={handleLogout} className="lp-btn-outline mt-4">{t('nav.logout')}</button>
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

export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

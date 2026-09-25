import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Brand } from '@/components/brand/Brand';

/** Enabled only on the public demo build; production builds leave it unset. */
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

/** Primary desktop navigation — the entry points requested for the landing. */
const NAV_LINKS: Array<{ key: string; to: string }> = [
  { key: 'nav.home', to: '/' },
  { key: 'nav.products', to: '/marketplace' },
  { key: 'nav.suppliers', to: '/suppliers' },
  { key: 'nav.merchants', to: '/merchants' },
  { key: 'nav.howItWorks', to: '/#how-it-works' },
  { key: 'nav.ai', to: '/#ai' },
];

function NavItems() {
  const { t } = useI18n();
  return (
    <>
      {NAV_LINKS.map((l) => (
        <Link key={l.key} to={l.to} className="nav-link">{t(l.key)}</Link>
      ))}
    </>
  );
}

export function PublicHeader() {
  const { t } = useI18n();
  const { user, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/');
    setMenuOpen(false);
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur-lg">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
        <Link to="/" className="min-w-0 shrink"><Brand compact /></Link>
        <nav className="ms-auto hidden items-center gap-6 text-sm font-semibold text-slate-600 xl:flex" aria-label={t('nav.home')}>
          <NavItems />
        </nav>
        <div className="ms-auto flex shrink-0 items-center gap-2 sm:gap-3 xl:ms-6">
          <LanguageSwitcher />
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className="btn-secondary hidden sm:inline-flex">{t('nav.myDashboard')}</Link>
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
                className="hidden text-sm font-semibold text-slate-600 transition-colors hover:text-brand-700 sm:block"
              >
                {t('nav.login')}
              </Link>
              <Link to="/register" className="btn-primary hidden sm:inline-flex">{t('nav.register')}</Link>
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
              <Link
                key={l.key}
                to={l.to}
                onClick={() => setMenuOpen(false)}
                className="border-b border-slate-100 py-3 text-sm font-semibold text-slate-700 last:border-0 hover:text-brand-700"
              >
                {t(l.key)}
              </Link>
            ))}
            <Link
              to="/price-comparison"
              onClick={() => setMenuOpen(false)}
              className="border-b border-slate-100 py-3 text-sm font-semibold text-slate-700 hover:text-brand-700"
            >
              {t('nav.priceComparison')}
            </Link>
            {!isAuthenticated ? (
              <div className="mt-4 flex gap-2">
                <Link to="/login" onClick={() => setMenuOpen(false)} className="btn-secondary flex-1">{t('nav.login')}</Link>
                <Link to="/register" onClick={() => setMenuOpen(false)} className="btn-primary flex-1">{t('nav.register')}</Link>
              </div>
            ) : (
              <button onClick={handleLogout} className="btn-secondary mt-4">{t('nav.logout')}</button>
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
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <Brand />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-500">{t('app.tagline')}</p>
            <p className="mt-4 text-sm text-slate-500">
              {t('nav.contact')}:{' '}
              <a href="mailto:contact@lewassit.com" className="font-medium text-slate-700 hover:text-brand-700">
                contact@lewassit.com
              </a>
            </p>
            {DEMO_MODE ? (
              <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-500" aria-hidden />
                {t('footer.demoEnv')}
              </span>
            ) : null}
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('footer.marketplace')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-600">
              <li><Link to="/marketplace" className="transition-colors hover:text-brand-700">{t('nav.marketplace')}</Link></li>
              <li><Link to="/marketplace" className="transition-colors hover:text-brand-700">{t('nav.products')}</Link></li>
              <li><Link to="/suppliers" className="transition-colors hover:text-brand-700">{t('nav.suppliers')}</Link></li>
              <li><Link to="/merchants" className="transition-colors hover:text-brand-700">{t('nav.merchants')}</Link></li>
              <li><Link to="/categories" className="transition-colors hover:text-brand-700">{t('nav.categories')}</Link></li>
            </ul>
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('footer.platform')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-600">
              <li><Link to="/#ai" className="transition-colors hover:text-brand-700">{t('nav.ai')}</Link></li>
              <li><Link to="/price-comparison" className="transition-colors hover:text-brand-700">{t('nav.priceComparison')}</Link></li>
              <li><Link to="/#how-it-works" className="transition-colors hover:text-brand-700">{t('nav.howItWorks')}</Link></li>
              <li><Link to="/#trust" className="transition-colors hover:text-brand-700">{t('footer.trust')}</Link></li>
            </ul>
          </div>

          <div className="md:col-span-3">
            <h4 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{t('footer.company')}</h4>
            <ul className="space-y-2.5 text-sm text-slate-600">
              <li><Link to="/#about" className="transition-colors hover:text-brand-700">{t('nav.about')}</Link></li>
              <li><a href="mailto:contact@lewassit.com" className="transition-colors hover:text-brand-700">{t('nav.contact')}</a></li>
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
          <span className="font-semibold tracking-[0.2em] text-slate-500">BUSINESS GLOBAL</span>
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

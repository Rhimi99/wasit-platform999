import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Brand } from '@/components/brand/Brand';

function NavItems() {
  const { t } = useI18n();
  return (
    <>
      <Link to="/" className="nav-link">{t('nav.home')}</Link>
      <Link to="/#a-propos" className="nav-link">{t('nav.about')}</Link>
      <Link to="/#solutions" className="nav-link">{t('nav.solutions')}</Link>
      <Link to="/marketplace" className="nav-link">{t('nav.markets')}</Link>
      <Link to="/#ressources" className="nav-link">{t('nav.resources')}</Link>
      <Link to="/#contact" className="nav-link">{t('nav.contact')}</Link>
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
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-5 sm:px-6">
        <Brand compact />
        <nav className="ms-auto hidden items-center gap-6 text-sm font-semibold text-slate-600 xl:flex">
          <NavItems />
        </nav>
        <div className="ms-auto flex items-center gap-2 sm:gap-3 xl:ms-4">
          <LanguageSwitcher />
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className="btn-secondary hidden sm:inline-flex">{t('nav.myDashboard')}</Link>
              <button onClick={handleLogout} className="text-sm font-semibold text-slate-500 hover:text-red-600">
                {t('nav.logout')}
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="hidden text-sm font-semibold text-slate-600 transition-colors hover:text-wasit-700 sm:block">
                {t('nav.login')}
              </Link>
              <Link to="/register" className="btn-primary">{t('nav.register')}</Link>
            </>
          )}
          {user?.roles.includes('ADMIN') || user?.roles.includes('SUPER_ADMIN') ? (
            <Link to="/admin" className="hidden text-sm font-semibold text-wasit-700 hover:underline lg:block">{t('nav.admin')}</Link>
          ) : null}
          {/* زر القائمة (موبايل) */}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-700 xl:hidden"
          >
            <span className="text-xl leading-none">{menuOpen ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>
      {/* قائمة موبايل */}
      {menuOpen ? (
        <nav className="border-t border-slate-100 bg-white px-4 py-3 shadow-card xl:hidden" aria-label="Mobile navigation">
          <div className="flex flex-col gap-1">
            <Link to="/" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.home')}</Link>
            <Link to="/#a-propos" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.about')}</Link>
            <Link to="/#solutions" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.solutions')}</Link>
            <Link to="/marketplace" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.markets')}</Link>
            <Link to="/#ressources" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.resources')}</Link>
            <Link to="/#contact" onClick={() => setMenuOpen(false)} className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">{t('nav.contact')}</Link>
            {!isAuthenticated ? (
              <div className="mt-2 flex gap-2 border-t border-slate-100 pt-3">
                <Link to="/login" onClick={() => setMenuOpen(false)} className="btn-secondary flex-1">{t('nav.login')}</Link>
                <Link to="/register" onClick={() => setMenuOpen(false)} className="btn-primary flex-1">{t('nav.register')}</Link>
              </div>
            ) : null}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="border-t border-slate-200 bg-slate-50/70">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 md:grid-cols-4">
          {/* العلامة */}
          <div className="md:col-span-2">
            <Brand />
            <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-500">{t('app.tagline')}</p>
            <p className="mt-3 text-sm text-slate-500">{t('nav.contact')}: <span className="font-medium text-slate-700">contact@lewassit.com</span></p>
          </div>
          {/* المنصة */}
          <div>
            <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">{t('nav.marketplace')}</h4>
            <ul className="space-y-2 text-sm text-slate-600">
              <li><Link to="/marketplace" className="transition-colors hover:text-wasit-700">{t('nav.marketplace')}</Link></li>
              <li><Link to="/suppliers" className="transition-colors hover:text-wasit-700">{t('nav.suppliers')}</Link></li>
              <li><Link to="/merchants" className="transition-colors hover:text-wasit-700">{t('nav.merchants')}</Link></li>
              <li><Link to="/companies" className="transition-colors hover:text-wasit-700">{t('nav.companies')}</Link></li>
              <li><Link to="/categories" className="transition-colors hover:text-wasit-700">{t('nav.categories')}</Link></li>
            </ul>
          </div>
          {/* الشركة */}
          <div>
            <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">{t('nav.about')}</h4>
            <ul className="space-y-2 text-sm text-slate-600">
              <li><Link to="/#a-propos" className="transition-colors hover:text-wasit-700">{t('nav.about')}</Link></li>
              <li><Link to="/#solutions" className="transition-colors hover:text-wasit-700">{t('nav.solutions')}</Link></li>
              <li><Link to="/#ressources" className="transition-colors hover:text-wasit-700">{t('nav.resources')}</Link></li>
              <li><Link to="/#contact" className="transition-colors hover:text-wasit-700">{t('nav.contact')}</Link></li>
              <li><Link to="/register" className="transition-colors hover:text-wasit-700">{t('nav.register')}</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-slate-200 pt-6 text-xs text-slate-400 sm:flex-row">
          <span>{t('footer.rights')}</span>
          <span className="font-semibold tracking-widest">LE WASSIT — BUSINESS GLOBAL</span>
        </div>
      </div>
    </footer>
  );
}

export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
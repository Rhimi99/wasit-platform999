import { useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';
import { AppSidebar, TopHeader } from './AppSidebar';
import { Spinner } from '@/components/ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Dashboard shell.
 *
 * The sidebar is a permanent column from `lg` up and an on-demand drawer below
 * it: a 240px rail on a phone leaves ~150px for the page, which makes every
 * dashboard table unusable. The drawer closes on navigation and on a backdrop
 * tap, so it never traps the page underneath.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <div className="hidden lg:flex">
        <AppSidebar />
      </div>
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" data-testid="dashboard-nav-drawer">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setNavOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 start-0 flex shadow-xl">
            <AppSidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopHeader onOpenNav={() => setNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
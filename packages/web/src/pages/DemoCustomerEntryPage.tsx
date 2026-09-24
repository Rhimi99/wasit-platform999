import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n-context';
import { PublicLayout } from '@/components/layouts/PublicLayout';

/**
 * Public-demo entry point: `/demo/customer`.
 *
 * Opening it signs the visitor in as the seeded demo customer and lands them on
 * the dashboard — no login form, no email or password. It is a thin client for
 * `POST /api/auth/demo-session`: the server decides whether auto-login is allowed
 * (demo only, never production) and which account it opens (a compiled-in
 * constant), so this page never carries an identity or a credential in the URL.
 *
 * The request is guarded against React's development double-invoke so only one
 * session is minted per visit.
 */
export function DemoCustomerEntryPage() {
  const { t } = useI18n();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    api
      .demoSession()
      .then((user) => {
        setUser(user);
        navigate('/dashboard', { replace: true });
      })
      .catch((err: unknown) => {
        // The most likely failure on a non-demo environment is a 404 — the route
        // genuinely does not exist there — so say that plainly instead of a
        // generic error.
        const status =
          typeof err === 'object' && err !== null && 'statusCode' in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        setError(status === 404 ? t('demo.notAvailable') : t('demo.failed'));
      });
  }, [navigate, setUser, t]);

  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-20 text-center">
        <p role="status" aria-live="polite" className="text-slate-700">
          {error ?? t('demo.entering')}
        </p>
      </div>
    </PublicLayout>
  );
}

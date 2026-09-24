import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n-context';
import { PublicLayout } from '@/components/layouts/PublicLayout';
import { Badge, Card, SectionHeader, Spinner } from '@/components/ui';
import { AUDIT_MODULE_GROUPS, moduleVisibleFor } from '@/lib/demo-owner-catalog';
import type { User } from '@/lib/types';

/**
 * Public-demo Owner Audit Center: `/demo/owner`.
 *
 * Opening it signs the owner in with a real session and lands on this index, from
 * which every role desk and every module can be opened. It is a thin client for
 * the two demo endpoints:
 *
 *  * `POST /api/auth/demo-audit-session` opens a session for one whitelisted
 *    fixture (by persona id only — never an email, id, or password);
 *  * when demo auto-login is off (production, or a plain dev run) the endpoint is
 *    a 404 and the page renders "not available" instead of a login form.
 *
 * The center deliberately does not merge roles: switching persona logs out and
 * opens a *separate* session that keeps exactly the account's stored roles. The
 * "probe" buttons call each module's real API endpoint with the live session and
 * show the status code, so a permission is proven against server RBAC rather than
 * inferred from a UI badge.
 */

const PERSONAS = [
  { id: 'super-admin', roleKey: 'demo.owner.role.superAdmin' },
  { id: 'admin', roleKey: 'demo.owner.role.admin' },
  { id: 'customer', roleKey: 'demo.owner.role.customer' },
  { id: 'merchant', roleKey: 'demo.owner.role.merchant' },
  { id: 'supplier', roleKey: 'demo.owner.role.supplier' },
  { id: 'company', roleKey: 'demo.owner.role.company' },
] as const;

type ProbeResult = { status: number; ok: boolean };

export function DemoOwnerAuditPage() {
  const { t } = useI18n();
  const { user, setUser, can, loading } = useAuth();
  const navigate = useNavigate();

  const [bootError, setBootError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const started = useRef(false);

  /** Opens the given persona's real session, replacing any current one. */
  const openPersona = useCallback(
    async (persona: string, after?: () => void) => {
      setBusy(persona);
      setBootError(null);
      try {
        // Log out first so the new cookie is the only session in play — the
        // persona switch must not leave the previous role reachable.
        await api.logout().catch(() => undefined);
        setUser(null);
        const opened = await api.demoAuditSession(persona);
        setUser(opened as User);
        setProbes({});
        after?.();
      } catch (err) {
        const status = err instanceof ApiClientError ? err.statusCode : undefined;
        setBootError(status === 404 ? t('demo.notAvailable') : t('demo.failed'));
      } finally {
        setBusy(null);
      }
    },
    [setUser, t],
  );

  // First visit: open the staff persona so the owner lands on the broadest desk.
  useEffect(() => {
    if (started.current || loading) return;
    started.current = true;
    if (user) return; // an existing session already works; the owner can switch.
    void openPersona('super-admin');
  }, [loading, user, openPersona]);

  const probe = useCallback(async (id: string, method: 'GET' | 'POST', path: string) => {
    setBusy(`probe:${id}`);
    try {
      const res = await fetch(path, { method, credentials: 'include' });
      setProbes((p) => ({ ...p, [id]: { status: res.status, ok: res.ok } }));
    } catch {
      setProbes((p) => ({ ...p, [id]: { status: 0, ok: false } }));
    } finally {
      setBusy(null);
    }
  }, []);

  const roles = user?.roles ?? [];
  const visibleCount = useMemo(
    () =>
      AUDIT_MODULE_GROUPS.flatMap((g) => g.modules).filter((m) => moduleVisibleFor(m, roles, can))
        .length,
    [roles, can],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setProbes({});
  }, [setUser]);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-6xl px-4 py-8" dir="auto">
        <SectionHeader title={t('demo.owner.title')} subtitle={t('demo.owner.subtitle')} />

        {bootError && (
          <Card>
            <p role="alert" className="text-sm text-red-600">
              {bootError}
            </p>
          </Card>
        )}

        {loading || (busy === 'super-admin' && !user) ? (
          <Spinner />
        ) : (
          <>
            {/* Current session */}
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    {t('demo.owner.current')}
                  </p>
                  {user ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-800" dir="ltr">
                        {user.email}
                      </span>
                      {user.roles.map((r) => (
                        <Badge key={r} color="green">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-slate-500">{t('demo.owner.noSession')}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void logout()}
                    disabled={!user}
                    data-testid="owner-logout"
                  >
                    {t('demo.owner.logout')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate('/dashboard')}
                    disabled={!user}
                  >
                    {t('demo.owner.open')}
                  </button>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-500">{t('demo.owner.hint')}</p>
            </Card>

            {/* Roles */}
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">{t('demo.owner.roles')}</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="owner-roles">
                {PERSONAS.map((p) => {
                  const active = busy === p.id;
                  return (
                    <Card key={p.id}>
                      <div className="flex h-full flex-col justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-800">{t(p.roleKey)}</p>
                          <p className="mt-1 text-[11px] text-slate-400" dir="ltr">
                            {p.id}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => void openPersona(p.id, () => navigate('/dashboard'))}
                            disabled={busy !== null}
                            data-testid={`owner-switch-${p.id}`}
                          >
                            {active ? t('demo.owner.switching') : t('demo.owner.switch')}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => void openPersona(p.id)}
                            disabled={busy !== null}
                            data-testid={`owner-session-${p.id}`}
                          >
                            {busy === p.id ? '…' : 'Session'}
                          </button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Modules */}
            <div className="mt-8">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700">
                  {t('demo.owner.modules')}{' '}
                  <span className="font-normal text-slate-400" data-testid="owner-visible-count">
                    ({visibleCount}/{AUDIT_MODULE_GROUPS.flatMap((g) => g.modules).length})
                  </span>
                </h3>
              </div>
              <p className="mt-1 text-xs text-slate-500">{t('demo.owner.probeHint')}</p>

              {AUDIT_MODULE_GROUPS.map((group) => (
                <div key={group.id} className="mt-5">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t(group.labelKey)}
                  </h4>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {group.modules.map((m) => {
                      const visible = moduleVisibleFor(m, roles, can);
                      const result = probes[m.id];
                      return (
                        <div
                          key={m.id}
                          data-testid={`owner-module-${m.id}`}
                          className={`rounded-md border p-3 ${
                            visible ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <Link
                              to={m.path}
                              className="text-sm font-medium text-slate-800 hover:text-wasit-700"
                              data-testid={`owner-open-${m.id}`}
                            >
                              {t(m.labelKey)}
                            </Link>
                            {m.flow && <Badge color="amber">E2E</Badge>}
                          </div>
                          <p className="mt-0.5 text-[10px] text-slate-400" dir="ltr">
                            {m.path}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="text-[10px]">
                              {visible ? (
                                <span className="text-green-700">{t('demo.owner.available')}</span>
                              ) : (
                                <span className="text-slate-400">{t('demo.owner.denied')}</span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => void probe(m.id, m.probe.method, m.probe.path)}
                              disabled={busy !== null}
                              data-testid={`owner-probe-${m.id}`}
                              className="rounded border border-slate-300 px-2 py-0.5 text-[10px] text-slate-600 hover:border-wasit-400 hover:text-wasit-700"
                            >
                              {t('demo.owner.probe')}
                            </button>
                            {result && (
                              <span
                                data-testid={`owner-probe-result-${m.id}`}
                                className={`text-[10px] font-medium ${
                                  result.ok ? 'text-green-700' : 'text-red-600'
                                }`}
                                dir="ltr"
                              >
                                {result.status} {result.ok ? t('demo.owner.probeOk') : t('demo.owner.probeDenied')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </PublicLayout>
  );
}

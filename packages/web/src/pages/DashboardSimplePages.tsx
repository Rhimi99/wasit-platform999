import { useEffect, useState } from 'react';
import { api, apiCall, apiErrorMessage, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { NotificationPreferenceMatrix } from '@/lib/types';

export function DashboardProfilePage() {
  const { t } = useI18n();
  const { user } = useAuth();
  if (!user) return <Spinner />;
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.profile')} />
      <Card>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">{t('field.email')}</span><span dir="ltr">{user.email}</span></div>
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">{t('field.id')}</span><span className="text-xs" dir="ltr">{user.id}</span></div>
          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">{t('auth.emailVerified')}</span><span>{user.emailVerified ? '✓' : '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">{t('auth.role')}</span>
            <div className="flex gap-1">{user.roles.map((r) => <Badge key={r} color="teal">{t(`role.${r}`)}</Badge>)}</div>
          </div>
        </div>
      </Card>
    </AppLayout>
  );
}

export function DashboardSecurityPage() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Array<{ id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; isCurrent?: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    apiCall(() => api.sessions()).then((res) => {
      setSessions(res.data ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, [reloadKey]);

  const revoke = async (id: string) => {
    setBusyId(id);
    setNotice(null);
    const res = await apiCall(() => api.revokeSession(id));
    if (res.error) {
      setError(res.error);
    } else {
      setNotice(t('security.sessionRevoked'));
      setReloadKey((k) => k + 1);
    }
    setBusyId(null);
  };

  return (
    <AppLayout>
      <SectionHeader title={t('security.title')} />
      <MfaCard />
      <Card className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('security.sessions')}</h3>
        {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="security-sessions-notice">{notice}</p>}
        {error && <ErrorState message={error} />}
        {loading ? <Spinner /> : sessions.length === 0 ? <EmptyState title={t('common.noData')} /> : (
          <table className="table-base">
            <thead><tr><th>{t('field.ip')}</th><th>{t('common.date')}</th><th>{t('field.expires')}</th><th>{t('field.userAgent')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} data-testid={`session-${s.id}`}>
                  <td className="text-xs" dir="ltr">{s.ipAddress ?? '—'}{s.isCurrent && <span className="ml-2 text-xs text-green-700">({t('security.currentSession')})</span>}</td>
                  <td>{String(s.createdAt).slice(0, 10)}</td>
                  <td>{String(s.expiresAt).slice(0, 10)}</td>
                  <td className="max-w-xs truncate text-xs" dir="ltr">{s.userAgent ?? ''}</td>
                  <td>
                    <button
                      type="button"
                      data-testid={`session-revoke-${s.id}`}
                      disabled={busyId === s.id}
                      onClick={() => revoke(s.id)}
                      className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                    >
                      {busyId === s.id ? '…' : s.isCurrent ? t('security.logoutThisDevice') : t('security.revokeSession')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('security.changePassword')}</h3>
        <p className="text-xs text-slate-400">{t('security.hashingNote')}</p>
      </Card>
    </AppLayout>
  );
}

/**
 * MFA lifecycle against the real backend: status → enroll (secret + recovery
 * codes shown once) → confirm with a TOTP → regenerate codes / disable with a
 * TOTP. No state is cached across steps except the one-time enrollment payload.
 */
function MfaCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ mfaEnabled: boolean; pendingEnrollment: boolean } | null>(null);
  const [enrollment, setEnrollment] = useState<{ secretBase32: string; qrUri: string; recoveryCodes: string[] } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    apiCall(() => api.mfaStatus()).then((res) => setStatus(res.data ?? null));
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      setCode('');
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const enroll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const enrollmentData = await api.mfaEnroll();
      setEnrollment(enrollmentData);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.mfaRecoveryCodes(code);
      setRecoveryCodes(res.recoveryCodes);
      setCode('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testId="mfa-card">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('mfa.title')}</h3>
      {status ? (
        <p className="mb-3 text-sm">
          <Badge testId="mfa-status" color={status.mfaEnabled ? 'green' : 'slate'}>
            {status.mfaEnabled ? t('mfa.enabled') : t('mfa.disabled')}
          </Badge>
        </p>
      ) : (
        <Spinner />
      )}

      {error && <p className="mb-2 text-sm text-red-600" role="alert">{error}</p>}
      {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="mfa-notice">{notice}</p>}

      {enrollment && !status?.mfaEnabled && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="mb-1 text-slate-600">{t('mfa.scanHint')}</p>
          <code data-testid="mfa-secret" className="block break-all rounded bg-white p-2 text-xs" dir="ltr">{enrollment.secretBase32}</code>
          <p className="mt-2 text-xs text-slate-500">{t('mfa.recoveryHint')}</p>
          <div className="mt-1 grid grid-cols-2 gap-1" data-testid="mfa-recovery-codes">
            {enrollment.recoveryCodes.map((rc) => (
              <code key={rc} className="rounded bg-white px-1 text-xs" dir="ltr">{rc}</code>
            ))}
          </div>
        </div>
      )}

      {recoveryCodes && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="mb-1 text-amber-800">{t('mfa.recoveryHint')}</p>
          <div className="grid grid-cols-2 gap-1" data-testid="mfa-regenerated-codes">
            {recoveryCodes.map((rc) => (
              <code key={rc} className="rounded bg-white px-1 text-xs" dir="ltr">{rc}</code>
            ))}
          </div>
        </div>
      )}

      {status?.mfaEnabled ? (
        <div className="space-y-3">
          <div>
            <label className="label">{t('mfa.code')}</label>
            <input
              data-testid="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="input"
              dir="ltr"
              inputMode="numeric"
            />
          </div>
          <div className="flex gap-2">
            <button
              data-testid="mfa-regenerate"
              className="btn-secondary"
              disabled={busy || code.length !== 6}
              onClick={regenerate}
            >
              {t('mfa.regenerate')}
            </button>
            <button
              data-testid="mfa-disable"
              className="btn-secondary text-red-600"
              disabled={busy || code.length !== 6}
              onClick={() => run(() => api.mfaDisable(code), t('mfa.disabledOk'))}
            >
              {t('mfa.disable')}
            </button>
          </div>
        </div>
      ) : enrollment ? (
        <div className="space-y-3">
          <div>
            <label className="label">{t('mfa.code')}</label>
            <input
              data-testid="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="input"
              dir="ltr"
              inputMode="numeric"
            />
          </div>
          <button
            data-testid="mfa-confirm"
            className="btn-primary"
            disabled={busy || code.length !== 6}
            onClick={() => run(() => api.mfaConfirm(code), t('mfa.enabledOk'))}
          >
            {t('mfa.confirm')}
          </button>
        </div>
      ) : (
        <button data-testid="mfa-enable" className="btn-primary" disabled={busy} onClick={enroll}>{t('mfa.enable')}</button>
      )}
    </Card>
  );
}

export function DashboardSettingsPage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.settings')} />
      <Card>
        <p className="text-sm text-slate-600">{t('settings.description')}</p>
      </Card>
      <NotificationPreferencesCard />
    </AppLayout>
  );
}

/**
 * PR-10 — notification preferences.
 *
 * The matrix is edited locally and saved in one PUT, so a user can flip several
 * switches without a request per toggle. Nothing is claimed about delivery here:
 * the card states the choice is saved, which is exactly what the server does.
 */
function NotificationPreferencesCard() {
  const { t } = useI18n();
  const [matrix, setMatrix] = useState<NotificationPreferenceMatrix | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const key = (channel: string, category: string) => `${channel}:${category}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .notificationPreferences()
      .then((data) => {
        if (cancelled) return;
        setMatrix(data);
        setDraft(Object.fromEntries(data.rows.map((r) => [key(r.channel, r.category), r.enabled])));
        setError(null);
      })
      .catch((e) => !cancelled && setError(apiErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    matrix !== null &&
    matrix.rows.some((r) => draft[key(r.channel, r.category)] !== r.enabled);

  async function save() {
    if (!matrix) return;
    const changes = matrix.rows
      .filter((r) => draft[key(r.channel, r.category)] !== r.enabled)
      .map((r) => ({
        channel: r.channel,
        category: r.category,
        enabled: draft[key(r.channel, r.category)] ?? r.enabled,
      }));
    if (changes.length === 0) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api.updateNotificationPreferences(changes);
      setMatrix(data);
      setDraft(Object.fromEntries(data.rows.map((r) => [key(r.channel, r.category), r.enabled])));
      setSaved(true);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">{t('settings.notifications.title')}</h3>
          <p className="mt-1 text-xs text-slate-500">{t('settings.notifications.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="notification-preferences-save"
          className="btn-primary px-3 py-1.5 text-xs"
          disabled={!dirty || saving}
          aria-busy={saving}
          onClick={save}
        >
          {t('common.save')}
        </button>
      </div>

      {loading && <div className="mt-4"><Spinner /></div>}
      {!loading && error && <div className="mt-4"><ErrorState message={error} /></div>}

      {!loading && matrix && (
        <div className="mt-4 overflow-x-auto" data-testid="notification-preferences">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="py-2 text-start font-medium">{t('settings.notifications.category')}</th>
                {matrix.channels.map((channel) => (
                  <th key={channel} className="py-2 text-center font-medium">
                    {t(`settings.notifications.channel.${channel}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.categories.map((category) => (
                <tr key={category} className="border-t border-slate-100">
                  <td className="py-2 pe-3">{t(`settings.notifications.category.${category}`)}</td>
                  {matrix.channels.map((channel) => {
                    const row = matrix.rows.find((r) => r.channel === channel && r.category === category);
                    const id = `notif-pref-${channel}-${category}`;
                    return (
                      <td key={channel} className="py-2 text-center">
                        <input
                          id={id}
                          data-testid={id}
                          type="checkbox"
                          className="h-4 w-4 accent-teal-600"
                          checked={draft[key(channel, category)] ?? row?.enabled ?? true}
                          aria-label={`${t(`settings.notifications.category.${category}`)} — ${t(
                            `settings.notifications.channel.${channel}`,
                          )}`}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [key(channel, category)]: e.target.checked }))
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-slate-400">{t('settings.notifications.footnote')}</p>
          {saved && (
            <p role="status" data-testid="notification-preferences-saved" className="mt-2 text-xs text-teal-700">
              {t('settings.notifications.saved')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
import { useEffect, useState } from 'react';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, SectionHeader, Spinner } from '@/components/ui';

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
  const [sessions, setSessions] = useState<Array<{ id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.sessions()).then((res) => {
      setSessions(res.data ?? []);
      setLoading(false);
    });
  }, []);

  return (
    <AppLayout>
      <SectionHeader title={t('security.title')} />
      <MfaCard />
      <Card className="mt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('security.sessions')}</h3>
        {loading ? <Spinner /> : sessions.length === 0 ? <EmptyState title={t('common.noData')} /> : (
          <table className="table-base">
            <thead><tr><th>{t('field.ip')}</th><th>{t('common.date')}</th><th>{t('field.expires')}</th><th>{t('field.userAgent')}</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs" dir="ltr">{s.ipAddress ?? '—'}</td>
                  <td>{String(s.createdAt).slice(0, 10)}</td>
                  <td>{String(s.expiresAt).slice(0, 10)}</td>
                  <td className="max-w-xs truncate text-xs" dir="ltr">{s.userAgent ?? ''}</td>
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
    </AppLayout>
  );
}
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { Card } from '@/components/ui';
import type { ConsentDefault, PrivacyConsentState } from '@/lib/types';

/**
 * Device-local marker that the consent notice was answered.
 *
 * The server's consent read model normalises every `CONSENT_TYPES` entry
 * (`granted: current.get(t) ?? false`), so "never decided" and "declined" are
 * indistinguishable through `GET /api/privacy/me` — the banner cannot tell from
 * the stored consents alone that it has already run. This flag only remembers
 * that the notice was answered on this device; the decision itself lives in the
 * server's consent rows, never here.
 */
const DECIDED_KEY = 'wasit.cookieConsent.decided';

function readDecided(): boolean {
  try {
    return window.localStorage.getItem(DECIDED_KEY) === '1';
  } catch {
    return false;
  }
}

function markDecided(): void {
  try {
    window.localStorage.setItem(DECIDED_KEY, '1');
  } catch {
    // A blocked storage must not stop the consent from being recorded server-side.
  }
}

/**
 * Consent types the server treats as baseline (`grantedByDefault`). These are the
 * legal bases for using the platform, not cookie choices, so they are shown as
 * always-required and are never written by this UI. Only the optional types —
 * the actual cookie/GDPR decision — are persisted.
 */
function splitTypes(defaults: ConsentDefault[]): { optional: ConsentDefault[]; essential: ConsentDefault[] } {
  return {
    optional: defaults.filter((d) => !d.grantedByDefault),
    essential: defaults.filter((d) => d.grantedByDefault),
  };
}

/**
 * Builds the decision to persist: one entry per optional type, each resolved by
 * `choose`. Baseline types are deliberately excluded — they are the platform's
 * terms of use, not a cookie choice, and writing them would spend a request per
 * type against the consent rate limiter for a decision the user cannot change.
 */
function decisionPayload(
  defaults: ConsentDefault[],
  choose: (type: string) => boolean,
): Array<{ type: string; granted: boolean }> {
  return splitTypes(defaults).optional.map((t) => ({ type: t.type, granted: choose(t.type) }));
}

/**
 * Writes each decision through the real consent endpoint. Returns the first
 * error message, or `null` when every write succeeded. Sequential on purpose:
 * it stops on the first failure rather than half-applying a burst of writes,
 * and it never reports success it did not get.
 */
async function persistConsent(entries: Array<{ type: string; granted: boolean }>): Promise<string | null> {
  for (const entry of entries) {
    try {
      await api.setConsent(entry.type, entry.granted);
    } catch (e) {
      return apiErrorMessage(e);
    }
  }
  return null;
}

function useConsentState(enabled: boolean) {
  const [state, setState] = useState<PrivacyConsentState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.privacyMe());
      setLoadError(null);
    } catch (e) {
      setLoadError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    void reload();
  }, [enabled, reload]);

  return { state, loading, loadError, reload };
}

/**
 * The consent controls themselves, shared by the first-visit banner and the
 * Settings card. `onDone` fires after a successful save so the caller can hide
 * the banner; a failed save leaves the UI open with the server's reason.
 */
function ConsentPreferences({
  state,
  onDone,
}: {
  state: PrivacyConsentState;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const { optional, essential } = splitTypes(state.defaults);
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const type of optional) initial[type.type] = state.consents.find((c) => c.type === type.type)?.granted ?? false;
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async (entries: Array<{ type: string; granted: boolean }>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const failure = await persistConsent(entries);
    if (failure) {
      // Never claim success on a failed write: keep the controls open with the
      // server's own reason so the operator can retry.
      setError(failure);
    } else {
      markDecided();
      setNotice(t('cookie.saved'));
      onDone?.();
    }
    setBusy(false);
  };

  const acceptAll = () => save(decisionPayload(state.defaults, () => true));
  const rejectNonEssential = () => save(decisionPayload(state.defaults, () => false));
  const saveSelection = () => save(decisionPayload(state.defaults, (type) => selected[type] ?? false));

  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-slate-600">{t('cookie.description')}</p>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert" data-testid="cookie-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" role="status" data-testid="cookie-notice">
          {notice}
        </p>
      )}

      <div className="space-y-2">
        {essential.map((type) => (
          <div key={type.type} className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <input type="checkbox" checked disabled readOnly className="mt-0.5" data-testid={`cookie-essential-${type.type}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-700">{t(`consent.type.${type.type}`)}</p>
              <p className="text-xs text-slate-500">{t('cookie.essentialNote')}</p>
            </div>
          </div>
        ))}

        {optional.map((type) => (
          <label key={type.type} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 hover:border-brand-300">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid={`cookie-type-${type.type}`}
              checked={selected[type.type] ?? false}
              disabled={busy}
              onChange={(e) => setSelected((prev) => ({ ...prev, [type.type]: e.target.checked }))}
            />
            <span className="min-w-0 text-sm text-slate-700">{t(`consent.type.${type.type}`)}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={acceptAll} data-testid="cookie-accept-all">
          {t('cookie.acceptAll')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={rejectNonEssential} data-testid="cookie-reject">
          {t('cookie.rejectNonEssential')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={saveSelection} data-testid="cookie-save">
          {t('cookie.saveSelection')}
        </button>
      </div>
    </div>
  );
}

/**
 * First-visit consent notice.
 *
 * Shown only to a signed-in account: the platform exposes no anonymous consent
 * endpoint (`PUT /api/privacy/consents` is behind `requireAuth`), so a visitor
 * with no session has nowhere to record a decision. That is not a gap in
 * practice — the only cookie the platform sets is the essential session cookie
 * (`wasit_session`, issued on login) and the SPA ships no tracker — so nothing
 * non-essential runs before a decision can be taken. The limitation is
 * documented in `docs/MASTER_GAP_AUDIT.md` (LC-02).
 */
export function CookieConsentBanner() {
  const { t } = useI18n();
  const { user, loading: authLoading } = useAuth();
  const [decided, setDecided] = useState(() => readDecided());
  const [open, setOpen] = useState(false);
  const enabled = !!user && !decided;
  const { state, loading, loadError } = useConsentState(enabled);

  if (!enabled || authLoading || loading) return null;

  if (!state) {
    // The state could not be read, so no honest decision UI can be offered.
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3" role="region" aria-label={t('cookie.title')} data-testid="cookie-consent">
        <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-4 shadow-lift">
          <h2 className="text-sm font-semibold text-slate-800">{t('cookie.title')}</h2>
          <p className="mt-1 text-sm text-slate-600" role="alert" data-testid="cookie-error">{loadError ?? t('cookie.loadFailed')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3" role="region" aria-label={t('cookie.title')} data-testid="cookie-consent">
      <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-4 shadow-lift">
        <h2 className="text-sm font-semibold text-slate-800">{t('cookie.title')}</h2>
        {open ? (
          <div className="mt-2">
            <ConsentPreferences state={state} onDone={() => setDecided(true)} />
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{t('cookie.description')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                data-testid="cookie-accept-all"
                onClick={async () => {
                  const failure = await persistConsent(decisionPayload(state.defaults, () => true));
                  if (failure) {
                    setOpen(true);
                  } else {
                    setDecided(true);
                  }
                }}
              >
                {t('cookie.acceptAll')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-testid="cookie-reject"
                onClick={async () => {
                  const failure = await persistConsent(decisionPayload(state.defaults, () => false));
                  if (failure) {
                    setOpen(true);
                  } else {
                    setDecided(true);
                  }
                }}
              >
                {t('cookie.rejectNonEssential')}
              </button>
              <button
                type="button"
                className="btn-ghost"
                data-testid="cookie-manage"
                aria-expanded={open}
                onClick={() => setOpen(true)}
              >
                {t('cookie.manage')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Settings-page consent management. Always available to a signed-in account so a
 * decision can be revisited after the first-visit banner has been dismissed.
 */
export function CookieConsentSettingsCard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { state, loading, loadError } = useConsentState(!!user);

  if (!user) return null;

  return (
    <Card testId="cookie-settings">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('cookie.settings.title')}</h3>
      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : state ? (
        // No post-save refetch: the controls already hold the values just written,
        // and a reload would flash the loading state over the success notice.
        <ConsentPreferences state={state} />
      ) : (
        <p className="text-sm text-red-600" role="alert" data-testid="cookie-settings-error">{loadError ?? t('cookie.loadFailed')}</p>
      )}
    </Card>
  );
}

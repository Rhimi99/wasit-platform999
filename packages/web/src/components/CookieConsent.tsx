import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-context';
import { useConsent } from '@/lib/consent-context';
import {
  CONSENT_CATEGORIES,
  type ConsentCategory,
  type ConsentCategories,
} from '@/lib/cookie-consent';

/**
 * LC-02 — cookie consent surface.
 *
 * Two shapes over one decision model:
 *  - a first-visit banner (no decision stored) with equally weighted
 *    "accept all" / "reject non-essential" plus "customise";
 *  - a settings dialog, reopenable at any time from the persistent link, where
 *    each category can be toggled and re-saved.
 *
 * The categories are described by what they technically do; no legal claim is
 * made here (the published cookie policy is a separate, legally-reviewed item —
 * LC-01). Necessary cookies are shown as always-on and cannot be switched off,
 * because they carry the session and security controls.
 */

const OPTIONAL_CATEGORIES: ConsentCategory[] = ['preferences', 'analytics', 'marketing'];

function categoryLabelKey(c: ConsentCategory): string {
  return `cookie.cat.${c}`;
}
function categoryDescKey(c: ConsentCategory): string {
  return `cookie.cat.${c}.desc`;
}

export function CookieConsent() {
  const { t } = useI18n();
  const { hasDecision, categories, isOpen, acceptAll, rejectNonEssential, save, open, close, policyChanged } = useConsent();
  const [draft, setDraft] = useState<ConsentCategories>(categories);

  // Seed the editable draft whenever the panel opens or the stored value changes.
  useEffect(() => {
    if (isOpen) setDraft({ ...categories });
  }, [isOpen, categories]);

  const showBanner = !hasDecision && !isOpen;
  const showDialog = isOpen;

  if (!showBanner && !showDialog) return null;

  const toggle = (c: ConsentCategory) => setDraft((d) => ({ ...d, [c]: !d[c] }));

  return (
    <>
      {showBanner ? (
        <div
          data-testid="cookie-consent-banner"
          role="region"
          aria-label={t('cookie.title')}
          className="fixed inset-x-0 bottom-0 z-[70] border-t border-slate-200 bg-white/98 shadow-panel backdrop-blur"
        >
          <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-4 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-800">{t('cookie.title')}</p>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-600">{t('cookie.bannerDesc')}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button type="button" data-testid="cookie-reject-all" onClick={rejectNonEssential} className="btn-secondary flex-1 md:flex-none">
                {t('cookie.rejectAll')}
              </button>
              <button type="button" data-testid="cookie-accept-all" onClick={acceptAll} className="btn-primary flex-1 md:flex-none">
                {t('cookie.acceptAll')}
              </button>
              <button type="button" data-testid="cookie-customize" onClick={open} className="btn-ghost flex-1 text-sm md:flex-none">
                {t('cookie.customize')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDialog ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-ink-1000/40 p-0 sm:items-center sm:p-4"
          onClick={close}
        >
          <div
            data-testid="cookie-consent-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('cookie.title')}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-slate-900">{t('cookie.title')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('cookie.dialogDesc')}</p>
            {policyChanged ? (
              <p data-testid="cookie-policy-changed" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('cookie.policyChanged')}
              </p>
            ) : null}

            <div className="mt-4 space-y-3">
              {CONSENT_CATEGORIES.map((c) => {
                const locked = c === 'necessary';
                const checked = locked ? true : draft[c];
                return (
                  <label
                    key={c}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3"
                  >
                    <input
                      type="checkbox"
                      data-testid={`cookie-toggle-${c}`}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                      checked={checked}
                      disabled={locked}
                      onChange={() => !locked && toggle(c)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">
                        {t(categoryLabelKey(c))}
                        {locked ? <span className="ms-2 text-[11px] font-normal text-slate-400">{t('cookie.alwaysOn')}</span> : null}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t(categoryDescKey(c))}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{t('cookie.policyNote')}</p>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-testid="cookie-dialog-reject" onClick={rejectNonEssential} className="btn-secondary">
                {t('cookie.rejectAll')}
              </button>
              <button type="button" data-testid="cookie-save" onClick={() => save(draft)} className="btn-primary">
                {t('cookie.save')}
              </button>
              <button type="button" data-testid="cookie-dialog-accept" onClick={acceptAll} className="btn-primary">
                {t('cookie.acceptAll')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Persistent, always-available way back into the settings (footer + sidebar).
 * It reopens the same dialog, so a decision can be changed or withdrawn at any
 * time without waiting for a re-prompt.
 */
export function CookieSettingsLink({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const { open } = useConsent();
  return (
    <button
      type="button"
      data-testid="cookie-settings-link"
      onClick={open}
      className={`text-start transition-colors hover:text-brand-700 ${className}`}
    >
      {t('cookie.settingsLink')}
    </button>
  );
}

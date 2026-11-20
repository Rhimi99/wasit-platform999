import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CONSENT_POLICY_VERSION,
  acceptAllCategories,
  applyConsentTransition,
  clearConsent,
  defaultCategories,
  isCategoryAllowed,
  loadConsent,
  loadEffectiveConsent,
  normalizeCategories,
  rejectNonEssentialCategories,
  saveConsent,
  type ConsentCategory,
  type ConsentCategories,
  type ConsentRecord,
} from './cookie-consent';

/**
 * LC-02 — consent state for the whole app.
 *
 * The stored record is the single source of truth. A record for an older policy
 * version (or an expired one) is surfaced as "no decision yet" — the visitor is
 * asked again and nothing optional is enabled in the meantime. There is no path
 * where a missing, corrupt or stale record is treated as agreement.
 */

interface ConsentCtx {
  /** True when the visitor has a current, unexpired decision. */
  hasDecision: boolean;
  /** Current effective categories (all-false optional when no decision). */
  categories: ConsentCategories;
  /** True when a stored decision exists but is for an older policy version. */
  policyChanged: boolean;
  policyVersion: number;
  /** Whether tracking/measurement for a category is permitted right now. */
  allows: (category: ConsentCategory) => boolean;
  acceptAll: () => void;
  rejectNonEssential: () => void;
  save: (categories: Partial<ConsentCategories>) => void;
  /** Reopen the settings panel (persistent link + revoke/re-change). */
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const Ctx = createContext<ConsentCtx | null>(null);

/** Emitted so non-React listeners (e.g. the ad tracker) react to changes live. */
export const CONSENT_CHANGED_EVENT = 'wasit:consent-changed';

function getLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [record, setRecord] = useState<ConsentRecord | null>(() => loadEffectiveConsent(getLocalStorage()));
  const [isOpen, setIsOpen] = useState(false);

  // The stored record may exist but be for an older version — surface that so the
  // UI can explain why it is asking again.
  const stored = loadConsent(getLocalStorage());
  const policyChanged = stored !== null && stored.version !== CONSENT_POLICY_VERSION;

  // A first visit (or a stale/expired record) is surfaced by the persistent,
  // non-blocking banner — never by auto-opening the settings dialog. The dialog
  // is a full-screen overlay; opening it on load would sit on top of the page
  // and swallow clicks (e.g. the sign-in button), so it stays closed until the
  // visitor explicitly asks for it (banner "customise" or the settings link).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'wasit.consent') {
        setRecord(loadEffectiveConsent(getLocalStorage()));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const persist = useCallback(
    (next: ConsentCategories) => {
      const storage = getLocalStorage();
      const previous = loadEffectiveConsent(storage);
      // Revocation side effects run before the new record is written. Some
      // identifiers live in sessionStorage (the ad engine's per-tab id), so both
      // stores are swept — each call only ever removes keys.
      applyConsentTransition(previous, next, storage);
      applyConsentTransition(previous, next, getSessionStorage());
      const saved = saveConsent(storage, next);
      setRecord(saved);
      setIsOpen(false);
      try {
        window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: saved }));
      } catch {
        /* non-browser env */
      }
    },
    [],
  );

  const acceptAll = useCallback(() => persist(acceptAllCategories()), [persist]);
  const rejectNonEssential = useCallback(() => persist(rejectNonEssentialCategories()), [persist]);
  const save = useCallback((categories: Partial<ConsentCategories>) => persist(normalizeCategories(categories)), [persist]);

  const value = useMemo<ConsentCtx>(() => {
    const categories = record ? record.categories : defaultCategories();
    return {
      hasDecision: record !== null,
      categories,
      policyChanged,
      policyVersion: CONSENT_POLICY_VERSION,
      allows: (category) => isCategoryAllowed(record, category),
      acceptAll,
      rejectNonEssential,
      save,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      isOpen,
    };
  }, [record, policyChanged, acceptAll, rejectNonEssential, save, isOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsent(): ConsentCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConsent must be used within ConsentProvider');
  return ctx;
}

/**
 * Reads the effective consent from storage without React — used by the tracking
 * gate so an ad/analytics call checks the same truth the UI shows.
 */
export function consentAllows(category: ConsentCategory): boolean {
  return isCategoryAllowed(loadEffectiveConsent(getLocalStorage()), category);
}

/** Test/utility hook: forget the stored decision entirely. */
export function resetStoredConsent(): void {
  clearConsent(getLocalStorage());
}

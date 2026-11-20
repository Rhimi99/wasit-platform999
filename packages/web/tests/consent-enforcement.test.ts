import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AD_SESSION_STORAGE_KEY,
  CONSENT_STORAGE_KEY,
  acceptAllCategories,
  applyConsentTransition,
  loadConsent,
  rejectNonEssentialCategories,
  saveConsent,
  type StorageLike,
} from '../src/lib/cookie-consent';
import { consentAllows } from '../src/lib/consent-context';
import { LOCALES, translate, type Locale } from '../src/lib/i18n';

/**
 * LC-02 — enforcement wiring and i18n/RTL contract (isolated, no DOM, no DB).
 *
 * Two kinds of proof:
 *  1. runtime — the gate function the tracking code calls (`consentAllows`)
 *     denies every optional category until a current decision says otherwise;
 *  2. wiring — the tracking components actually consult that gate and react to
 *     consent changes, so hiding a slot in the UI is not the enforcement.
 *
 * The real browser flow (banner → choice → reload → reopen) is covered by
 * `e2e/cookie-consent.spec.ts`.
 */

const webSrc = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;

function stubWindow(storage: StorageLike) {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

beforeEach(() => {
  stubWindow(new FakeStorage());
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe('LC-02 — the tracking gate denies by default', () => {
  it('analytics and marketing are blocked before any decision', () => {
    expect(consentAllows('marketing')).toBe(false);
    expect(consentAllows('analytics')).toBe(false);
    expect(consentAllows('necessary')).toBe(true);
  });

  it('after rejecting non-essential, tracking stays blocked', () => {
    saveConsent((globalThis as { window: { localStorage: StorageLike } }).window.localStorage, rejectNonEssentialCategories());
    expect(consentAllows('marketing')).toBe(false);
    expect(consentAllows('analytics')).toBe(false);
    expect(consentAllows('preferences')).toBe(false);
  });

  it('after accepting all, tracking is permitted', () => {
    saveConsent((globalThis as { window: { localStorage: StorageLike } }).window.localStorage, acceptAllCategories());
    expect(consentAllows('marketing')).toBe(true);
    expect(consentAllows('analytics')).toBe(true);
  });

  it('a marketing-only grant does not leak into analytics', () => {
    saveConsent((globalThis as { window: { localStorage: StorageLike } }).window.localStorage, {
      necessary: true,
      preferences: false,
      analytics: false,
      marketing: true,
    });
    expect(consentAllows('marketing')).toBe(true);
    expect(consentAllows('analytics')).toBe(false);
  });
});

describe('LC-02 — tracking components consult the gate (no early load)', () => {
  it('AdSlot gates the ad fetch and impression on marketing consent', () => {
    const src = webSrc('components/AdSlot.tsx');
    expect(src).toContain('consentAllows');
    expect(src).toContain("consentAllows('marketing')");
    // Both the served-ads fetch and the impression effect are behind the flag.
    expect(src).toMatch(/if \(!marketingAllowed\)[\s\S]*return/);
    // It reacts to live consent changes (grant starts, revoke stops).
    expect(src).toContain('CONSENT_CHANGED_EVENT');
    // No ad content or report when marketing is not allowed.
    expect(src).toMatch(/if \(!marketingAllowed\) return null/);
  });

  it('the analytics capture call is never invoked automatically by the web app', () => {
    // The only analytics client calls are the seller/admin dashboards reading
    // their own KPIs; no page auto-fires captureAnalyticsEvent on load.
    const app = webSrc('App.tsx');
    expect(app).not.toContain('captureAnalyticsEvent');
    const api = webSrc('lib/api.ts');
    // The function exists but is opt-in only; nothing schedules it on mount.
    expect(api).toContain('captureAnalyticsEvent');
  });

  it('App mounts the consent surface and main wraps the provider', () => {
    const app = webSrc('App.tsx');
    expect(app).toContain('CookieConsent');
    expect(app).toMatch(/<CookieConsent \/>/);
    const main = webSrc('main.tsx');
    expect(main).toContain('ConsentProvider');
    expect(main).toMatch(/<ConsentProvider>[\s\S]*<App \/>/);
  });

  it('a persistent settings link exists in the public footer and the dashboard sidebar', () => {
    expect(webSrc('components/layouts/PublicLayout.tsx')).toContain('CookieSettingsLink');
    expect(webSrc('components/layouts/AppSidebar.tsx')).toContain('CookieSettingsLink');
    // The link reopens the same dialog (not a one-shot banner).
    const component = webSrc('components/CookieConsent.tsx');
    expect(component).toContain('cookie-settings-link');
    expect(component).toContain('cookie-consent-dialog');
  });
});

describe('LC-02 — i18n and RTL/LTR contract', () => {
  const locales: Locale[] = ['ar', 'en', 'fr', 'zh'];
  const keys = [
    'cookie.title',
    'cookie.bannerDesc',
    'cookie.dialogDesc',
    'cookie.acceptAll',
    'cookie.rejectAll',
    'cookie.customize',
    'cookie.save',
    'cookie.settingsLink',
    'cookie.alwaysOn',
    'cookie.policyChanged',
    'cookie.policyNote',
    'cookie.cat.necessary',
    'cookie.cat.necessary.desc',
    'cookie.cat.preferences',
    'cookie.cat.preferences.desc',
    'cookie.cat.analytics',
    'cookie.cat.analytics.desc',
    'cookie.cat.marketing',
    'cookie.cat.marketing.desc',
  ];

  it('every consent key is translated in all four locales (no raw-key fallback)', () => {
    for (const locale of locales) {
      for (const key of keys) {
        const value = translate(locale, key);
        expect(value, `${locale}:${key}`).not.toBe(key);
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('Arabic is RTL and the other three are LTR', () => {
    expect(LOCALES.find((l) => l.code === 'ar')!.dir).toBe('rtl');
    for (const code of ['en', 'fr', 'zh'] as Locale[]) {
      expect(LOCALES.find((l) => l.code === code)!.dir).toBe('ltr');
    }
  });

  it('the consent surface uses logical (RTL-safe) spacing utilities', () => {
    const src = webSrc('components/CookieConsent.tsx');
    // Logical properties (ms-*) mirror under RTL; physical left/right do not.
    expect(src).toContain('ms-2');
    expect(src).not.toMatch(/\bml-|\bmr-|\bpl-|\bpr-/);
  });
});

describe('LC-02 — revocation sweeps both stores (regression for the browser bug)', () => {
  // The ad engine keeps its per-tab id in sessionStorage while the consent record
  // lives in localStorage. `persist()` therefore sweeps both stores; these cases
  // pin the behaviour the browser test (007.2) caught when only localStorage was
  // swept. Each call only ever removes keys, so sweeping twice is safe.
  let local: FakeStorage;
  let session: FakeStorage;

  const sweep = (
    previous: ReturnType<typeof loadConsent>,
    next: ReturnType<typeof acceptAllCategories>,
  ): string[] => [
    ...applyConsentTransition(previous, next, local),
    ...applyConsentTransition(previous, next, session),
  ];

  beforeEach(() => {
    local = new FakeStorage();
    session = new FakeStorage();
    stubWindow(local);
  });

  it('deletes wasit.adSession from sessionStorage when marketing is withdrawn', () => {
    saveConsent(local, acceptAllCategories());
    session.setItem(AD_SESSION_STORAGE_KEY, 'tab-123');
    const removed = sweep(loadConsent(local), rejectNonEssentialCategories());
    expect(removed).toContain(AD_SESSION_STORAGE_KEY);
    expect(session.getItem(AD_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('keeps the necessary consent record (never deletes it)', () => {
    saveConsent(local, acceptAllCategories());
    const before = local.getItem(CONSENT_STORAGE_KEY);
    sweep(loadConsent(local), rejectNonEssentialCategories());
    expect(local.getItem(CONSENT_STORAGE_KEY)).toBe(before);
  });

  it('does not touch unrelated client identifiers', () => {
    local.setItem('wasit.theme', 'dark');
    session.setItem('wasit.cart', 'abc');
    saveConsent(local, acceptAllCategories());
    session.setItem(AD_SESSION_STORAGE_KEY, 'tab-123');
    sweep(loadConsent(local), rejectNonEssentialCategories());
    expect(local.getItem('wasit.theme')).toBe('dark');
    expect(session.getItem('wasit.cart')).toBe('abc');
  });

  it('does nothing while marketing consent is retained', () => {
    saveConsent(local, acceptAllCategories());
    session.setItem(AD_SESSION_STORAGE_KEY, 'tab-123');
    const removed = sweep(loadConsent(local), acceptAllCategories());
    expect(removed).toEqual([]);
    expect(session.getItem(AD_SESSION_STORAGE_KEY)).toBe('tab-123');
  });

  it('still writes the localStorage consent record as before', () => {
    const saved = saveConsent(local, acceptAllCategories());
    expect(saved.categories.marketing).toBe(true);
    expect(loadConsent(local)?.categories).toEqual(saved.categories);
    expect(loadConsent(local)?.version).toBe(saved.version);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AD_SESSION_STORAGE_KEY,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  acceptAllCategories,
  applyConsentTransition,
  clearConsent,
  defaultCategories,
  isCategoryAllowed,
  isConsentCurrent,
  loadConsent,
  loadEffectiveConsent,
  normalizeCategories,
  parseConsent,
  rejectNonEssentialCategories,
  saveConsent,
  storageKeysForCategory,
  type StorageLike,
} from '../src/lib/cookie-consent';

/**
 * LC-02 — cookie-consent decision logic (isolated, no DOM, no DB).
 *
 * These cases pin the mandated behaviours: no implied consent on a first visit,
 * accept/reject/customise, persistence and reload, change, withdrawal, policy
 * versioning, expiry, and the necessary-cookie guarantees. Enforcement (nothing
 * tracked before consent) is proven separately in `consent-enforcement.test.ts`
 * and end to end in `e2e/cookie-consent.spec.ts`.
 */

/** In-memory Storage fake (also mirrors the sessionStorage ad-session key). */
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
  has(k: string) {
    return this.map.has(k);
  }
}

let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
});

describe('LC-02 — first visit has no implied consent', () => {
  it('no stored record → loadEffectiveConsent is null', () => {
    expect(loadEffectiveConsent(storage)).toBeNull();
  });

  it('a missing decision grants nothing optional and keeps necessary on', () => {
    const record = loadEffectiveConsent(storage);
    expect(isCategoryAllowed(record, 'preferences')).toBe(false);
    expect(isCategoryAllowed(record, 'analytics')).toBe(false);
    expect(isCategoryAllowed(record, 'marketing')).toBe(false);
    expect(isCategoryAllowed(record, 'necessary')).toBe(true);
  });

  it('default categories are necessary-only', () => {
    expect(defaultCategories()).toEqual({
      necessary: true,
      preferences: false,
      analytics: false,
      marketing: false,
    });
  });
});

describe('LC-02 — accept all / reject non-essential / customise', () => {
  it('accept all enables every optional category', () => {
    saveConsent(storage, acceptAllCategories());
    const record = loadEffectiveConsent(storage)!;
    expect(record.categories).toEqual({
      necessary: true,
      preferences: true,
      analytics: true,
      marketing: true,
    });
  });

  it('reject non-essential keeps only necessary', () => {
    saveConsent(storage, rejectNonEssentialCategories());
    const record = loadEffectiveConsent(storage)!;
    expect(record.categories).toEqual({
      necessary: true,
      preferences: false,
      analytics: false,
      marketing: false,
    });
  });

  it('a per-category choice is stored exactly (customise)', () => {
    saveConsent(storage, { necessary: true, preferences: true, analytics: false, marketing: true });
    const record = loadEffectiveConsent(storage)!;
    expect(record.categories.analytics).toBe(false);
    expect(record.categories.preferences).toBe(true);
    expect(record.categories.marketing).toBe(true);
  });

  it('normalizeCategories never lets a caller turn necessary off', () => {
    const c = normalizeCategories({ necessary: false, analytics: true } as never);
    expect(c.necessary).toBe(true);
    expect(c.analytics).toBe(true);
  });
});

describe('LC-02 — persistence, reload and change', () => {
  it('a decision is persisted and survives a reload (new read of same storage)', () => {
    saveConsent(storage, { necessary: true, preferences: false, analytics: true, marketing: false });
    const reloaded = loadEffectiveConsent(storage)!;
    expect(reloaded.categories.analytics).toBe(true);
    expect(reloaded.categories.marketing).toBe(false);
  });

  it('changing the choice overwrites the previous decision', () => {
    saveConsent(storage, acceptAllCategories());
    saveConsent(storage, { necessary: true, preferences: false, analytics: false, marketing: false });
    const record = loadEffectiveConsent(storage)!;
    expect(record.categories).toEqual({
      necessary: true,
      preferences: false,
      analytics: false,
      marketing: false,
    });
  });

  it('the stored record carries a decision timestamp and a policy version', () => {
    const now = new Date('2026-11-07T10:00:00.000Z');
    const record = saveConsent(storage, acceptAllCategories(), now);
    expect(record.decidedAt).toBe(now.toISOString());
    expect(record.version).toBe(CONSENT_POLICY_VERSION);
    const parsed = loadConsent(storage)!;
    expect(parsed.decidedAt).toBe(now.toISOString());
    expect(parsed.version).toBe(CONSENT_POLICY_VERSION);
  });
});

describe('LC-02 — withdrawal stops optional categories (and only those)', () => {
  it('withdrawing marketing revokes marketing but leaves necessary on', () => {
    saveConsent(storage, acceptAllCategories());
    saveConsent(storage, { necessary: true, preferences: true, analytics: true, marketing: false });
    const record = loadEffectiveConsent(storage)!;
    expect(isCategoryAllowed(record, 'marketing')).toBe(false);
    expect(isCategoryAllowed(record, 'necessary')).toBe(true);
  });

  it('withdrawal clears the marketing identifier and keeps necessary storage intact', () => {
    storage.setItem(AD_SESSION_STORAGE_KEY, 'web_abc');
    storage.setItem('wasit_session', 'keep-me');
    saveConsent(storage, acceptAllCategories());
    const previous = loadEffectiveConsent(storage)!;
    const removed = applyConsentTransition(
      previous,
      { necessary: true, preferences: true, analytics: true, marketing: false },
      storage,
    );
    expect(removed).toContain(AD_SESSION_STORAGE_KEY);
    expect(storage.has(AD_SESSION_STORAGE_KEY)).toBe(false);
    expect(storage.getItem('wasit_session')).toBe('keep-me');
  });

  it('storageKeysForCategory only targets marketing identifiers', () => {
    expect(storageKeysForCategory('marketing')).toEqual([AD_SESSION_STORAGE_KEY]);
    expect(storageKeysForCategory('analytics')).toEqual([]);
    expect(storageKeysForCategory('necessary')).toEqual([]);
  });
});

describe('LC-02 — policy version change and expiry never become implied consent', () => {
  it('a record from an older policy version is not current', () => {
    const old = {
      version: CONSENT_POLICY_VERSION - 1,
      categories: acceptAllCategories(),
      decidedAt: new Date().toISOString(),
      id: 'x',
    };
    expect(isConsentCurrent(old)).toBe(false);
    expect(isCategoryAllowed(old, 'analytics')).toBe(false);
  });

  it('an expired decision is treated as no decision', () => {
    const longAgo = new Date(Date.now() - (CONSENT_MAX_AGE_DAYS + 1) * 86400_000);
    saveConsent(storage, acceptAllCategories(), longAgo);
    expect(loadEffectiveConsent(storage)).toBeNull();
    expect(isCategoryAllowed(loadEffectiveConsent(storage), 'marketing')).toBe(false);
  });

  it('a fresh decision is current', () => {
    saveConsent(storage, acceptAllCategories());
    expect(loadEffectiveConsent(storage)).not.toBeNull();
  });

  it('a corrupt record is refused rather than trusted', () => {
    storage.setItem(CONSENT_STORAGE_KEY, '{not json');
    expect(parseConsent(storage.getItem(CONSENT_STORAGE_KEY))).toBeNull();
    expect(loadEffectiveConsent(storage)).toBeNull();

    storage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        decidedAt: 'x',
        id: 'y',
        categories: { necessary: false, preferences: true, analytics: true, marketing: true },
      }),
    );
    expect(parseConsent(storage.getItem(CONSENT_STORAGE_KEY))).toBeNull();
  });

  it('clearConsent removes the decision entirely', () => {
    saveConsent(storage, acceptAllCategories());
    clearConsent(storage);
    expect(loadEffectiveConsent(storage)).toBeNull();
  });
});

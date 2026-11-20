// LC-02 — Cookie consent core (pure, framework-free, storage-injectable).
//
// The rules live here, away from React, so they can be unit-tested with a fake
// storage and so the enforcement path (tracking gates) reads the same truth as
// the UI. Nothing here touches the session cookie (`wasit_session`): necessary
// cookies are never gated, removed or weakened.

/** Bump when the published cookie policy changes materially. */
export const CONSENT_POLICY_VERSION = 1;

/** localStorage key holding the single consent record. */
export const CONSENT_STORAGE_KEY = 'wasit.consent';

/** sessionStorage key used by the advertising engine for per-tab grouping. */
export const AD_SESSION_STORAGE_KEY = 'wasit.adSession';

/** Consent older than this is treated as expired (re-asked, never assumed). */
export const CONSENT_MAX_AGE_DAYS = 180;

export const CONSENT_CATEGORIES = ['necessary', 'preferences', 'analytics', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** Categories that never require consent because they are strictly necessary. */
export const NECESSARY_CATEGORIES: readonly ConsentCategory[] = ['necessary'];

export type ConsentCategories = Record<ConsentCategory, boolean>;

export interface ConsentRecord {
  /** Policy version the decision was made under. */
  version: number;
  categories: ConsentCategories;
  /** ISO timestamp of the (last) decision. */
  decidedAt: string;
  /** Random, non-personal identifier for the record itself. */
  id: string;
}

/** Minimal Storage shape so tests can pass an in-memory fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A first visit: only necessary cookies are on; nothing else is implied. */
export function defaultCategories(): ConsentCategories {
  return { necessary: true, preferences: false, analytics: false, marketing: false };
}

/** Necessary is always on; the caller may only set the optional categories. */
export function normalizeCategories(input: Partial<ConsentCategories> | undefined): ConsentCategories {
  const base = defaultCategories();
  if (!input) return base;
  for (const c of CONSENT_CATEGORIES) {
    if (c === 'necessary') continue;
    if (typeof input[c] === 'boolean') base[c] = input[c] as boolean;
  }
  return base;
}

export function acceptAllCategories(): ConsentCategories {
  return { necessary: true, preferences: true, analytics: true, marketing: true };
}

export function rejectNonEssentialCategories(): ConsentCategories {
  return defaultCategories();
}

function isCategoryMap(v: unknown): v is ConsentCategories {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return CONSENT_CATEGORIES.every((c) => typeof o[c] === 'boolean');
}

/** Parses a stored string into a record, or null if anything is off. */
export function parseConsent(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.version !== 'number') return null;
  if (typeof o.decidedAt !== 'string') return null;
  if (typeof o.id !== 'string') return null;
  if (!isCategoryMap(o.categories)) return null;
  const categories = normalizeCategories(o.categories);
  // A record claiming necessary=false is corrupt; refuse it rather than trust it.
  if ((o.categories as ConsentCategories).necessary !== true) return null;
  return { version: o.version, decidedAt: o.decidedAt, id: o.id, categories };
}

/**
 * A record only counts when it is for the current policy version and not expired.
 * Anything else — missing, corrupt, old version, expired — is "no decision".
 */
export function isConsentCurrent(
  record: ConsentRecord | null,
  now: Date = new Date(),
  policyVersion: number = CONSENT_POLICY_VERSION,
  maxAgeDays: number = CONSENT_MAX_AGE_DAYS,
): boolean {
  if (!record) return false;
  if (record.version !== policyVersion) return false;
  const decided = Date.parse(record.decidedAt);
  if (Number.isNaN(decided)) return false;
  const ageMs = now.getTime() - decided;
  if (ageMs < 0) return false; // clock skew / tampering → treat as invalid
  return ageMs <= maxAgeDays * 86400_000;
}

/** Loads the stored record, returning null when absent or unreadable. */
export function loadConsent(storage: StorageLike | null | undefined): ConsentRecord | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    return null;
  }
  return parseConsent(raw);
}

/** The record that governs behaviour now: current-and-unexpired, else null. */
export function loadEffectiveConsent(
  storage: StorageLike | null | undefined,
  now: Date = new Date(),
): ConsentRecord | null {
  const record = loadConsent(storage);
  return isConsentCurrent(record, now) ? record : null;
}

function newRecordId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `consent_${Date.now().toString(36)}_${rand}`;
}

/** Persists a decision and returns the stored record. */
export function saveConsent(
  storage: StorageLike | null | undefined,
  categories: ConsentCategories,
  now: Date = new Date(),
  policyVersion: number = CONSENT_POLICY_VERSION,
): ConsentRecord {
  const record: ConsentRecord = {
    version: policyVersion,
    categories: normalizeCategories(categories),
    decidedAt: now.toISOString(),
    id: newRecordId(),
  };
  if (storage) {
    try {
      storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
    } catch {
      /* storage full/blocked: the in-memory record still applies this session */
    }
  }
  return record;
}

/** Removes the stored decision (used when a policy change invalidates it). */
export function clearConsent(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a tracking/measurement action for `category` is permitted. Necessary
 * is never a tracking category and optional categories default to denied.
 */
export function isCategoryAllowed(
  record: ConsentRecord | null,
  category: ConsentCategory,
  now: Date = new Date(),
): boolean {
  if (category === 'necessary') return true;
  if (!isConsentCurrent(record, now)) return false;
  return record!.categories[category] === true;
}

/**
 * Storage that must be wiped when a category is revoked. Marketing/analytics
 * identifiers are removed; the session cookie and other necessary state are
 * deliberately left untouched.
 */
export function storageKeysForCategory(category: ConsentCategory): string[] {
  switch (category) {
    case 'marketing':
      return [AD_SESSION_STORAGE_KEY];
    case 'analytics':
      return [];
    default:
      return [];
  }
}

/**
 * Applies the side effects of a consent transition: when an optional category
 * goes from granted to denied, its client-side identifiers are deleted.
 * Returns the keys actually removed.
 */
export function applyConsentTransition(
  previous: ConsentRecord | null,
  next: ConsentCategories,
  storage: StorageLike | null | undefined,
  now: Date = new Date(),
): string[] {
  const removed: string[] = [];
  if (!storage) return removed;
  for (const category of CONSENT_CATEGORIES) {
    if (category === 'necessary') continue;
    const wasGranted = isCategoryAllowed(previous, category, now);
    const isGranted = next[category] === true;
    if (wasGranted && !isGranted) {
      for (const key of storageKeysForCategory(category)) {
        try {
          storage.removeItem(key);
          removed.push(key);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return removed;
}

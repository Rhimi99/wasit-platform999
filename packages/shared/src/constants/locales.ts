/**
 * Languages the platform supports end to end (M1).
 *
 * This is the single source of truth for the locale tags the API accepts. It
 * exists so the web interface and every server-side locale schema agree: a
 * locale the UI offers can never be rejected by the endpoint that receives it.
 * Before this, each server schema inlined its own `['ar', 'fr', 'en']` list and
 * silently dropped `zh`, which the interface already shipped.
 *
 * Scope: this governs *acceptance* of a locale tag only. It carries no
 * authorization, identity or consent semantics — the locale a user picks never
 * changes what they may do, nor which legal documents bind them.
 */
export const SUPPORTED_LOCALES = ['ar', 'fr', 'en', 'zh'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Locale applied when a caller does not supply one. */
export const DEFAULT_LOCALE: SupportedLocale = 'ar';

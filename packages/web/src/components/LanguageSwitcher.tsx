import { LOCALES } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n-context';
import { Icon } from '@/components/Icon';

/**
 * Language picker: globe + short code (FR) + caret, as in the reference.
 * The native <select> stays in place (invisible overlay) so the control keeps
 * working on touch devices and with assistive tech.
 */
export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale } = useI18n();
  const current = LOCALES.find((l) => l.code === locale);
  const short = (current?.code ?? 'fr').toUpperCase();

  return (
    <div
      className={`relative inline-flex h-10 items-center gap-1.5 rounded-[10px] border px-3 transition-colors ${
        dark
          ? 'border-white/25 text-white hover:border-white/40'
          : 'border-slate-200 text-ink-1000 hover:border-brand-300'
      }`}
    >
      <Icon name="globe" className={`h-4 w-4 shrink-0 ${dark ? 'text-white/80' : 'text-slate-500'}`} />
      <span className="text-sm font-semibold" aria-hidden>{short}</span>
      <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 ${dark ? 'text-white/70' : 'text-slate-400'}`} aria-hidden>
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as typeof locale)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="Language"
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code} className="text-slate-900">{l.label}</option>
        ))}
      </select>
    </div>
  );
}
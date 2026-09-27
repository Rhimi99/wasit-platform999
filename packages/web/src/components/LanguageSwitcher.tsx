import { LOCALES } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n-context';

export function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale } = useI18n();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      className={
        dark
          ? 'rounded-md border border-white/20 bg-white/5 px-2 py-1 text-xs font-medium text-slate-200'
          : 'rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700'
      }
      aria-label="Language"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code} className={dark ? 'text-slate-900' : undefined}>{l.label}</option>
      ))}
    </select>
  );
}
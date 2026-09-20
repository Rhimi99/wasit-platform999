import { LOCALES } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n-context';

export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700"
      aria-label="Language"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>{l.label}</option>
      ))}
    </select>
  );
}
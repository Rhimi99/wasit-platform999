import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LOCALES, translate, type Locale } from './i18n';

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
  dir: 'rtl' | 'ltr';
}

const Ctx = createContext<I18nCtx | null>(null);

const STORAGE_KEY = 'wasit.locale';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved && LOCALES.some((l) => l.code === saved)) return saved as Locale;
    return 'ar';
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale);
    const dir = LOCALES.find((l) => l.code === locale)?.dir ?? 'rtl';
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale]);

  const value = useMemo<I18nCtx>(() => {
    const dir = LOCALES.find((l) => l.code === locale)?.dir ?? 'rtl';
    return {
      locale,
      setLocale: setLocaleState,
      t: (key) => translate(locale, key),
      dir,
    };
  }, [locale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
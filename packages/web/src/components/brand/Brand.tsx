import { Link } from 'react-router-dom';
import { useI18n } from '@/lib/i18n-context';
import { WMonogram } from './WMonogram';

/**
 * Official identity: LE WASSIT / BUSINESS GLOBAL.
 * `presentation` renders the oversized hero lockup — large W, serif wordmark,
 * a thin rule and the spaced-out baseline. The compact form is used in the
 * header and footer.
 */
export function Brand({
  className = '',
  compact = false,
  light = false,
  presentation = false,
  as,
}: {
  className?: string;
  compact?: boolean;
  light?: boolean;
  presentation?: boolean;
  /** Render the presentation lockup as this element (e.g. 'h1') for the page heading. */
  as?: 'div' | 'h1';
}) {
  const { t } = useI18n();
  const name = light ? 'text-white' : 'text-brand-900';
  const sub = light ? 'text-slate-300' : 'text-brand-700';
  const rule = light ? 'bg-white/30' : 'bg-brand-200';

  if (presentation) {
    const Tag = as ?? 'div';
    return (
      <Tag className={`flex items-center gap-5 sm:gap-6 ${className}`} aria-label={t('app.name')}>
        <WMonogram size={148} variant="hero" className="shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className={`font-serif text-4xl font-bold uppercase leading-none tracking-[0.02em] ${name} sm:text-5xl`}>
            {t('brand.name')}
          </span>
          <span className={`my-3 h-px w-full ${rule}`} aria-hidden />
          <span className={`text-[11px] font-semibold uppercase tracking-[0.42em] ${sub} sm:text-xs`}>
            {t('brand.sub')}
          </span>
        </span>
      </Tag>
    );
  }

  return (
    <Link to="/" className={`group flex items-center gap-3 ${className}`} aria-label={t('app.name')}>
      <WMonogram size={compact ? 44 : 54} className="shrink-0 transition-transform duration-300 group-hover:scale-[1.03]" />
      <span className="flex flex-col leading-tight">
        <span className={`font-serif text-2xl font-bold uppercase tracking-[0.02em] ${name}`}>
          {t('brand.name')}
        </span>
        <span className={`mt-1 text-[10px] font-semibold uppercase tracking-[0.34em] ${sub}`}>
          {t('brand.sub')}
        </span>
      </span>
    </Link>
  );
}
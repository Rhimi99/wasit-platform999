import { Link } from 'react-router-dom';
import { useI18n } from '@/lib/i18n-context';
import { WMonogram } from './WMonogram';

// الهوية البصرية الرسمية: LE WASSIT + BUSINESS GLOBAL
export function Brand({
  className = '',
  compact = false,
  light = false,
}: {
  className?: string;
  compact?: boolean;
  light?: boolean;
}) {
  const { t } = useI18n();
  const name = light ? 'text-white' : 'text-slate-900';
  const sub = light ? 'text-slate-300' : 'text-slate-500';
  return (
    <Link to="/" className={`group flex items-center gap-3 ${className}`} aria-label={t('app.name')}>
      <WMonogram size={compact ? 40 : 44} className="shrink-0 drop-shadow-sm transition-transform duration-300 group-hover:scale-[1.03]" />
      <span className="flex flex-col leading-tight">
        <span className={`text-[17px] font-extrabold tracking-[0.08em] ${name}`}>
          {t('brand.name')}
        </span>
        <span className={`text-[10px] font-semibold tracking-[0.28em] ${sub}`}>
          {t('brand.sub')}
        </span>
      </span>
    </Link>
  );
}
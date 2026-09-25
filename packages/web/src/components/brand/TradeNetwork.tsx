import { useI18n } from '@/lib/i18n-context';

/**
 * Hero visual for the landing page: LE WASSIT sits at the centre of a trade
 * network linking buyers, merchants, suppliers and companies. Pure CSS/SVG —
 * no external images — so it stays light and renders identically on every
 * device and in both writing directions.
 */
export function TradeNetwork({ className = '' }: { className?: string }) {
  const { t } = useI18n();

  const satellites = [
    { key: 'home.net.buyer', pos: 'top-2 left-1/2 -translate-x-1/2', tone: 'text-brand-700 bg-brand-50 border-brand-200' },
    { key: 'home.net.supplier', pos: 'top-1/2 right-0 -translate-y-1/2', tone: 'text-teal-700 bg-teal-50 border-teal-200' },
    { key: 'home.net.merchant', pos: 'bottom-2 left-1/2 -translate-x-1/2', tone: 'text-slate-700 bg-white border-slate-200' },
    { key: 'home.net.company', pos: 'top-1/2 left-0 -translate-y-1/2', tone: 'text-slate-700 bg-white border-slate-200' },
  ];

  return (
    <div
      className={`relative aspect-[4/3] w-full overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white via-brand-50/40 to-teal-50/30 shadow-card ${className}`}
      aria-hidden
    >
      {/* subtle grid */}
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(148,163,184,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.16) 1px, transparent 1px)',
          backgroundSize: '34px 34px',
        }}
      />

      {/* connection lines */}
      <svg viewBox="0 0 400 300" className="absolute inset-0 h-full w-full" fill="none">
        <g stroke="#2563eb" strokeOpacity="0.25" strokeWidth="1.4">
          <line x1="200" y1="150" x2="200" y2="52" />
          <line x1="200" y1="150" x2="330" y2="150" />
          <line x1="200" y1="150" x2="200" y2="248" />
          <line x1="200" y1="150" x2="70" y2="150" />
        </g>
        <g stroke="#14b8a6" strokeOpacity="0.5" strokeWidth="1.6" strokeDasharray="5 7" strokeLinecap="round">
          <line x1="200" y1="150" x2="200" y2="52">
            <animate attributeName="stroke-dashoffset" values="0;-24" dur="1.8s" repeatCount="indefinite" />
          </line>
          <line x1="200" y1="150" x2="330" y2="150">
            <animate attributeName="stroke-dashoffset" values="0;-24" dur="2.4s" repeatCount="indefinite" />
          </line>
        </g>
      </svg>

      {/* centre node */}
      <div className="absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-2xl bg-navy text-white shadow-lift sm:h-28 sm:w-28">
        <span className="text-[10px] font-semibold tracking-[0.28em] text-teal-300">LE WASSIT</span>
        <span className="mt-1 text-base font-black tracking-tight sm:text-lg">AI</span>
        <span className="mt-0.5 text-[9px] font-medium text-slate-400">{t('home.net.core')}</span>
      </div>

      {/* satellites */}
      {satellites.map((s) => (
        <span
          key={s.key}
          className={`absolute rounded-xl border px-3 py-1.5 text-[11px] font-bold shadow-sm sm:text-xs ${s.pos} ${s.tone}`}
        >
          {t(s.key)}
        </span>
      ))}

      {/* trust ribbon */}
      <div className="absolute bottom-3 right-3 rounded-lg bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200 backdrop-blur">
        {t('home.net.badge')}
      </div>
    </div>
  );
}

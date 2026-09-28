import { useEffect, useRef } from 'react';

/**
 * Public-demo banner. Rendered only when VITE_DEMO_MODE=true, so the same build
 * stays clean for production. It makes the demo surface unmistakable and warns
 * visitors that the data is fictional and the payment provider is offline.
 *
 * The banner is sticky, so it publishes its measured height as
 * `--demo-banner-h`; the sticky header offsets itself by that value to avoid
 * covering the banner (and being covered by it) while scrolling.
 */
export function DemoBanner() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--demo-banner-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--demo-banner-h');
    };
  }, []);

  return (
    <div
      ref={ref}
      role="status"
      dir="rtl"
      className="sticky top-0 z-[60] bg-ink-950 px-3 py-1.5 text-center text-[11px] leading-tight text-slate-300 sm:text-xs"
    >
      <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 font-bold tracking-wide text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-400" aria-hidden />
          DEMO
        </span>
        <span className="hidden text-slate-400 sm:inline" aria-hidden>·</span>
        <span>بيانات تجريبية فقط، لا مدفوعات حقيقية.</span>
        <span className="text-slate-400" dir="ltr">Fake data, no real payments.</span>
      </span>
    </div>
  );
}

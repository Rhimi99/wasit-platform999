/**
 * Public-demo banner. Rendered only when VITE_DEMO_MODE=true, so the same build
 * stays clean for production. It makes the demo surface unmistakable and warns
 * visitors that the data is fictional and the payment provider is offline.
 */
export function DemoBanner() {
  return (
    <div
      role="status"
      dir="rtl"
      className="sticky top-0 z-[60] bg-navy px-3 py-1.5 text-center text-[11px] leading-tight text-slate-300 sm:text-xs"
    >
      <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 font-bold tracking-wide text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-400" aria-hidden />
          DEMO
        </span>
        <span className="hidden text-slate-400 sm:inline" aria-hidden>·</span>
        <span>بيانات تجريبية فقط، لا مدفوعات حقيقية.</span>
        <span className="text-slate-400" dir="ltr">Fake data, no real payments.</span>
      </span>
    </div>
  );
}

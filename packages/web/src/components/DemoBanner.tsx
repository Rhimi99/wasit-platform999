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
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 60,
        background: 'linear-gradient(90deg,#7c3aed,#2563eb)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        lineHeight: 1.4,
        padding: '6px 12px',
        textAlign: 'center',
      }}
    >
      <strong>وضع العرض التجريبي (DEMO)</strong> — بيانات تجريبية فقط، لا مدفوعات
      حقيقية، ولا بيانات مستخدمين حقيقيين. ·{' '}
      <span dir="ltr">Demo mode — fake data, no real payments.</span>
    </div>
  );
}

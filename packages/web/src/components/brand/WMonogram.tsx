// حرف W — العنصر الأساسي في الهوية البصرية لـ LE WASSIT
// شعار مونوغرامي بأزرق تجاري (Royal → Navy) — مخصص لإعادة الاستخدام.

interface WMonogramProps {
  size?: number;
  className?: string;
  /** تدرج أزرق واضح للشعار الكبير في الـ Hero، وتدرج أزرق هادئ للـ header/footer */
  variant?: 'default' | 'hero';
}

export function WMonogram({ size = 48, className = '', variant = 'default' }: WMonogramProps) {
  const gradId = variant === 'hero' ? 'wg-hero' : 'wg-default';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="W"
      className={className}
    >
      <defs>
        <linearGradient id={gradId} x1="6" y1="10" x2="22" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#1e3a8a" />
        </linearGradient>
      </defs>
      <path
        d="M8 12h5.6c1.1 0 2.1.6 2.6 1.6L32 40l15.8-26.4c.5-1 1.5-1.6 2.6-1.6H56l2 7.4L40.4 50.6a4.9 4.9 0 0 1-8.2 0L6 19.4 8 12z"
        fill={`url(#${gradId})`}
      />
    </svg>
  );
}
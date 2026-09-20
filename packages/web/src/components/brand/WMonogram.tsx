// حرف W — العنصر الأساسي في الهوية البصرية لـ LE WASSIT
// شعار مونوغرامي نظيف بألوان الأزرق الرمادي (Blue-Gray) — مخصص لإعادة الاستخدام.

interface WMonogramProps {
  size?: number;
  className?: string;
  /** يلون الحرف بتدرج واضح (hero) أو بتدرج هادئ (header/footer) */
  variant?: 'default' | 'hero';
}

export function WMonogram({ size = 48, className = '', variant = 'default' }: WMonogramProps) {
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
        <linearGradient id={variant === 'hero' ? 'wg-hero' : 'wg-default'} x1="0" y1="0" x2="64" y2="64">
          <stop offset="0%" stopColor={variant === 'hero' ? '#e0e7ff' : '#64748b'} />
          <stop offset="100%" stopColor={variant === 'hero' ? '#818cf8' : '#334155'} />
        </linearGradient>
      </defs>
      <path
        d="M8 12h5.6c1.1 0 2.1.6 2.6 1.6L32 40l15.8-26.4c.5-1 1.5-1.6 2.6-1.6H56l2 7.4L40.4 50.6a4.9 4.9 0 0 1-8.2 0L6 19.4 8 12z"
        fill={`url(#${variant === 'hero' ? 'wg-hero' : 'wg-default'})`}
      />
    </svg>
  );
}
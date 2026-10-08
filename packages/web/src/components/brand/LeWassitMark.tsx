import { useId } from 'react';

/**
 * LE WASSIT symbol mark.
 *
 * The geometry is a "W" drawn as trade lanes rather than a letterform: two
 * outer lanes descend from the top corners to a shared baseline (the point
 * where buyer and seller meet), and a third lane rises between them to an
 * elevated apex (the mediator, standing above the transaction). The two upper
 * terminals carry open rings — the two parties — while the apex is filled, so
 * the mediator is the only solid node in the mark.
 *
 * Flat fills and uniform stroke weights keep it legible down to 16px, and the
 * whole mark collapses to a single colour for print and faxes.
 */

export type MarkTone = 'brand' | 'inverse' | 'mono';

/** Palette anchors (packages/web/tailwind.config.js). */
const BLUE_500 = '#3b82f6';
const BLUE_600 = '#2563eb';
const BLUE_300 = '#93c5fd';
const INK_900 = '#081335';
const CANVAS = '#f8fafc';
const WHITE = '#ffffff';

interface LeWassitMarkProps {
  /** Rendered size in px — the mark is square. */
  size?: number;
  tone?: MarkTone;
  className?: string;
  /** Accessible name. Pass an empty string when the mark sits next to visible text. */
  title?: string;
}

export function LeWassitMark({ size = 40, tone = 'brand', className = '', title = 'LE WASSIT' }: LeWassitMarkProps) {
  // Gradient ids leak across instances when they are constants, so scope them.
  const uid = useId().replace(/:/g, '');
  const gradId = `lw-plate-${uid}`;

  const mono = tone === 'mono';
  const inverse = tone === 'inverse';

  const plateFill = mono ? 'none' : `url(#${gradId})`;
  const laneStroke = mono ? 'currentColor' : inverse ? INK_900 : WHITE;
  const accentStroke = mono ? 'currentColor' : inverse ? BLUE_600 : BLUE_300;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      {mono ? null : (
        <defs>
          <linearGradient id={gradId} x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
            {inverse ? (
              <>
                <stop offset="0%" stopColor={CANVAS} />
                <stop offset="100%" stopColor="#e2e8f0" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor={BLUE_500} />
                <stop offset="100%" stopColor={INK_900} />
              </>
            )}
          </linearGradient>
        </defs>
      )}

      <rect x="3" y="3" width="58" height="58" rx="15.75" fill={plateFill} />

      {/* outer trade lanes — the two parties, white */}
      <path d="M17 21 L26.5 45" stroke={laneStroke} strokeWidth="5.4" strokeLinecap="round" />
      <path d="M47 21 L37.5 45" stroke={laneStroke} strokeWidth="5.4" strokeLinecap="round" />

      {/* centre lane — the mediator, elevated apex, accent */}
      <path
        d="M26.5 45 L32 24 L37.5 45"
        stroke={accentStroke}
        strokeWidth="5.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* party terminals: open rings */}
      <circle cx="17" cy="21" r="3.2" fill="none" stroke={accentStroke} strokeWidth="2.4" />
      <circle cx="47" cy="21" r="3.2" fill="none" stroke={accentStroke} strokeWidth="2.4" />
    </svg>
  );
}

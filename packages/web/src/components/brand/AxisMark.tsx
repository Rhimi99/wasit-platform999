import { useId } from 'react';

/**
 * LE WASSIT symbol — "A · AXIS".
 *
 * The mediator is built into the geometry rather than added as decoration: two
 * wedges lean in from opposite sides and meet a single vertical axis that rises
 * above both. The axis is the only element spanning the full height and the only
 * one both wedges touch, so removing it disconnects the two parties. That is the
 * whole idea — a third party between two, and nothing else.
 *
 * The silhouette is deliberately not a letterform and not a globe: a tall bar
 * between two triangles. It was selected after rendering candidates at true
 * 16/24/32 px and discarding every one that collapsed into a blob at favicon
 * size, so the geometry below must not be redrawn casually — changing it means
 * re-running that legibility check.
 *
 * Geometry source of truth: the tested vector in /tmp/concepts/FA.svg. The
 * `transform` group applies the icon inset, so the paths stay byte-identical to
 * what was tested.
 */

export type MarkTone = 'brand' | 'inverse' | 'mono';

/** Palette anchors (packages/web/tailwind.config.js). */
const BLUE_500 = '#3b82f6';
const BLUE_600 = '#2563eb';
const BLUE_300 = '#93c5fd';
const INK_900 = '#081335';
const CANVAS = '#f8fafc';

interface AxisMarkProps {
  /** Rendered size in px — the mark is square. */
  size?: number;
  tone?: MarkTone;
  className?: string;
  /** Accessible name. Pass an empty string when the mark sits next to visible text. */
  title?: string;
}

export function AxisMark({ size = 40, tone = 'brand', className = '', title = 'LE WASSIT' }: AxisMarkProps) {
  // Gradient ids are global in the document, so two marks on one page would
  // otherwise share (and fight over) the first definition.
  const uid = useId().replace(/:/g, '');
  const gradId = `lw-axis-${uid}`;

  const mono = tone === 'mono';
  const inverse = tone === 'inverse';

  const plateFill = mono ? 'none' : `url(#${gradId})`;
  const wedgeFill = mono ? 'currentColor' : inverse ? INK_900 : '#ffffff';
  const axisFill = mono ? 'currentColor' : inverse ? BLUE_600 : BLUE_300;

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

      {/* Icon inset: the tested geometry occupies 3–61, scaled to sit inside the plate. */}
      <g transform="translate(32 32) scale(0.62) translate(-32 -32)">
        {/* the two parties */}
        <path d="M3 13 L25 32 L3 51 Z" fill={wedgeFill} />
        <path d="M61 13 L39 32 L61 51 Z" fill={wedgeFill} />
        {/* the mediator */}
        <rect x="26" y="3" width="12" height="58" rx="6" fill={axisFill} />
      </g>
    </svg>
  );
}

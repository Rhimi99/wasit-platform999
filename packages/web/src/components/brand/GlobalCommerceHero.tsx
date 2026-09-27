import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n-context';

/**
 * Landing hero visual: a dotted globe (orthographic projection) with animated
 * great-circle trade arcs linking market hubs. Pure SVG/CSS — no external
 * images — so it renders identically everywhere and stays light.
 *
 * Coordinates are data, not text, so RTL never mirrors or distorts the globe;
 * only the surrounding HTML labels follow the writing direction.
 */

const R = 168;
const CX = 240;
const CY = 232;

/** Orthographic projection. Returns null for points on the far hemisphere. */
function project(latDeg: number, lonDeg: number, spinDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = ((lonDeg + spinDeg) * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  const x = cosLat * Math.sin(lon);
  const y = Math.sin(lat);
  const z = cosLat * Math.cos(lon);
  if (z <= 0) return null;
  return { x: CX + R * x, y: CY - R * y, depth: z };
}

/** Trade hubs as [label, latitude, longitude]. */
const HUBS: Array<[string, number, number]> = [
  ['TUN', 36.8, 10.2],
  ['PAR', 48.9, 2.3],
  ['LON', 51.5, -0.1],
  ['NYC', 40.7, -74.0],
  ['DXB', 25.2, 55.3],
  ['SHA', 31.2, 121.5],
  ['SIN', 1.3, 103.8],
  ['BOM', 19.1, 72.9],
  ['CAI', 30.0, 31.2],
  ['DKR', 14.7, -17.5],
  ['SAO', -23.5, -46.6],
  ['SYD', -33.9, 151.2],
];

/** Hub pairs that carry a visible trade lane. */
const LANES: Array<[number, number]> = [
  [0, 1], [0, 4], [0, 9], [1, 3], [4, 5], [5, 6], [4, 7],
  [2, 3], [6, 11], [10, 0], [8, 4], [1, 8],
];

function GlobeDots() {
  const dots = useMemo(() => {
    const out: Array<{ x: number; y: number; o: number; r: number }> = [];
    // Denser near the horizon so the sphere reads as volumetric.
    for (let lat = -84; lat <= 84; lat += 6) {
      const step = 6 / Math.max(0.28, Math.cos((lat * Math.PI) / 180));
      for (let lon = -180; lon < 180; lon += step) {
        const p = project(lat, lon, -18);
        if (!p) continue;
        out.push({ x: p.x, y: p.y, o: 0.16 + 0.62 * p.depth, r: 1.05 + 0.75 * p.depth });
      }
    }
    return out;
  }, []);

  return (
    <g>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#8fa8f7" opacity={d.o} />
      ))}
    </g>
  );
}

function Arcs() {
  const arcs = useMemo(
    () =>
      LANES.map(([a, b]) => {
        const A = HUBS[a];
        const B = HUBS[b];
        const pa = project(A[1], A[2], -18);
        const pb = project(B[1], B[2], -18);
        if (!pa || !pb) return null;
        // Lift the control point off the chord centre for an orbital feel.
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.hypot(dx, dy) || 1;
        const lift = Math.min(120, len * 0.42);
        const cx = mx - (dy / len) * lift;
        const cy = my + (dx / len) * lift;
        const depth = Math.min(pa.depth, pb.depth);
        return { d: `M${pa.x.toFixed(1)},${pa.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${pb.x.toFixed(1)},${pb.y.toFixed(1)}`, depth };
      }).filter(Boolean) as Array<{ d: string; depth: number }>,
    [],
  );

  return (
    <g fill="none" strokeLinecap="round">
      {arcs.map((a, i) => (
        <g key={i}>
          <path d={a.d} stroke="#60a5fa" strokeOpacity={0.18 + 0.22 * a.depth} strokeWidth={1.1} />
          <path d={a.d} stroke="#7dd3fc" strokeOpacity={0.65 * a.depth} strokeWidth={1.5} strokeDasharray="3 22">
            <animate attributeName="stroke-dashoffset" values="0;-75" dur={`${4.4 + i * 0.35}s`} repeatCount="indefinite" />
          </path>
        </g>
      ))}
    </g>
  );
}

function HubMarkers() {
  const hubs = useMemo(
    () =>
      HUBS.map(([label, lat, lon]) => {
        const p = project(lat, lon, -18);
        return p ? { label, ...p } : null;
      }).filter(Boolean) as Array<{ label: string; x: number; y: number; depth: number }>,
    [],
  );

  return (
    <g>
      {hubs.map((h) => (
        <g key={h.label}>
          <circle cx={h.x} cy={h.y} r={11} fill="#38bdf8" opacity={0.14 * h.depth}>
            <animate attributeName="r" values="5;17" dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values={`${0.32 * h.depth};0`} dur="2.8s" repeatCount="indefinite" />
          </circle>
          <circle cx={h.x} cy={h.y} r={2.9} fill="#e0f2fe" opacity={0.5 + 0.5 * h.depth} />
        </g>
      ))}
    </g>
  );
}

export function GlobalCommerceHero({ className = '' }: { className?: string }) {
  const { t } = useI18n();

  const chips = [
    { key: 'lp.hero.chip.buyers', pos: 'start-[2%] top-[12%]' },
    { key: 'lp.hero.chip.suppliers', pos: 'end-[2%] top-[24%]' },
    { key: 'lp.hero.chip.companies', pos: 'start-[6%] bottom-[16%]' },
    { key: 'lp.hero.chip.markets', pos: 'end-[8%] bottom-[10%]' },
  ];

  return (
    <div className={`relative ${className}`}>
      {/* ambient wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(52% 52% at 62% 38%, rgba(61,89,214,0.30), transparent 68%), radial-gradient(42% 42% at 22% 78%, rgba(125,211,252,0.18), transparent 70%)',
        }}
      />

      <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-b from-ink-800/70 to-ink-950/80 p-5 shadow-glow backdrop-blur-sm sm:p-8">
        <div className="relative mx-auto max-w-[560px]">
          <svg viewBox="0 0 480 464" className="h-auto w-full" role="img" aria-label={t('lp.hero.visualAlt')} style={{ direction: 'ltr' }}>
            <defs>
              <radialGradient id="gch-atmo" cx="42%" cy="36%" r="62%">
                <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.30" />
                <stop offset="62%" stopColor="#3d59d6" stopOpacity="0.10" />
                <stop offset="100%" stopColor="#081335" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="gch-hub" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#e0e7ff" />
                <stop offset="100%" stopColor="#8fa8f7" />
              </linearGradient>
            </defs>

            {/* atmosphere + sphere */}
            <circle cx={CX} cy={CY} r={R + 46} fill="url(#gch-atmo)" />
            <circle cx={CX} cy={CY} r={R} fill="#0a1740" fillOpacity="0.55" stroke="#8fa8f7" strokeOpacity="0.28" strokeWidth="1" />
            <ellipse cx={CX} cy={CY} rx={R} ry={R * 0.34} stroke="#8fa8f7" strokeOpacity="0.16" strokeWidth="0.9" fill="none" />
            <ellipse cx={CX} cy={CY} rx={R} ry={R * 0.67} stroke="#8fa8f7" strokeOpacity="0.12" strokeWidth="0.9" fill="none" />
            <ellipse cx={CX} cy={CY} rx={R * 0.5} ry={R} stroke="#8fa8f7" strokeOpacity="0.12" strokeWidth="0.9" fill="none" />

            <GlobeDots />
            <Arcs />
            <HubMarkers />

            {/* LE WASSIT hub badge */}
            <g>
              <rect x={CX - 58} y={CY + R + 16} rx="14" width="116" height="34" fill="#0b1a45" stroke="#8fa8f7" strokeOpacity="0.35" />
              <text x={CX} y={CY + R + 38} textAnchor="middle" fontSize="13" fontWeight="800" fill="url(#gch-hub)" fontFamily="Inter, system-ui, sans-serif" letterSpacing="1.2">
                LE WASSIT
              </text>
            </g>
          </svg>

          {/* role chips — HTML so they follow the writing direction */}
          {chips.map((c) => (
            <span
              key={c.key}
              className={`absolute ${c.pos} hidden rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white shadow-soft backdrop-blur-sm sm:inline-flex`}
            >
              {t(c.key)}
            </span>
          ))}
        </div>

        <p className="mt-4 text-center text-[11px] font-medium tracking-wide text-ink-300/70">
          {t('lp.hero.visualNote')}
        </p>
      </div>
    </div>
  );
}

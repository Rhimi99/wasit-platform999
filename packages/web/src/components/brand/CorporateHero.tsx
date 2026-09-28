import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n-context';

/**
 * Landing hero visual: a dotted world map with a global trade network over a
 * modern city skyline reflected in water. Rendered entirely with SVG so there
 * is no external/stock imagery, no network request and no RTL mirroring.
 *
 * Stage is 1000x560: map dots in the upper band, skyline anchored on the
 * horizon line (y=430), water below it.
 */

const STAGE_W = 1000;
const STAGE_H = 560;
const HORIZON = 430;
const MAP_TOP = 26;
const MAP_BOTTOM = 330;

/** Coarse continent outlines in map space (equirectangular-ish, hand-tuned). */
const CONTINENTS: Array<Array<[number, number]>> = [
  // North America
  [
    [96, 96], [150, 74], [232, 68], [286, 84], [300, 118], [272, 152],
    [244, 186], [214, 214], [186, 232], [166, 198], [140, 162], [110, 128],
  ],
  // Greenland
  [[318, 40], [392, 46], [384, 92], [330, 88]],
  // South America
  [
    [246, 250], [300, 238], [322, 282], [312, 336], [286, 396], [258, 402],
    [238, 366], [230, 318], [236, 276],
  ],
  // Europe
  [[452, 88], [512, 78], [556, 96], [546, 130], [500, 148], [466, 132], [448, 110]],
  // Africa
  [
    [462, 168], [520, 158], [566, 186], [574, 236], [548, 296], [512, 330],
    [486, 300], [470, 252], [458, 208],
  ],
  // Asia
  [
    [560, 78], [648, 62], [742, 68], [838, 96], [866, 138], [820, 178],
    [742, 196], [672, 188], [612, 158], [568, 118],
  ],
  // India
  [[642, 196], [688, 190], [682, 234], [652, 228]],
  // South-East Asia
  [[742, 214], [798, 208], [812, 248], [762, 254]],
  // Australia
  [[800, 296], [878, 290], [892, 342], [834, 356], [798, 326]],
];

function inPolygon(x: number, y: number, poly: Array<[number, number]>) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Trade hubs plotted on the map — used for both the network and the arcs. */
const HUBS: Array<[number, number]> = [
  [176, 122], [262, 168], [278, 320], [492, 104], [508, 206],
  [628, 122], [700, 150], [774, 236], [846, 320], [368, 74],
];

const ARCS: Array<[number, number]> = [
  [0, 3], [0, 5], [3, 4], [3, 5], [1, 6], [5, 6], [4, 7], [6, 8], [5, 9], [2, 7],
];

/** Skyline: [x, width, height]; index 13 is the dominant tower. */
const TOWERS: Array<[number, number, number]> = [
  [28, 40, 118], [74, 30, 168], [110, 46, 132], [162, 36, 206],
  [204, 52, 150], [262, 40, 186], [308, 34, 128], [348, 56, 232],
  [410, 38, 164], [454, 48, 198], [508, 34, 142], [548, 52, 214],
  [606, 42, 172], [654, 62, 322], [722, 44, 196], [772, 36, 152],
  [814, 50, 176], [870, 38, 132], [914, 46, 158], [966, 34, 112],
];
const MAIN_TOWER = 13;

export function CorporateHero({ className = '' }: { className?: string }) {
  const { t } = useI18n();

  const mapDots = useMemo(() => {
    const dots: Array<[number, number]> = [];
    const step = 9;
    for (let y = MAP_TOP; y <= MAP_BOTTOM; y += step) {
      for (let x = 40; x <= 960; x += step) {
        for (const poly of CONTINENTS) {
          if (inPolygon(x, y, poly)) {
            dots.push([x, y]);
            break;
          }
        }
      }
    }
    return dots;
  }, []);

  return (
    <div className={className} style={{ direction: 'ltr' }}>
      <svg
        viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t('lp.hero.visualAlt')}
      >
        <defs>
          <linearGradient id="ch-sky" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#eff6ff" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#dbeafe" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="ch-towerA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="55%" stopColor="#5b7c99" />
            <stop offset="100%" stopColor="#1e3a8a" />
          </linearGradient>
          <linearGradient id="ch-towerB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bfdbfe" />
            <stop offset="60%" stopColor="#8ba2c0" />
            <stop offset="100%" stopColor="#233390" />
          </linearGradient>
          <linearGradient id="ch-towerMain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bfdbfe" />
            <stop offset="40%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#1e3a8a" />
          </linearGradient>
          <linearGradient id="ch-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#93c5fd" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#dbeafe" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ch-glass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="ch-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ch-reflectGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="ch-reflect">
            <rect x="0" y={HORIZON} width={STAGE_W} height={STAGE_H - HORIZON} fill="url(#ch-reflectGrad)" />
          </mask>
        </defs>

        {/* ambient wash */}
        <rect x="0" y="0" width={STAGE_W} height={STAGE_H} fill="url(#ch-sky)" />
        <circle cx="700" cy="200" r="300" fill="url(#ch-glow)" />

        {/* dotted world map — sits behind the city */}
        <g fill="#2563eb" opacity="0.42">
          {mapDots.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.5" />
          ))}
        </g>

        {/* global trade network */}
        <g fill="none" stroke="#2563eb" strokeLinecap="round">
          {ARCS.map(([a, b], i) => {
            const [x1, y1] = HUBS[a];
            const [x2, y2] = HUBS[b];
            const cx = (x1 + x2) / 2;
            const cy = Math.min(y1, y2) - Math.abs(x2 - x1) * 0.22 - 14;
            return (
              <path
                key={i}
                d={`M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`}
                strokeOpacity="0.3"
                strokeWidth="1.1"
                strokeDasharray={i % 3 === 0 ? '5 7' : undefined}
              >
                {i % 3 === 0 ? (
                  <animate attributeName="stroke-dashoffset" values="0;-24" dur="3.4s" repeatCount="indefinite" />
                ) : null}
              </path>
            );
          })}
        </g>
        <g>
          {HUBS.map(([x, y], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r="9" fill="#2563eb" opacity="0.14">
                <animate attributeName="r" values="4;15" dur="3.6s" begin={`${i * 0.35}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.3;0" dur="3.6s" begin={`${i * 0.35}s`} repeatCount="indefinite" />
              </circle>
              <circle cx={x} cy={y} r="3" fill="#1e3a8a" />
              <circle cx={x} cy={y} r="6.5" fill="none" stroke="#2563eb" strokeOpacity="0.35" strokeWidth="1" />
            </g>
          ))}
        </g>

        {/* skyline */}
        <g>
          {TOWERS.map(([x, w, h], i) => {
            const isMain = i === MAIN_TOWER;
            const fill = isMain ? 'url(#ch-towerMain)' : i % 2 === 0 ? 'url(#ch-towerA)' : 'url(#ch-towerB)';
            return (
              <g key={i}>
                <rect x={x} y={HORIZON - h} width={w} height={h} rx="3" fill={fill} />
                {isMain ? (
                  <>
                    <rect x={x + w / 2 - 2} y={HORIZON - h - 26} width="4" height="26" rx="2" fill="#1e3a8a" />
                    <circle cx={x + w / 2} cy={HORIZON - h - 28} r="4" fill="#2563eb">
                      <animate attributeName="opacity" values="1;0.35;1" dur="2.6s" repeatCount="indefinite" />
                    </circle>
                  </>
                ) : null}
                {/* window banding on the taller towers */}
                {h > 150
                  ? Array.from({ length: Math.floor(h / 30) }).map((_, r) => (
                      <rect
                        key={r}
                        x={x + w * 0.22}
                        y={HORIZON - h + 14 + r * 30}
                        width={w * 0.56}
                        height="2.5"
                        rx="1.25"
                        fill="#eff6ff"
                        opacity={isMain ? 0.5 : 0.72}
                      />
                    ))
                  : null}
              </g>
            );
          })}
        </g>

        {/* water + reflection */}
        <rect x="0" y={HORIZON} width={STAGE_W} height={STAGE_H - HORIZON} fill="url(#ch-water)" />
        <g mask="url(#ch-reflect)">
          <g transform={`translate(0 ${HORIZON * 2}) scale(1 -1)`} opacity="0.5">
            {TOWERS.map(([x, w, h], i) => (
              <rect
                key={i}
                x={x}
                y={HORIZON - h}
                width={w}
                height={h}
                rx="3"
                fill={i === MAIN_TOWER ? '#2563eb' : '#5b7c99'}
                opacity={i === MAIN_TOWER ? 0.55 : 0.4}
              />
            ))}
          </g>
        </g>
        <g stroke="#93c5fd" strokeOpacity="0.5" strokeWidth="1">
          {[456, 486, 520, 552].map((y, i) => (
            <line key={i} x1={i % 2 === 0 ? 40 : 220} y1={y} x2={i % 2 === 0 ? 780 : 960} y2={y} />
          ))}
        </g>
        <line x1="0" y1={HORIZON} x2={STAGE_W} y2={HORIZON} stroke="#bfdbfe" strokeWidth="1.4" />

        {/* glass sheen over the upper band */}
        <rect x="0" y="0" width={STAGE_W} height="180" fill="url(#ch-glass)" />
      </svg>
    </div>
  );
}

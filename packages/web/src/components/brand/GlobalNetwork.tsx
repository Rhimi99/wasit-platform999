// شبكة اقتصادية عالمية — رسم بياني SVG خفيف لتمثيل الاتصال بين الأسواق.
// رسم مجرد (غير جغرافي دقيق): عقد (مدن/أسواق) وخطوط ربط، بألوان الأزرق الرمادي.

const NODES: Array<{ x: number; y: number; r: number; label: string }> = [
  { x: 120, y: 70, r: 5, label: 'TUN' },
  { x: 300, y: 56, r: 6, label: 'PAR' },
  { x: 470, y: 84, r: 5, label: 'NYC' },
  { x: 610, y: 50, r: 6, label: 'DXB' },
  { x: 700, y: 110, r: 5, label: 'SHA' },
  { x: 260, y: 160, r: 4, label: 'DKR' },
  { x: 540, y: 170, r: 4, label: 'MOW' },
  { x: 640, y: 200, r: 4, label: 'BOM' },
  { x: 390, y: 210, r: 5, label: 'CAI' },
  { x: 500, y: 250, r: 4, label: 'JKT' },
  { x: 700, y: 260, r: 4, label: 'SIN' },
  { x: 160, y: 240, r: 4, label: 'SAO' },
];

const LINKS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [1, 8], [2, 8], [3, 6],
  [6, 4], [8, 9], [9, 10], [8, 11], [0, 8], [5, 11], [3, 9], [6, 8],
];

export function GlobalNetwork({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 800 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Global trade network"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="gn-globe" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.16" />
          <stop offset="50%" stopColor="#818cf8" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.04" />
        </linearGradient>
        <radialGradient id="gn-pulse" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#64748b" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#64748b" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* كرة أرضية مجردة */}
      <ellipse cx="400" cy="160" rx="290" ry="140" fill="url(#gn-globe)" />
      <ellipse cx="400" cy="160" rx="290" ry="140" stroke="#94a3b8" strokeOpacity="0.35" strokeWidth="1.2" />
      <ellipse cx="400" cy="160" rx="210" ry="98" stroke="#94a3b8" strokeOpacity="0.18" strokeWidth="0.8" strokeDasharray="4 6" />
      <ellipse cx="400" cy="160" rx="120" ry="54" stroke="#94a3b8" strokeOpacity="0.14" strokeWidth="0.8" strokeDasharray="3 7" />

      {/* خطوط ربط */}
      {LINKS.map(([a, b], i) => (
        <line
          key={i}
          x1={NODES[a].x} y1={NODES[a].y}
          x2={NODES[b].x} y2={NODES[b].y}
          stroke="#64748b"
          strokeOpacity="0.4"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      ))}

      {/* نبض على الخطوط */}
      {[0, 2, 6, 8, 10].map((i) => (
        <circle key={`p${i}`} cx={NODES[i].x} cy={NODES[i].y} r="16" fill="url(#gn-pulse)">
          <animate attributeName="r" values="8;22" dur="2.6s" repeatCount="indefinite" />
        </circle>
      ))}

      {/* العقد */}
      {NODES.map((n, i) => (
        <g key={`n${i}`}>
          <circle cx={n.x} cy={n.y} r={n.r + 3} fill="#475569" opacity="0.14" />
          <circle cx={n.x} cy={n.y} r={n.r} fill="#334155" stroke="#e2e8f0" strokeWidth="1" />
          <text x={n.x} y={n.y - n.r - 5} textAnchor="middle" fontSize="9" fontWeight="600" fill="#64748b" fontFamily="system-ui, sans-serif">
            {n.label}
          </text>
        </g>
      ))}

      {/* كبسولة قيمة */}
      <g>
        <rect x="532" y="120" rx="12" width="168" height="34" fill="rgba(255,255,255,0.92)" stroke="#cbd5e1" />
        <text x="616" y="142" textAnchor="middle" fontSize="12" fontWeight="700" fill="#1e293b" fontFamily="system-ui, sans-serif">
          LE WASSIT
        </text>
      </g>
      <g>
        <rect x="110" y="92" rx="12" width="150" height="30" fill="rgba(255,255,255,0.92)" stroke="#cbd5e1" />
        <text x="185" y="111" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#475569" fontFamily="system-ui, sans-serif">
          B2B + B2C
        </text>
      </g>
    </svg>
  );
}
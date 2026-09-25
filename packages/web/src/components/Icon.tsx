/**
 * Minimal line-icon set for the landing experience. Inline SVG (currentColor,
 * 1.6px strokes) so there are no icon-font or image requests and the icons
 * inherit colour and scale in both LTR and RTL.
 */
type IconName =
  | 'globe'
  | 'sparkles'
  | 'buildings'
  | 'shield'
  | 'tag'
  | 'megaphone'
  | 'chart'
  | 'search'
  | 'headset'
  | 'check'
  | 'user'
  | 'cart'
  | 'route'
  | 'verified'
  | 'scale'
  | 'alert'
  | 'clipboard'
  | 'lock'
  | 'arrow';

const PATHS: Record<IconName, string> = {
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9m0-18C9.5 5.6 8.2 8.7 8.2 12s1.3 6.4 3.8 9M3.5 9h17M3.5 15h17',
  sparkles: 'M12 3.5 13.6 9l5.5 1.6-5.5 1.6L12 17.8l-1.6-5.6L4.9 10.6 10.4 9 12 3.5ZM18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z',
  buildings: 'M4 21V6l7-3v18M11 21h9V10l-9-4M7 8.5h.01M7 12h.01M7 15.5h.01M15 12h.01M15 15.5h.01M15 19h.01',
  shield: 'M12 3 5 6v6c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6l-7-3Zm-2.5 9L11 13.5l4-4.5',
  tag: 'M3.5 12.5 11 5h6.5v6.5L10 19l-6.5-6.5ZM15 9h.01',
  megaphone: 'M4 10v4a1.5 1.5 0 0 0 1.5 1.5H7l7 4V4.5l-7 4H5.5A1.5 1.5 0 0 0 4 10Zm14-1.5a5 5 0 0 1 0 7',
  chart: 'M4 20h16M7 20v-6M12 20V6M17 20v-9',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4',
  headset: 'M5 13v-1a7 7 0 0 1 14 0v1M5 13h1.5a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 6.5 19H6a1 1 0 0 1-1-1v-5Zm14 0h-1.5a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H18a1 1 0 0 0 1-1v-5Z',
  check: 'M5 12.5 10 17.5 19 7',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-7 16a7 7 0 0 1 14 0',
  cart: 'M4 5h2l2 10h10l2-7H7M9 20h.01M17 20h.01',
  route: 'M6 4v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v4M6 4 4.5 6M6 4l1.5 2M18 16l1.5 2M18 16l-1.5 2',
  verified: 'm12 3 2.2 1.6 2.7-.2 1 2.5 2.3 1.4-.8 2.6.8 2.6-2.3 1.4-1 2.5-2.7-.2L12 21l-2.2-1.6-2.7.2-1-2.5L3.8 15.7l.8-2.6-.8-2.6 2.3-1.4 1-2.5 2.7.2L12 3Zm-2.5 9L11 13.5l4-4.5',
  scale: 'M12 4v16M7 20h10M6 8h12M6 8 3.5 14h5L6 8Zm12 0-2.5 6h5L18 8Z',
  alert: 'M12 4 3 19h18L12 4Zm0 5v5m0 3h.01',
  clipboard: 'M9 4h6v3H9V4Zm-2 0H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1M9 12h6M9 16h4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13v-9Zm7 4v2',
  arrow: 'M5 12h13m0 0-5-5m5 5-5 5',
};

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export type { IconName };

/**
 * Rasterized brand assets for the "A - AXIS" symbol.
 *
 * Geometry source of truth: the tested vector mirrored in
 * packages/web/src/components/brand/AxisMark.tsx. If that geometry changes,
 * regenerate these files so the tab/PWA icon does not drift from the in-page mark.
 *
 * Run from anywhere: `node scripts/generate-brand-assets.mjs`. Paths below are
 * derived from this file's location, so the repo can be moved or cloned
 * elsewhere without edits. Needs a Chromium binary — see resolveChromium().
 *
 * Produces, for browser / PWA / launcher / print:
 *   le-wassit-icon.svg        full-colour Icon Mark (plate + symbol)
 *   le-wassit-icon-mono.svg   single-ink version for stamps and 1-colour print
 *   le-wassit-icon-light.svg  for light backgrounds
 *   le-wassit-icon-dark.svg   for dark backgrounds (knockout)
 *   favicon.svg / favicon-16.png / favicon-24.png / favicon-32.png
 *   apple-touch-icon.png (180), icon-192.png, icon-512.png
 *   icon-maskable-512.png (safe-zone padded for Android adaptive icons)
 *
 * The SVG sources are written as text so the vectors stay diffable.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'packages/web/public');

const BLUE_500 = '#3b82f6';
const BLUE_600 = '#2563eb';
const BLUE_300 = '#93c5fd';
const INK_900 = '#081335';
const CANVAS = '#f8fafc';

/**
 * The symbol itself, occupying 3-61 of the 64-unit box. Kept as a string so the
 * on-screen component and every generated asset share one description.
 */
const axisGeometry = (wedge, axis) => `
      <path d="M3 13 L25 32 L3 51 Z" fill="${wedge}"/>
      <path d="M61 13 L39 32 L61 51 Z" fill="${wedge}"/>
      <rect x="26" y="3" width="12" height="58" rx="6" fill="${axis}"/>`;

const inset = (inner, scale = 0.62) =>
  `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${inner}</g>`;

const plateGradient = (id, from, to) => `
    <linearGradient id="${id}" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>`;

/**
 * Full-colour Icon Mark: navy plate, white wedges, accent axis - the same
 * construction the on-screen mark uses.
 */
function iconSvg({ size = 64, scale = 0.62 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" role="img" aria-label="LE WASSIT">
  <defs>${plateGradient('lw-axis', BLUE_500, INK_900)}</defs>
  <rect x="3" y="3" width="58" height="58" rx="15.75" fill="url(#lw-axis)"/>
${inset(axisGeometry('#ffffff', BLUE_300), scale)}
</svg>
`;
}

/** Single-ink mark for stamps, faxes and one-colour print. */
function iconSvgMono({ color = INK_900, scale = 0.62 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none" role="img" aria-label="LE WASSIT">
${inset(axisGeometry(color, color), scale)}
</svg>
`;
}

/** For dark surfaces: the mark knocked out of a light plate. */
function iconSvgDark({ scale = 0.62 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none" role="img" aria-label="LE WASSIT">
  <defs>${plateGradient('lw-axis-dark', CANVAS, '#e2e8f0')}</defs>
  <rect x="3" y="3" width="58" height="58" rx="15.75" fill="url(#lw-axis-dark)"/>
${inset(axisGeometry(INK_900, BLUE_600), scale)}
</svg>
`;
}

/**
 * Android adaptive icons crop to a safe zone, so the mark is inset further and
 * the plate runs to the edges - otherwise the launcher shaves off the wedges.
 */
function iconSvgMaskable() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" fill="none" role="img" aria-label="LE WASSIT">
  <defs>${plateGradient('lw-axis-mask', BLUE_500, INK_900)}</defs>
  <rect x="0" y="0" width="64" height="64" fill="url(#lw-axis-mask)"/>
${inset(axisGeometry('#ffffff', BLUE_300), 0.46)}
</svg>
`;
}

/**
 * Picks a Chromium binary without hard-coding one machine's path.
 *
 * Playwright's own download is preferred; when it is absent (browsers never
 * installed, or `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`) we fall back to a system
 * browser so the script still runs on CI images that ship Chromium but not
 * Playwright's copy. `CHROMIUM_EXECUTABLE_PATH` wins if set.
 */
function resolveChromium() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH) return process.env.CHROMIUM_EXECUTABLE_PATH;

  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Playwright throws when the browser was never downloaded.
  }

  const candidates = [
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  return candidates.find((p) => fs.existsSync(p));
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'le-wassit-icon.svg'), iconSvg({ size: 64 }));
fs.writeFileSync(path.join(OUT, 'le-wassit-icon-mono.svg'), iconSvgMono());
fs.writeFileSync(path.join(OUT, 'le-wassit-icon-light.svg'), iconSvg({ size: 64 }));
fs.writeFileSync(path.join(OUT, 'le-wassit-icon-dark.svg'), iconSvgDark());
fs.writeFileSync(path.join(OUT, 'favicon.svg'), iconSvg({ size: 64 }));

const executablePath = resolveChromium();
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();

/** Renders an SVG at `px` and writes the PNG bytes to `file`. */
async function png(svg, px, file) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<body style="margin:0"><div style="width:${px}px;height:${px}px">${svg.replace(
      /width="\d+" height="\d+"/,
      `width="${px}" height="${px}"`,
    )}</div></body>`,
  );
  const el = await page.$('svg');
  await el.screenshot({ path: path.join(OUT, file), omitBackground: true });
}

const icon = iconSvg();
await png(icon, 180, 'apple-touch-icon.png');
await png(icon, 192, 'icon-192.png');
await png(icon, 512, 'icon-512.png');
await png(iconSvgMaskable(), 512, 'icon-maskable-512.png');
await png(iconSvgMono(), 512, 'icon-512-mono.png');
await png(icon, 32, 'favicon-32.png');
await png(icon, 24, 'favicon-24.png');
await png(icon, 16, 'favicon-16.png');

await browser.close();
console.log('wrote brand assets to', OUT);

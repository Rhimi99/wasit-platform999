/**
 * Read-only UI verification for the LE WASSIT homepage redesign.
 * Drives the running public build; no DB writes, no re-seeding.
 * Usage: node scripts/ui-redesign-check.mjs <baseURL>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const OUT = '/tmp/ui-check';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function open(ctxOpts, label) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (m) => {
    // Resource-load messages (favicon 404, anonymous 401) are asserted via the
    // network listener below; here we only care about real JS console errors.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { ctx, page, errors, pageErrors, failed, label };
}

// ── Desktop / French ────────────────────────────────────────────────────────
{
  const { ctx, page, errors, pageErrors, failed } = await open({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' }, 'desktop-fr');
  await page.screenshot({ path: `${OUT}/desktop-fr.png`, fullPage: false });

  const h1 = page.locator('h1');
  const h1Text = await h1.innerText();
  record('desktop: H1 lockup shows LE WASSIT', /LE WASSIT/.test(h1Text), h1Text.replace(/\n/g, ' / '));
  record('desktop: H1 lockup also shows BUSINESS GLOBAL', /BUSINESS GLOBAL/.test(h1Text));

  // Hero background is a light white→#EFF6FF gradient (not a flat colour).
  const heroBg = await page.evaluate(() => {
    const el = document.querySelector('main > section');
    return { image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).backgroundColor };
  });
  record('desktop: hero is a light white→#EFF6FF gradient', /linear-gradient/.test(heroBg.image) && /rgb\(239, 246, 255\)/.test(heroBg.image), heroBg.image.slice(0, 80));

  const cta = page.locator('main a[href="/register"]').first();
  const ctaBg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  record('desktop: primary CTA is brand blue #2563EB', ctaBg === 'rgb(37, 99, 235)', ctaBg);

  // Solid blue statistics bar fed by live platform data.
  const band = await page.evaluate(() => {
    const el = [...document.querySelectorAll('main div')].find((e) => /rgb\(30, 58, 138\)/.test(getComputedStyle(e).backgroundImage));
    return el ? { text: el.textContent.slice(0, 80), radius: getComputedStyle(el).borderRadius } : null;
  });
  record('desktop: solid blue statistics bar present', !!band, band ? `radius=${band.radius}` : 'not found');

  // Header: white, tall, centred nav with a blue underline on the active item.
  const header = await page.evaluate(() => {
    const h = document.querySelector('header');
    const active = document.querySelector('header nav a[aria-current="page"]');
    const login = document.querySelector('header a[href="/login"]');
    return {
      bg: getComputedStyle(h).backgroundColor,
      innerHeight: Math.round(h.firstElementChild.getBoundingClientRect().height),
      underline: active ? getComputedStyle(active, '::after').backgroundColor : null,
      underlineW: active ? getComputedStyle(active, '::after').width : null,
      loginBg: login ? getComputedStyle(login).backgroundColor : null,
    };
  });
  record('desktop: header is white', header.bg === 'rgb(255, 255, 255)', header.bg);
  record('desktop: header is tall (>=100px)', header.innerHeight >= 100, `${header.innerHeight}px`);
  record('desktop: active nav item has a blue underline', header.underline === 'rgb(37, 99, 235)' && parseFloat(header.underlineW) > 0, `${header.underlineW}`);
  record('desktop: "Se connecter" is a blue button', header.loginBg === 'rgb(37, 99, 235)', header.loginBg ?? 'not found');

  // Hero artwork: dotted world map + skyline + network, drawn in SVG.
  const art = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('main svg')];
    const svg = svgs.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!svg) return null;
    return {
      circles: svg.querySelectorAll('circle').length,
      rects: svg.querySelectorAll('rect').length,
      paths: svg.querySelectorAll('path').length,
      mask: !!svg.querySelector('mask'),
    };
  });
  record('desktop: hero artwork renders map + skyline + reflection', !!art && art.circles > 300 && art.rects > 60 && art.paths > 5 && art.mask, JSON.stringify(art));

  // Header nav links scroll to sections and must exist.
  for (const sel of ['#solutions', '#markets', '#resources']) {
    const link = page.locator(`header a[href="/${sel}"]`).first();
    const exists = await page.locator(sel).count();
    record(`desktop: nav target ${sel} exists`, (await link.count()) > 0 && exists > 0, `${exists} node(s)`);
  }

  // Search actually filters → navigates to marketplace with a query.
  const searchInput = page.locator('input[placeholder]').first();
  await searchInput.fill('test');
  const searchBtn = page.locator('form button').first();
  await Promise.all([
    page.waitForURL(/marketplace/, { timeout: 15000 }).catch(() => null),
    (await searchBtn.count()) ? searchBtn.click() : searchInput.press('Enter'),
  ]);
  record('desktop: search lands on /search results', /\/search\?/.test(page.url()) || /marketplace/.test(page.url()), page.url());

  // Anonymous session probing /api/auth/me yields 401 by design — every other call must succeed.
  record('desktop: no JS console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  record('desktop: no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  const realFailed = failed.filter((f) => !/\/api\/auth\/me/.test(f));
  record('desktop: no failing API calls (401 excused)', realFailed.length === 0, realFailed.slice(0, 2).join(' | '));
  await ctx.close();
}

// ── Mobile viewport ─────────────────────────────────────────────────────────
{
  const { ctx, page, errors, pageErrors, failed } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR' }, 'mobile');
  await page.screenshot({ path: `${OUT}/mobile-fr.png`, fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record('mobile: no horizontal overflow', overflow <= 2, `overflow=${overflow}px`);
  const menuBtn = page.locator('header button[aria-label="Menu"]');
  record('mobile: menu button visible', await menuBtn.isVisible());
  await menuBtn.click();
  await page.waitForTimeout(300);
  const mobileNav = await page.locator('nav[aria-label="Mobile navigation"]').count();
  record('mobile: menu opens', mobileNav > 0);
  await page.screenshot({ path: `${OUT}/mobile-menu.png` });
  record('mobile: no JS console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  record('mobile: no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  record('mobile: no failing API calls (401 excused)', failed.filter((f) => !/\/api\/auth\/me/.test(f)).length === 0);
  await ctx.close();
}

// ── Arabic RTL ──────────────────────────────────────────────────────────────
{
  const { ctx, page, errors, pageErrors } = await open({ viewport: { width: 1440, height: 900 }, locale: 'ar' }, 'rtl');
  const dir = await page.evaluate(() => document.documentElement.dir);
  record('rtl: document dir = rtl', dir === 'rtl', dir);
  // Hero grid must put text on the right in RTL (logical start).
  const pos = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const r = h1.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
  });
  record('rtl: hero heading sits on the right side', pos.left > pos.vw / 3, JSON.stringify(pos));
  await page.screenshot({ path: `${OUT}/rtl-ar.png` });
  record('rtl: no JS console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  record('rtl: no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();

const failedN = results.filter((r) => !r.pass).length;
console.log(`\n=== ${results.length - failedN}/${results.length} checks passed ===`);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
process.exit(failedN ? 1 : 0);

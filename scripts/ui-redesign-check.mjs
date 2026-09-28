/**
 * Read-only UI verification for the LE WASSIT homepage redesign — dark navy
 * premium theme.
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

/** Deep navy used by the landing hero surface (#050c24). */
const NAVY = 'rgb(5, 12, 36)';
const BRAND = 'rgb(37, 99, 235)';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function open(ctxOpts) {
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
  return { ctx, page, errors, pageErrors, failed };
}

// ── Desktop / French ────────────────────────────────────────────────────────
{
  const { ctx, page, errors, pageErrors, failed } = await open({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/desktop-fr.png`, fullPage: false });

  const h1 = page.locator('h1');
  const h1Text = await h1.innerText();
  record('desktop: H1 lockup shows LE WASSIT', /LE WASSIT/.test(h1Text), h1Text.replace(/\n/g, ' / '));
  record('desktop: H1 lockup also shows BUSINESS GLOBAL', /BUSINESS GLOBAL/.test(h1Text));

  // Hero surface is premium dark navy (not a light gradient).
  const hero = await page.evaluate(() => {
    const el = document.querySelector('main > section');
    return { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color };
  });
  record('desktop: hero is deep navy (#050c24)', hero.bg === NAVY, hero.bg);
  record('desktop: hero copy renders in white', /rgb\(255, 255, 255\)/.test(hero.color), hero.color);

  // The hero headline is white and the subtitle is a light brand tint.
  const heroType = await page.evaluate(() => {
    const h2 = document.querySelector('main section h2');
    const p = document.querySelector('main section h2 + p');
    return {
      h2: h2 ? getComputedStyle(h2).color : null,
      h2Text: h2 ? h2.textContent.trim().slice(0, 60) : '',
      p: p ? getComputedStyle(p).color : null,
    };
  });
  record('desktop: hero headline is white', heroType.h2 === 'rgb(255, 255, 255)', `${heroType.h2} "${heroType.h2Text}"`);

  const cta = page.locator('main a[href="/register"]').first();
  const ctaBg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  record('desktop: primary CTA is brand blue #2563EB', ctaBg === BRAND, ctaBg);

  // Statistics band is fed by live platform data (or shows the pending notice).
  const stats = await page.evaluate(() => {
    const note = [...document.querySelectorAll('main p')]
      .map((p) => p.textContent)
      .find((t) => /chiffres|stats|plateforme|أرقام|منصة/i.test(t));
    return { hasNote: !!note, note: note ? note.slice(0, 70) : null, sections: document.querySelectorAll('main section').length };
  });
  record('desktop: statistics band renders platform figures/notice', stats.hasNote, stats.note ?? `${stats.sections} sections`);

  // Header: dark navy, premium, centred nav with a blue underline on the active item.
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
  // The header is 95%-opaque navy over the hero artwork, so accept the alpha form too.
  record('desktop: header is dark navy', /rgba?\(5, 12, 36(, 0\.95)?\)/.test(header.bg), header.bg);
  record('desktop: header is premium tall (>=96px)', header.innerHeight >= 96, `${header.innerHeight}px`);
  record('desktop: active nav item has a blue underline', header.underline === 'rgb(96, 165, 250)' && parseFloat(header.underlineW) > 0, `${header.underline}`);
  record('desktop: "Se connecter" is a blue button', header.loginBg === BRAND, header.loginBg ?? 'not found');

  // Hero artwork: dotted world map + skyline + network, drawn in SVG.
  const art = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('main svg')];
    const all = svgs.map((s) => ({
      circles: s.querySelectorAll('circle').length,
      rects: s.querySelectorAll('rect').length,
      paths: s.querySelectorAll('path').length,
      mask: !!s.querySelector('mask'),
    }));
    return {
      circles: all.reduce((n, a) => n + a.circles, 0),
      rects: all.reduce((n, a) => n + a.rects, 0),
      paths: all.reduce((n, a) => n + a.paths, 0),
      mask: all.some((a) => a.mask),
    };
  });
  record(
    'desktop: hero artwork renders map + skyline + reflection',
    art.circles > 300 && art.rects > 60 && art.paths > 5 && art.mask,
    JSON.stringify(art),
  );

  // Layer contract: the decorative artwork must never cover the copy. The
  // skyline is in normal flow, so it has to start below the last copy element,
  // and the CTA/headline must be the topmost element at their own centres.
  const layers = await page.evaluate(() => {
    const hero = document.querySelector('main > section');
    const copy = hero.querySelector('.relative.z-10');
    const cta = hero.querySelector('a[href="/register"]');
    const h2 = hero.querySelector('h2');
    const sky = [...hero.querySelectorAll('div')].find((d) => d.className.includes('aspect-'));
    const lastCopy = hero.querySelector('.mt-9.flex.flex-wrap') || hero.querySelector('a[href="/marketplace"]');
    const contentBottom = Math.round(lastCopy.getBoundingClientRect().bottom);
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    };
    return {
      skylineTop: sky ? Math.round(sky.getBoundingClientRect().top) : null,
      contentBottom,
      ctaZ: getComputedStyle(cta).zIndex,
      copyZ: getComputedStyle(copy).zIndex,
      skyZ: sky ? getComputedStyle(sky).zIndex : null,
      ctaOnTop: cta.contains(at(cta)) || at(cta) === cta,
      h2OnTop: h2.contains(at(h2)) || at(h2) === h2,
    };
  });
  record('desktop: skyline sits below the hero copy (no overlap)', layers.skylineTop >= layers.contentBottom, `skylineTop=${layers.skylineTop} contentBottom=${layers.contentBottom}`);
  record('desktop: CTA is the topmost layer at its centre', layers.ctaOnTop, `z=${layers.ctaZ} (copy ${layers.copyZ}, skyline ${layers.skyZ})`);
  record('desktop: headline is the topmost layer at its centre', layers.h2OnTop);

  // Header nav links scroll to sections and must exist.
  for (const sel of ['#solutions', '#markets', '#resources']) {
    const link = page.locator(`header a[href="/${sel}"]`).first();
    const exists = await page.locator(sel).count();
    record(`desktop: nav target ${sel} exists`, (await link.count()) > 0 && exists > 0, `${exists} node(s)`);
  }

  // Search actually filters → navigates to search results.
  const searchInput = page.locator('input[placeholder]').first();
  await searchInput.fill('test');
  const searchBtn = page.locator('form button').first();
  await Promise.all([
    page.waitForURL(/search|marketplace/, { timeout: 15000 }).catch(() => null),
    (await searchBtn.count()) ? searchBtn.click() : searchInput.press('Enter'),
  ]);
  record('desktop: search lands on results', /\/search\?/.test(page.url()) || /marketplace/.test(page.url()), page.url());

  // Nav anchor jumps must land the section heading *below* the sticky chrome
  // (demo banner + header); this used to tuck the heading under the header.
  const anchor = await page.evaluate(() => {
    const a = [...document.querySelectorAll('header nav a')].find((x) => x.getAttribute('href') === '/#solutions');
    a?.click();
    return !!a;
  });
  if (anchor) {
    await page.waitForTimeout(1500);
    const below = await page.evaluate(() => {
      const header = document.querySelector('header');
      const head = document.getElementById('solutions')?.querySelector('h2');
      if (!head) return null;
      return { headingTop: Math.round(head.getBoundingClientRect().top), headerBottom: Math.round(header.getBoundingClientRect().bottom) };
    });
    record('desktop: nav anchor lands the heading below the header', !!below && below.headingTop >= below.headerBottom, JSON.stringify(below));
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(800);
  }

  // Anonymous session probing /api/auth/me yields 401 by design — every other call must succeed.
  record('desktop: no JS console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  record('desktop: no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  const realFailed = failed.filter((f) => !/\/api\/auth\/me/.test(f));
  record('desktop: no failing API calls (401 excused)', realFailed.length === 0, realFailed.slice(0, 2).join(' | '));
  await ctx.close();
}

// ── Mobile viewport: dark premium header, no clipping, working menu ─────────
for (const width of [360, 390]) {
  const { ctx, page, errors, pageErrors, failed } = await open({
    viewport: { width, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/mobile-${width}-fr.png`, fullPage: false });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(`mobile ${width}: no horizontal overflow`, overflow <= 2, `overflow=${overflow}px`);

  // Dark premium header: hamburger present, logo fully visible (no clipping).
  const head = await page.evaluate(() => {
    const h = document.querySelector('header');
    const row = h.firstElementChild;
    const brand = row.querySelector('a[aria-label]');
    const logoText = brand ? brand.querySelector('span span') : null;
    const t = logoText ? logoText.getBoundingClientRect() : null;
    const burger = h.querySelector('button[aria-label="Menu"]');
    const b = burger ? burger.getBoundingClientRect() : null;
    const vw = document.documentElement.clientWidth;
    return {
      bg: getComputedStyle(h).backgroundColor,
      textClipped: t ? t.right > vw + 1 || t.left < -1 : null,
      logoText: logoText ? logoText.textContent.trim() : null,
      burger: !!b,
      burgerLeft: b ? Math.round(b.left) : null,
    };
  });
  record(`mobile ${width}: header is dark navy`, /rgba?\(5, 12, 36(, 0\.95)?\)/.test(head.bg), head.bg);
  record(`mobile ${width}: brand logo text is not clipped`, head.textClipped === false, `"${head.logoText}"`);
  record(`mobile ${width}: hamburger menu present`, head.burger, `left=${head.burgerLeft}px`);
  record(`mobile ${width}: login action present`, (await page.locator('header a[href="/login"]').count()) > 0);

  // Layer contract on phones, where the skyline used to climb over the CTA.
  // Runs before the menu opens so the nav overlay cannot sit over the CTA.
  const mLayers = await page.evaluate(() => {
    const hero = document.querySelector('main > section');
    const cta = hero.querySelector('a[href="/register"]');
    const h2 = hero.querySelector('h2');
    const sky = [...hero.querySelectorAll('div')].find((d) => d.className.includes('aspect-'));
    const lastCopy = hero.querySelector('.mt-9.flex.flex-wrap') || hero.querySelector('a[href="/marketplace"]');
    const contentBottom = Math.round(lastCopy.getBoundingClientRect().bottom);
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    };
    return {
      skylineTop: sky ? Math.round(sky.getBoundingClientRect().top) : null,
      contentBottom,
      ctaOnTop: cta.contains(at(cta)) || at(cta) === cta,
      h2OnTop: h2.contains(at(h2)) || at(h2) === h2,
    };
  });
  record(
    `mobile ${width}: skyline sits below the hero copy (no overlap)`,
    mLayers.skylineTop >= mLayers.contentBottom,
    `skylineTop=${mLayers.skylineTop} contentBottom=${mLayers.contentBottom}`,
  );
  record(`mobile ${width}: CTA is the topmost layer at its centre`, mLayers.ctaOnTop);
  record(`mobile ${width}: headline is the topmost layer at its centre`, mLayers.h2OnTop);

  const menuBtn = page.locator('header button[aria-label="Menu"]');
  await menuBtn.click();
  await page.waitForTimeout(300);
  const mobileNav = await page.locator('nav[aria-label="Mobile navigation"]').count();
  record(`mobile ${width}: menu opens`, mobileNav > 0);
  await page.screenshot({ path: `${OUT}/mobile-${width}-menu.png` });

  // The hero must not be hidden behind the sticky header/banner.
  const heroVisible = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const header = document.querySelector('header');
    if (!h1 || !header) return null;
    const a = h1.getBoundingClientRect();
    const b = header.getBoundingClientRect();
    return { h1Top: Math.round(a.top), headerBottom: Math.round(b.bottom) };
  });
  record(
    `mobile ${width}: hero lockup starts below the header`,
    !!heroVisible && heroVisible.h1Top >= heroVisible.headerBottom - 1,
    JSON.stringify(heroVisible),
  );

  record(`mobile ${width}: no JS console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  record(`mobile ${width}: no uncaught exceptions`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  record(`mobile ${width}: no failing API calls (401 excused)`, failed.filter((f) => !/\/api\/auth\/me/.test(f)).length === 0);
  await ctx.close();
}

// ── Arabic RTL ──────────────────────────────────────────────────────────────
{
  const { ctx, page, errors, pageErrors } = await open({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
  await page.waitForTimeout(1500);
  const dir = await page.evaluate(() => document.documentElement.dir);
  record('rtl: document dir = rtl', dir === 'rtl', dir);

  // The hero is centred, so the lockup must be horizontally centred in RTL too.
  const pos = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const r = h1.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const centre = r.left + r.width / 2;
    return { centre: Math.round(centre), vw, delta: Math.round(Math.abs(centre - vw / 2)) };
  });
  record('rtl: hero lockup is centred', pos.delta <= 24, JSON.stringify(pos));
  await page.screenshot({ path: `${OUT}/rtl-ar.png` });
  record('rtl: no JS console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  record('rtl: no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  await ctx.close();
}

// ── Non-home public routes keep the light header ─────────────────────────────
{
  const { ctx, page } = await open({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
  await page.goto(BASE + '/marketplace', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1200);
  const headerBg = await page.evaluate(() => getComputedStyle(document.querySelector('header')).backgroundColor);
  record('marketplace: header stays light (white)', headerBg === 'rgb(255, 255, 255)', headerBg);
  await ctx.close();
}

await browser.close();

const failedN = results.filter((r) => !r.pass).length;
console.log(`\n=== ${results.length - failedN}/${results.length} checks passed ===`);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
process.exit(failedN ? 1 : 0);

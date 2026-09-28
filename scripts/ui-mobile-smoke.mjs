/**
 * Mobile functional smoke test — the flows a user can actually exercise from a
 * phone. Drives the real public UI at a phone viewport (390x844, touch), not
 * just the API, and asserts that a visible result reaches the user.
 *
 * Usage: node scripts/ui-mobile-smoke.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function phone() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  const apiErrors = [];
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) apiErrors.push(`${r.status()} ${r.url()}`); });
  return { ctx, page, apiErrors };
}

// ── Browse → product detail (anonymous) ─────────────────────────────────────
{
  const { ctx, page } = await phone();
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  const cards = page.locator('a[href^="/products/"]');
  const n = await cards.count();
  check('mobile: marketplace lists real products', n > 0, `${n} product link(s)`);

  if (n > 0) {
    const href = await cards.first().getAttribute('href');
    await cards.first().click();
    await page.waitForURL(/\/products\//, { timeout: 20000 });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    check('mobile: product detail opens from the card', /\/products\//.test(page.url()), page.url().replace(BASE, ''));
    check('mobile: product detail shows price/content', body.length > 300 && /\d/.test(body), `${body.length} chars`);
    check('mobile: product detail has an order/contact action', /اطلب|أضف|طلب|contact|commander|order|تواصل/i.test(body));
    void href;
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile: product detail has no horizontal overflow', overflow <= 2, `overflow=${overflow}px`);
  await page.screenshot({ path: '/tmp/mobile-product-detail.png' });
  await ctx.close();
}

// ── Customer: login → dashboard → orders → notifications ────────────────────
{
  const { ctx, page, apiErrors } = await phone();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'customer1@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });
  check('mobile: customer logs in from the phone form', /dashboard/.test(page.url()));

  await page.goto(`${BASE}/dashboard/orders`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  const ordersBody = await page.locator('body').innerText();
  check('mobile: orders page renders order rows', ordersBody.length > 300, `${ordersBody.length} chars`);
  check('mobile: orders show status/amount detail', /TND|د\.ت|طلب|ORD|status|حالة/i.test(ordersBody));

  // Notifications bell → panel opens.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  const bell = page.locator('button').filter({ hasText: '🔔' }).first();
  check('mobile: notifications bell present', (await bell.count()) > 0);
  if (await bell.count()) {
    await bell.click();
    await page.waitForTimeout(1500);
    check('mobile: notifications panel opens', /إشعار|notification|لا توجد/i.test(await page.locator('body').innerText()));
  }

  // Search from the phone.
  await page.goto(`${BASE}/search?q=زيت`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  const searchBody = await page.locator('body').innerText();
  check('mobile: search returns real results', searchBody.length > 200 && !/لا توجد نتائج/i.test(searchBody), `${searchBody.length} chars`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile: dashboard/search no horizontal overflow', overflow <= 2, `overflow=${overflow}px`);
  check('mobile: no 5xx API responses', apiErrors.length === 0, apiErrors.slice(0, 2).join(' | '));
  await page.screenshot({ path: '/tmp/mobile-search.png' });
  await ctx.close();
}

// ── Mobile navigation menu actually routes ──────────────────────────────────
{
  const { ctx, page } = await phone();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1800);
  const menuBtn = page.locator('header button[aria-label="Menu"]');
  await menuBtn.click();
  await page.waitForTimeout(500);
  const nav = page.locator('nav[aria-label="Mobile navigation"]');
  check('mobile: header menu opens', (await nav.count()) > 0);

  const mkt = nav.locator('a[href="/marketplace"]').first();
  check('mobile: menu exposes marketplace link', (await mkt.count()) > 0);
  if (await mkt.count()) {
    await mkt.click();
    await page.waitForURL(/marketplace/, { timeout: 20000 });
    check('mobile: menu link navigates to marketplace', /marketplace/.test(page.url()));
  }
  await ctx.close();
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} mobile checks passed ===`);
process.exit(failed ? 1 : 0);

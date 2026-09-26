import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev';
const PASSWORD = 'Passw0rd!2026';

const results = [];
function record(feature, ok, detail) {
  results.push({ feature, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${feature}  ${detail}`);
}

async function login(page, email, expected = /\/dashboard/) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(expected, { timeout: 25000 }),
    page.locator('form button[type="submit"]').click(),
  ]);
}

async function settle(page, ms = 2500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const api5xx = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 500) api5xx.push(`${r.status()} ${r.url()}`);
});

try {
  await login(page, 'admin@wasit.tn', /\/admin/);
  await settle(page);
  const kpi = await page.locator('main').innerText();
  record('admin: login + KPI dashboard', /\d/.test(kpi), `${kpi.replace(/\s+/g, ' ').slice(0, 160)}`);
} catch (e) {
  record('admin: login + KPI dashboard', false, e.message);
}

for (const [name, url] of [
  ['admin: users', '/admin/users'],
  ['admin: products', '/admin/products'],
  ['admin: orders', '/admin/orders'],
  ['admin: transactions', '/admin/transactions'],
  ['admin: ledger', '/admin/ledger'],
  ['admin: audit', '/admin/audit'],
  ['admin: verification', '/admin/verification'],
  ['admin: trust', '/admin/trust'],
  ['admin: risk', '/admin/risk'],
  ['admin: disputes', '/admin/disputes'],
  ['admin: ads', '/admin/ads'],
  ['admin: ai', '/admin/ai'],
  ['admin: subscriptions', '/admin/subscriptions'],
]) {
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2000);
    const text = await page.locator('main').innerText();
    const rows = await page.locator('table tbody tr').count();
    const ok = text.length > 80 && !/Forbidden/i.test(text);
    record(name, ok, `${rows} rows, ${text.length} chars`);
  } catch (e) {
    record(name, false, e.message);
  }
}

try {
  await login(page, 'merchanta@wasit.tn');
  await page.goto(`${BASE}/dashboard/video-studio`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const productSel = page.getByTestId('studio-product');
  const opts = await productSel.locator('option').count();
  record('video: product/language/audience/style controls render', opts > 1, `${opts - 1} selectable products`);

  if (opts > 1) {
    const firstProduct = await productSel.locator('option').nth(1).getAttribute('value');
    await productSel.selectOption(firstProduct);
    await page.getByTestId('studio-language').selectOption('en');
    // Leave the duration at the form default (the input enforces min 35s).
    const before = await page.locator('[data-testid^="studio-asset-"]').count();
    await page.getByTestId('studio-generate').click();
    await settle(page, 5000);

    const notice = await page.getByTestId('studio-notice').innerText().catch(() => '');
    const err = await page.getByTestId('studio-error').innerText().catch(() => '');
    const after = await page.locator('[data-testid^="studio-asset-"]').count();
    record(
      'video: generate submits and reports',
      Boolean(notice) || Boolean(err),
      `notice="${notice}" error="${err}" library ${before}->${after}`,
    );

    const previews = await page.locator('[data-testid^="studio-preview-"]').count();
    const downloads = await page.locator('[data-testid^="studio-download-"]').count();
    record('video: library shows preview/download', previews + downloads > 0, `${previews} previews, ${downloads} downloads`);
  }
} catch (e) {
  record('video: studio flow', false, e.message);
}

console.log('\n--- 5xx ---');
console.log(api5xx.length ? [...new Set(api5xx)].join('\n') : '(none)');
const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
await browser.close();

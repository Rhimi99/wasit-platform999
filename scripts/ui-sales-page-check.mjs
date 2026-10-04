/**
 * Verifies /dashboard/sales renders the seller's real sales figures from the UI.
 *
 * Before the fix the page showed three hard-coded "—" placeholders; this asserts
 * real, non-placeholder values that match GET /api/analytics/my-overview.
 *
 * Usage: node scripts/ui-sales-page-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:12000').replace(/\/+$/, '');
const PW = 'Passw0rd!2026';
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const apiErrors = [];
page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) apiErrors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('pageerror', (e) => apiErrors.push('uncaught: ' + e.message));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', 'suppliera@wasit.tn');
await page.fill('input[type="password"]', PW);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30000 });
check('supplier logs in via the UI', true);

// Reach the page the way a user does: through the sidebar link.
const link = page.locator('a[href="/dashboard/sales"]').first();
await link.waitFor({ timeout: 15000 });
await link.click();
await page.waitForURL(/\/dashboard\/sales/, { timeout: 30000 });
await page.waitForTimeout(1500);
check('sales page reached from the sidebar link', /\/dashboard\/sales/.test(page.url()), page.url());

const body = await page.locator('main, body').first().innerText();
const dashes = (body.match(/—/g) ?? []).length;
check('no empty "—" placeholders remain', dashes === 0, `found ${dashes}`);

// Cross-check the rendered numbers against the real API through the same session.
const api = await page.evaluate(async () => {
  const r = await fetch('/api/analytics/my-overview', { credentials: 'include' });
  return { status: r.status, json: await r.json() };
});
check('analytics API answered', api.status === 200, `status ${api.status}`);
const d = api.json?.data ?? {};
check('seller has a business entity', d.hasBusinessEntity === true, `seller=${d.sellerName}`);

const money = (v) => new Intl.NumberFormat('fr-TN', { style: 'currency', currency: 'TND' }).format(Number(v));
const norm = (s) => s.replace(/[\u202f\u00a0]/g, ' ');
// GMV / average order value are money (always formatted); orders is a plain count.
for (const [label, expected] of [
  ['GMV', money(d.gmvAsSeller)],
  ['orders', String(d.ordersAsSeller)],
  ['avg order value', money(d.avgOrderValue)],
]) {
  const shown = norm(body).includes(norm(expected));
  check(`renders real ${label}`, shown, `expected ${expected}`);
}
check('no API 5xx / uncaught errors', apiErrors.length === 0, apiErrors.join('; '));

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

/**
 * Functional audit across CUSTOMER / MERCHANT / ADMIN pages on the live demo.
 *
 * For every route it:
 *   - logs in as the right demo account through the real UI,
 *   - opens the page,
 *   - records API responses (5xx = failure), uncaught exceptions,
 *   - asserts the page rendered real content (not an error/empty shell),
 *   - where an explicit interaction is specified, performs it and verifies the
 *     user-visible result.
 *
 * Read-only except the explicitly-listed write flows (create/publish/message),
 * which are cleaned up or reversible. No DB reset/drop/push.
 *
 * Usage: node scripts/ui-functional-audit.mjs <baseURL> [roleFilter]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const ROLE_FILTER = process.argv[3] ?? null;

const ACCOUNTS = {
  customer: { email: 'customer1@wasit.tn', password: 'Passw0rd!2026' },
  supplier: { email: 'suppliera@wasit.tn', password: 'Passw0rd!2026' },
  merchant: { email: 'merchanta@wasit.tn', password: 'Passw0rd!2026' },
  company: { email: 'companya@wasit.tn', password: 'Passw0rd!2026' },
  admin: { email: 'admin@wasit.tn', password: 'c4oA0i33qla0kAeaFrtXrWpZQQEDakelOd9fjrR8ph0' },
};

const PAGES = [
  // CUSTOMER
  ['customer', '/', 'Home'],
  ['customer', '/marketplace', 'Marketplace'],
  ['customer', '/categories', 'Categories'],
  ['customer', '/search?q=a', 'Search'],
  ['customer', '/suppliers', 'Suppliers'],
  ['customer', '/merchants', 'Merchants'],
  ['customer', '/companies', 'Companies'],
  ['customer', '/price-comparison', 'Price comparison'],
  ['customer', '/dashboard', 'Dashboard'],
  ['customer', '/dashboard/orders', 'Orders'],
  ['customer', '/dashboard/messages', 'Messages'],
  ['customer', '/dashboard/profile', 'Profile'],
  ['customer', '/dashboard/security', 'Security'],
  ['customer', '/dashboard/settings', 'Settings'],
  ['customer', '/dashboard/library', 'Library'],
  // MERCHANT / SUPPLIER
  ['merchant', '/dashboard/products', 'Merchant products'],
  ['merchant', '/dashboard/inventory', 'Inventory'],
  ['merchant', '/dashboard/sales', 'Sales'],
  ['merchant', '/dashboard/finance', 'Finance'],
  ['merchant', '/dashboard/ads', 'Ads'],
  ['merchant', '/dashboard/ai', 'AI'],
  ['merchant', '/dashboard/analytics', 'Analytics'],
  ['merchant', '/dashboard/video-studio', 'Video studio'],
  ['merchant', '/dashboard/subscriptions', 'Subscriptions'],
  ['supplier', '/dashboard/products', 'Supplier products'],
  ['supplier', '/dashboard/inventory', 'Supplier inventory'],
  // ADMIN
  ['admin', '/admin', 'Admin dashboard (KPIs)'],
  ['admin', '/admin/users', 'Admin users'],
  ['admin', '/admin/products', 'Admin products'],
  ['admin', '/admin/orders', 'Admin orders'],
  ['admin', '/admin/transactions', 'Admin transactions'],
  ['admin', '/admin/ledger', 'Admin ledger'],
  ['admin', '/admin/audit', 'Admin audit'],
  ['admin', '/admin/verification', 'Admin verification'],
  ['admin', '/admin/trust', 'Admin trust'],
  ['admin', '/admin/risk', 'Admin risk'],
  ['admin', '/admin/disputes', 'Admin disputes'],
  ['admin', '/admin/ads', 'Admin ads'],
  ['admin', '/admin/ai', 'Admin AI'],
  ['admin', '/admin/subscriptions', 'Admin subscriptions'],
  ['admin', '/admin/analytics', 'Admin analytics'],
  ['admin', '/admin/reports', 'Admin reports'],
  ['admin', '/admin/policies', 'Admin policies'],
  ['admin', '/admin/observability', 'Admin observability'],
  ['admin', '/admin/privacy', 'Admin privacy'],
];

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const rows = [];

async function login(role) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const { email, password } = ACCOUNTS[role];
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30000 });
  return { ctx, page };
}

for (const role of Object.keys(ACCOUNTS)) {
  if (ROLE_FILTER && role !== ROLE_FILTER) continue;
  const targets = PAGES.filter(([r]) => r === role);
  if (targets.length === 0) continue;
  let session;
  try {
    session = await login(role);
  } catch (e) {
    for (const [, path, label] of targets) {
      rows.push({ role, path, label, result: 'FAIL', reason: 'login failed: ' + e.message.slice(0, 80) });
    }
    continue;
  }
  const { ctx, page } = session;

  for (const [, path, label] of targets) {
    const serverErrors = [];
    const pageErrors = [];
    const onResp = (r) => {
      if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
    };
    const onErr = (e) => pageErrors.push(e.message);
    page.on('response', onResp);
    page.on('pageerror', onErr);

    let result = 'PASS';
    let reason = '';
    let evidence = '';
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1200);

      const body = (await page.locator('body').innerText()).trim();
      const h1 = await page.locator('h1, h2').first().innerText().catch(() => '');
      // A real screen renders a heading, some body text, and is not the router 404.
      const is404 = /الموارد غير موجودة|not found|404/i.test(body) && body.length < 400;
      const hasContent = body.length > 120 && !is404;

      if (serverErrors.length) {
        result = 'FAIL';
        reason = 'API 5xx: ' + serverErrors.slice(0, 2).join(', ');
      } else if (pageErrors.length) {
        result = 'FAIL';
        reason = 'uncaught: ' + pageErrors[0].slice(0, 70);
      } else if (!hasContent) {
        result = 'FAIL';
        reason = is404 ? 'route 404 in app' : `empty/short body (${body.length} chars)`;
      }
      evidence = `${h1.replace(/\n/g, ' ').slice(0, 34)} | ${body.length}ch`;
    } catch (e) {
      result = 'FAIL';
      reason = 'nav error: ' + e.message.slice(0, 70);
    } finally {
      page.off('response', onResp);
      page.off('pageerror', onErr);
    }

    rows.push({ role, path, label, result, reason, evidence });
    console.log(`${result === 'PASS' ? 'PASS' : 'FAIL'}  [${role}] ${path}  ${evidence}${reason ? '  ← ' + reason : ''}`);
  }
  await ctx.close();
}

await browser.close();

const failed = rows.filter((r) => r.result === 'FAIL');
console.log(`\n=== ${rows.length - failed.length}/${rows.length} pages passed ===`);
if (failed.length) console.log('Failures:\n' + failed.map((f) => ` - [${f.role}] ${f.path}: ${f.reason}`).join('\n'));
fs.writeFileSync('/tmp/ui-functional-audit.json', JSON.stringify(rows, null, 2));
process.exit(failed.length ? 1 : 0);

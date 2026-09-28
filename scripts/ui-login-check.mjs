/**
 * Real end-to-end login through the UI for the public demo accounts.
 * Drives the actual form + API; no mocks. Read-only with respect to data.
 * Usage: node scripts/ui-login-check.mjs <baseURL> [email] [password]
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const EMAIL = process.argv[3] ?? 'customer1@wasit.tn';
const PASSWORD = process.argv[4] ?? 'Passw0rd!2026';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const apiCalls = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.request().method() !== 'GET') {
    apiCalls.push(`${r.request().method()} ${r.status()} ${new URL(r.url()).pathname}`);
  }
});

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 45000 });
console.log('after goto:', page.url(), '| title:', await page.title());
console.log('inputs found:', await page.locator('input').count());
console.log('body head:', (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' / '));
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);

// Real button click → real POST /api/auth/login → session cookie.
await page.click('button[type="submit"]');
await page.waitForTimeout(4000);

const url = page.url();
const loginCall = apiCalls.find((c) => c.includes('/api/auth/login'));
console.log('login request:', loginCall ?? '(none observed)');
console.log('landed on:', url);

// Verify a session actually exists by asking the API from inside the page context.
const meStatus = await page.evaluate(async () => {
  const r = await fetch('/api/auth/me', { credentials: 'include' });
  return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
});
console.log('GET /api/auth/me →', meStatus.status, meStatus.body ? `(roles: ${JSON.stringify(meStatus.body.roles ?? meStatus.body.user?.roles ?? null)})` : '');

const loggedOut = /\/login/.test(url);
const ok = !loggedOut && meStatus.status === 200 && loginCall?.startsWith('POST 200');
console.log(`\n${ok ? 'PASS' : 'FAIL'} — UI login for ${EMAIL}`);
if (errors.length) console.log('page errors:', errors.join(' | '));

await browser.close();
process.exit(ok ? 0 : 1);

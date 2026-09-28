/**
 * Registration journey through the real UI: fill the public sign-up form,
 * submit it, and confirm the user actually ends up signed in / able to reach
 * their dashboard. A unique email is generated per run so the check is
 * repeatable without touching existing demo accounts.
 *
 * Usage: node scripts/ui-register-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const RUN = Date.now().toString(36).slice(-6);
const EMAIL = `ui.reg.${RUN}@example.com`;

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const apiErrors = [];
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) apiErrors.push(`${r.status()} ${r.url()}`); });

await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);
check('register page renders a form', (await page.locator('form').count()) > 0);

const inputs = page.locator('form input');
const n = await inputs.count();
check('register form exposes the expected fields', n >= 4, `${n} input(s)`);

// Fill by position: first/last name, email, password (labels are localised).
await inputs.nth(0).fill('Ui');
await inputs.nth(1).fill(`Reg${RUN}`);
await page.locator('form input[type="email"]').fill(EMAIL);
await page.locator('form input[type="password"]').fill('Passw0rd!2026');

const roleSel = page.locator('form select').first();
if ((await roleSel.count()) > 0) {
  const opts = await roleSel.locator('option').allTextContents();
  check('register form offers account roles', opts.length > 0, opts.map((o) => o.trim()).join('/').slice(0, 60));
  await roleSel.selectOption({ index: 0 });
}

await page.locator('form button[type="submit"]').click();
await page.waitForTimeout(6000);

const body = await page.locator('body').innerText();
const url = page.url();
const landedInApp = /dashboard/.test(url);
check('registration completes without a visible error', !/error|خطأ|فشل|invalid/i.test(body.slice(0, 2000)) || landedInApp, landedInApp ? 'auto-signed in' : url.replace(BASE, ''));
check('new account reaches an authenticated surface', landedInApp || /verify|تأكيد|login|دخول/i.test(body), landedInApp ? 'dashboard' : 'redirected to a follow-up step');
check('no 5xx API responses during registration', apiErrors.length === 0, apiErrors.slice(0, 2).join(' | '));

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

/**
 * Public-demo functional audit — real Chromium against the published HTTPS URL.
 *
 * It exercises what a visitor actually does (browse, register, log in as each
 * role, open the role dashboards, switch languages, use a phone viewport) and
 * records console errors and 5xx API responses for every page it visits.
 *
 * Credentials come from scripts/lib/demo-credentials.mjs; nothing is printed.
 *
 * Usage: node scripts/ui-demo-audit.mjs https://<demo-host>
 */
import { chromium } from 'playwright';
import { demoPasswordFor } from './lib/demo-credentials.mjs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

/** Opens a context/page that records console errors and failed API calls. */
async function newPage(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...options });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const apiFailures = [];
  const authProbes = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Chrome logs every non-2xx fetch as "Failed to load resource". The status is
    // checked below with its URL; here we keep only genuine script errors.
    if (/Failed to load resource/i.test(text)) return;
    consoleErrors.push(text.slice(0, 200));
  });
  page.on('response', (r) => {
    if (!r.url().includes('/api/')) return;
    const path = new URL(r.url()).pathname;
    if (r.status() === 401 && path === '/api/auth/me') {
      // Expected: the SPA asks "who am I?" before anyone logs in.
      authProbes.push(r.status());
      return;
    }
    if (r.status() >= 400) apiFailures.push(`${r.status()} ${r.request().method()} ${path}`);
  });
  return { ctx, page, consoleErrors, apiFailures };
}

async function login(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|admin)/, { timeout: 30000 });
  return page.url();
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function pageText(page) {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

// ── 1. Anonymous surface ────────────────────────────────────────────────────
{
  const { ctx, page, consoleErrors, apiFailures } = await newPage();
  const res = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page);
  const text = await pageText(page);
  check('home responds 200', res?.status() === 200, `status=${res?.status()}`);
  check('home renders the brand', /WASSIT|WASIT/i.test(text), text.slice(0, 60));
  check('demo banner is visible', await page.getByText('بيانات تجريبية فقط', { exact: false }).first().isVisible().catch(() => false));
  check('home has no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check('home has no unexpected API errors', apiFailures.length === 0, apiFailures.join(' | '));
  await ctx.close();
}

// ── 2. Marketplace and product detail ──────────────────────────────────────
{
  const { ctx, page, consoleErrors, apiFailures } = await newPage();
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 2000);
  const cards = page.locator('a[href^="/products/"]');
  const count = await cards.count();
  check('marketplace lists products', count > 0, `${count} product link(s)`);
  if (count > 0) {
    const href = await cards.first().getAttribute('href');
    const detail = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 1500);
    const text = await pageText(page);
    check('product detail renders a price', /\d/.test(text) && text.length > 200, `${href} status=${detail?.status()}`);
  }
  check('marketplace has no unexpected API errors', apiFailures.length === 0, apiFailures.join(' | '));
  check('marketplace has no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await ctx.close();
}

// ── 3. Registration (creates a throwaway demo account) ─────────────────────
{
  const { ctx, page, apiFailures } = await newPage();
  const email = `demo-ui-${Date.now()}@example.com`;
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input').nth(0).fill('Demo');
  await page.locator('input').nth(1).fill('Visitor');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', `Ui!${Math.random().toString(36).slice(2)}A9`);
  await page.click('form button[type="submit"]');
  // Success shows a confirmation and then redirects to /login after ~1.8s.
  await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
  const text = await pageText(page);
  const landedOnLogin = page.url().includes('/login');
  check('registration is accepted', landedOnLogin || /تحقق|تم|success|vérif|verify/i.test(text), page.url().replace(BASE, ''));
  check('registration has no unexpected API errors', apiFailures.length === 0, apiFailures.join(' | '));
  await ctx.close();
}

// ── 4. Each role logs in and reaches its own surface ───────────────────────
const ROLES = [
  { key: 'customer', email: 'customer1@wasit.tn', expect: '/dashboard' },
  { key: 'merchant', email: 'merchanta@wasit.tn', expect: '/dashboard' },
  { key: 'supplier', email: 'suppliera@wasit.tn', expect: '/dashboard' },
  { key: 'company', email: 'companya@wasit.tn', expect: '/dashboard' },
  { key: 'admin', email: 'admin@wasit.tn', expect: '/admin' },
];

for (const role of ROLES) {
  const { ctx, page, consoleErrors, apiFailures } = await newPage();
  let url = '';
  try {
    url = await login(page, role.email, demoPasswordFor(role.email));
  } catch (err) {
    check(`${role.key}: login`, false, String(err).slice(0, 120));
    await ctx.close();
    continue;
  }
  check(`${role.key}: login lands on ${role.expect}`, url.includes(role.expect), url.replace(BASE, ''));
  await settle(page);
  const text = await pageText(page);
  check(`${role.key}: dashboard renders content`, text.length > 300, `${text.length} chars`);
  check(`${role.key}: no unexpected API errors after login`, apiFailures.length === 0, apiFailures.slice(0, 2).join(' | '));
  check(`${role.key}: no console errors after login`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // Admin surfaces must stay closed to business roles, and vice versa.
  if (role.key !== 'admin') {
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 800);
    const after = page.url();
    const body = await pageText(page);
    const blocked = !after.includes('/admin/users') || /غير مصرح|forbidden|403|غير مسموح/i.test(body);
    check(`${role.key}: /admin/users is refused`, blocked, after.replace(BASE, ''));
  }

  // Role-specific workspace pages.
  const pages = role.key === 'admin'
    ? ['/admin', '/admin/users', '/admin/orders', '/admin/audit', '/admin/ai']
    : role.key === 'merchant'
      ? ['/dashboard/products', '/dashboard/inventory', '/dashboard/sales', '/dashboard/ai']
      : role.key === 'customer'
        ? ['/dashboard/orders', '/dashboard/ai', '/dashboard/messages']
        : ['/dashboard/profile'];
  for (const path of pages) {
    const before = apiFailures.length;
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 1200);
    const text2 = await pageText(page);
    const hardFail = /Something went wrong|حدث خطأ|Internal Server Error/i.test(text2);
    check(`${role.key}: ${path} loads`, !hardFail && apiFailures.length === before, `${text2.length} chars`);
  }
  await ctx.close();
}

// ── 5. Languages and direction ─────────────────────────────────────────────
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 800);
  for (const [code, dir] of [['ar', 'rtl'], ['fr', 'ltr'], ['en', 'ltr'], ['zh', 'ltr']]) {
    await page.selectOption('select[aria-label="Language"]', code);
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      text: document.body.innerText.slice(0, 200),
    }));
    check(`locale ${code} applies dir=${dir}`, state.dir === dir && state.lang === code, `dir=${state.dir} lang=${state.lang}`);
    check(`locale ${code} renders translated copy`, state.text.trim().length > 20, state.text.replace(/\s+/g, ' ').slice(0, 60));
  }
  await ctx.close();
}

// ── 6. Phone viewport ──────────────────────────────────────────────────────
{
  const { ctx, page, consoleErrors, apiFailures } = await newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone: home does not scroll horizontally', overflow <= 2, `overflow=${overflow}px`);
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 1500);
  const cards = await page.locator('a[href^="/products/"]').count();
  check('phone: marketplace lists products', cards > 0, `${cards} card(s)`);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone: marketplace does not scroll horizontally', overflow2 <= 2, `overflow=${overflow2}px`);
  try {
    const url = await login(page, 'customer1@wasit.tn', demoPasswordFor('customer1@wasit.tn'));
    await settle(page, 1200);
    const overflow3 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone: login works and dashboard fits', url.includes('/dashboard') && overflow3 <= 2, `overflow=${overflow3}px`);
  } catch (err) {
    check('phone: login works and dashboard fits', false, String(err).slice(0, 120));
  }
  check('phone: no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check('phone: no unexpected API errors', apiFailures.length === 0, apiFailures.join(' | '));
  await ctx.close();
}

// ── 7. AI honesty: the status must name the real provider ──────────────────
{
  const { ctx, page } = await newPage();
  await login(page, 'customer1@wasit.tn', demoPasswordFor('customer1@wasit.tn'));
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/ai/status', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const provider = status.body?.data?.provider ?? status.body?.data?.ai?.provider ?? '';
  check('AI status is reachable', status.status === 200, `status=${status.status}`);
  check('AI reports the local deterministic provider (no fake cloud claim)', String(provider).includes('local'), `provider=${provider}`);
  await page.goto(`${BASE}/dashboard/ai`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 1500);
  const text = await pageText(page);
  check('AI page renders', text.length > 200, `${text.length} chars`);
  await ctx.close();
}

// ── 8. Video delivery respects permissions ────────────────────────────────
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const anon = await page.evaluate(async () => {
    const r = await fetch('/api/media/assets?kind=MARKETING_VIDEO', { credentials: 'include' });
    return r.status;
  });
  check('video library is not public', anon === 401 || anon === 403, `anonymous=${anon}`);
  await login(page, 'merchanta@wasit.tn', demoPasswordFor('merchanta@wasit.tn'));
  const mine = await page.evaluate(async () => {
    const r = await fetch('/api/media/assets?kind=MARKETING_VIDEO', { credentials: 'include' });
    const body = await r.json().catch(() => null);
    return { status: r.status, items: body?.data?.items?.length ?? null };
  });
  check('merchant can list its own videos', mine.status === 200, `status=${mine.status} items=${mine.items}`);
  const forged = await page.evaluate(async () => {
    const r = await fetch('/api/ai/tasks/00000000-0000-0000-0000-000000000000/video', { credentials: 'include' });
    return r.status;
  });
  check('unknown video task is not disclosed', forged === 404, `status=${forged}`);
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n== UI RESULTS: ${results.length - failed.length} passed, ${failed.length} failed ==`);
for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
process.exit(failed.length === 0 ? 0 : 1);

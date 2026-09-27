/**
 * Admin operations + the full dispute lifecycle, exercised from the UI:
 *   - admin dashboard KPIs, users, products, orders/transactions, ledger, audit
 *   - trust page computes a score for a real user
 *   - customer opens a dispute on a real order
 *   - admin sees it, moves its status, records a decision
 *   - admin lists/updates ads, subscriptions, AI, risk
 * Rejection/decision outcomes are chosen to leave demo data coherent.
 * Usage: DEMO_STAFF_PASSWORD=... node scripts/ui-admin-dispute-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const RUN = Date.now().toString(36).slice(-6);
const staffPw = (process.env.DEMO_STAFF_PASSWORD ?? '').trim();
if (!staffPw) throw new Error('DEMO_STAFF_PASSWORD is required');

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

// ── Admin read-only surfaces must show real data ────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'admin@wasit.tn');
  await page.fill('input[type="password"]', staffPw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin/, { timeout: 30000 });

  const surfaces = [
    ['/admin', /مستخدم|user|طلب|order|إيراد|revenue|KPI|لوحة/i, 'dashboard KPIs'],
    ['/admin/users', /customer1@wasit\.tn|مستخدم|user/i, 'users list'],
    ['/admin/products', /منتج|product/i, 'products list'],
    ['/admin/orders', /ORD-|طلب|order/i, 'orders/transactions'],
    ['/admin/ledger', /قيد|ledger|journal|مدين|دائن/i, 'ledger'],
    ['/admin/audit', /تدقيق|audit|action|log/i, 'audit log'],
    ['/admin/trust', /ثقة|trust/i, 'trust'],
    ['/admin/risk', /مخاطر|risk/i, 'risk'],
    ['/admin/disputes', /نزاع|dispute/i, 'disputes'],
    ['/admin/ads', /إعلان|ads|campaign/i, 'ads'],
    ['/admin/ai', /ذكاء|AI|agent|وكيل/i, 'AI'],
    ['/admin/subscriptions', /اشتراك|subscription|plan/i, 'subscriptions'],
  ];
  for (const [path, re, label] of surfaces) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200);
    const body = await page.locator('body').innerText();
    check(`admin ${label} renders with real content`, re.test(body) && body.length > 300, `${body.length} chars`);
  }
  await ctx.close();
}

// ── Trust recompute on a real user (the customer page owns the action) ──────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'customer1@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });
  await page.goto(`${BASE}/dashboard/trust`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const btn = page.locator('button').filter({ hasText: /إعادة|recompute|recalcul/i }).first();
  check('customer trust recompute control present', (await btn.count()) > 0);
  if ((await btn.count()) > 0) {
    await btn.click();
    await page.waitForTimeout(3500);
    const score = await page.request.get(`${BASE}/api/trust/me`);
    const json = (await score.json().catch(() => null))?.data ?? null;
    check('recompute stores a real trust score', typeof json?.latest?.score === 'number' || typeof json?.score === 'number', JSON.stringify(json?.latest ?? json ?? {}).slice(0, 90));
  }
  await ctx.close();

  // The admin trust page must now surface that snapshot, with its own action.
  const actx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const apage = await actx.newPage();
  await apage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await apage.fill('input[type="email"]', 'admin@wasit.tn');
  await apage.fill('input[type="password"]', staffPw);
  await apage.click('button[type="submit"]');
  await apage.waitForURL(/\/admin/, { timeout: 30000 });
  await apage.goto(`${BASE}/admin/trust`, { waitUntil: 'networkidle', timeout: 60000 });
  await apage.waitForTimeout(2000);
  const api = await apage.request.get(`${BASE}/api/admin/trust`);
  const items = api.ok() ? (await api.json())?.data?.items ?? [] : [];
  check('admin sees the stored trust score', items.length > 0, `${items.length} score(s)`);
  const recompute = apage.locator('button').filter({ hasText: /إعادة|recompute|recalcul/i }).first();
  if ((await recompute.count()) > 0) {
    await recompute.click();
    await apage.waitForTimeout(3000);
    const after = (await (await apage.request.get(`${BASE}/api/admin/trust`)).json())?.data?.items ?? [];
    check('admin recompute keeps a valid score row', after.length > 0 && typeof after[0]?.score === 'number', `score=${after[0]?.score}`);
  } else {
    check('admin trust recompute control present', false);
  }
  await actx.close();
}

// ── Dispute lifecycle ───────────────────────────────────────────────────────
let disputeId = null;
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'customer1@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });

  await page.goto(`${BASE}/dashboard/disputes`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);

  const orderSel = page.getByTestId('dispute-order');
  check('dispute order selector renders', (await orderSel.count()) > 0);

  // An order can only carry one open dispute, so choose one that has none.
  const mineList = await page.request.get(`${BASE}/api/disputes`);
  const existing = (mineList.ok() ? (await mineList.json())?.data?.items ?? [] : [])
    .filter((d) => d.status === 'OPEN').map((d) => d.orderId);
  const orderOptions = await orderSel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
  check('customer has orders available for a dispute', orderOptions.length > 0, `${orderOptions.length} order(s)`);
  const freeOption = orderOptions.find((id) => !existing.includes(id));

  if (freeOption) {
    await orderSel.selectOption(freeOption);
    await page.getByTestId('dispute-reason').selectOption('NOT_AS_DESCRIBED');
    await page.getByTestId('dispute-description').fill(`اعتراض تدقيق ${RUN} — المنتج لا يطابق الوصف المرسل.`);
    await page.getByTestId('dispute-create-submit').click();
    await page.waitForTimeout(4000);

    const mine = await page.request.get(`${BASE}/api/disputes`);
    const items = mine.ok() ? (await mine.json())?.data?.items ?? [] : [];
    const created = items.find((d) => (d.description ?? '').includes(RUN));
    disputeId = created?.id ?? null;
    check('dispute created from the UI', !!disputeId, disputeId ?? 'not found');
    const body = await page.locator('body').innerText();
    check('created dispute is shown to the customer', body.includes(RUN), body.includes(RUN) ? 'visible' : 'not visible');
  }
  await ctx.close();
}

if (disputeId) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'admin@wasit.tn');
  await page.fill('input[type="password"]', staffPw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin/, { timeout: 30000 });

  await page.goto(`${BASE}/admin/disputes`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  check('dispute appears in the admin queue', (await page.getByTestId(`admin-dispute-${disputeId}`).count()) > 0);

  // Open it and move the status, then record a decision.
  await page.getByTestId(`admin-dispute-${disputeId}`).click();
  await page.waitForTimeout(2500);

  const statusSel = page.getByTestId('admin-dispute-status-select');
  if ((await statusSel.count()) > 0) {
    await statusSel.selectOption('UNDER_REVIEW');
    await page.getByTestId('admin-dispute-status-note').fill('قيد المراجعة');
    await page.getByTestId('admin-dispute-status-submit').click();
    await page.waitForTimeout(3000);
    const d = await page.request.get(`${BASE}/api/disputes/${disputeId}`);
    const row = d.ok() ? (await d.json())?.data : null;
    check('status update reaches the backend', row?.status === 'UNDER_REVIEW', row?.status ?? 'unknown');
  }

  const decisionSel = page.getByTestId('admin-dispute-decision-select');
  if ((await decisionSel.count()) > 0) {
    await decisionSel.selectOption('REJECTED');
    await page.getByTestId('admin-dispute-decision-note').fill('لا توجد أدلة كافية');
    await page.getByTestId('admin-dispute-decide-submit').click();
    await page.waitForTimeout(3500);
    const d = await page.request.get(`${BASE}/api/disputes/${disputeId}`);
    const row = d.ok() ? (await d.json())?.data : null;
    check('decision reaches the backend', ['REJECTED', 'RESOLVED', 'CLOSED', 'DECIDED'].includes(row?.status ?? ''), `status=${row?.status} decision=${row?.decision ?? '-'}`);
  }
  await ctx.close();
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

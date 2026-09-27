/**
 * End-to-end verification chain through the UI:
 *   customer submits a real verification request (when none is pending) →
 *   admin sees it in the queue → admin rejects it via the real button.
 * Rejection is deliberate: it clears the queue (idempotent runs) and leaves the
 * demo user's verification level unchanged.
 * Usage: DEMO_STAFF_PASSWORD=... node scripts/ui-verification-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const RUN = Date.now().toString(36).slice(-6);

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

let requestId = null;
let levelBefore = null;
let submittedNow = false;

// ── Customer submits ────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'customer1@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });

  const before = await page.request.get(`${BASE}/api/verification/me`);
  const status = (await before.json().catch(() => null))?.data ?? null;
  levelBefore = status?.currentLevel ?? null;

  await page.goto(`${BASE}/dashboard/verification`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  check('verification page loads with levels', /تحقق|verification|vérification|BASIC|VERIFIED/i.test(await page.locator('body').innerText()));

  const submit = page.getByTestId('verification-submit');
  const enabled = (await submit.count()) > 0 && (await submit.isEnabled());

  if (enabled) {
    const inputs = page.locator('input[type="text"], input:not([type])');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) { const v = await inputs.nth(i).inputValue(); if (!v) await inputs.nth(i).fill(i === 0 ? 'ID_CARD' : `TN-${RUN}`); }
    await submit.click();
    await page.waitForTimeout(3000);
    submittedNow = true;
    const list = await page.request.get(`${BASE}/api/verification/requests`);
    const items = list.ok() ? (await list.json())?.data?.items ?? [] : [];
    check('request persisted server-side', items.length > 0, `${items.length} request(s)`);
    requestId = items.find((r) => r.status === 'PENDING' || r.status === 'SUBMITTED')?.id ?? null;
  } else {
    check('submit blocked while a request is pending (real guard)', !!status?.activeRequest, status?.activeRequest ? `active=${status.activeRequest.status}` : 'no active request');
    requestId = status?.activeRequest?.id ?? null;
  }
  check('a request id is available for the admin queue', !!requestId, requestId ?? 'none');
  await ctx.close();
}

// ── Admin reviews ───────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'admin@wasit.tn');
  const staffPw = (process.env.DEMO_STAFF_PASSWORD ?? '').trim();
  if (!staffPw) throw new Error('DEMO_STAFF_PASSWORD is required to test the admin UI');
  await page.fill('input[type="password"]', staffPw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin/, { timeout: 30000 });

  await page.goto(`${BASE}/admin/verification`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  const listApi = await page.request.get(`${BASE}/api/admin/verification/requests`);
  const all = listApi.ok() ? (await listApi.json())?.data?.items ?? [] : [];
  const open = all.filter((r) => ['PENDING', 'SUBMITTED', 'IN_REVIEW'].includes(r.status));
  check('admin queue shows the submitted request', open.length > 0, `${open.length} open / ${all.length} total`);
  const target = open.find((r) => r.id === requestId) ?? open[0];
  check('admin sees the submitted request specifically', !!target && target.id === requestId, target?.id ?? 'none');

  if (target) {
    check('pending request is visible in the admin UI', (await page.getByTestId(`admin-verification-${target.id}`).count()) > 0);
    const rejectBtn = page.getByTestId(`admin-verification-reject-${target.id}`);
    check('admin reject control present', (await rejectBtn.count()) > 0);
    if ((await rejectBtn.count()) > 0) {
      await rejectBtn.click();
      await page.waitForTimeout(3000);
      const after = await page.request.get(`${BASE}/api/admin/verification/requests?status=REJECTED`);
      const rejected = (after.ok() ? (await after.json())?.data?.items ?? [] : []).find((r) => r.id === target.id);
      check('admin decision reaches the backend', !!rejected, rejected ? `status=${rejected.status}` : 'not in rejected list');
    }
  }

  const custCtx = await browser.newContext();
  const custPage = await custCtx.newPage();
  await custPage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await custPage.fill('input[type="email"]', 'customer1@wasit.tn');
  await custPage.fill('input[type="password"]', 'Passw0rd!2026');
  await custPage.click('button[type="submit"]');
  await custPage.waitForURL(/dashboard/, { timeout: 30000 });
  const st = await custPage.request.get(`${BASE}/api/verification/me`);
  const levelAfter = (st.ok() ? (await st.json())?.data?.currentLevel : null) ?? null;
  check('rejection leaves the level unchanged', levelAfter === levelBefore, `${levelBefore} → ${levelAfter}`);

  await custPage.goto(`${BASE}/dashboard/verification`, { waitUntil: 'networkidle', timeout: 60000 });
  await custPage.waitForTimeout(2000);
  check('submit re-enables after the decision', await custPage.getByTestId('verification-submit').isEnabled());
  await custCtx.close();
  await ctx.close();
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===${submittedNow ? '' : ' (no fresh submit this run)'}`);
process.exit(failed ? 1 : 0);

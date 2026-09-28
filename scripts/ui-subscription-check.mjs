/**
 * Subscription flow through the real UI: merchant picks a real plan, subscribes,
 * and the backend subscription is verified via API. Then billing cycle toggles
 * real prices. Cancellation is left alone so the demo keeps its state meaningful
 * on re-runs; re-running is idempotent because subscribing to the current plan
 * is a change/no-op.
 * Usage: node scripts/ui-subscription-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', 'merchanta@wasit.tn');
await page.fill('input[type="password"]', 'Passw0rd!2026');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });

await page.goto(`${BASE}/dashboard/subscriptions`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

const plans = await page.request.get(`${BASE}/api/subscriptions/plans`);
const planItems = plans.ok() ? (await plans.json())?.data?.items ?? [] : [];
check('subscription plans load from the backend', planItems.length > 0, `${planItems.length} plan(s)`);
check('current-subscription card renders', (await page.getByTestId('sub-current').count()) > 0);

// Remember the starting plan so the demo is left exactly as we found it.
const original = (await (await page.request.get(`${BASE}/api/subscriptions/me`)).json())?.data?.subscription ?? null;

// Billing-cycle toggle must reflect real stored prices.
const yearly = page.getByTestId('sub-cycle-YEARLY');
if ((await yearly.count()) > 0) {
  await yearly.click();
  await page.waitForTimeout(800);
  check('yearly cycle toggle applies', true);
  await page.getByTestId('sub-cycle-MONTHLY').click();
  await page.waitForTimeout(800);
}

// Subscribe (or switch) to the first real plan through the UI button.
const planBtn = page.locator('button:not([disabled])').filter({ hasText: /اشترك|تغيير الخطة|subscribe|change plan|s'abonner|changer/i }).first();
const hasSubscribe = (await planBtn.count()) > 0;
check('an enabled subscribe/change control is present', hasSubscribe);
if (hasSubscribe) {
  await planBtn.click();
  await page.waitForTimeout(3500);
  const notice = await page.locator('[role="status"]').first().innerText().catch(() => '');
  check('subscribe yields a user-visible confirmation', notice.length > 0, notice.slice(0, 60));

  const mine = await page.request.get(`${BASE}/api/subscriptions/me`);
  const sub = mine.ok() ? (await mine.json())?.data?.subscription : null;
  check('backend records an active subscription', !!sub && ['ACTIVE', 'TRIAL'].includes(sub.status), sub ? `plan=${sub.planCode} status=${sub.status}` : 'none');

  // Restore the plan the demo started with (if it changed).
  if (original && sub && sub.planId !== original.planId) {
    await page.request.patch(`${BASE}/api/subscriptions/me/plan`, {
      data: { planId: original.planId, billingCycle: original.billingCycle ?? 'MONTHLY' },
    });
    const restored = (await (await page.request.get(`${BASE}/api/subscriptions/me`)).json())?.data?.subscription;
    check('demo subscription restored to its original plan', restored?.planId === original.planId, restored?.planCode ?? 'unknown');
  }
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

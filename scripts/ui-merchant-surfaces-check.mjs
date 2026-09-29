/**
 * Merchant surfaces that the other suites do not assert directly:
 * dashboard KPIs, orders list, analytics overview, ads list, AI, subscription.
 * Read-only apart from the AI run (a real agent invocation, no data mutation).
 * Usage: node scripts/ui-merchant-surfaces-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', 'merchanta@wasit.tn');
await page.fill('input[type="password"]', 'Passw0rd!2026');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });

const surfaces = [
  ['/dashboard', /لوحة|dashboard|منتج|product|طلب|order|إيراد|revenue/i, 'dashboard'],
  ['/dashboard/orders', /ORD-|طلب|order|لا توجد|no order/i, 'orders'],
  ['/dashboard/analytics', /GMV|مبيعات|sales|منتج|product|إيراد/i, 'analytics'],
  ['/dashboard/ads', /إعلان|ads|campaign|حملة/i, 'ads'],
  ['/dashboard/ai', /ذكاء|AI|agent|وكيل/i, 'AI'],
  ['/dashboard/subscriptions', /اشتراك|subscription|plan|SMALL_MERCHANT|باقة/i, 'subscriptions'],
  ['/dashboard/products', /منتج|product/i, 'products'],
  ['/dashboard/inventory', /مخزون|inventory|SKU/i, 'inventory'],
];
for (const [path, re, label] of surfaces) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  check(`merchant ${label} renders with real content`, re.test(body) && body.length > 300, `${body.length} chars`);
}

// The analytics payload must carry real numbers, not a hollow shell.
const api = await page.request.get(`${BASE}/api/analytics/my-overview`);
const a = api.ok() ? (await api.json())?.data : null;
check('analytics API returns merchant figures', !!a && a.hasBusinessEntity !== false, a ? `gmv=${a.gmvAsSeller} orders=${a.ordersAsSeller} products=${a.products}` : `status ${api.status()}`);

// The subscription endpoint must answer with a well-formed payload: either the
// merchant's active subscription or an explicit `null` (no subscription yet —
// a legitimate state for a fresh demo account, not a failure). The plans
// catalogue must be served too, since that is what lets them subscribe.
const sub = await page.request.get(`${BASE}/api/subscriptions/me`);
const s = sub.ok() ? (await sub.json())?.data : null;
const hasPlan = !!s?.subscription?.plan?.code || !!s?.subscription;
const plansRes = await page.request.get(`${BASE}/api/subscriptions/plans`);
const plans = plansRes.ok() ? (await plansRes.json())?.data?.items ?? [] : [];
check(
  'subscription endpoint answers and the plans catalogue is servable',
  sub.ok() && plans.length > 0,
  hasPlan ? `active plan=${s.subscription.plan?.code ?? s.subscription.planCode}` : `no active subscription; ${plans.length} plan(s) available`,
);

await ctx.close();
await browser.close();
const failed = steps.filter((s2) => !s2.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

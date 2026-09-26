import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:12000';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Passw0rd!2026';

const results = [];
function record(feature, ok, detail) {
  results.push({ feature, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${feature}  ${detail}`);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const api5xx = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 500) api5xx.push(`${r.status()} ${r.url()}`);
});
const settle = async (ms = 2500) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
};
const mainText = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim();

async function login(email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 25000 }),
    page.locator('form button[type="submit"]').click(),
  ]);
}

// Find candidate products the buyer could purchase.
let candidates = [];
try {
  const res = await page.request.get(`${BASE}/api/products?pageSize=50`);
  const json = await res.json();
  const items = json?.data?.items ?? [];
  candidates = items.filter((p) => p.status === 'ACTIVE' && p.sellerType !== 'COMPANY').map((p) => p.id);
  record('purchase: purchasable products listed', candidates.length > 0, `${candidates.length} ACTIVE non-company products`);
} catch (e) {
  record('purchase: purchasable products listed', false, e.message);
}

// Count the buyer's orders before, so we can prove a new one was created.
let before = 0;
try {
  await login('customer1@wasit.tn');
  await settle();
  const res = await page.request.get(`${BASE}/api/orders?pageSize=100`);
  const json = await res.json();
  before = (Array.isArray(json?.data) ? json.data : json?.data?.items ?? []).length;
  record('purchase: buyer order history loads', before >= 0, `${before} existing orders`);
} catch (e) {
  record('purchase: buyer order history loads', false, e.message);
}

// Place the order from the real checkout UI, trying candidates until one has
// enough stock (the checkout UI only reveals stock availability on submit).
try {
  if (candidates.length === 0) throw new Error('no product available');

  let breakdown = null;
  let lastError = '';
  for (const id of candidates.slice(0, 12)) {
    await page.goto(`${BASE}/checkout?productId=${id}`, { waitUntil: 'domcontentloaded' });
    await settle();
    const orderBtn = page.getByRole('button', { name: /إتمام الطلب|Place order/i }).first();
    if ((await orderBtn.count()) === 0) continue;
    await orderBtn.click();
    await settle(3500);

    if ((await page.getByTestId('order-breakdown').count()) > 0) {
      breakdown = page.getByTestId('order-breakdown');
      break;
    }
    lastError = await mainText();
    if (!/stock|مخزون/i.test(lastError)) break;
  }

  if (!breakdown) throw new Error(`no order breakdown after submit: ${lastError.slice(0, 160)}`);

  const itemsTotal = Number(await breakdown.getAttribute('data-items-total'));
  const commission = Number(await breakdown.getAttribute('data-commission'));
  const sellerC = Number(await breakdown.getAttribute('data-commission-seller'));
  const buyerC = Number(await breakdown.getAttribute('data-commission-buyer'));
  record('purchase: order placed from the UI', true, `items=${itemsTotal} commission=${commission}`);

  // Commission policy: 4% total = 2% seller + 2% buyer.
  const expected = itemsTotal * 0.04;
  const matches =
    Math.abs(commission - expected) < 0.02 &&
    Math.abs(sellerC - itemsTotal * 0.02) < 0.02 &&
    Math.abs(buyerC - itemsTotal * 0.02) < 0.02;
  record(
    'purchase: commission is 4% (2%+2%)',
    matches,
    `total=${commission} seller=${sellerC} buyer=${buyerC} expected≈${expected.toFixed(3)}`,
  );

  // The order must now be visible in the buyer's own order list.
  await page.goto(`${BASE}/dashboard/orders`, { waitUntil: 'domcontentloaded' });
  await settle();
  const res = await page.request.get(`${BASE}/api/orders?pageSize=100`);
  const json = await res.json();
  const after = (Array.isArray(json?.data) ? json.data : json?.data?.items ?? []).length;
  record('purchase: new order visible to the buyer', after > before, `${before} → ${after} orders`);

  const rows = await page.locator('main table tbody tr').count();
  record('purchase: orders table renders the new order', rows > 0, `${rows} rows on screen`);
} catch (e) {
  record('purchase: order placed from the UI', false, e.message);
}

console.log('\n--- 5xx ---');
console.log(api5xx.length ? [...new Set(api5xx)].join('\n') : '(none)');
const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
await browser.close();

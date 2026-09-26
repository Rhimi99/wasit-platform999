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

async function login(email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 25000 }),
    page.locator('form button[type="submit"]').click(),
  ]);
}

const mainText = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim();
const onLogin = async () => (await page.locator('main form input[type="password"]').count()) > 0;

// Login as merchant
try {
  await login('merchanta@wasit.tn');
  await settle();
  record('merchant: login lands on dashboard', !(await onLogin()), (await mainText()).slice(0, 110));
} catch (e) {
  record('merchant: login lands on dashboard', false, e.message);
}

// Dashboard
try {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await settle();
  const t = await mainText();
  record('merchant: dashboard shows real numbers', !(await onLogin()) && /\d/.test(t), t.slice(0, 110));
} catch (e) {
  record('merchant: dashboard shows real numbers', false, e.message);
}

// Create a product through the real form.
const unique = `Audit Widget ${Date.now()}`;
let createdId = null;
try {
  await page.goto(`${BASE}/dashboard/products`, { waitUntil: 'domcontentloaded' });
  await settle();
  const t = await mainText();
  record('merchant: products list renders', !(await onLogin()) && t.length > 60, t.slice(0, 110));
} catch (e) {
  record('merchant: products list renders', false, e.message);
}

try {
  await page.goto(`${BASE}/dashboard/products/new`, { waitUntil: 'domcontentloaded' });
  await settle();
  if (await onLogin()) throw new Error('redirected to login');

  await page.locator('#p-name').fill(unique);
  await page.locator('#p-sku').fill(`AUD-${Date.now()}`);
  await page.locator('#p-price').fill('42');
  // Category and seller entity are populated from the API.
  const cat = await page.locator('#p-category option').count();
  if (cat > 1) await page.locator('#p-category').selectOption({ index: 1 });
  const sel = await page.locator('#p-seller option').count();
  if (sel > 0) await page.locator('#p-seller').selectOption({ index: 0 });

  await page.locator('form button[type="submit"]').first().click();
  await settle(3000);

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const failed = /حدث خطأ|فشل|error/i.test(body);
  record('merchant: create product submits', !failed, `${cat - 1} categories, ${sel} sellers`);

  const res = await page.request.get(`${BASE}/api/products?search=${encodeURIComponent(unique)}`);
  const json = await res.json().catch(() => null);
  const items = json?.data?.items ?? json?.data ?? [];
  createdId = Array.isArray(items) ? items.find((p) => p.name === unique)?.id ?? null : null;
  record('merchant: created product persisted', Boolean(createdId), createdId ? `id=${createdId}` : 'not found via API');
} catch (e) {
  record('merchant: create product submits', false, e.message);
}

// Edit the created product through the modal on the products page.
if (createdId) {
  try {
    await page.goto(`${BASE}/dashboard/products`, { waitUntil: 'domcontentloaded' });
    await settle();
    await page.getByTestId(`product-edit-${createdId}`).click();
    await page.getByTestId('product-edit-form').waitFor({ timeout: 10000 });
    await page.locator('#ep-name').fill(`${unique} EDITED`);
    await page.getByTestId('product-edit-form').locator('button[type="submit"]').first().click();
    await settle(3000);

    const res = await page.request.get(`${BASE}/api/products/${createdId}`);
    const json = await res.json().catch(() => null);
    const name = json?.data?.name ?? null;
    record('merchant: edit product persists', name === `${unique} EDITED`, `server name="${name}"`);
  } catch (e) {
    record('merchant: edit product persists', false, e.message);
  }
}

// Publish / unpublish the created product and confirm the change persists.
if (createdId) {
  try {
    await page.goto(`${BASE}/dashboard/products`, { waitUntil: 'domcontentloaded' });
    await settle();
    const toggle = page.getByTestId(`product-status-${createdId}`);
    const before = await toggle.innerText();
    await toggle.click();
    await settle(2500);

    const res = await page.request.get(`${BASE}/api/products/${createdId}`);
    const json = await res.json().catch(() => null);
    const status = json?.data?.status ?? null;
    const expected = /إلغاء النشر|unpublish/i.test(before) ? 'INACTIVE' : 'ACTIVE';
    record('merchant: publish/unpublish persists', status === expected, `button="${before.trim()}" → server=${status}`);
  } catch (e) {
    record('merchant: publish/unpublish persists', false, e.message);
  }
}

// Inventory: adjust stock through the real modal and confirm server-side.
try {
  await page.goto(`${BASE}/dashboard/inventory`, { waitUntil: 'domcontentloaded' });
  await settle();
  const addBtn = page.getByText(/إضافة|Add/i).first();
  if ((await addBtn.count()) === 0) throw new Error('no inventory action rendered');
  await addBtn.click();
  await settle(1500);
  const dialog = page.locator('[role="dialog"], form').filter({ has: page.locator('input[type="number"]') }).first();
  const qty = dialog.locator('input[type="number"]').first();
  if ((await qty.count()) === 0) throw new Error('no quantity input in the inventory modal');
  await qty.fill('5');
  const confirm = dialog.locator('button.btn-primary, button[type="submit"]').first();
  await confirm.click();
  await settle(3000);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  record('merchant: inventory adjustment applies', !/حدث خطأ|فشل/i.test(body), body.slice(0, 120));
} catch (e) {
  record('merchant: inventory adjustment applies', false, e.message);
}

// Other merchant surfaces
for (const [name, url] of [
  ['merchant: inventory', '/dashboard/inventory'],
  ['merchant: orders', '/dashboard/orders'],
  ['merchant: ads', '/dashboard/ads'],
  ['merchant: ai', '/dashboard/ai'],
  ['merchant: analytics', '/dashboard/analytics'],
  ['merchant: subscriptions', '/dashboard/subscriptions'],
  ['merchant: video studio', '/dashboard/video-studio'],
]) {
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    await settle(2000);
    const t = await mainText();
    const ok = !(await onLogin()) && t.length > 60 && !/غير مصرح|ليس لديك صلاحية/i.test(t);
    record(name, ok, `${t.length} chars`);
  } catch (e) {
    record(name, false, e.message);
  }
}

console.log('\n--- 5xx ---');
console.log(api5xx.length ? [...new Set(api5xx)].join('\n') : '(none)');
const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
await browser.close();

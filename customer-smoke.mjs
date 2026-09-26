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

async function mainText() {
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ').trim();
}

// 1. Login
try {
  await login('customer1@wasit.tn');
  await settle();
  const t = await mainText();
  const leftLogin = (await page.locator('main form input[type="password"]').count()) === 0;
  record('customer: login lands on dashboard', leftLogin && t.length > 60, t.slice(0, 110));
} catch (e) {
  record('customer: login lands on dashboard', false, e.message);
}

// 2. Search — query a term that exists in the demo catalog.
try {
  await page.goto(`${BASE}/search?q=Olive`, { waitUntil: 'domcontentloaded' });
  await settle();
  const cards = await page.locator('main a[href*="/product"]').count();
  const t = await mainText();
  record('customer: search returns results', cards > 0, `${cards} product links`);
} catch (e) {
  record('customer: search returns results', false, e.message);
}

// 3. Browse marketplace
try {
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'domcontentloaded' });
  await settle();
  const links = await page.locator('main a[href*="/product"]').count();
  record('customer: marketplace lists products', links > 0, `${links} product links`);
} catch (e) {
  record('customer: marketplace lists products', false, e.message);
}

// 4. Product detail
try {
  await page.goto(`${BASE}/marketplace`, { waitUntil: 'domcontentloaded' });
  await settle();
  const first = page.locator('main a[href*="/product"]').first();
  const href = await first.getAttribute('href');
  await first.click();
  await settle();
  const t = await mainText();
  const canonical = await page.locator('link[rel="canonical"]').count();
  record('customer: product detail opens', /\/product/.test(page.url()) && t.length > 80, `${href} canonical=${canonical}`);
} catch (e) {
  record('customer: product detail opens', false, e.message);
}

// 5. Orders
try {
  await page.goto(`${BASE}/dashboard/orders`, { waitUntil: 'domcontentloaded' });
  await settle();
  const rows = await page.locator('main table tbody tr').count();
  const t = await mainText();
  const leftLogin = (await page.locator('main form input[type="password"]').count()) === 0;
  record('customer: orders page renders', leftLogin && rows > 0, `${rows} rows`);
} catch (e) {
  record('customer: orders page renders', false, e.message);
}

// 6. Notifications — delivered by the header bell, not a standalone route.
try {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await settle();
  const bell = page.locator('button[aria-label="الإشعارات"], button[aria-label="Notifications"]').first();
  if ((await bell.count()) === 0) throw new Error('no notifications bell in the header');
  await bell.click();
  await settle(1500);
  // The dropdown lives in the header, so read the whole page, not just <main>.
  const panel = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const opened = /لا توجد إشعارات|تحديد الكل|No notifications|Mark all/.test(panel);
  record('customer: notifications bell opens', opened, opened ? 'dropdown rendered' : panel.slice(0, 120));
} catch (e) {
  record('customer: notifications bell opens', false, e.message);
}

// 7. Messages
try {
  await page.goto(`${BASE}/dashboard/messages`, { waitUntil: 'domcontentloaded' });
  await settle();
  const leftLogin = (await page.locator('main form input[type="password"]').count()) === 0;
  const t = await mainText();
  record('customer: messages page renders', leftLogin && t.length > 60, t.slice(0, 100));
} catch (e) {
  record('customer: messages page renders', false, e.message);
}

console.log('\n--- 5xx ---');
console.log(api5xx.length ? [...new Set(api5xx)].join('\n') : '(none)');
const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
await browser.close();

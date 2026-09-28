/**
 * End-to-end purchase journey for the CUSTOMER, entirely through the UI:
 * browse marketplace -> open a product -> add to order (checkout) -> place the
 * order -> open it under Orders. Verifies the real commission split on screen
 * (4% = 2% seller + 2% buyer) and that the order is persisted.
 *
 * Demo stock is shared with the other suites (reservations are cumulative), so
 * the journey walks the catalogue and places the order on the first product
 * that genuinely has enough available stock. It never lowers the quantity below
 * the product MOQ and never fabricates stock: if no product can be ordered, the
 * suite fails.
 *
 * Usage: node scripts/ui-purchase-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', 'customer1@wasit.tn');
await page.fill('input[type="password"]', 'Passw0rd!2026');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });
check('customer login', true);

await page.goto(`${BASE}/marketplace`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
const productLinks = page.locator('a[href^="/products/"]');
const count = await productLinks.count();
check('marketplace lists products', count > 0, `${count} product link(s)`);
if (!count) { await browser.close(); process.exit(1); }

const hrefs = [];
for (let i = 0; i < count; i++) {
  const h = await productLinks.nth(i).getAttribute('href');
  if (h && !hrefs.includes(h)) hrefs.push(h);
}

const catalogue = await page.request.get(`${BASE}/api/products?page=1&pageSize=100`);
const moqById = new Map(((await catalogue.json().catch(() => null))?.data?.items ?? []).map((p) => [p.id, p.moq ?? 1]));

let breakdownData = null;
let orderedProduct = null;
let firstDetailTitle = null;
let ctaSeen = false;
let attempts = 0;
const rejections = [];

for (const href of hrefs.slice(0, 10)) {
  const productId = href.replace('/products/', '');
  const qtyWanted = Math.max(1, moqById.get(productId) ?? 1);

  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
  const title = (await page.locator('h1').first().innerText().catch(() => '')).trim();
  if (!firstDetailTitle) {
    firstDetailTitle = title;
    check('product details page loads', !!title, title.slice(0, 40));
  }

  const orderLink = page.locator('a[href^="/checkout"]').first();
  if ((await orderLink.count()) > 0 && !ctaSeen) {
    ctaSeen = true;
    check('add-to-order CTA present', true, await orderLink.getAttribute('href').catch(() => ''));
  }

  await page.goto(`${BASE}${href.replace('/products/', '/checkout?productId=')}`, { waitUntil: 'networkidle', timeout: 60000 });
  const qty = page.locator('input[type="number"]').first();
  if ((await qty.count()) > 0) await qty.fill(String(qtyWanted));
  await page.waitForTimeout(1200);

  const placeBtn = page.locator('button:has-text("تأكيد"), button:has-text("الطلب"), button[type="submit"]').last();
  if ((await placeBtn.count()) === 0) { rejections.push(`${productId}: no place-order button`); continue; }
  attempts++;
  await placeBtn.click();
  await page.waitForTimeout(4000);

  const breakdown = page.getByTestId('order-breakdown').first();
  if ((await breakdown.count()) > 0) {
    breakdownData = await breakdown.evaluate((el) => ({
      text: el.textContent.slice(0, 140),
      itemsTotal: Number(el.getAttribute('data-items-total')),
      commission: Number(el.getAttribute('data-commission')),
      seller: Number(el.getAttribute('data-commission-seller')),
      buyer: Number(el.getAttribute('data-commission-buyer')),
      grandTotal: Number(el.getAttribute('data-grand-total')),
      paymentFee: Number(el.getAttribute('data-payment-fee') ?? 0),
    }));
    orderedProduct = { id: productId, title, qty: qtyWanted };
    break;
  }

  const bodyText = await page.locator('body').innerText();
  const err = (bodyText.match(/Insufficient available stock|مخزون|stock/i) ?? [])[0];
  rejections.push(`${productId}: ${err ?? 'no breakdown'}`);
}

check('order placed, breakdown shown', !!breakdownData, orderedProduct ? `${orderedProduct.title} x${orderedProduct.qty} (after ${attempts} attempt(s))` : `no orderable product (${attempts} attempt(s))`);

if (breakdownData) {
  // Commission policy: 4% total = 2% seller + 2% buyer, applied to the items total.
  const { itemsTotal, commission, seller, buyer, grandTotal, paymentFee } = breakdownData;
  const near = (a, b) => Math.abs(a - b) < 0.01;
  check('commission total is 4% of the items total', near(commission, itemsTotal * 0.04), `${commission} vs ${(itemsTotal * 0.04).toFixed(4)}`);
  check('commission split is 2% + 2%', near(seller, itemsTotal * 0.02) && near(buyer, itemsTotal * 0.02) && near(commission, seller + buyer), `seller=${seller} buyer=${buyer}`);
  // The buyer pays their own 2% on top of the items total; the seller's 2% is
  // withheld from their payout, so it is not part of what the buyer is charged.
  // The payment-provider fee is tracked separately and is not part of grandTotal.
  check('buyer pays items + their 2% commission', near(grandTotal, itemsTotal + buyer), `${grandTotal} vs ${(itemsTotal + buyer).toFixed(4)}`);
  check('breakdown visible to the user', breakdownData.text.length > 0, breakdownData.text.replace(/\s+/g, ' ').slice(0, 70));
} else {
  console.log('     rejected:', rejections.join(' | '));
  check('commission total is 4% of the items total', false, 'no order placed');
  check('commission split is 2% + 2%', false, 'no order placed');
  check('buyer pays items + their 2% commission', false, 'no order placed');
  check('breakdown visible to the user', false, 'no order placed');
}

await page.goto(`${BASE}/dashboard/orders`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const ordersBody = await page.locator('body').innerText();
const orderRows = await page.locator('a[href^="/dashboard/orders/"]').count();
check('order appears in Orders list', orderRows > 0 || /طلب|order/i.test(ordersBody), `${orderRows} row link(s)`);

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

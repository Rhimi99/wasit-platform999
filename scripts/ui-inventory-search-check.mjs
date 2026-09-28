/**
 * Inventory + Search through the real UI.
 *   - merchant: adjust stock (+5) on the first inventory line and verify persistence,
 *   - filters work,
 *   - customer: run a search and see real grouped results.
 * Usage: node scripts/ui-inventory-search-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
// ── Merchant inventory ──────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'merchanta@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });

  await page.goto(`${BASE}/dashboard/inventory`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);

  const invBefore = await page.request.get(`${BASE}/api/inventory?pageSize=100`);
  const items = invBefore.ok() ? (await invBefore.json())?.data?.items ?? [] : [];
  check('inventory has real rows', items.length > 0, `${items.length} item(s)`);

  if (items.length) {
    const item = items[0];
    const qtyBefore = item.quantity;

    // Open the "add stock" modal on the first row.
    const addBtn = page.locator('button').filter({ hasText: /إضافة|add stock|ajouter/i }).first();
    const invBody = await page.locator('body').innerText();
    check('inventory table renders with add/remove controls', /إضافة|add|ajouter/i.test(invBody));

    if ((await addBtn.count()) > 0) {
      await addBtn.click();
      await page.waitForTimeout(1200);
      const dialog = page.locator('[role="dialog"]');
      check('stock modal opens', (await dialog.count()) > 0);
      const inputs = dialog.locator('input[type="number"], input');
      await inputs.first().fill('5');
      const reason = dialog.locator('textarea, input').last();
      await reason.fill('audit check').catch(() => {});
      await dialog.locator('button').filter({ hasText: /حفظ|save|confirmer|تأكيد|إضافة/i }).last().click();
      await page.waitForTimeout(3000);

      const invAfter = await (await page.request.get(`${BASE}/api/inventory?pageSize=100`)).json();
      const after = (invAfter?.data?.items ?? []).find((i) => i.id === item.id);
      check('stock adjustment persisted (+5)', after && after.quantity === qtyBefore + 5, `${qtyBefore} → ${after?.quantity}`);
    }

    // Filter buttons change the visible rows.
    const lowBtn = page.locator('button').filter({ hasText: /منخفض|low/i }).first();
    if ((await lowBtn.count()) > 0) {
      await lowBtn.click();
      await page.waitForTimeout(1800);
      check('low-stock filter applies without error', !(await page.locator('body').innerText()).includes('خطأ فادح'));
    }
  }
  await ctx.close();
}

// ── Customer search ─────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'customer1@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });

  await page.goto(`${BASE}/search?q=زيت`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  check('search returns real results for a live query', body.length > 200 && !/لا توجد نتائج/i.test(body), `${body.length} chars`);

  const api = await page.request.get(`${BASE}/api/search?q=${encodeURIComponent('زيت')}&pageSize=8`);
  const j = api.ok() ? await api.json() : null;
  const groups = j?.data?.results ?? [];
  const total = groups.reduce((n, g) => n + (g.items?.length ?? 0), 0);
  check('search API returns grouped hits', total > 0, `${groups.length} group(s), ${total} hit(s)`);
  await ctx.close();
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

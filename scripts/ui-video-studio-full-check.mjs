/**
 * Marketing Video Studio — full UI flow: product, language, audience, style,
 * duration, Generate, wait for a READY asset, preview, download, delete.
 * Uses the merchant demo account. Deletes only the asset it just created.
 * Usage: node scripts/ui-video-studio-full-check.mjs <baseURL>
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

await page.goto(`${BASE}/dashboard/video-studio`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

// Product selection is a real list of the merchant's products.
const productSel = page.getByTestId('studio-product');
check('product selector renders', (await productSel.count()) > 0);
const productOptions = await productSel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
check('product list is populated from the backend', productOptions.length > 0, `${productOptions.length} product(s)`);
if (productOptions.length) await productSel.selectOption(productOptions[0]);

// Language / audience / style / duration are all real controls.
await page.getByTestId('studio-language').selectOption('fr');
await page.getByTestId('studio-audience').selectOption('B2C');
await page.getByTestId('studio-style').selectOption('BOLD');
await page.getByTestId('studio-duration').fill('35');
check('language/audience/style/duration settable',
  (await page.getByTestId('studio-language').inputValue()) === 'fr' &&
  (await page.getByTestId('studio-audience').inputValue()) === 'B2C' &&
  (await page.getByTestId('studio-style').inputValue()) === 'BOLD' &&
  (await page.getByTestId('studio-duration').inputValue()) === '35');

const beforeIds = (await (await page.request.get(`${BASE}/api/media/assets?kind=MARKETING_VIDEO&limit=50`)).json())?.data?.items?.map((a) => a.id) ?? [];

await page.getByTestId('studio-generate').click();

// Wait for a user-visible outcome (notice or error).
let notice = '', error = '';
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1500);
  notice = await page.getByTestId('studio-notice').innerText().catch(() => '');
  error = await page.getByTestId('studio-error').innerText().catch(() => '');
  if (notice || error) break;
}
check('generate yields a user-visible result', !!(notice || error), notice || error);

// Wait for the READY asset to appear in the list (real server-side generation).
let asset = null;
for (let i = 0; i < 30; i++) {
  const items = (await (await page.request.get(`${BASE}/api/media/assets?kind=MARKETING_VIDEO&limit=50`)).json())?.data?.items ?? [];
  asset = items.find((a) => !beforeIds.includes(a.id));
  if (asset && asset.status === 'READY') break;
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'networkidle' });
}
check('a new video asset reaches READY', asset?.status === 'READY', asset ? `id=${asset.id} status=${asset.status} provider=${asset.provider}` : 'no new asset');

if (asset) {
  const card = page.getByTestId(`studio-asset-${asset.id}`);
  check('asset card appears in the UI', (await card.count()) > 0);

  if (asset.previewable) {
    const preview = page.getByTestId(`studio-preview-${asset.id}`);
    check('preview element renders for the asset', (await preview.count()) > 0);
    const src = (await preview.getAttribute('src')) ?? '';
    const probe = await page.request.get(src.startsWith('http') ? src : `${BASE}${src}`);
    check('preview URL serves real video bytes', probe.ok(), `status ${probe.status()}`);
  }

  const dl = page.getByTestId(`studio-download-${asset.id}`);
  if ((await dl.count()) > 0) {
    const href = (await dl.getAttribute('href')) ?? '';
    const resp = await page.request.get(href.startsWith('http') ? href : `${BASE}${href}`);
    const body = await resp.body();
    check('download link serves a real non-empty MP4', resp.ok() && body.length > 10000, `${body.length} bytes`);
  } else {
    check('download control present', false);
  }

  // Delete the asset we created and confirm it is gone from the UI and the API.
  await page.getByTestId(`studio-delete-${asset.id}`).click();
  await page.waitForTimeout(4000);
  const cardGone = (await page.getByTestId(`studio-asset-${asset.id}`).count()) === 0;
  const items = (await (await page.request.get(`${BASE}/api/media/assets?kind=MARKETING_VIDEO&limit=50`)).json())?.data?.items ?? [];
  const row = items.find((a) => a.id === asset.id);
  const softDeleted = !row || row.status === 'DELETED';
  check('delete removes the created asset from the UI', cardGone, cardGone ? 'card removed' : 'card still shown');
  check('delete clears the asset server-side', softDeleted, row ? `status=${row.status}` : 'not listed');
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

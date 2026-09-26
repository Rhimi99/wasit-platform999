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

await login('merchanta@wasit.tn');
await page.goto(`${BASE}/dashboard/video-studio`, { waitUntil: 'domcontentloaded' });
await settle();

// 1. Select a product.
const productSel = page.getByTestId('studio-product');
const productOpts = await productSel.locator('option').count();
if (productOpts > 1) await productSel.selectOption({ index: 1 });
record('video: select product', productOpts > 1, `${productOpts - 1} products available`);

// 2. Select a language.
const langSel = page.getByTestId('studio-language');
const langOpts = await langSel.locator('option').count();
if (langOpts > 1) await langSel.selectOption({ index: 1 });
record('video: select language', langOpts > 1, `${langOpts - 1} languages available`);

// 3. Select an audience.
const audSel = page.getByTestId('studio-audience');
const audOpts = await audSel.locator('option').count();
if (audOpts > 1) await audSel.selectOption({ index: 1 });
record('video: select audience', audOpts > 1, `${audOpts - 1} audiences available`);

// 4. Select a style.
const styleSel = page.getByTestId('studio-style');
const styleOpts = await styleSel.locator('option').count();
if (styleOpts > 1) await styleSel.selectOption({ index: 1 });
record('video: select style', styleOpts > 1, `${styleOpts - 1} styles available`);

// 5. Set duration within the allowed range.
const durInput = page.getByTestId('studio-duration');
const min = Number(await durInput.getAttribute('min'));
const max = Number(await durInput.getAttribute('max'));
const chosen = Math.min(Math.max(15, min), max);
await durInput.fill(String(chosen));
record('video: set duration', (await durInput.inputValue()) === String(chosen), `set ${chosen}s (range ${min}-${max})`);

// Capture the library size before generating.
const libraryBefore = await page.locator('[data-testid^="studio-asset-"]').count();

// 6. Generate.
await page.getByTestId('studio-generate').click();
await page.getByTestId('studio-notice').waitFor({ timeout: 30000 }).catch(() => {});
await settle(2000);
const notice = await page.getByTestId('studio-notice').innerText().catch(() => '');
const errText = await page.getByTestId('studio-error').innerText().catch(() => '');
record('video: generate submits', notice.length > 0 && errText.length === 0, `notice="${notice}" error="${errText}"`);

// 7. Wait for the asset to reach READY and appear.
let readyId = null;
for (let i = 0; i < 20; i++) {
  await settle(1500);
  const ready = page.locator('[data-testid^="studio-asset-"]').filter({ hasText: 'READY' }).last();
  if ((await ready.count()) > 0) {
    const testid = await ready.getAttribute('data-testid');
    readyId = testid?.replace('studio-asset-', '') ?? null;
    if (readyId) break;
  }
}
record('video: generation reaches READY', Boolean(readyId), readyId ? `asset=${readyId}` : 'no READY asset within ~30s');

// 8. Preview renders.
if (readyId) {
  const preview = page.getByTestId(`studio-preview-${readyId}`);
  const hasPreview = (await preview.count()) > 0;
  const src = hasPreview ? await preview.getAttribute('src') : null;
  record('video: preview renders', hasPreview && Boolean(src), src ? `src=${src.slice(0, 60)}` : 'no preview element');

  // 9. Download link resolves to real bytes.
  const dl = page.getByTestId(`studio-download-${readyId}`);
  const href = (await dl.count()) > 0 ? await dl.getAttribute('href') : null;
  let ok = false;
  let detail = 'no download link';
  if (href) {
    const url = href.startsWith('http') ? href : `${BASE}${href}`;
    const resp = await page.request.get(url);
    const len = Number(resp.headers()['content-length'] ?? 0);
    const buf = await resp.body();
    ok = resp.status() === 200 && buf.length > 0;
    detail = `status=${resp.status()} bytes=${buf.length}${len ? ` (declared ${len})` : ''}`;
  }
  record('video: download returns real bytes', ok, detail);

  // 10. Delete removes it from the library.
  await page.getByTestId(`studio-delete-${readyId}`).click();
  await settle(3000);
  const stillThere = await page.getByTestId(`studio-asset-${readyId}`).count();
  record('video: delete removes the asset', stillThere === 0, stillThere === 0 ? 'asset removed from library' : 'asset still rendered');
} else {
  record('video: preview renders', false, 'skipped — no READY asset');
  record('video: download returns real bytes', false, 'skipped — no READY asset');
  record('video: delete removes the asset', false, 'skipped — no READY asset');
}

console.log('\n--- 5xx ---');
console.log(api5xx.length ? [...new Set(api5xx)].join('\n') : '(none)');
const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
await browser.close();

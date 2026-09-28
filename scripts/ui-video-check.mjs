/**
 * Real Marketing Video Studio journey through the UI on the public demo:
 * pick product → language → audience → style → duration → Generate →
 * wait READY → preview → download → delete. No mocks; the offline structural
 * renderer writes a real MP4.
 * Usage: node scripts/ui-video-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const EMAIL = process.argv[3] ?? 'merchanta@wasit.tn';
const PASSWORD = process.argv[4] ?? 'Passw0rd!2026';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const steps = [];
const check = (name, pass, detail = '') => {
  steps.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. Real UI login as the merchant fixture.
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });
check('login as merchant reaches dashboard', /dashboard/.test(page.url()), page.url());

// 2. Open the Studio.
await page.goto(`${BASE}/dashboard/video-studio`, { waitUntil: 'networkidle', timeout: 60000 });
const product = page.getByTestId('studio-product');
await product.waitFor({ timeout: 30000 });
const options = await product.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
check('product list is populated from real ACTIVE products', options.length > 0, `${options.length} option(s)`);

// 3. Fill every input the spec calls for.
await product.selectOption(options[0]);
await page.getByTestId('studio-language').selectOption('fr');
await page.getByTestId('studio-audience').selectOption('B2C');
await page.getByTestId('studio-style').selectOption('BOLD');
await page.getByTestId('studio-duration').fill('45');
check('language/audience/style/duration set', true, 'fr / B2C / BOLD / 45s');

// 4. Generate — the real POST + render.
const t0 = Date.now();
await page.getByTestId('studio-generate').click();
await page.getByTestId('studio-notice').waitFor({ timeout: 120000 });
check('generate returns a user-visible confirmation', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
check('no error notice shown', (await page.getByTestId('studio-error').count()) === 0);

// 5. The generation must be terminal (READY), not a perpetual spinner.
const assets = await (await page.request.get(`${BASE}/api/media/assets?kind=MARKETING_VIDEO&limit=50`)).json();
const items = assets?.data?.items ?? [];
const created = items.find((a) => a.language === 'fr' && a.durationSeconds === 45 && a.status !== 'DELETED');
check('video asset exists server-side', !!created, created ? `id=${created.id} status=${created.status}` : 'not found');
if (created) {
  check('asset is READY (terminal)', created.status === 'READY', created.status);
  check('asset is a real MP4 with bytes', created.mimeType === 'video/mp4' && created.sizeBytes > 0, `${created.mimeType} ${created.sizeBytes}B`);
  check('asset is previewable', created.previewable === true);
  check('downloadUrl present', !!created.downloadUrl, created.downloadUrl ?? '');
}

// 6. Preview in the UI, then download the real bytes.
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
const createdId = created?.id;
if (createdId) {
  const preview = page.getByTestId(`studio-preview-${createdId}`);
  const hasPreview = (await preview.count()) > 0;
  check('video element renders in the list', hasPreview);
  if (hasPreview) {
    await preview.scrollIntoViewIfNeeded();
    check('video has a playable src', !!(await preview.getAttribute('src')));
  }
  const dlUrl = created.downloadUrl;
  const resp = await page.request.get(dlUrl.startsWith('http') ? dlUrl : `${BASE}${dlUrl}`);
  const buf = await resp.body();
  const isMp4 = buf.length > 12 && buf.slice(4, 8).toString('ascii') === 'ftyp';
  check('download returns real MP4 bytes', resp.ok() && isMp4, `${resp.status()} ${buf.length}B`);

  // 7. Delete through the UI.
  const delBtn = page.getByTestId(`studio-delete-${createdId}`);
  if ((await delBtn.count()) > 0) {
    await delBtn.click();
    await page.waitForTimeout(2500);
    const after = await (await page.request.get(`${BASE}/api/media/assets?kind=MARKETING_VIDEO&limit=50`)).json();
    const still = (after?.data?.items ?? []).find((a) => a.id === createdId && a.status !== 'DELETED');
    check('delete removes the asset from the active list', !still, still ? still.status : 'gone');
  } else {
    check('delete button present', false);
  }
}

await browser.close();
const failed = steps.filter((s) => !s.pass).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

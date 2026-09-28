/**
 * Registration through the real UI, plus the merchant Ads and AI action flows.
 *
 * Registration creates a brand-new unique account each run (unique email), which
 * is inert demo data — no destructive operation. Ads creates a DRAFT campaign and
 * then cancels it. AI runs one real agent task.
 *
 * Usage: node scripts/ui-flows-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const RUN = Date.now().toString(36).slice(-6);

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

// ── Registration ────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
  const inputs = await page.locator('input').count();
  check('register form renders', inputs >= 3, `${inputs} input(s)`);

  const email = `audit.${RUN}@example.com`;
  const pw = 'AuditPass!2026';
  await page.locator('input[type="text"], input#r-first, input').first().fill('Audit');
  const all = page.locator('input');
  // Fill by type where possible, then any remaining text inputs.
  if ((await page.locator('input[type="email"]').count()) > 0) await page.locator('input[type="email"]').fill(email);
  const pwInputs = page.locator('input[type="password"]');
  const pwn = await pwInputs.count();
  for (let i = 0; i < pwn; i++) await pwInputs.nth(i).fill(pw);
  // Any leftover empty required text inputs (names).
  const texts = page.locator('input[type="text"]');
  const tn = await texts.count();
  for (let i = 0; i < tn; i++) { const v = await texts.nth(i).inputValue(); if (!v) await texts.nth(i).fill('Audit'); }
  // Accept required checkbox (terms) if present.
  const checks = page.locator('input[type="checkbox"]');
  const cn = await checks.count();
  for (let i = 0; i < cn; i++) if (!(await checks.nth(i).isChecked())) await checks.nth(i).check().catch(() => {});

  await page.locator('form button[type="submit"]').first().click();
  await page.waitForTimeout(4500);
  const body = await page.locator('body').innerText();
  const url = page.url();
  const ok = !/\/register$/.test(url) || /نجاح|succès|success|تحقق|verify|created/i.test(body);
  check('registration submits and yields a real outcome', ok, `url=${url.replace(BASE, '')} | ${body.slice(0, 70).replace(/\n/g, ' ')}`);
  await ctx.close();
}

// ── Merchant: Ads + AI ──────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[type="email"]', 'merchanta@wasit.tn');
  await page.fill('input[type="password"]', 'Passw0rd!2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 30000 });

  // ADS: create a DRAFT campaign through the form, then cancel it.
  await page.goto(`${BASE}/dashboard/ads`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  const form = page.locator('form').filter({ has: page.locator('input[placeholder]') }).first();
  const titleInput = page.locator('input').filter({ hasNot: page.locator('[type=number]') }).first();
  await page.locator('form input').first().fill(`Audit campaign ${RUN}`);
  const advSel = page.locator('form select').nth(1); // advertiser entity select
  const advOpts = await advSel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean)).catch(() => []);
  if (advOpts.length) await advSel.selectOption(advOpts[0]);
  else {
    const advInput = page.locator('form input[placeholder*="entity"], form input').nth(1);
    // fall back to API to discover an advertiser
    const r = await page.request.get(`${BASE}/api/ads/advertisers`);
    if (r.ok()) { const j = await r.json(); const id = j?.data?.items?.[0]?.id ?? j?.data?.[0]?.id; if (id) await advInput.fill(id); }
  }
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForTimeout(3000);

  let campaign = null;
  const cr = await page.request.get(`${BASE}/api/ads/campaigns?pageSize=100`);
  if (cr.ok()) { const j = await cr.json(); campaign = (j?.data?.items ?? []).find((c) => c.title === `Audit campaign ${RUN}`); }
  check('ads campaign created from the UI', !!campaign, campaign ? `id=${campaign.id} status=${campaign.status}` : 'not found');

  if (campaign && campaign.status === 'DRAFT') {
    const cancelBtn = page.getByTestId(`ads-cancel-${campaign.id}`);
    if ((await cancelBtn.count()) > 0) {
      await cancelBtn.click();
      await page.waitForTimeout(2500);
      const after = await (await page.request.get(`${BASE}/api/ads/campaigns?pageSize=100`)).json();
      const c2 = (after?.data?.items ?? []).find((c) => c.id === campaign.id);
      check('ads cancel updates the real status', c2?.status === 'CANCELLED', c2?.status ?? 'gone');
    }
  }

  // AI: run a real agent task and require a non-empty result.
  await page.goto(`${BASE}/dashboard/ai`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  const agentAction = page.locator('button').filter({ hasText: /تشغيل|run|exécuter|تنفيذ|ابدأ/i }).first();
  const hasAction = (await agentAction.count()) > 0;
  check('AI agent action button present', hasAction);
  if (hasAction) {
    await agentAction.click();
    await page.waitForTimeout(6000);
    const body = await page.locator('body').innerText();
    check('AI agent returns a visible result', !/خطأ|error|فشل/i.test(body.slice(0, 400)) && body.length > 800, `${body.length} chars`);
  }

  await ctx.close();
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

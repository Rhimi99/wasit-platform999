/**
 * Messaging + notifications through the real UI.
 *   - open the demo thread as customer1 (listed by the other participant's name),
 *   - send a real message, verify it renders and is persisted,
 *   - open the notifications bell and exercise "mark all read".
 * Usage: node scripts/ui-messages-check.mjs <baseURL>
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:12000').replace(/\/+$/, '');
const steps = [];
const check = (n, ok, d = '') => { steps.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const RUN = Date.now().toString(36).slice(-6);
const MSG = `رسالة تدقيق ${RUN}`;

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[type="email"]', 'customer1@wasit.tn');
await page.fill('input[type="password"]', 'Passw0rd!2026');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });

const threadsRes = await page.request.get(`${BASE}/api/messages`);
const threads = threadsRes.ok() ? (await threadsRes.json())?.data?.items ?? [] : [];
check('customer has a real thread', threads.length > 0, `${threads.length} thread(s)`);
const threadId = threads[0]?.id;

await page.goto(`${BASE}/dashboard/messages`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const listBody = await page.locator('body').innerText();
check('thread is listed in the UI', /suppliera@wasit\.tn|استفسار|زيت/.test(listBody));

const threadBtn = page.locator('button').filter({ hasText: /suppliera@wasit\.tn|استفسار|زيت/ }).first();
if ((await threadBtn.count()) > 0) {
  await threadBtn.click();
  await page.waitForTimeout(2500);
  const textarea = page.locator('textarea').first();
  check('composer opens for the thread', (await textarea.count()) > 0);

  await textarea.fill(MSG);
  await page.locator('button').filter({ hasText: /إرسال|send|envoyer|发送/ }).last().click();
  await page.waitForTimeout(3000);

  const body = await page.locator('body').innerText();
  check('sent message renders in the conversation', body.includes(MSG), body.includes(MSG) ? 'visible' : 'not visible');

  const detailRes = await page.request.get(`${BASE}/api/messages/${threadId}`);
  let persisted = false;
  if (detailRes.ok()) {
    const j = await detailRes.json();
    const msgs = (j?.data?.messages ?? j?.data?.items ?? []);
    persisted = msgs.some((m) => m.body === MSG);
  }
  check('message persisted server-side', persisted, persisted ? 'found in thread' : `status ${detailRes.status()}`);
} else {
  check('conversation is openable', false, 'no thread button matched');
}

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('button').filter({ hasText: '🔔' }).first().click();
await page.waitForTimeout(1500);
check('notifications panel opens with content', /إشعار|notification|لا توجد/i.test(await page.locator('body').innerText()));
const markAll = page.locator('button').filter({ hasText: /تحديد الكل|mark all|tout marquer/i }).first();
if ((await markAll.count()) > 0) {
  await markAll.click();
  await page.waitForTimeout(2000);
  const cnt = await page.request.get(`${BASE}/api/notifications/unread-count`);
  const j = cnt.ok() ? await cnt.json() : null;
  check('mark-all-read clears the unread counter', (j?.data?.count ?? 1) === 0, `unread=${j?.data?.count}`);
} else {
  check('mark-all control present', false);
}

await browser.close();
const failed = steps.filter((s) => !s.ok).length;
console.log(`\n=== ${steps.length - failed}/${steps.length} checks passed ===`);
process.exit(failed ? 1 : 0);

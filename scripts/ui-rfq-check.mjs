/**
 * B2B-01 phase 2 — real-browser verification of the RFQ screens.
 *
 * Runs against a live API and the real Vite app; no mocks, no route interception.
 * The only steps done over the API are the ones that depend on the seller
 * directory (sending invitations) and account creation — every RFQ action the
 * user can take is clicked in the UI.
 *
 * Usage (from the repository root):
 *   # 1. disposable database: CREATE DATABASE wasit_ui, then migrate + seed it
 *   DATABASE_URL=postgresql://…/wasit_ui npx drizzle-kit migrate   (in packages/server)
 *   DATABASE_URL=postgresql://…/wasit_ui npx tsx src/scripts/seed.ts
 *   # 2. API with email verification skipped and generous rate limits
 *   PORT=3100 NODE_ENV=development DEMO_SKIP_EMAIL_VERIFICATION=true \
 *     DEMO_PAYMENT_MODE=true RATE_LIMIT_LOGIN_MAX=500 RATE_LIMIT_REGISTER_MAX=200 \
 *     DATABASE_URL=postgresql://…/wasit_ui npx tsx src/index.ts      (in packages/server)
 *   # 3. web on 5199 proxying to it
 *   WEB_PROXY_TARGET=http://localhost:3100 npx vite --port 5199     (in packages/web)
 *   # 4. run the checks
 *   node scripts/ui-rfq-check.mjs
 *
 * Every line prints ✓/✗ and the process exits non-zero on the first failure count.
 */
import { chromium } from 'playwright';

const WEB = 'http://127.0.0.1:5199';
const API = 'http://127.0.0.1:3100';

let failures = 0;
function check(label, condition, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

function apiClient() {
  let cookie = '';
  return {
    async req(path, { method = 'GET', body } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const raw of setCookie) cookie = raw.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
      return { status: res.status, data };
    },
  };
}

const stamp = Date.now();
async function register(role, label) {
  const client = apiClient();
  const email = `rfqui-${label}-${stamp}@wasit.tn`;
  const password = 'StrongPass123!';
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password, firstName: 'UI', lastName: label, role },
  });
  if (reg.status !== 201) throw new Error(`register ${role} ${reg.status} ${JSON.stringify(reg.data)}`);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password, allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`login ${role} ${login.status}`);
  const me = await client.req('/api/auth/me');
  return { client, email, password, userId: me.data.data.id };
}

async function login(page, email, password) {
  await page.goto(`${WEB}/login`);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
}

const browser = await chromium.launch();

try {
  console.log('Setup — accounts and entities');
  const company = await register('COMPANY', 'buyer');
  const sellerA = await register('SUPPLIER', 'sellera');
  const sellerB = await register('MERCHANT', 'sellerb');

  const companyId = (await company.client.req('/api/companies', { method: 'POST', body: { legalName: 'Achats Atlas SARL' } })).data.data.id;
  const sellerAId = (await sellerA.client.req('/api/suppliers', { method: 'POST', body: { companyName: 'Verre du Sud' } })).data.data.id;
  const sellerBId = (await sellerB.client.req('/api/merchants', { method: 'POST', body: { storeName: 'Commerce Nour' } })).data.data.id;
  check('company entity created', Boolean(companyId));

  for (const seller of [sellerA, sellerB]) {
    const consent = await seller.client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'RFQ_PARTICIPATION', granted: true },
    });
    check(`consent granted (${seller.email.split('@')[0]})`, consent.status === 200, String(consent.status));
  }

  // ---------------------------------------------------------------- buyer UI
  console.log('Buyer — create a request through the form');
  const buyerPage = await browser.newPage({ locale: 'ar-TN' });
  const buyerErrors = [];
  buyerPage.on('pageerror', (e) => buyerErrors.push(String(e)));
  await login(buyerPage, company.email, company.password);

  await buyerPage.goto(`${WEB}/dashboard/rfqs`);
  await buyerPage.getByTestId('rfq-new').click();
  await buyerPage.locator('#rfq-title').fill('تزويد زجاجات موسم الصيف');
  await buyerPage.locator('#rfq-needed').fill('2026-12-20');
  await buyerPage.getByLabel('اسم البند').first().fill('زجاجات 75 سل');
  await buyerPage.getByLabel('الكمية').first().fill('500');
  await buyerPage.getByLabel('السعر المستهدف').first().fill('1.250');
  await buyerPage.getByTestId('rfq-create').click();
  await buyerPage.getByTestId('rfq-created').waitFor({ timeout: 20000 });
  const createdText = await buyerPage.getByTestId('rfq-created').innerText();
  check('draft created and confirmed in the UI', /RFQ-/.test(createdText), createdText);

  await buyerPage.getByRole('link', { name: 'فتح الطلب' }).click();
  await buyerPage.waitForURL(/\/dashboard\/rfqs\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const rfqId = buyerPage.url().split('/').pop();
  await buyerPage.getByTestId('rfq-items').waitFor();
  check('detail page shows the requested line', (await buyerPage.getByTestId('rfq-items').innerText()).includes('زجاجات 75 سل'));
  check('send panel visible while DRAFT', await buyerPage.getByTestId('rfq-send-panel').isVisible());

  // Sending needs the seller directory, which is populated outside this flow.
  console.log('Send — via API, then the UI is refreshed');
  const send = await company.client.req(`/api/rfqs/${rfqId}/send`, {
    method: 'POST',
    body: { sellerIds: [sellerAId, sellerBId], acknowledgeDisclosure: true },
  });
  check('invitations sent', send.status === 200, `${send.status} ${JSON.stringify(send.data)}`);

  await buyerPage.reload();
  await buyerPage.getByTestId('rfq-recipients').waitFor();
  const recipientsText = await buyerPage.getByTestId('rfq-recipients').innerText();
  check('both invited sellers listed', recipientsText.includes('Verre du Sud') && recipientsText.includes('Commerce Nour'));
  check('recipient status rendered in Arabic', recipientsText.includes('مدعو'), recipientsText);
  check('send panel gone once OPEN', (await buyerPage.getByTestId('rfq-send-panel').count()) === 0);

  // -------------------------------------------------------------- seller UI
  console.log('Seller A — inbox, quote, then revision');
  const sellerPage = await browser.newPage({ locale: 'ar-TN' });
  const sellerErrors = [];
  sellerPage.on('pageerror', (e) => sellerErrors.push(String(e)));
  await login(sellerPage, sellerA.email, sellerA.password);

  await sellerPage.goto(`${WEB}/dashboard/rfq-inbox`);
  await sellerPage.getByTestId('rfq-inbox').waitFor({ timeout: 20000 });
  const inboxText = await sellerPage.getByTestId('rfq-inbox').innerText();
  check('invitation visible in the seller inbox', inboxText.includes('تزويد زجاجات موسم الصيف'));
  check('buyer company name shown', inboxText.includes('Achats Atlas SARL'));

  await sellerPage.getByRole('link', { name: 'تزويد زجاجات موسم الصيف' }).click();
  await sellerPage.waitForURL(/\/dashboard\/rfqs\/[0-9a-f-]{36}$/);
  await sellerPage.getByText('لوحة البائع').waitFor({ timeout: 20000 });
  check('seller panel rendered', (await sellerPage.getByTestId('rfq-quote-form').count()) === 1);
  await sellerPage.locator('input[aria-label="سعر الوحدة زجاجات 75 سل"]').fill('1.150');
  await sellerPage.getByLabel('مدة التوريد (أيام)').fill('7');
  await sellerPage.getByTestId('rfq-quote-submit').click();
  await sellerPage.getByTestId('rfq-my-quote').waitFor({ timeout: 20000 });
  const quoteText = await sellerPage.getByTestId('rfq-my-quote').innerText();
  check('quote submitted and priced by the server', /575[.,\s]?000/.test(quoteText), quoteText);
  check('quote status shows as submitted', quoteText.includes('مقدَّم'));

  console.log('Buyer — sees the quote, opens revisions, rejects with a reason');
  await buyerPage.reload();
  await buyerPage.getByTestId('rfq-recipients').waitFor();
  const quoteCard = buyerPage.locator('[data-testid^="rfq-quote-"]').first();
  await quoteCard.waitFor({ timeout: 20000 });
  const buyerQuoteText = await quoteCard.innerText();
  check('buyer sees the seller quote total', /575[.,\s]?000/.test(buyerQuoteText), buyerQuoteText);
  check('buyer sees the seller name on the quote', buyerQuoteText.includes('Verre du Sud'));

  await quoteCard.getByRole('button', { name: 'الإصدارات' }).click();
  await buyerPage.getByTestId('rfq-revisions').waitFor();
  check('revision chain lists revision 1', (await buyerPage.getByTestId('rfq-revisions').innerText()).includes('rev 1'));

  await quoteCard.getByRole('button', { name: 'رفض' }).click();
  await buyerPage.locator('#rfq-reject-reason').fill('السعر أعلى من الميزانية المعتمدة');
  await buyerPage.getByTestId('rfq-reject-submit').click();
  await buyerPage.getByText('تم رفض العرض.').waitFor({ timeout: 20000 });
  const afterReject = await buyerPage.locator('[data-testid^="rfq-quote-"]').first().innerText();
  check('quote status updates to rejected', afterReject.includes('مرفوض'), afterReject);
  check('rejection reason visible to the buyer', afterReject.includes('الميزانية'));

  console.log('Seller A — sees the reason and submits a revision');
  await sellerPage.reload();
  await sellerPage.getByTestId('rfq-my-quote').waitFor();
  const sellerQuoteText = await sellerPage.getByTestId('rfq-my-quote').innerText();
  check('seller sees the rejection reason', sellerQuoteText.includes('الميزانية'), sellerQuoteText);
  check('withdraw hidden for a terminal revision', (await sellerPage.getByTestId('rfq-withdraw').count()) === 0);

  await sellerPage.locator('input[aria-label="سعر الوحدة زجاجات 75 سل"]').fill('1.050');
  await sellerPage.getByTestId('rfq-quote-submit').click();
  await sellerPage.getByText('تم إرسال العرض.').waitFor({ timeout: 20000 });
  const revisedText = await sellerPage.getByTestId('rfq-my-quote').innerText();
  check('revision 2 submitted', revisedText.includes('rev 2'), revisedText);
  check('revision 2 repriced', /525[.,\s]?000/.test(revisedText), revisedText);

  await buyerPage.reload();
  await buyerPage.getByTestId('rfq-recipients').waitFor();
  const finalQuote = await buyerPage.locator('[data-testid^="rfq-quote-"]').first().innerText();
  check('buyer sees exactly the live revision', finalQuote.includes('rev 2') && /525[.,\s]?000/.test(finalQuote), finalQuote);

  console.log('Buyer — compares the offers');
  await buyerPage.getByTestId('rfq-comparison').getByRole('button').click();
  await buyerPage.getByTestId('rfq-comparison-table').waitFor({ timeout: 20000 });
  const comparisonText = await buyerPage.getByTestId('rfq-comparison').innerText();
  check('comparison lists the seller and the live total',
    comparisonText.includes('Verre du Sud') && /525[.,\s]?000/.test(comparisonText), comparisonText);
  check('comparison marks the best price', comparisonText.includes('الأفضل سعراً'), comparisonText);
  check('comparison shows unit prices per line', (await buyerPage.getByTestId('rfq-comparison-lines').count()) === 1);
  const excludedText = await buyerPage.getByTestId('rfq-comparison-excluded').innerText();
  check('comparison excludes the superseded revision', excludedText.includes('مراجعة قديمة'), excludedText);

  const timelineText = await buyerPage.getByTestId('rfq-timeline').innerText();
  check('timeline records creation, sending, quoting and the rejection',
    ['إرسال', 'عرض جديد', 'رفض عرض', 'إصدار جديد'].every((label) => timelineText.includes(label)), timelineText);

  console.log('Seller B — declines the invitation');
  const sellerBPage = await browser.newPage({ locale: 'ar-TN' });
  await login(sellerBPage, sellerB.email, sellerB.password);
  await sellerBPage.goto(`${WEB}/dashboard/rfqs/${rfqId}`);
  await sellerBPage.getByText('لوحة البائع').waitFor({ timeout: 20000 });
  await sellerBPage.getByRole('button', { name: 'الاعتذار عن الدعوة' }).click();
  await sellerBPage.locator('#rfq-decline-reason').fill('لا نغطي هذه الكمية حاليًا');
  await sellerBPage.getByTestId('rfq-decline-submit').click();
  await sellerBPage.getByText('تم تسجيل اعتذارك.').waitFor({ timeout: 20000 });
  check('decline recorded for the seller', (await sellerBPage.getByTestId('rfq-my-quote').count()) === 0);

  await buyerPage.reload();
  await buyerPage.getByTestId('rfq-recipients').waitFor();
  const afterDecline = await buyerPage.getByTestId('rfq-recipients').innerText();
  check('buyer sees the seller declined with the reason',
    afterDecline.includes('اعتذر') && afterDecline.includes('لا نغطي'), afterDecline);

  // --------------------------------------------------------------- cancel UI
  console.log('Buyer — cancels the request');
  await buyerPage.getByRole('button', { name: 'إلغاء الطلب' }).click();
  await buyerPage.locator('#rfq-cancel-reason').fill('تمت التغطية داخليًا');
  await buyerPage.getByTestId('rfq-cancel-submit').click();
  await buyerPage.getByText('تم إلغاء الطلب.').waitFor({ timeout: 20000 });
  await buyerPage.reload();
  await buyerPage.getByTestId('rfq-recipients').waitFor();
  check('cancelled badge rendered', (await buyerPage.locator('body').innerText()).includes('ملغى'));

  console.log('Seller A — the request is closed');
  await sellerPage.goto(`${WEB}/dashboard/rfqs/${rfqId}`);
  await sellerPage.getByText('لوحة البائع').waitFor({ timeout: 20000 });
  check('seller can no longer quote a cancelled request', (await sellerPage.getByTestId('rfq-quote-form').count()) === 0);

  // ----------------------------------------------------------------- i18n
  console.log('i18n — French and English render the same flow');
  const ctx = await browser.newContext();
  const frPage = await ctx.newPage();
  await login(frPage, company.email, company.password);
  await frPage.locator('select[aria-label="Language"]').selectOption('fr');
  await frPage.goto(`${WEB}/dashboard/rfqs`);
  await frPage.getByTestId('rfq-list').waitFor({ timeout: 20000 });
  const frText = await frPage.getByTestId('rfq-list').innerText();
  check('French labels rendered', frText.includes('Annulée') || frText.includes('Demandes'), frText);

  const enCtx = await browser.newContext();
  const enPage = await enCtx.newPage();
  await login(enPage, company.email, company.password);
  await enPage.locator('select[aria-label="Language"]').selectOption('en');
  await enPage.goto(`${WEB}/dashboard/rfqs/${rfqId}`);
  await enPage.getByText('Buyer panel').waitFor({ timeout: 20000 });
  check('English panel label rendered', true);

  const zhCtx = await browser.newContext();
  const zhPage = await zhCtx.newPage();
  await login(zhPage, company.email, company.password);
  await zhPage.locator('select[aria-label="Language"]').selectOption('zh');
  await zhPage.goto(`${WEB}/dashboard/rfqs/${rfqId}`);
  await zhPage.getByText('买方面板').waitFor({ timeout: 20000 });
  check('Chinese panel label rendered', true);

  check('no uncaught page errors (buyer)', buyerErrors.length === 0, buyerErrors.join(' | '));
  check('no uncaught page errors (seller)', sellerErrors.length === 0, sellerErrors.join(' | '));

  await buyerPage.screenshot({ path: '/tmp/rfq-buyer.png', fullPage: true });
  await sellerPage.screenshot({ path: '/tmp/rfq-seller.png', fullPage: true });
} catch (error) {
  failures += 1;
  console.error('FATAL', error);
} finally {
  await browser.close();
}

console.log(failures === 0 ? 'UI RESULT: ALL CHECKS PASSED' : `UI RESULT: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

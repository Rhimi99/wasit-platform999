import { test as base, expect, type Page } from '@playwright/test';
import path from 'node:path';

export const DEMO_PASSWORD = 'Passw0rd!2026';

/**
 * HMAC secret the suite signs payment webhooks with.
 *
 * Must equal the `PAYMENT_WEBHOOK_SECRET` `playwright.config.ts` starts the API
 * with — the server rejects a signature computed with any other value. Reading it
 * from the shell would let a stray export (the local demo stack sets its own)
 * sign with the wrong key and fail as though the payment kernel were broken, so
 * the suite owns the value and the config imports it from here.
 */
export const E2E_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789';

export const DEMO_USERS = {
  customer: 'customer1@wasit.tn',
  supplier: 'suppliera@wasit.tn',
  merchant: 'merchanta@wasit.tn',
  company: 'companya@wasit.tn',
  admin: 'admin@wasit.tn',
  admin2: 'admin2@wasit.tn',
} as const;

/**
 * Official PUBLIC-DEMO test account, provisioned by `seed-demo.ts` (not by any
 * login special-case) as an ordinary CUSTOMER. It shares the published demo
 * password unless the demo env overrides it via `DEMO_TEST_ACCOUNT_PASSWORD`.
 */
export const DEMO_TEST_ACCOUNT = 'rhimiimed18@gmail.com';
export const DEMO_TEST_ACCOUNT_PASSWORD = process.env.DEMO_TEST_ACCOUNT_PASSWORD ?? DEMO_PASSWORD;

export type DemoRole = keyof typeof DEMO_USERS;

/** Path to the storage state created by global-setup (real API session per role). */
export function storageFor(role: DemoRole): string {
  return path.resolve(process.cwd(), 'e2e/.auth', `${role}.json`);
}

/**
 * Drives the real login form and waits for the post-login redirect. Used by the
 * auth spec so the form itself is covered; role specs use stored sessions instead.
 */
export async function loginViaUi(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('form input[type="email"]').fill(email);
  await page.locator('form input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
}

export const test = base;
export { expect };

/**
 * Completes email verification for a freshly registered account, tolerating both
 * environments the suite runs against.
 *
 * The public demo sets DEMO_SKIP_EMAIL_VERIFICATION, so a registration is already
 * verified and the dev helper answers 422 ALREADY_VERIFIED (or the account is
 * ready to sign in immediately). Every other environment keeps the real flow:
 * mint the token through the dev helper and consume it via POST /verify-email,
 * exactly as the emailed link would. Returns whether a verification was actually
 * performed, so a spec can assert on the right post-registration message.
 */
export async function completeEmailVerification(
  ctx: { post: (url: string, options?: { data?: unknown }) => Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }> },
  email: string,
): Promise<boolean> {
  const link = await ctx.post('/api/auth/dev/verification-link', { data: { email } });
  if (link.ok()) {
    const token = ((await link.json()) as { data: { token: string } }).data.token;
    const verified = await ctx.post('/api/auth/verify-email', { data: { token } });
    if (!verified.ok()) throw new Error(`verify-email failed: HTTP ${verified.status()}`);
    return true;
  }
  // Already verified by the demo bypass: there is nothing to click.
  const body = (await link.json()) as { error?: { code?: string; fieldErrors?: Array<{ code?: string }> } };
  const alreadyVerified =
    body.error?.fieldErrors?.some((f) => f.code === 'ALREADY_VERIFIED') === true;
  if (!alreadyVerified) throw new Error(`dev/verification-link failed: HTTP ${link.status()}`);
  return false;
}

/**
 * Whether the environment already stores a fresh registration verified, i.e. the
 * public-demo bypass is active. Probes the dev verification-link helper without
 * consuming anything: `ALREADY_VERIFIED` means there is nothing to click.
 */
export async function isDemoVerified(
  ctx: { post: (url: string, options?: { data?: unknown }) => Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }> },
  email: string,
): Promise<boolean> {
  const link = await ctx.post('/api/auth/dev/verification-link', { data: { email } });
  if (link.ok()) return false;
  const body = (await link.json()) as { error?: { fieldErrors?: Array<{ code?: string }> } };
  return body.error?.fieldErrors?.some((f) => f.code === 'ALREADY_VERIFIED') === true;
}

/**
 * Places a real order through the UI and returns its id (from the orders API).
 *
 * Walks the marketplace listings until a product accepts the order. The demo
 * seeder is idempotent and deliberately preserves depleted stock, while the
 * backend correctly refuses out-of-stock / below-MOQ lines — so a helper that
 * always picked the first listing would flake across repeated suite runs.
 *
 * Listings are newest-first, and specs such as functional-audit create ACTIVE
 * products with no stock on every run. On a database reused across runs those
 * crowd page 1, so the helper pages through the marketplace (as a browsing user
 * would) before giving up, instead of depending on page 1 staying orderable.
 */
export async function placeOrderViaUi(page: Page): Promise<string> {
  const hrefs: string[] = [];
  for (let pageNo = 1; pageNo <= 12; pageNo++) {
    await page.goto(`/marketplace?page=${pageNo}`);
    const links = page.locator('a[href^="/products/"]');
    await links.first().waitFor({ timeout: 10_000 }).catch(() => {});
    const count = await links.count();
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      if (href && !hrefs.includes(href)) hrefs.push(href);
    }
  }
  if (hrefs.length === 0) throw new Error('Marketplace listed no products at all.');

  const diag: string[] = [];

  for (const href of hrefs) {
    await page.goto(href);

    // The auth context hydrates the persisted session asynchronously. Until it
    // resolves, ProductDetailsPage renders the logged-out CTA (which points at
    // /login) and hides the saved/favorite actions — so wait for the signed-in
    // header before touching the order link, or the click would bail to /login.
    const signedIn = page.getByRole('link', { name: /لوحة التحكم|Dashboard/i }).first();
    const hydrated = await signedIn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (!hydrated) {
      diag.push(`${href}: session did not hydrate`);
      continue;
    }

    const orderLink = page.getByRole('link', { name: /اطلب|Order/i }).first();
    const ctaReady = await orderLink.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (!ctaReady) {
      diag.push(`${href}: order CTA never appeared`);
      continue;
    }
    await orderLink.click();
    await expect(page).toHaveURL(/\/checkout/);

    const qtyInput = page.locator('input[type="number"]').first();
    const moq = Number(await qtyInput.inputValue()) || 1;
    await qtyInput.fill(String(moq));
    await page.getByRole('button', { name: /إتمام الطلب|Place order/i }).click();

    const created = page.getByText(/تم إنشاء الطلب بنجاح|Order created successfully/i);
    const rejected = page.getByRole('alert');
    await expect(created.or(rejected).first()).toBeVisible();
    if (await created.isVisible()) {
      const res = await page.request.get('/api/orders');
      const body = await res.json();
      expect(res.ok()).toBeTruthy();
      return (body.data[0] as { id: string }).id;
    }
    diag.push(`${href}: rejected with "${(await rejected.first().innerText().catch(() => '')).trim()}"`);
  }

  throw new Error(`No order could be placed. Diagnostics:\n${diag.join('\n')}`);
}
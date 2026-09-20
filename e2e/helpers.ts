import { test as base, expect, type Page } from '@playwright/test';
import path from 'node:path';

export const DEMO_PASSWORD = 'Passw0rd!2026';

export const DEMO_USERS = {
  customer: 'customer1@wasit.tn',
  supplier: 'suppliera@wasit.tn',
  merchant: 'merchanta@wasit.tn',
  company: 'companya@wasit.tn',
  admin: 'admin@wasit.tn',
} as const;

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
 * Places a real order through the UI and returns its id (from the orders API).
 *
 * Walks the marketplace listing until a product accepts the order. The demo
 * seeder is idempotent and deliberately preserves depleted stock, while the
 * backend correctly refuses out-of-stock / below-MOQ lines — so a helper that
 * always picked the first listing would flake across repeated suite runs.
 */
export async function placeOrderViaUi(page: Page): Promise<string> {
  await page.goto('/marketplace');
  const links = page.locator('a[href^="/products/"]');
  await links.first().waitFor();

  const hrefs: string[] = [];
  const count = await links.count();
  for (let i = 0; i < count; i++) hrefs.push((await links.nth(i).getAttribute('href'))!);

  for (const href of hrefs) {
    await page.goto(href);
    const orderLink = page.getByRole('link', { name: /اطلب|Order/i }).first();
    if (!(await orderLink.isVisible().catch(() => false))) continue;
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
  }

  throw new Error('No in-stock product was available to place an order');
}
import { test, expect, storageFor, type Page } from './helpers';

/**
 * Navigation audit: every sidebar link a role can see must lead to a real page,
 * not the NotFound route. Catches dead links that an HTTP-200 check would miss
 * (the SPA shell returns 200 for unknown paths too).
 */

/**
 * Asserts the NotFound route did not render.
 *
 * Matches the route's own heading element rather than any "404" text on the
 * page: identifiers in the data tables (an order or entity UUID) can legitimately
 * contain the substring "404", which a bare text match would misread as the
 * NotFound page.
 */
async function expectNotFoundPage(page: Page): Promise<void> {
  await expect(page.locator('p.text-6xl')).toHaveCount(0);
}

test.describe('Sidebar navigation audit', () => {
  test.use({ storageState: storageFor('merchant') });

  test('every visible merchant sidebar link opens a real page', async ({ page }) => {
    await page.goto('/dashboard');
    const links = page.locator('aside nav a');
    await links.first().waitFor();
    const hrefs: string[] = [];
    for (let i = 0; i < (await links.count()); i++) {
      hrefs.push((await links.nth(i).getAttribute('href'))!);
    }
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      await page.goto(href);
      await expectNotFoundPage(page);
      await expect(page.locator('main, .card, table').first()).toBeVisible();
    }
  });
});

test.describe('Admin sidebar navigation audit', () => {
  test.use({ storageState: storageFor('admin') });

  test('every visible admin sidebar link opens a real page', async ({ page }) => {
    await page.goto('/admin');
    const links = page.locator('aside nav a');
    await links.first().waitFor();
    const hrefs: string[] = [];
    for (let i = 0; i < (await links.count()); i++) {
      hrefs.push((await links.nth(i).getAttribute('href'))!);
    }
    for (const href of hrefs) {
      await page.goto(href);
      await expectNotFoundPage(page);
      await expect(page.locator('main, .card, table').first()).toBeVisible();
    }
  });
});
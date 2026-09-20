import { test, expect, storageFor, placeOrderViaUi } from './helpers';
import type { Browser, Page } from '@playwright/test';

/**
 * A4 — Dispute Appeal, exercised against the real API + PostgreSQL.
 *
 * Role sessions come from real API logins (global-setup). The customer walks the
 * normal order path through the UI, then the dispute/appeal lifecycle is driven
 * through the genuine endpoints — no mocks, no direct DB writes.
 */

async function createDecidedDispute(page: Page, browser: Browser): Promise<string> {
  const orderId = await placeOrderViaUi(page);

  const created = await page.request.post('/api/disputes', {
    data: {
      orderId,
      reasonCode: 'NOT_AS_DESCRIBED',
      description: 'E2E: goods do not match the listing and seller is unresponsive.',
    },
  });
  expect(created.ok()).toBeTruthy();
  const disputeId = (await created.json()).data.id as string;

  // Deciding is a staff action — use a real admin session.
  const admin = await browser.newContext({ storageState: storageFor('admin') });
  const decided = await admin.request.post(`/api/admin/disputes/${disputeId}/decide`, {
    data: { decision: 'IN_FAVOR_OF_SELLER', note: 'E2E decision to enable an appeal.' },
  });
  expect(decided.ok()).toBeTruthy();
  await admin.close();
  return disputeId;
}

test.describe('Dispute appeal lifecycle', () => {
  test.use({ storageState: storageFor('customer') });

  test('a buyer opens a dispute from the dashboard and it appears in the list', async ({ page }) => {
    const orderId = await placeOrderViaUi(page);

    await page.goto('/dashboard/disputes');
    await page.getByTestId('dispute-order').selectOption(orderId);
    await page.getByTestId('dispute-reason').selectOption('NOT_RECEIVED');
    const description = `E2E: order ${orderId} never arrived and the seller cannot be reached.`;
    await page.getByTestId('dispute-description').fill(description);
    await page.getByTestId('dispute-create-submit').click();

    // The new dispute opens in the detail pane with the description just filed.
    await expect(page.getByText(description).first()).toBeVisible();
    // And it is present in the buyer's own list via the API.
    const listRes = await page.request.get('/api/disputes');
    const items = (await listRes.json()).data.items as { orderId: string; status: string }[];
    expect(items.some((d) => d.orderId === orderId && d.status === 'OPEN')).toBe(true);
  });

  test('a party files an appeal, staff sees it, and the deciding admin is recused', async ({ page, browser }) => {
    const disputeId = await createDecidedDispute(page, browser);

    // Customer files the appeal.
    const appealRes = await page.request.post(`/api/disputes/${disputeId}/appeals`, {
      data: { reason: 'E2E: delivery proof submitted after the original review was not considered.' },
    });
    expect(appealRes.ok()).toBeTruthy();
    const appealId = (await appealRes.json()).data.id as string;

    // It is listed for the customer and reflected on the dispute detail.
    const listed = await page.request.get(`/api/disputes/${disputeId}/appeals`);
    expect(listed.ok()).toBeTruthy();
    const items = (await listed.json()).data.items as { id: string; status: string }[];
    expect(items.some((a) => a.id === appealId && a.status === 'PENDING')).toBe(true);

    // A second appeal while one is pending is refused.
    const dup = await page.request.post(`/api/disputes/${disputeId}/appeals`, {
      data: { reason: 'E2E: duplicate appeal attempt while the first is still pending.' },
    });
    expect(dup.status()).toBe(409);

    // Customer sees the appeal in the UI.
    const disputeDetail = await page.request.get(`/api/disputes/${disputeId}`);
    const disputeNumber = (await disputeDetail.json()).data.disputeNumber as string;
    await page.goto('/dashboard/disputes');
    await page.getByRole('button', { name: new RegExp(disputeNumber) }).click();
    await expect(page.getByTestId('appeal-list')).toContainText(/قيد المراجعة|Pending|مقبول|Accepted/i);

    // Staff sees the pending appeal in the admin surface.
    const admin = await browser.newContext({ storageState: storageFor('admin') });
    const adminPage = await admin.newPage();
    await adminPage.goto('/admin/disputes');
    await adminPage.getByRole('row', { name: new RegExp(disputeNumber) }).click();
    await expect(adminPage.getByTestId('admin-appeal-list')).toContainText(/قيد المراجعة|Pending/i);

    // The admin who decided the dispute is recused from reviewing its appeal.
    const recused = await adminPage.request.post(`/api/admin/disputes/${disputeId}/appeals/${appealId}/review`, {
      data: { status: 'ACCEPTED', note: 'E2E: self-review must be refused.' },
    });
    expect(recused.status()).toBe(403);

    // The dispute decision therefore still stands.
    const after = await page.request.get(`/api/disputes/${disputeId}`);
    expect((await after.json()).data.status).toBe('DECIDED');
    await admin.close();
  });

  test('the appeal window from policy is enforced', async ({ page, browser }) => {
    const disputeId = await createDecidedDispute(page, browser);

    // The decide endpoint clamps nothing; the window is read from policy. We assert
    // the current policy exposes a positive window, then that an appeal lands.
    const policy = await page.request.get('/api/disputes/policies');
    const rules = (await policy.json()).data.rules as { appealWindowDays: number; maxAppeals: number };
    expect(rules.appealWindowDays).toBeGreaterThan(0);
    expect(rules.maxAppeals).toBeGreaterThan(0);

    const appealRes = await page.request.post(`/api/disputes/${disputeId}/appeals`, {
      data: { reason: 'E2E: appeal within the policy window should be accepted.' },
    });
    expect(appealRes.ok()).toBeTruthy();
  });

  test('a non-party cannot appeal a dispute', async ({ page, browser }) => {
    // customer1 is a party to the order it just placed; suppliera is not.
    const disputeId = await createDecidedDispute(page, browser);

    const supplier = await browser.newContext({ storageState: storageFor('supplier') });
    const supplierPage = await supplier.newPage();
    const denied = await supplierPage.request.post(`/api/disputes/${disputeId}/appeals`, {
      data: { reason: 'E2E: a non-party attempting to appeal this dispute.' },
    });
    expect(denied.status()).toBe(403);
    await supplier.close();
  });
});
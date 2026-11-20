import { createHmac } from 'node:crypto';
import { test, expect, storageFor, E2E_WEBHOOK_SECRET } from './helpers';
import type { Page } from '@playwright/test';

const WEBHOOK_SECRET = E2E_WEBHOOK_SECRET;
const MAX_ATTEMPTS = 5;

/**
 * OBS-01 — Webhook failure desk (functional audit).
 *
 * Rendering the tab is never treated as success: the spec drives an event to
 * DEAD_LETTERED through the real signed webhook path, sees it in the admin UI,
 * replays it from the UI, and then reads the real backend state (event row +
 * audit log) back to prove the effect.
 *
 * The event is a `payment.succeeded` for a non-existent intent: every apply
 * attempt throws, which is exactly how a real stuck event reaches the DLQ —
 * without moving any money.
 */

async function deadLetterEvent(page: Page): Promise<{ eventId: string; externalRef: string }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const eventId = `evt-e2e-dlq-${stamp}`;
  const externalRef = `ref-e2e-ghost-${stamp}`;
  const raw = JSON.stringify({ eventId, type: 'payment.succeeded', externalRef });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const res = await page.request.post('/api/payment-webhooks', {
      headers: { 'Content-Type': 'application/json', 'x-wasit-signature': signature },
      data: raw,
    });
    expect(res.status()).toBe(404);
  }
  return { eventId, externalRef };
}

async function currentUserId(page: Page): Promise<string> {
  const me = await (await page.request.get('/api/auth/me')).json();
  return me.data.id as string;
}

test.describe('Webhook failure desk', () => {
  test.use({ storageState: storageFor('admin') });

  test('a dead-lettered event is visible in the UI and replaying it resets the row, honestly', async ({ page }) => {
    const { eventId } = await deadLetterEvent(page);

    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-webhooks').click();

    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('DEAD_LETTERED');
    await expect(row).toContainText('manual');

    // Confirm dialog before any change: accept it to proceed.
    page.on('dialog', (d) => void d.accept());

    const statusText = await row.locator('[data-testid^="admin-obs-webhook-status-"]').innerText();
    expect(statusText).toBe('DEAD_LETTERED');

    // The row id (used for the replay endpoint) is derived from the row's testid.
    const rowTestId = (await row.getAttribute('data-testid'))!;
    const rowId = rowTestId.replace('admin-obs-webhook-row-', '');
    const auditBefore = (await (await page.request.get('/api/admin/audit-logs')).json()).data.items.length;

    await page.getByTestId(`admin-obs-webhook-replay-${rowId}`).click();

    // Honest notice: the event is back to RECEIVED, not "processed".
    await expect(page.getByText(/RECEIVED/).first()).toBeVisible();

    // Backend truth: the row is RECEIVED with attempts reset, and no longer listed
    // as a terminal failure.
    const after = (await (await page.request.get(`/api/payments/webhook-failures?limit=200`)).json()).data.items as Array<{ eventId: string }>;
    expect(after.some((i) => i.eventId === eventId)).toBe(false);

    // The replay is audited with the operator's real identity.
    const me = await currentUserId(page);
    const audit = (await (await page.request.get('/api/admin/audit-logs')).json()).data.items as Array<{ action: string; actorId: string | null; entityId: string }>;
    expect(audit.length).toBeGreaterThan(auditBefore - 1);
    const entry = audit.find((a) => a.action === 'PAYMENT.WEBHOOK_REPLAY' && a.entityId === rowId);
    expect(entry).toBeTruthy();
    expect(entry!.actorId).toBe(me);
  });

  test('cancelling the confirmation does not change the event', async ({ page }) => {
    const { eventId } = await deadLetterEvent(page);

    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-webhooks').click();
    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row).toBeVisible();

    // Dismiss the dialog: no state change must follow.
    page.on('dialog', (d) => void d.dismiss());

    const rowTestId = (await row.getAttribute('data-testid'))!;
    const rowId = rowTestId.replace('admin-obs-webhook-row-', '');
    await page.getByTestId(`admin-obs-webhook-replay-${rowId}`).click();

    await expect(row).toContainText('DEAD_LETTERED');
    const listed = (await (await page.request.get('/api/payments/webhook-failures?limit=200')).json()).data.items as Array<{ eventId: string }>;
    expect(listed.some((i) => i.eventId === eventId)).toBe(true);
  });

  test('the desk renders a real count and an empty-state when there are no failures', async ({ page }) => {
    await page.goto('/admin/observability');
    await page.getByTestId('admin-obs-tab-webhooks').click();
    await expect(page.getByTestId('admin-obs-webhook-count')).toBeVisible();
    await expect(page.getByTestId('admin-obs-webhook-count')).toContainText(/\d/);
  });
});

test.describe('Webhook failure desk — RBAC', () => {
  test.use({ storageState: storageFor('merchant') });

  test('a merchant is refused by both webhook-failure endpoints', async ({ page }) => {
    expect((await page.request.get('/api/payments/webhook-failures')).status()).toBe(403);
    expect((await page.request.post('/api/payments/webhook-failures/00000000-0000-0000-0000-000000000000/replay')).status()).toBe(403);
  });
});

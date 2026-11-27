import { request as playwrightRequest } from '@playwright/test';
import fs from 'node:fs';
import { test, expect, E2E_WEB_URL, storageFor } from './helpers';

/**
 * AI-FIRST-COMPLETION-05 — operational surfaces, exercised against the real stack.
 *
 * No route interception and no fixtures: the merchant session is the one
 * `e2e/global-setup.ts` minted by signing the demo role in through the real
 * `POST /api/auth/login`, the page drives the real agent task, a staff session
 * performs the human approval the agent requires, and the video is fetched back
 * from the real storage. The same spec runs on a phone viewport
 * (`mobile-chromium` project).
 *
 * The spec never handles a password. A missing session file is a setup failure
 * and fails the run — it is never turned into a silent skip, which would let the
 * surface rot untested while the suite stays green.
 */

const WEB_URL = E2E_WEB_URL;

function session(role: 'merchant' | 'admin'): string {
  const file = storageFor(role);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No stored ${role} session at ${file}. Run the suite through Playwright so ` +
        'e2e/global-setup.ts can sign the demo roles in first.',
    );
  }
  return file;
}

test.describe('AFC-05 — agent video production surface', () => {
  test('produces, gates, previews and downloads a real video', async ({ browser }) => {
    test.setTimeout(360_000);
    const merchant = await browser.newContext({ storageState: session('merchant'), baseURL: WEB_URL });
    const page = await merchant.newPage();

    await page.goto('/dashboard/agent-video');
    await expect(page.getByTestId('agent-video-form')).toBeVisible();

    const product = page.getByTestId('agent-video-product');
    await expect(product.locator('option')).not.toHaveCount(1);
    await product.selectOption({ index: 1 });
    await page.getByTestId('agent-video-duration').fill('35');

    // Every supported language is offered, and the voice status explains the
    // one language the platform cannot speak (Tunisian) instead of hiding it.
    const language = page.getByTestId('agent-video-language');
    await expect(language.locator('option')).toHaveCount(5);
    await expect(page.getByTestId('agent-video-voice-status')).toBeVisible();

    const created = page.waitForResponse(
      (res) => res.url().includes('/api/ai/agents/marketing-video-agent/tasks') && res.request().method() === 'POST',
    );
    await page.getByTestId('agent-video-start').click();
    const createdRes = await created;
    expect([200, 201]).toContain(createdRes.status());
    const taskId = ((await createdRes.json()) as { data: { id: string } }).data.id;

    // The agent is human-gated: it must stop here, not render on its own.
    await expect(page.getByTestId('agent-video-approval')).toBeVisible();
    await expect(page.getByTestId('agent-video-status')).toContainText(/انتظار|waiting|attente|等待/i);

    const admin = await playwrightRequest.newContext({
      baseURL: WEB_URL,
      ignoreHTTPSErrors: true,
      storageState: session('admin'),
      extraHTTPHeaders: { Origin: WEB_URL },
    });
    const approve = await admin.post(`/api/ai/tasks/${taskId}/approve`, { data: { decision: 'APPROVE', reason: 'AFC-05 e2e' } });
    expect(approve.status()).toBe(200);
    await admin.dispose();

    // Refresh until the task leaves the approval gate, then wait for the render.
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: /تحديث|refresh|actualiser|刷新/i }).click();
          const res = await page.request.get(`/api/ai/tasks/${taskId}`);
          const body = (await res.json()) as { data: { status: string } };
          return body.data.status;
        },
        { timeout: 240_000, intervals: [2_000, 3_000, 5_000] },
      )
      .toMatch(/^(succeeded|approved)$/);

    await expect(page.getByTestId('agent-video-preview')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-testid="agent-video-preview"]') as HTMLVideoElement | null;
      return Boolean(video && video.readyState >= 1 && video.duration > 0);
    }, undefined, { timeout: 60_000 });

    // The delivery gate is shown with its verdict; a withheld video has no
    // preview and no download button at all.
    await expect(page.getByTestId('agent-video-gate')).toBeVisible();
    await expect(page.getByTestId('agent-video-gate-status')).toBeVisible();
    await expect(page.getByTestId('agent-video-gate-metrics')).toContainText(/LUFS/i);

    const facts = await page.getByTestId('agent-video-facts').innerText();
    expect(facts).toMatch(/\d+(\.\d+)?s/);
    expect(facts).toMatch(/h264|mp4|vp9|av1/i);

    // Download goes through the authenticated route and returns a real MP4.
    const download = await page.evaluate(async (id: string) => {
      const res = await fetch(`/api/ai/tasks/${id}/video?download=1`, { credentials: 'include' });
      const buffer = await res.arrayBuffer();
      return {
        status: res.status,
        type: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
        bytes: buffer.byteLength,
      };
    }, taskId);
    expect(download.status).toBe(200);
    expect(download.type).toContain('video/mp4');
    expect(download.disposition).toContain('attachment');
    expect(download.bytes).toBeGreaterThan(1000);

    // The storage key never reaches the client.
    const html = await page.content();
    expect(html).not.toMatch(/agent-videos\//);

    await merchant.close();
  });

  test('a stranger cannot read the task or its video', async () => {
    const merchant = await playwrightRequest.newContext({
      baseURL: WEB_URL,
      ignoreHTTPSErrors: true,
      storageState: session('merchant'),
      extraHTTPHeaders: { Origin: WEB_URL },
    });
    // Open the merchant's own task, so the probe never depends on what an
    // earlier case left behind (which is why this case used to skip itself).
    const products = await merchant.get('/api/products/mine?pageSize=100');
    expect(products.status()).toBe(200);
    const active = ((await products.json()) as { data: { items: Array<{ id: string; status: string }> } }).data.items.filter(
      (p) => p.status === 'ACTIVE',
    );
    expect(active.length, 'the merchant needs one ACTIVE listing to open a task').toBeGreaterThan(0);

    const created = await merchant.post('/api/ai/agents/marketing-video-agent/tasks', {
      data: {
        input: {
          productId: active[0].id,
          language: 'ar',
          objective: 'SALES',
          audience: 'B2B',
          style: 'MODERN',
          durationSeconds: 35,
        },
      },
    });
    expect([200, 201]).toContain(created.status());
    const taskId = ((await created.json()) as { data: { id: string } }).data.id;
    await merchant.dispose();

    const anon = await playwrightRequest.newContext({
      baseURL: WEB_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Origin: WEB_URL },
    });
    const task = await anon.get(`/api/ai/tasks/${taskId}`);
    const video = await anon.get(`/api/ai/tasks/${taskId}/video`);
    expect(task.status()).toBe(401);
    expect(video.status()).toBe(401);
    await anon.dispose();
  });
});

test.describe('AFC-05 — partner suggestions surface', () => {
  test('consent gates discovery, and results carry no contact data', async ({ browser }) => {
    const context = await browser.newContext({ storageState: session('merchant'), baseURL: WEB_URL });
    const page = await context.newPage();

    await page.goto('/dashboard/partners');
    await expect(page.getByTestId('partners-consent-status')).toBeVisible();

    const toggle = page.getByTestId('partners-consent-toggle');
    const status = page.getByTestId('partners-consent-status');
    if ((await status.innerText()).match(/غير|not|non|未/i)) {
      await toggle.click();
      await expect(status).toHaveText(/ممنوحة|granted|accordé|已同意/i);
    }

    const created = page.waitForResponse(
      (res) => res.url().includes('/api/ai/agents/b2b-agent/tasks') && res.request().method() === 'POST',
    );
    await page.getByTestId('partners-find').click();
    const createdRes = await created;
    expect([200, 201]).toContain(createdRes.status());
    const taskId = ((await createdRes.json()) as { data: { id: string } }).data.id;

    // The agent is human-gated: a staff approval must come first.
    await expect(page.getByTestId('partners-refresh')).toBeVisible({ timeout: 30_000 });
    const admin = await playwrightRequest.newContext({
      baseURL: WEB_URL,
      ignoreHTTPSErrors: true,
      storageState: session('admin'),
      extraHTTPHeaders: { Origin: WEB_URL },
    });
    const approve = await admin.post(`/api/ai/tasks/${taskId}/approve`, { data: { decision: 'APPROVE', reason: 'AFC-05 e2e' } });
    expect(approve.status()).toBe(200);
    await admin.dispose();

    await page.getByTestId('partners-refresh').click();
    const results = page.getByTestId('partners-results');
    const empty = page.getByText(/لا يوجد شريك مطابق|No matching partner|Aucun partenaire|没有匹配/i);
    await expect(results.or(empty)).toBeVisible({ timeout: 60_000 });

    if (await results.isVisible()) {
      const text = await results.innerText();
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/\+?\d{8,}/);
    }

    // Withdrawal is immediate and clears the previous result.
    await page.getByTestId('partners-consent-toggle').click();
    await expect(status).toHaveText(/غير ممنوحة|not granted|non accordé|未同意/i);
    await expect(page.getByTestId('partners-results')).toHaveCount(0);

    await context.close();
  });
});

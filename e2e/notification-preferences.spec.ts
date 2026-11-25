import { request, type Browser, type Page } from '@playwright/test';
import {
  CONSENT_STORAGE_KEY,
  E2E_WEB_URL,
  completeEmailVerification,
  consentRecord,
  expect,
  storageFor,
  test,
} from './helpers';

/**
 * PR-10 — notification preferences, end to end in a real browser.
 *
 * Two kinds of account are used on purpose:
 *
 * - the demo customer (via `storageState`) for the read/locale/save-and-restore
 *   cases, so the suite also proves the page works for an account that already
 *   has a history;
 * - throw-away accounts registered through the real API for the cases that need
 *   a *known* starting point (all-on, nothing explicit) or two isolated users.
 *   A fresh account is the only way to assert "default" without depending on
 *   what previous runs left in a shared demo row.
 *
 * Every account created here is prefixed `pr10-` so a failed run is identifiable.
 */

const CATEGORIES = 10;
const CHANNELS = 3;
const TOTAL = CATEGORIES * CHANNELS;
const PASSWORD = 'Passw0rd!2026';
/** No cookies, no origins: the starting point of a real stranger. */
const EMPTY_STATE = { cookies: [], origins: [] };

/** The copy each locale must actually render (from `lib/i18n.ts`). */
const LOCALE_COPY = {
  ar: { dir: 'rtl', title: 'تفضيلات الإشعارات', message: 'الرسائل' },
  en: { dir: 'ltr', title: 'Notification preferences', message: 'Messages' },
  fr: { dir: 'ltr', title: 'Préférences de notification', message: 'Messages' },
  zh: { dir: 'ltr', title: '通知偏好', message: '消息' },
} as const;

test.use({ storageState: storageFor('customer') });

/** Every switch in the matrix. The testid sits on the `<input>` itself. */
const allSwitches = (page: Page) => page.locator('input[data-testid^="notif-pref-"]');

async function openSettings(page: Page) {
  await page.goto('/dashboard/settings');
  await expect(page.getByTestId('notification-preferences')).toBeVisible();
}

interface MatrixResponse {
  status: number;
  data: {
    rows: Array<{ channel: string; category: string; enabled: boolean; explicit: boolean }>;
    mandatoryCategories: string[];
  };
}

/** Reads the matrix through the real endpoint with the browser's own session. */
async function readMatrix(page: Page): Promise<MatrixResponse> {
  const raw = await page.evaluate(async () => {
    const res = await fetch('/api/notifications/preferences', { credentials: 'include' });
    return { status: res.status, body: await res.json() };
  });
  return { status: raw.status, data: (raw.body as { data: MatrixResponse['data'] }).data };
}

/**
 * Registers a brand-new customer through the real API, verifies the mailbox the
 * way the product does, signs in, and hands back a page carrying that session
 * plus the stored consent decision (so the fixed banner never covers the card).
 */
async function freshUserPage(
  browser: Browser,
  tag: string,
  viewport = { width: 1280, height: 720 },
): Promise<Page> {
  // `request.newContext()` inherits `test.use({ storageState })`, so the
  // context is emptied explicitly: this account must not borrow the demo one.
  const api = await request.newContext({ baseURL: E2E_WEB_URL, storageState: EMPTY_STATE });
  const email = `pr10-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.test`;

  const registered = await api.post('/api/auth/register', {
    data: { email, password: PASSWORD, firstName: 'PR', lastName: 'Ten', role: 'CUSTOMER' },
  });
  expect(registered.ok(), `register ${email}: HTTP ${registered.status()} ${await registered.text()}`).toBe(true);

  await completeEmailVerification(api, email);

  const login = await api.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${email}: HTTP ${login.status()}`).toBe(true);
  const state = await api.storageState();
  await api.dispose();

  const context = await browser.newContext({ baseURL: E2E_WEB_URL, storageState: state, viewport });
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch {
        /* opaque origin — nothing to seed */
      }
    },
    [CONSENT_STORAGE_KEY, JSON.stringify(consentRecord())] as const,
  );
  return context.newPage();
}

test.describe('PR-10 — notification preferences', () => {
  test('lists every category and channel for the signed-in user', async ({ page }) => {
    await openSettings(page);

    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeVisible();
    await expect(page.getByTestId('notif-pref-IN_APP-DISPUTE')).toBeVisible();
    await expect(page.getByTestId('notif-pref-SMS-PAYOUT')).toBeVisible();

    await expect(allSwitches(page)).toHaveCount(TOTAL);

    // Nothing is saved until the user asks for it.
    await expect(page.getByTestId('notification-preferences-save')).toBeDisabled();
  });

  test('saves a choice that survives a reload, then restores it', async ({ page }) => {
    await openSettings(page);

    const target = page.getByTestId('notif-pref-EMAIL-MESSAGE');
    const wasChecked = await target.isChecked();

    await target.setChecked(!wasChecked);
    await expect(page.getByTestId('notification-preferences-save')).toBeEnabled();
    await page.getByTestId('notification-preferences-save').click();
    await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('notification-preferences')).toBeVisible();
    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeChecked({ checked: !wasChecked });

    // Restore the shared demo account.
    const restore = page.getByTestId('notif-pref-EMAIL-MESSAGE');
    await restore.setChecked(wasChecked);
    await page.getByTestId('notification-preferences-save').click();
    await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).toBeChecked({ checked: wasChecked });
  });

  test('the API refuses an unknown category with the real session', async ({ page }) => {
    await openSettings(page);

    // In-page fetch keeps the session cookie (a Secure cookie is dropped by
    // Playwright's request context over plain HTTP).
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferences: [{ channel: 'EMAIL', category: 'NOPE', enabled: false }] }),
      });
      return res.status;
    });
    expect(status).toBe(422);
  });

  test('a new account starts with every pair on and nothing explicit', async ({ browser }) => {
    const page = await freshUserPage(browser, 'defaults');
    try {
      await openSettings(page);

      await expect(allSwitches(page)).toHaveCount(TOTAL);
      const checked = await allSwitches(page).evaluateAll(
        (nodes) => nodes.filter((n) => (n as HTMLInputElement).checked).length,
      );
      expect(checked).toBe(TOTAL);
      await expect(page.getByTestId('notification-preferences-save')).toBeDisabled();

      // The UI's claim is backed by the stored matrix, not by a client default.
      const matrix = await readMatrix(page);
      expect(matrix.status).toBe(200);
      expect(matrix.data.rows).toHaveLength(TOTAL);
      expect(matrix.data.rows.every((r) => r.enabled && !r.explicit)).toBe(true);
      // Silence is opt-in: no category is declared mandatory until that policy
      // is decided (PR-10 §3.1), so the server must not invent one.
      expect(matrix.data.mandatoryCategories).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test('saving one cell changes exactly that cell', async ({ browser }) => {
    const page = await freshUserPage(browser, 'single-cell');
    try {
      await openSettings(page);
      const before = await readMatrix(page);

      await page.getByTestId('notif-pref-EMAIL-MESSAGE').uncheck();
      await expect(page.getByTestId('notification-preferences-save')).toBeEnabled();
      await page.getByTestId('notification-preferences-save').click();
      await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();

      const after = await readMatrix(page);
      expect(after.data.rows).toHaveLength(TOTAL);

      const changed = after.data.rows
        .map((row, i) => ({ row, prev: before.data.rows[i]! }))
        .filter(({ row, prev }) => row.enabled !== prev.enabled || row.explicit !== prev.explicit);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.row).toMatchObject({
        channel: 'EMAIL',
        category: 'MESSAGE',
        enabled: false,
        explicit: true,
      });

      // Reload: the single cell is off, the other 29 are still on.
      await page.reload();
      await expect(page.getByTestId('notification-preferences')).toBeVisible();
      await expect(page.getByTestId('notif-pref-EMAIL-MESSAGE')).not.toBeChecked();
      await expect(allSwitches(page)).toHaveCount(TOTAL);
      const stillChecked = await allSwitches(page).evaluateAll(
        (nodes) => nodes.filter((n) => (n as HTMLInputElement).checked).length,
      );
      expect(stillChecked).toBe(TOTAL - 1);
    } finally {
      await page.context().close();
    }
  });

  test('one user’s choice never reaches another account', async ({ browser }) => {
    const owner = await freshUserPage(browser, 'owner');
    const stranger = await freshUserPage(browser, 'stranger');
    try {
      await openSettings(owner);
      await owner.getByTestId('notif-pref-SMS-PAYOUT').uncheck();
      await owner.getByTestId('notification-preferences-save').click();
      await expect(owner.getByTestId('notification-preferences-saved')).toBeVisible();

      const ownerMatrix = await readMatrix(owner);
      const ownerCell = ownerMatrix.data.rows.find((r) => r.channel === 'SMS' && r.category === 'PAYOUT');
      expect(ownerCell).toMatchObject({ enabled: false, explicit: true });

      await openSettings(stranger);
      const strangerMatrix = await readMatrix(stranger);
      expect(strangerMatrix.status).toBe(200);
      const strangerCell = strangerMatrix.data.rows.find((r) => r.channel === 'SMS' && r.category === 'PAYOUT');
      expect(strangerCell).toMatchObject({ enabled: true, explicit: false });
      await expect(stranger.getByTestId('notif-pref-SMS-PAYOUT')).toBeChecked();
    } finally {
      await owner.context().close();
      await stranger.context().close();
    }
  });

  test('an anonymous caller can neither read nor write preferences', async () => {
    const anonymous = await request.newContext({ baseURL: E2E_WEB_URL, storageState: EMPTY_STATE });
    try {
      const read = await anonymous.get('/api/notifications/preferences');
      expect(read.status()).toBe(401);

      const write = await anonymous.put('/api/notifications/preferences', {
        data: { preferences: [{ channel: 'EMAIL', category: 'MESSAGE', enabled: false }] },
      });
      expect(write.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });

  test('renders in Arabic, English, French and Chinese with the right direction', async ({ page }) => {
    await openSettings(page);
    const language = page.getByLabel('Language');

    for (const [locale, copy] of Object.entries(LOCALE_COPY)) {
      await language.selectOption(locale);
      await expect(page.getByRole('heading', { level: 3, name: copy.title })).toBeVisible();

      const dir = await page.evaluate(() => document.documentElement.dir);
      const lang = await page.evaluate(() => document.documentElement.lang);
      expect(dir, `${locale} direction`).toBe(copy.dir);
      expect(lang, `${locale} lang attribute`).toBe(locale);

      // The matrix itself is translated too, not just the card title.
      await expect(
        page.getByTestId('notification-preferences').getByText(copy.message, { exact: true }),
      ).toBeVisible();
      await expect(allSwitches(page)).toHaveCount(TOTAL);
    }
  });

  test('works at a phone viewport and keeps the page from overflowing', async ({ browser }) => {
    const page = await freshUserPage(browser, 'phone', { width: 390, height: 844 });
    try {
      await openSettings(page);
      await expect(allSwitches(page)).toHaveCount(TOTAL);

      // No page-level horizontal scroll: the matrix scrolls inside its own card.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      // Every channel column is reachable: the container scrolls to the last one
      // and that column lands inside the viewport, not outside it.
      const matrix = page.getByTestId('notification-preferences');
      const smsHeader = matrix.getByText('رسالة نصية', { exact: true });
      // `scrollIntoViewIfNeeded` follows the writing direction, which a raw
      // `scrollLeft` assignment does not (this page is RTL).
      await smsHeader.scrollIntoViewIfNeeded();
      await expect(smsHeader).toBeVisible();
      const box = await smsHeader.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);

      // Known shell constraint (recorded in GAP_REGISTER): the dashboard sidebar
      // keeps 240px of a 390px screen, so the matrix is a narrow scroll window.
      const geometry = await matrix.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(geometry.scroll).toBeGreaterThan(geometry.client);

      await page.getByTestId('notif-pref-IN_APP-ORDER').uncheck();
      await page.getByTestId('notification-preferences-save').click();
      await expect(page.getByTestId('notification-preferences-saved')).toBeVisible();

      await page.reload();
      await expect(page.getByTestId('notification-preferences')).toBeVisible();
      await expect(page.getByTestId('notif-pref-IN_APP-ORDER')).not.toBeChecked();

      await page.screenshot({ path: 'test-results/pr10-phone-settings.png', fullPage: true });
    } finally {
      await page.context().close();
    }
  });
});

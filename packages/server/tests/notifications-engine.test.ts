import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { notifications, notificationDeliveries } from '../src/db/schema/messaging.js';
import { newId } from '../src/lib/ids.js';
import {
  notify,
  dispatchPendingDeliveries,
  isChannelEnabled,
} from '../src/lib/notifications/engine.js';
import { eventDefinition } from '../src/lib/notifications/types.js';
import { renderNotification, emailParts, smsBody } from '../src/lib/notifications/templates.js';
import { resetMailTransport } from '../src/lib/mail/resolve.js';
import { resetSmsTransport } from '../src/lib/sms/resolve.js';
import { resetPushTransport } from '../src/lib/notifications/push.js';
import { resetNotificationWebhook } from '../src/lib/notifications/webhook.js';

const app = createApp();

function makeClient(base: Hono) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await base.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { data: data as any, status: res.status };
    },
  };
}

async function createUser(email: string, role = 'CUSTOMER'): Promise<string> {
  const r = await makeClient(app).req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Notif', role },
  });
  expect(r.status).toBe(201);
  const login = await makeClient(app).req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return rows[0].id;
}

/** A logged-in client whose session cookie is set. */
async function loggedInClient(email: string, role = 'CUSTOMER') {
  const c = makeClient(app);
  await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Notif', role },
  });
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return c;
}

const createdUserIds: string[] = [];

afterAll(async () => {
  resetMailTransport();
  resetSmsTransport();
  resetPushTransport();
  resetNotificationWebhook();
  await closeDb();
});

describe('Notification engine — registry and templates', () => {
  it('fans order/payment/refund events out to the external channels and keeps inventory in-app only', () => {
    expect(eventDefinition('ORDER_CREATED').channels).toEqual(
      expect.arrayContaining(['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK']),
    );
    expect(eventDefinition('PAYMENT_SUCCEEDED').category).toBe('PAYMENT');
    expect(eventDefinition('REFUND_COMPLETED').category).toBe('REFUND');
    // Low-stock is an operator-facing alert, not something to page a seller about.
    expect(eventDefinition('INVENTORY_LOW_STOCK').channels).toEqual(['IN_APP']);
  });

  it('renders copy per locale and falls back to Arabic for an unknown locale', () => {
    const ar = renderNotification('ORDER_CREATED', { orderNumber: 'ORD-1' }, 'ar');
    expect(ar.body).toContain('ORD-1');
    const en = renderNotification('ORDER_CREATED', { orderNumber: 'ORD-1' }, 'en');
    expect(en.title).toBe('New order');
    expect(en.body).toContain('ORD-1');
    const fr = renderNotification('ORDER_CREATED', { orderNumber: 'ORD-1' }, 'fr');
    expect(fr.title).toBe('Nouvelle commande');
    // Unknown locale -> Arabic fallback, not a crash.
    expect(renderNotification('ORDER_CREATED', {}, 'zz').title).toBe('طلب جديد');
    // Unknown event -> neutral copy, never throws.
    expect(renderNotification('SOMETHING_NEW', {}, 'en').title).toBe('SOMETHING_NEW');
  });

  it('builds an email (subject/text/html) and a prefixed SMS body from the same copy', () => {
    const copy = renderNotification('PAYMENT_SUCCEEDED', { orderNumber: 'ORD-2', amount: '10', currency: 'TND' }, 'en');
    const email = emailParts(copy);
    expect(email.subject).toBe(copy.title);
    expect(email.html).toContain('<p>');
    expect(smsBody(copy)).toMatch(/^WASIT — /);
  });
});

describe('Notification engine — delivery ledger', () => {
  it('records one ledger row per channel and links the in-app row to its delivery', async () => {
    const userId = await createUser(`it-pr09-ledger-${Date.now()}@wasit.tn`);
    createdUserIds.push(userId);

    const { notificationId } = await notify(db, {
      userId,
      type: 'ORDER_CREATED',
      entityType: 'ORDER',
      entityId: 'ORD-LEDGER-1',
      vars: { orderNumber: 'ORD-LEDGER-1' },
      idempotencyKey: 'ORD-LEDGER-1',
    });
    expect(notificationId).toBeTruthy();

    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.entityId, 'ORD-LEDGER-1'), eq(notificationDeliveries.userId, userId)));
    expect(rows.length).toBe(5);
    const byChannel = new Map(rows.map((r) => [r.channel, r]));
    expect(byChannel.get('IN_APP')!.status).toBe('SENT');
    for (const ch of ['EMAIL', 'SMS', 'PUSH', 'WEBHOOK']) {
      expect(byChannel.get(ch)!.status).toBe('PENDING');
      expect(byChannel.get(ch)!.attempts).toBe(0);
    }
    // The in-app ledger row points back at the feed row.
    expect(byChannel.get('IN_APP')!.notificationId).toBe(notificationId);

    const feed = await db.select().from(notifications).where(eq(notifications.id, notificationId!));
    expect(feed.length).toBe(1);
    expect(feed[0].type).toBe('ORDER_CREATED');
  });

  it('is idempotent: the same idempotency key inserts neither a second ledger row nor a second feed row', async () => {
    const userId = await createUser(`it-pr09-idem-${Date.now()}@wasit.tn`);
    createdUserIds.push(userId);

    const first = await notify(db, {
      userId,
      type: 'PAYMENT_SUCCEEDED',
      entityType: 'ORDER',
      entityId: 'ORD-IDEM-1',
      idempotencyKey: 'ORD-IDEM-1:PAID',
    });
    const second = await notify(db, {
      userId,
      type: 'PAYMENT_SUCCEEDED',
      entityType: 'ORDER',
      entityId: 'ORD-IDEM-1',
      idempotencyKey: 'ORD-IDEM-1:PAID',
    });
    expect(first.notificationId).toBeTruthy();
    // The duplicate is a no-op: no new feed row is returned.
    expect(second.notificationId).toBeNull();

    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.entityId, 'ORD-IDEM-1'), eq(notificationDeliveries.userId, userId)));
    expect(rows.length).toBe(5);
    const feed = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'PAYMENT_SUCCEEDED')));
    expect(feed.length).toBe(1);
  });

  it('treats distinct events with no key as separate occurrences', async () => {
    const userId = await createUser(`it-pr09-distinct-${Date.now()}@wasit.tn`);
    createdUserIds.push(userId);

    await notify(db, { userId, type: 'INVENTORY_LOW_STOCK', entityType: 'PRODUCT', entityId: 'P-1' });
    await notify(db, { userId, type: 'INVENTORY_LOW_STOCK', entityType: 'PRODUCT', entityId: 'P-1' });

    const feed = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'INVENTORY_LOW_STOCK')));
    expect(feed.length).toBe(2);
  });
});

describe('Notification engine — dispatch and preferences', () => {
  it('drains pending deliveries, records SENT, and leaves nothing pending', async () => {
    const userId = await createUser(`it-pr09-dispatch-${Date.now()}@wasit.tn`);
    createdUserIds.push(userId);

    await notify(db, {
      userId,
      type: 'ORDER_CREATED',
      entityType: 'ORDER',
      entityId: 'ORD-DISPATCH-1',
      vars: { orderNumber: 'ORD-DISPATCH-1' },
      idempotencyKey: 'ORD-DISPATCH-1',
    });

    const result = await dispatchPendingDeliveries(db, 500);
    expect(result.processed).toBeGreaterThanOrEqual(4);
    expect(result.failed).toBe(0);

    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.entityId, 'ORD-DISPATCH-1'), eq(notificationDeliveries.userId, userId)));
    expect(rows.every((r) => r.status === 'SENT' || r.status === 'SKIPPED')).toBe(true);

    const pending = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.entityId, 'ORD-DISPATCH-1'), eq(notificationDeliveries.status, 'PENDING')));
    expect(pending.length).toBe(0);
  });

  it('skips a channel the user disabled and honours the per-category switch', async () => {
    const c = await loggedInClient(`it-pr09-pref-${Date.now()}@wasit.tn`);
    const email = (await c.req('/api/auth/me')).data.data.email as string;
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const userId = rows[0].id;
    createdUserIds.push(userId);

    // Email for ORDER events off; everything else stays at the default (on).
    const put = await c.req('/api/notifications/preferences', {
      method: 'PUT',
      body: { channel: 'EMAIL', category: 'ORDER', enabled: false },
    });
    expect(put.status).toBe(200);

    expect(await isChannelEnabled(db, userId, 'EMAIL', 'ORDER')).toBe(false);
    expect(await isChannelEnabled(db, userId, 'SMS', 'ORDER')).toBe(true);
    expect(await isChannelEnabled(db, userId, 'EMAIL', 'PAYMENT')).toBe(true);

    await notify(db, {
      userId,
      type: 'ORDER_CREATED',
      entityType: 'ORDER',
      entityId: 'ORD-PREF-1',
      idempotencyKey: 'ORD-PREF-1',
    });
    await dispatchPendingDeliveries(db, 500);

    const emailRow = await db
      .select()
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.entityId, 'ORD-PREF-1'),
        eq(notificationDeliveries.userId, userId),
        eq(notificationDeliveries.channel, 'EMAIL'),
      ));
    expect(emailRow[0].status).toBe('SKIPPED');
    expect(emailRow[0].lastError).toContain('disabled');

    // The full matrix is returned with defaults for unset pairs.
    const prefs = await c.req('/api/notifications/preferences');
    expect(prefs.status).toBe(200);
    const items = prefs.data.data.items as Array<{ channel: string; category: string; enabled: boolean }>;
    const emailOrder = items.find((p) => p.channel === 'EMAIL' && p.category === 'ORDER');
    expect(emailOrder!.enabled).toBe(false);
    const smsOrder = items.find((p) => p.channel === 'SMS' && p.category === 'ORDER');
    expect(smsOrder!.enabled).toBe(true);
  });

  it('refuses to disable IN_APP security/system notifications', async () => {
    const c = await loggedInClient(`it-pr09-sec-${Date.now()}@wasit.tn`);
    const res = await c.req('/api/notifications/preferences', {
      method: 'PUT',
      body: { channel: 'IN_APP', category: 'SECURITY', enabled: false },
    });
    expect(res.status).toBe(422);
  });

  it('rejects an unknown channel or category with a validation error', async () => {
    const c = await loggedInClient(`it-pr09-bad-${Date.now()}@wasit.tn`);
    const badChannel = await c.req('/api/notifications/preferences', {
      method: 'PUT',
      body: { channel: 'CARRIER_PIGEON', category: 'ORDER', enabled: true },
    });
    expect(badChannel.status).toBe(422);
    const badCategory = await c.req('/api/notifications/preferences', {
      method: 'PUT',
      body: { channel: 'EMAIL', category: 'GOSSIP', enabled: true },
    });
    expect(badCategory.status).toBe(422);
  });

  it('exposes the caller’s own delivery history and never another user’s', async () => {
    const a = await loggedInClient(`it-pr09-deliv-a-${Date.now()}@wasit.tn`);
    const b = await loggedInClient(`it-pr09-deliv-b-${Date.now()}@wasit.tn`);
    const aEmail = (await a.req('/api/auth/me')).data.data.email as string;
    const aId = (await db.select({ id: users.id }).from(users).where(eq(users.email, aEmail)).limit(1))[0].id;
    createdUserIds.push(aId);

    await notify(db, {
      userId: aId,
      type: 'ORDER_CREATED',
      entityType: 'ORDER',
      entityId: 'ORD-DELIV-1',
      idempotencyKey: 'ORD-DELIV-1',
    });

    const mine = await a.req('/api/notifications/deliveries');
    expect(mine.status).toBe(200);
    expect(mine.data.data.items.length).toBeGreaterThanOrEqual(5);
    expect(mine.data.data.items.every((i: { entityId: string }) => i.entityId === 'ORD-DELIV-1')).toBe(true);

    // b sees none of a's deliveries.
    const theirs = await b.req('/api/notifications/deliveries');
    expect(theirs.status).toBe(200);
    expect(theirs.data.data.items.length).toBe(0);
  });
});

describe('Notification engine — external-approval gate', () => {
  it('does not deliver through a real transport when production has not approved it', async () => {
    // Swap the live env to a real (SMTP) transport with an unreachable host and
    // production NODE_ENV. The gate must stop the send before any connection is
    // attempted, so the row is SKIPPED — not FAILED — which is what proves no
    // network I/O happened. `withEnv` mirrors the pattern the demo specs use:
    // the parsed env object is mutated and restored, since it is read at call
    // time rather than frozen.
    const { env } = await import('../src/lib/env.js');
    const target = env as unknown as Record<string, unknown>;

    // Create the recipient while still in test env: a production login requires a
    // verified email, which the fixture does not have.
    const userId = await createUser(`it-pr09-gate-${Date.now()}@wasit.tn`);
    createdUserIds.push(userId);

    const previous = {
      NODE_ENV: target.NODE_ENV,
      MAIL_TRANSPORT: target.MAIL_TRANSPORT,
      SMTP_HOST: target.SMTP_HOST,
      NOTIFICATION_EXTERNAL_APPROVED: target.NOTIFICATION_EXTERNAL_APPROVED,
    };
    Object.assign(target, {
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.invalid',
      NOTIFICATION_EXTERNAL_APPROVED: false,
    });
    resetMailTransport();

    try {
      const { notificationExternalApproved } = await import('../src/lib/env.js');
      expect(notificationExternalApproved()).toBe(false);

      await notify(db, {
        userId,
        type: 'ORDER_CREATED',
        entityType: 'ORDER',
        entityId: 'ORD-GATE-1',
        idempotencyKey: 'ORD-GATE-1',
      });
      await dispatchPendingDeliveries(db, 500);

      const emailRow = await db
        .select()
        .from(notificationDeliveries)
        .where(and(
          eq(notificationDeliveries.entityId, 'ORD-GATE-1'),
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.channel, 'EMAIL'),
        ));
      expect(emailRow[0].status).toBe('SKIPPED');
      expect(emailRow[0].lastError).toContain('not approved');
    } finally {
      Object.assign(target, previous);
      resetMailTransport();
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles, sessions } from '../src/db/schema/auth.js';
import { notificationPreferences } from '../src/db/schema/messaging.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  categoryOfNotificationType,
  isEnabled,
} from '../src/modules/notifications/preferences.js';

/**
 * PR-10 — notification preferences.
 *
 * Real app, real session cookies, real PostgreSQL. No mocks: the point is that a
 * user's choice survives a round trip and belongs to exactly one user.
 */

const app = createApp();
const createdUserIds: string[] = [];
const PASSWORD = 'NotifPrefs!2026';

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-pr10-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: 'IT',
    lastName: 'Prefs',
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} missing from seed`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  createdUserIds.push(id);
  return id;
}

/** Signs in through the real route and returns the session cookie pair. */
async function login(email: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('no session cookie issued');
  return cookie;
}

function call(path: string, cookie: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        cookie,
        ...(init.headers ?? {}),
      },
    }),
  );
}

let customerEmail = '';
let customerId = '';

beforeAll(async () => {
  customerId = await createUser('CUSTOMER');
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, customerId));
  customerEmail = row!.email;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, createdUserIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, createdUserIds));
    await db.delete(sessions).where(inArray(sessions.userId, createdUserIds));
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeDb();
});

describe('category mapping', () => {
  it('maps every notification type the codebase writes to a known category', () => {
    const written = [
      'MESSAGE.NEW',
      'ORDER_CREATED',
      'PAYMENT_SUCCEEDED',
      'REFUND_COMPLETED',
      'DISPUTE.STATUS',
      'DISPUTE.DECISION',
      'DISPUTE.ASSIGNED',
      'DISPUTE.APPEAL',
      'DISPUTE.APPEAL.DECIDED',
      'INVENTORY_LOW_STOCK',
      'INVENTORY_OUT_OF_STOCK',
      'VERIFICATION.DECISION',
      'RISK.ALERT',
      'AI_ESCALATION',
      'AI.AGENT_TASK_COMPLETED',
      'payout.completed',
      'payout.failed',
      'payout.held',
      'payout.processing',
    ];
    for (const type of written) {
      expect(categoryOfNotificationType(type), type).not.toBeNull();
    }
    expect(categoryOfNotificationType('payout.completed')).toBe('PAYOUT');
    expect(categoryOfNotificationType('INVENTORY_LOW_STOCK')).toBe('INVENTORY');
    expect(categoryOfNotificationType('something.else')).toBeNull();
  });

  it('treats a missing row as enabled', () => {
    expect(isEnabled({ rows: [] }, 'EMAIL', 'MESSAGE')).toBe(true);
    expect(
      isEnabled(
        { rows: [{ channel: 'EMAIL', category: 'MESSAGE', enabled: false, explicit: true, updatedAt: null }] },
        'EMAIL',
        'MESSAGE',
      ),
    ).toBe(false);
    // The same category on another channel is unaffected.
    expect(
      isEnabled(
        { rows: [{ channel: 'EMAIL', category: 'MESSAGE', enabled: false, explicit: true, updatedAt: null }] },
        'IN_APP',
        'MESSAGE',
      ),
    ).toBe(true);
  });
});

describe('GET /api/notifications/preferences', () => {
  it('refuses an anonymous caller', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/notifications/preferences', {
        headers: { origin: 'http://localhost' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns the full matrix with everything enabled by default', async () => {
    const cookie = await login(customerEmail);
    const res = await call('/api/notifications/preferences', cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: any };
    expect(body.success).toBe(true);
    expect(body.data.channels).toEqual([...NOTIFICATION_CHANNELS]);
    expect(body.data.categories).toEqual([...NOTIFICATION_CATEGORIES]);
    expect(body.data.rows).toHaveLength(NOTIFICATION_CHANNELS.length * NOTIFICATION_CATEGORIES.length);
    expect(body.data.rows.every((r: any) => r.enabled === true && r.explicit === false)).toBe(true);
  });
});

describe('PUT /api/notifications/preferences', () => {
  it('persists a choice and reports it as explicit', async () => {
    const cookie = await login(customerEmail);
    const res = await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({
        preferences: [
          { channel: 'EMAIL', category: 'MESSAGE', enabled: false },
          { channel: 'SMS', category: 'INVENTORY', enabled: false },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any };
    const emailMessage = body.data.rows.find((r: any) => r.channel === 'EMAIL' && r.category === 'MESSAGE');
    expect(emailMessage).toMatchObject({ enabled: false, explicit: true });
    expect(typeof emailMessage.updatedAt).toBe('string');

    // A second read is served from the table, not from defaults.
    const again = await call('/api/notifications/preferences', cookie);
    const reread = ((await again.json()) as { data: any }).data.rows.find(
      (r: any) => r.channel === 'EMAIL' && r.category === 'MESSAGE',
    );
    expect(reread).toMatchObject({ enabled: false, explicit: true });
  });

  it('updates an existing row instead of inserting a duplicate', async () => {
    const cookie = await login(customerEmail);
    for (const enabled of [true, false, true]) {
      const res = await call('/api/notifications/preferences', cookie, {
        method: 'PUT',
        body: JSON.stringify({ preferences: [{ channel: 'SMS', category: 'INVENTORY', enabled }] }),
      });
      expect(res.status).toBe(200);
    }
    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, customerId),
          eq(notificationPreferences.channel, 'SMS'),
          eq(notificationPreferences.category, 'INVENTORY'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
  });

  it('writes one audit row naming the actor', async () => {
    const cookie = await login(customerEmail);
    await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({ preferences: [{ channel: 'IN_APP', category: 'DISPUTE', enabled: false }] }),
    });
    const audits = await db
      .select({ actorId: auditLogs.actorId, action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, customerId), eq(auditLogs.action, 'NOTIFICATION.PREFERENCES_UPDATED')));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.actorId === customerId)).toBe(true);
  });

  it('rejects an unknown category and writes nothing', async () => {
    const cookie = await login(customerEmail);
    const before = await db
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, customerId));
    const res = await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({ preferences: [{ channel: 'EMAIL', category: 'NOT_A_CATEGORY', enabled: false }] }),
    });
    expect(res.status).toBe(422);
    const after = await db
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, customerId));
    expect(after.length).toBe(before.length);
  });

  it('rejects an unknown channel', async () => {
    const cookie = await login(customerEmail);
    const res = await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({ preferences: [{ channel: 'CARRIER_PIGEON', category: 'MESSAGE', enabled: false }] }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an empty list and a duplicated pair', async () => {
    const cookie = await login(customerEmail);
    const empty = await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({ preferences: [] }),
    });
    expect(empty.status).toBe(422);

    const duplicated = await call('/api/notifications/preferences', cookie, {
      method: 'PUT',
      body: JSON.stringify({
        preferences: [
          { channel: 'EMAIL', category: 'ORDER', enabled: false },
          { channel: 'EMAIL', category: 'ORDER', enabled: true },
        ],
      }),
    });
    expect(duplicated.status).toBe(422);
  });

  it('keeps one user’s choices out of another user’s matrix', async () => {
    const otherId = await createUser('CUSTOMER');
    const [other] = await db.select({ email: users.email }).from(users).where(eq(users.id, otherId));
    const otherCookie = await login(other!.email);

    const ownerCookie = await login(customerEmail);
    await call('/api/notifications/preferences', ownerCookie, {
      method: 'PUT',
      body: JSON.stringify({ preferences: [{ channel: 'EMAIL', category: 'PAYMENT', enabled: false }] }),
    });

    const res = await call('/api/notifications/preferences', otherCookie);
    const row = ((await res.json()) as { data: any }).data.rows.find(
      (r: any) => r.channel === 'EMAIL' && r.category === 'PAYMENT',
    );
    expect(row).toMatchObject({ enabled: true, explicit: false });
  });
});

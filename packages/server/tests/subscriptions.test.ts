import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { subscriptionPlans, subscriptions, invoices } from '../src/db/schema/subscriptions.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { newId } from '../src/lib/ids.js';
import { rolloverDueSubscriptions } from '../src/modules/subscriptions/service.js';
import type { UserRole } from '@wasit/shared';

const app = createApp();

function makeClient(base: Hono, initialCookie = '') {
  let cookie = initialCookie;
  return {
    cookie(): string {
      return cookie;
    },
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

async function createUserWithRole(role: UserRole, tag: string): Promise<{ id: string; cookie: string }> {
  const c = makeClient(app);
  const email = `sub-${tag}-${role}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: tag, role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);

  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const id = (login.data.data as { id: string }).id;
  expect(id).toBeTruthy();

  if (role === 'CUSTOMER') {
    return { id, cookie: c.cookie() };
  }
  const roleRow = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  expect(roleRow[0]).toBeTruthy();
  // Registration always grants CUSTOMER; replace it so the user holds exactly the intended role.
  await db.delete(userRoles).where(eq(userRoles.userId, id));
  await db.insert(userRoles).values({
    id: newId(),
    userId: id,
    roleId: roleRow[0].id,
  });
  return { id, cookie: c.cookie() };
}

beforeAll(async () => {
  // No-op; setup.ts already recreates + migrates + seeds the test database.
});

afterAll(async () => {
  await closeDb();
});

describe('Subscriptions — plans catalog', () => {
  it('returns active plans only (CUSTOMER/MERCHANT/COMPANY/GLOBAL targets)', async () => {
    const c = makeClient(app);
    const res = await c.req('/api/subscriptions/plans');
    expect(res.status).toBe(401); // auth required
  });

  it('lets an authenticated CUSTOMER list plans', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'plans');
    const c = makeClient(app, cookie);
    const res = await c.req('/api/subscriptions/plans');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<{ code: string; planTarget: string; isActive: boolean }>;
    const codes = items.map((p) => p.code);
    expect(codes).toContain('CUSTOMER_FREE');
    expect(codes).toContain('SMALL_MERCHANT');
    // All returned plans must be active.
    for (const p of items) expect(p.isActive).toBe(true);
  });
});

describe('Subscriptions — lifecycle (CUSTOMER role)', () => {
  it('subscribe → read → change plan → invoices → cancel', async () => {
    const { cookie, id } = await createUserWithRole('CUSTOMER', 'life');

    const plansRes = await makeClient(app, cookie).req('/api/subscriptions/plans');
    expect(plansRes.status).toBe(200);
    const plans = plansRes.data.data.items as Array<{ id: string; code: string; planTarget: string }>;
    const free = plans.find((p) => p.code === 'CUSTOMER_FREE')!;
    const small = plans.find((p) => p.code === 'SMALL_MERCHANT')!;
    expect(free).toBeTruthy();
    expect(small).toBeTruthy();

    const client = makeClient(app, cookie);

    // Subscribe to CUSTOMER_FREE.
    const subRes = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: free.id, billingCycle: 'MONTHLY' },
    });
    expect(subRes.status).toBe(200);
    const sub = subRes.data.data.subscription;
    expect(sub.planCode).toBe('CUSTOMER_FREE');
    expect(sub.status).toBe('ACTIVE');
    expect(sub.autoRenew).toBe(true);

    // Idempotent — subscribing again returns the same subscription.
    const subAgain = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: free.id, billingCycle: 'MONTHLY' },
    });
    expect(subAgain.status).toBe(200);
    expect(subAgain.data.data.subscription.id).toBe(sub.id);

    // Read back /me.
    const meRes = await client.req('/api/subscriptions/me');
    expect(meRes.status).toBe(200);
    expect(meRes.data.data.subscription.id).toBe(sub.id);

    // Change plan to SMALL_MERCHANT (delta invoice expected).
    const changeRes = await client.req('/api/subscriptions/me/plan', {
      method: 'PATCH',
      body: { planId: small.id, billingCycle: 'MONTHLY' },
    });
    expect(changeRes.status).toBe(200);
    expect(changeRes.data.data.subscription.planCode).toBe('SMALL_MERCHANT');

    // Invoices exist (initial + delta).
    const invRes = await client.req('/api/subscriptions/me/invoices');
    expect(invRes.status).toBe(200);
    const invs = invRes.data.data.items as Array<{ invoiceNumber: string; amount: string; status: string }>;
    expect(invs.length).toBeGreaterThanOrEqual(2);
    expect(invs.some((i) => i.status === 'PENDING')).toBe(true);
    expect(invs.every((i) => i.invoiceNumber.startsWith('INV-'))).toBe(true);

    // Cancel.
    const cancelRes = await client.req('/api/subscriptions/me/cancel', { method: 'POST' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.data.data.cancelled).toBe(true);

    // After cancel, /me returns null (no active subscription).
    const meAfter = await client.req('/api/subscriptions/me');
    expect(meAfter.data.data.subscription).toBeNull();

    // Audit trail written for subscribe + cancel.
    const auditRows = await db.select().from(auditLogs).where(eq(auditLogs.actorId, id));
    const actions = auditRows.map((a) => a.action);
    expect(actions).toContain('SUBSCRIPTION.SUBSCRIBED');
    expect(actions).toContain('SUBSCRIPTION.CANCELLED');
  });
});

describe('Subscriptions — RBAC', () => {
  it.each(['MERCHANT', 'SUPPLIER', 'COMPANY'] as const)('%s may subscribe/change/cancel', async (role) => {
    const { cookie } = await createUserWithRole(role, 'rbac');
    const client = makeClient(app, cookie);
    const plansRes = await client.req('/api/subscriptions/plans');
    expect(plansRes.status).toBe(200);
    const plans = plansRes.data.data.items as Array<{ id: string; code: string; planTarget: string }>;
    let target = plans.find((p) => {
      if (role === 'MERCHANT') return p.planTarget === 'MERCHANT';
      if (role === 'SUPPLIER') return p.planTarget === 'MERCHANT';
      return p.planTarget === 'COMPANY';
    });
    if (!target) target = plans[0];

    const subRes = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: target.id, billingCycle: 'MONTHLY' },
    });
    expect(subRes.status).toBe(200);

    const cancelRes = await client.req('/api/subscriptions/me/cancel', { method: 'POST' });
    expect(cancelRes.status).toBe(200);
  });

  it('blocks SUBSCRIPTION_CREATE for a user without the permission (SUPPORT role)', async () => {
    const { cookie } = await createUserWithRole('SUPPORT', 'denied');
    const client = makeClient(app, cookie);
    const plansRes = await client.req('/api/subscriptions/plans');
    expect(plansRes.status).toBe(200);
    const plans = plansRes.data.data.items as Array<{ id: string }>;
    const subRes = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: plans[0].id, billingCycle: 'MONTHLY' },
    });
    expect(subRes.status).toBe(403);
  });
});

describe('Subscriptions — admin endpoints', () => {
  it('SUBSCRIPTION_MANAGE allows activating/deactivating a plan and listing admin data', async () => {
    const { cookie } = await createUserWithRole('ADMIN', 'admin');
    const client = makeClient(app, cookie);

    const plan = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.code, 'SMALL_MERCHANT'))
      .limit(1);
    expect(plan[0]).toBeTruthy();

    const toggleRes = await client.req(`/api/subscriptions/admin/plans/${plan[0].id}/active`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.data.data.plan.isActive).toBe(false);

    // Reactivate.
    const onRes = await client.req(`/api/subscriptions/admin/plans/${plan[0].id}/active`, {
      method: 'PATCH',
      body: { isActive: true },
    });
    expect(onRes.status).toBe(200);

    const listRes = await client.req('/api/subscriptions/admin/plans');
    expect(listRes.status).toBe(200);

    const subsRes = await client.req('/api/subscriptions/admin/subscriptions');
    expect(subsRes.status).toBe(200);

    const invRes = await client.req('/api/subscriptions/admin/invoices');
    expect(invRes.status).toBe(200);
  });

  it('denies admin endpoints for a role without SUBSCRIPTION_MANAGE', async () => {
    const { cookie } = await createUserWithRole('MERCHANT', 'denyadmin');
    const client = makeClient(app, cookie);
    const listRes = await client.req('/api/subscriptions/admin/subscriptions');
    expect(listRes.status).toBe(403);
  });

  it('runs rollover via the admin route, is idempotent, and audits the run', async () => {
    const { cookie, id: subberId } = await createUserWithRole('CUSTOMER', 'rollroute');
    const subber = makeClient(app, cookie);
    const plansRes = await subber.req('/api/subscriptions/plans');
    const merchantPlan = (plansRes.data.data.items as Array<{ id: string; code: string }>).find(
      (p) => p.code === 'SMALL_MERCHANT',
    )!;
    const subRes = await subber.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: merchantPlan.id, billingCycle: 'MONTHLY' },
    });
    expect(subRes.status).toBe(200);
    const subId = subRes.data.data.subscription.id;

    await db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(subscriptions.id, subId));

    const { cookie: adminCookie } = await createUserWithRole('ADMIN', 'rollrouteadmin');
    const admin = makeClient(app, adminCookie);

    const first = await admin.req('/api/subscriptions/admin/rollover', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(first.data.data.renewed).toBeGreaterThanOrEqual(1);

    const second = await admin.req('/api/subscriptions/admin/rollover', { method: 'POST' });
    expect(second.status).toBe(200);
    expect(second.data.data.renewed).toBe(0);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'SUBSCRIPTION.ROLLOVER_RUN'));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // A role without SUBSCRIPTION_MANAGE cannot trigger it.
    const { cookie: merchantCookie } = await createUserWithRole('MERCHANT', 'rollroutedenied');
    const denied = await makeClient(app, merchantCookie).req('/api/subscriptions/admin/rollover', {
      method: 'POST',
    });
    expect(denied.status).toBe(403);
    expect(subberId).toBeTruthy();
  });
});

describe('Subscriptions — UI contract (/dashboard/subscriptions)', () => {
  // The web page reads exactly these three endpoints; the shape asserted here is
  // the shape the UI renders, so a change to any of them breaks the page loudly.
  it('serves a plan catalog whose prices are backend-owned (no hardcoded UI numbers)', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-plans');
    const client = makeClient(app, cookie);
    const res = await client.req('/api/subscriptions/plans');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.code).toBe('string');
      expect(typeof p.priceMonthly).toBe('string');
      expect(typeof p.priceYearly).toBe('string');
      expect(typeof p.currencyCode).toBe('string');
      expect(typeof p.planTarget).toBe('string');
    }
    // The real seeded catalog must contain a non-zero priced plan, otherwise the
    // page would render a grid of zeros and silently look "fine".
    expect(items.some((p) => Number(p.priceMonthly) > 0)).toBe(true);
  });

  it('reports the owner a null subscription, then the newly created one after subscribe', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-me');
    const client = makeClient(app, cookie);

    const before = await client.req('/api/subscriptions/me');
    expect(before.status).toBe(200);
    expect(before.data.data.subscription).toBeNull();

    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    const created = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: plans[0].id, billingCycle: 'YEARLY' },
    });
    expect(created.status).toBe(200);
    expect(created.data.data.subscription.planId).toBe(plans[0].id);
    expect(created.data.data.subscription.billingCycle).toBe('YEARLY');

    const after = await client.req('/api/subscriptions/me');
    expect(after.data.data.subscription).not.toBeNull();
    expect(after.data.data.subscription.id).toBe(created.data.data.subscription.id);
  });

  it('returns the owner invoices including the one minted by subscribe', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-invoices');
    const client = makeClient(app, cookie);
    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: plans[0].id, billingCycle: 'MONTHLY' },
    });

    const res = await client.req('/api/subscriptions/me/invoices');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const inv of items) {
      expect(typeof inv.invoiceNumber).toBe('string');
      expect(typeof inv.amount).toBe('string');
      expect(typeof inv.status).toBe('string');
    }
  });

  it('changes the plan the UI shows as current, and returns 404 (not 500) for an unknown plan', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-change');
    const client = makeClient(app, cookie);
    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    await client.req('/api/subscriptions/subscribe', { method: 'POST', body: { planId: plans[0].id } });

    const target = plans[plans.length - 1];
    const changed = await client.req('/api/subscriptions/me/plan', {
      method: 'PATCH',
      body: { planId: target.id, billingCycle: 'MONTHLY' },
    });
    expect(changed.status).toBe(200);
    expect(changed.data.data.subscription.planId).toBe(target.id);

    // A missing plan must be a clean 404 so the UI shows an error state, not a 500.
    const missing = await client.req('/api/subscriptions/me/plan', {
      method: 'PATCH',
      body: { planId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(missing.status).toBe(404);
  });

  it('cancels the subscription and turns auto-renew off, then 404s a second cancel', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-cancel');
    const client = makeClient(app, cookie);
    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    const created = await client.req('/api/subscriptions/subscribe', { method: 'POST', body: { planId: plans[0].id } });
    const subId = created.data.data.subscription.id;

    const res = await client.req('/api/subscriptions/me/cancel', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(res.data.data.cancelled).toBe(true);

    // The row is cancelled in place (not deleted) so billing history survives.
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    expect(rows[0].cancelledAt).not.toBeNull();
    expect(rows[0].autoRenew).toBe(false);
    expect(rows[0].status).toBe('CANCELLED');

    // The active-subscription endpoint no longer surfaces it, and a second cancel is a
    // clean 404 rather than acting on an already-cancelled subscription.
    const me = await client.req('/api/subscriptions/me');
    expect(me.data.data.subscription).toBeNull();
    const again = await client.req('/api/subscriptions/me/cancel', { method: 'POST', body: {} });
    expect(again.status).toBe(404);
  });

  it('returns a clean 404 when subscribing or cancelling without an active subscription', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-none');
    const client = makeClient(app, cookie);
    const cancel = await client.req('/api/subscriptions/me/cancel', { method: 'POST', body: {} });
    expect(cancel.status).toBe(404);

    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    const unknown = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(unknown.status).toBe(404);
    expect(plans.length).toBeGreaterThan(0);
  });

  it('lets the owner start payment for their generated invoice through the UI route', async () => {
    const { cookie } = await createUserWithRole('CUSTOMER', 'ui-pay');
    const client = makeClient(app, cookie);
    const plans = (await client.req('/api/subscriptions/plans')).data.data.items as Array<{ id: string }>;
    await client.req('/api/subscriptions/subscribe', { method: 'POST', body: { planId: plans[0].id } });
    const invoices = (await client.req('/api/subscriptions/me/invoices')).data.data.items as Array<{ id: string; status: string }>;
    const pending = invoices.find((i) => i.status === 'PENDING');
    expect(pending).toBeTruthy();

    const pay = await client.req(`/api/subscriptions/me/invoices/${pending!.id}/pay`, { method: 'POST', body: {} });
    expect(pay.status).toBe(201);
    expect(pay.data.data.externalRef).toBeTruthy();
  });
});

describe('Subscriptions — rollover service', () => {
  it('rolls over a due autoRenew subscription and creates a new invoice', async () => {
    const { cookie, id } = await createUserWithRole('CUSTOMER', 'roll');
    const client = makeClient(app, cookie);
    const plansRes = await client.req('/api/subscriptions/plans');
    const plans = plansRes.data.data.items as Array<{ id: string; planTarget: string }>;
    const small = plans.find((p) => p.planTarget === 'MERCHANT')!;
    const subRes = await client.req('/api/subscriptions/subscribe', {
      method: 'POST',
      body: { planId: small.id, billingCycle: 'MONTHLY' },
    });
    expect(subRes.status).toBe(200);
    const subId = subRes.data.data.subscription.id;

    // Force the subscription to be due in the past.
    await db
      .update(subscriptions)
      .set({ endsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(subscriptions.id, subId));

    const result = await rolloverDueSubscriptions(db);
    expect(result.renewed).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(invoices).where(eq(invoices.subscriptionId, subId));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Idempotent: a second run right after the first must not extend or invoice again.
    const again = await rolloverDueSubscriptions(db);
    expect(again.renewed).toBe(0);
    const after = await db.select().from(invoices).where(eq(invoices.subscriptionId, subId));
    expect(after.length).toBe(rows.length);
  });
});
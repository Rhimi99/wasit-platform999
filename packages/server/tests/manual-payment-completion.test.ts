import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { orders, transactionLedger } from '../src/db/schema/commerce.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { env } from '../src/lib/env.js';

/**
 * PS-02 — Manual payment completion desk.
 *
 * Exercises the real route end-to-end (session auth → /api/admin guard →
 * permission → service → database) and proves the guardrails:
 *  - an ADMIN completes a `manual` payment and the order/intent/payment reach PAID;
 *  - the ledger stays PENDING (completion is NOT settlement);
 *  - the action is refused outside demo payment mode;
 *  - no trading role can reach it;
 *  - a missing reference is refused, and the same order cannot be double-applied;
 *  - the audit trail records the operator, the reference and the action;
 *  - the route can never confirm an intent belonging to another provider.
 */

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
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
      return { res, data: data as any, status: res.status };
    },
  };
}

async function registerUser(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'PS02', role },
  });
  expect(r.status).toBe(201);
}

async function staffClient(roleName: 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `ps02-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('StaffPass123!'),
    firstName: roleName,
    emailVerified: true,
    isActive: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return c;
}

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

/** Builds an order with an unpaid `manual` intent, through the real payment flow. */
async function orderWithManualIntent() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `ps02-sup-${stamp}@wasit.tn`;
  const buyerEmail = `ps02-buy-${stamp}@wasit.tn`;

  await registerUser(supplier, supplierEmail, 'SUPPLIER');
  await registerUser(buyer, buyerEmail, 'CUSTOMER');
  await supplier.req('/api/auth/login', {
    method: 'POST',
    body: { email: supplierEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  const buyerLogin = await buyer.req('/api/auth/login', {
    method: 'POST',
    body: { email: buyerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  const buyerUserId = (buyerLogin.data.data as { id: string }).id;

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'PS02 Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `PS02SKU-${stamp}`,
      categoryId,
      name: `PS02 Product ${stamp}`,
      basePrice: '15.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
      quantity: 100,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
  });
  expect(order.status).toBe(201);
  const orderData = order.data.data as { orderId: string; transactionId: string; grandTotal: string };

  const intentRes = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  expect(intentRes.status).toBe(201);
  const intent = intentRes.data.data.intent as { id: string; externalRef: string; provider: string; amount: string };

  return { orderId: orderData.orderId, transactionId: orderData.transactionId, intent, stamp };
}

afterAll(async () => {
  await closeDb();
});

describe('PS-02 — manual payment completion', () => {
  it('lets an ADMIN complete a manual payment and moves intent/payment/order to PAID', async () => {
    const { orderId, transactionId, intent } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    const res = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'offline-ref-001' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.alreadyPaid).toBe(false);
    expect(res.data.data.paymentReference).toBe('offline-ref-001');

    const intentRow = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).limit(1);
    expect(intentRow[0].status).toBe('SUCCEEDED');

    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).toBe('PAID');
    // Completion is payment, not settlement.
    expect(orderRow[0].settlementStatus).toBe('PENDING');

    // Ledger entries stay PENDING — never promoted to SETTLED by this path.
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((e) => e.status !== 'SETTLED')).toBe(true);
    expect(ledger.some((e) => e.entryType === 'SETTLEMENT')).toBe(false);
  });

  it('records an audit entry naming the operator, the reference and the action', async () => {
    const { orderId } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');
    const me = await admin.req('/api/auth/me');
    const adminId = (me.data.data as { id: string }).id;

    const res = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'offline-ref-audit' },
    });
    expect(res.status).toBe(200);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'PAYMENT.MANUAL_COMPLETED'), eq(auditLogs.entityId, orderId)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorId).toBe(adminId);
    const after = audit[0].after as { paymentReference?: string; provider?: string };
    expect(after.paymentReference).toBe('offline-ref-audit');
    expect(after.provider).toBe('manual');
  });

  it('is idempotent: completing the same order twice does not double-apply', async () => {
    const { orderId } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    const first = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-1' },
    });
    expect(first.status).toBe(200);
    expect(first.data.data.alreadyPaid).toBe(false);

    const second = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-2' },
    });
    expect(second.status).toBe(200);
    expect(second.data.data.alreadyPaid).toBe(true);
  });

  it('refuses a missing payment reference with a validation error', async () => {
    const { orderId } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    const missing = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId },
    });
    expect(missing.status).toBe(422);

    const blank = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: '   ' },
    });
    expect(blank.status).toBe(422);
  });

  it('fails closed outside demo payment mode', async () => {
    const { orderId } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    const res = await withEnv({ DEMO_PAYMENT_MODE: false }, () =>
      admin.req('/api/admin/finance/manual-completions', {
        method: 'POST',
        body: { orderId, paymentReference: 'ref-demo-off' },
      }),
    );
    expect(res.status).toBe(503);

    // And nothing was written.
    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).not.toBe('PAID');
  });

  it('never confirms an intent belonging to a non-manual provider', async () => {
    const { orderId, intent } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    // Simulate the order having been charged on a real rail.
    await db.update(paymentIntents).set({ provider: 'open-checkout' }).where(eq(paymentIntents.id, intent.id));

    const res = await admin.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-wrong-provider' },
    });
    expect(res.status).toBe(409);

    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).not.toBe('PAID');
  });

  it('rejects a CUSTOMER and a MERCHANT (no access to the admin money desk)', async () => {
    const { orderId } = await orderWithManualIntent();

    const customer = await staffClient('CUSTOMER');
    const cRes = await customer.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-customer' },
    });
    expect(cRes.status).toBe(403);

    const merchant = await staffClient('MERCHANT');
    const mRes = await merchant.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-merchant' },
    });
    expect(mRes.status).toBe(403);

    const orderRow = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(orderRow[0].paymentStatus).not.toBe('PAID');
  });

  it('refuses an anonymous caller with 401', async () => {
    const { orderId } = await orderWithManualIntent();
    const anon = makeClient();
    const res = await anon.req('/api/admin/finance/manual-completions', {
      method: 'POST',
      body: { orderId, paymentReference: 'ref-anon' },
    });
    expect(res.status).toBe(401);
  });

  it('exposes an eligibility view that reflects demo mode and provider', async () => {
    const { orderId } = await orderWithManualIntent();
    const admin = await staffClient('ADMIN');

    const view = await admin.req(`/api/admin/finance/manual-completions/${orderId}`);
    expect(view.status).toBe(200);
    expect(view.data.data.demoMode).toBe(true);
    expect(view.data.data.eligible).toBe(true);
    expect(view.data.data.intent.provider).toBe('manual');

    const availability = await admin.req('/api/admin/finance/manual-payment-availability');
    expect(availability.status).toBe(200);
    expect(availability.data.data.demoMode).toBe(true);
    expect(availability.data.data.provider).toBe('manual');
  });

  it('does not leak whether an order exists to a non-admin', async () => {
    const customer = await staffClient('CUSTOMER');
    const view = await customer.req(`/api/admin/finance/manual-completions/${randomUUID()}`);
    expect(view.status).toBe(403);
  });
});

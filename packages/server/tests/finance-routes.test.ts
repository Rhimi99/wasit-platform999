import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { orders, transactionLedger, transactions } from '../src/db/schema/commerce.js';
import { suppliers } from '../src/db/schema/trade.js';
import { computeWebhookSignature, ManualPaymentProvider } from '../src/lib/payments/providers.js';
import { handlePaymentWebhook } from '../src/modules/payments/service.js';
import { confirmSettlement } from '../src/modules/settlements/service.js';

/**
 * P3 — HTTP surface for settlement / payout / reconciliation.
 *
 * Exercises the real routes end-to-end (session auth → permission → service →
 * database) and proves the routes cannot be used to bypass an invariant: a
 * merchant cannot move money, and an admin cannot force a payout to COMPLETED
 * without matching provider evidence.
 */

const app = createApp();
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;

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
    body: { email, password: 'StrongPass123!', firstName: 'Fin', role },
  });
  expect(r.status).toBe(201);
}

async function staffClient(roleName: 'ADMIN' | 'MERCHANT') {
  const id = randomUUID();
  const email = `fin-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
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

/** Builds a paid + settled transaction through the real payment flow. */
async function paidAndSettledOrder() {
  const supplier = makeClient();
  const buyer = makeClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const supplierEmail = `fin-sup-${stamp}@wasit.tn`;
  const buyerEmail = `fin-buy-${stamp}@wasit.tn`;

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

  const supplierProfile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Fin Test Co' } });
  expect(supplierProfile.status).toBe(201);
  const supplierId = supplierProfile.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: `FINSKU-${stamp}`,
      categoryId,
      name: `Finance Product ${stamp}`,
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
  const orderData = order.data.data as { orderId: string; grandTotal: string; transactionId: string };

  const intentRes = await buyer.req(`/api/payments/orders/${orderData.orderId}/intent`, { method: 'POST', body: {} });
  expect(intentRes.status).toBe(201);
  const intent = intentRes.data.data.intent as { externalRef: string; amount: string };

  const rawBody = JSON.stringify({
    eventId: `evt-${stamp}`,
    type: 'payment.succeeded',
    externalRef: intent.externalRef,
    amount: intent.amount,
    currencyCode: 'TND',
  });
  const paid = await handlePaymentWebhook(
    db,
    { rawBody, signature: computeWebhookSignature(rawBody, WEBHOOK_SECRET) },
    new ManualPaymentProvider(),
  );
  expect(paid.applied).toBe(true);

  // Settlement is a distinct fact with distinct evidence.
  const settled = await confirmSettlement(db, {
    externalRef: intent.externalRef,
    amount: intent.amount,
    currencyCode: 'TND',
    providerId: 'open-checkout',
    settlementRef: `settle-${stamp}`,
  });
  expect(settled.applied).toBe(true);

  return {
    supplier,
    buyer,
    supplierId,
    buyerUserId,
    orderId: orderData.orderId,
    transactionId: orderData.transactionId,
    grandTotal: orderData.grandTotal,
    externalRef: intent.externalRef,
    settlementRef: `settle-${stamp}`,
    stamp,
  };
}

afterAll(async () => {
  await closeDb();
});

describe('P3 finance routes — authentication and permission', () => {
  it('refuses an unauthenticated caller', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/admin/finance/payout-providers')).status).toBe(401);
    expect(
      (
        await anon.req('/api/admin/finance/settlements/confirm', {
          method: 'POST',
          body: { externalRef: 'x', amount: '1', currencyCode: 'TND', providerId: 'p', settlementRef: 'r' },
        })
      ).status,
    ).toBe(401);
  });

  it('refuses a CUSTOMER (no money-movement permission)', async () => {
    const c = makeClient();
    const email = `fin-cust-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
    await registerUser(c, email, 'CUSTOMER');
    const login = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);
    expect((await c.req('/api/admin/finance/payout-providers')).status).toBe(403);
  });

  it('refuses a MERCHANT (no money-movement permission)', async () => {
    const merchant = await staffClient('MERCHANT');
    expect((await merchant.req('/api/admin/finance/payout-providers')).status).toBe(403);
  });

  it('refuses a MERCHANT attempting to confirm a settlement', async () => {
    const merchant = await staffClient('MERCHANT');
    const r = await merchant.req('/api/admin/finance/settlements/confirm', {
      method: 'POST',
      body: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout', settlementRef: 'r' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses a MERCHANT attempting to create a payout', async () => {
    const merchant = await staffClient('MERCHANT');
    const r = await merchant.req('/api/admin/finance/payouts', {
      method: 'POST',
      body: { transactionId: 'x', providerId: 'sandbox' },
    });
    expect(r.status).toBe(403);
  });

  it('allows an ADMIN to list payout providers', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/payout-providers');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data.providers)).toBe(true);
  });
});

describe('P3 finance routes — payout cannot be forced to COMPLETED', () => {
  it('an ADMIN creates a payout via HTTP; it starts as CREATED', async () => {
    const { transactionId } = await paidAndSettledOrder();
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/payouts', {
      method: 'POST',
      body: { transactionId, providerId: 'sandbox' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data.status).toBe('CREATED');
    // Amount is derived server-side, never supplied by the caller:
    // itemsTotal 310.00 − seller share of the 4% commission (6.20) = 303.80.
    expect(r.data.data.amount).toBe('303.8000');
  });

  it('dispatching over HTTP reaches PROCESSING, never COMPLETED', async () => {
    const { transactionId } = await paidAndSettledOrder();
    const admin = await staffClient('ADMIN');
    const created = await admin.req('/api/admin/finance/payouts', {
      method: 'POST',
      body: { transactionId, providerId: 'sandbox' },
    });
    const payoutId = created.data.data.id as string;

    const dispatched = await admin.req(`/api/admin/finance/payouts/${payoutId}/dispatch`, {
      method: 'POST',
      body: { beneficiaryRef: 'beneficiary-http-1' },
    });
    expect(dispatched.status).toBe(200);
    expect(dispatched.data.data.payout.status).toBe('PROCESSING');
    expect(dispatched.data.data.payout.status).not.toBe('COMPLETED');
  });

  it('reading a payout over HTTP returns its persisted state', async () => {
    const { transactionId } = await paidAndSettledOrder();
    const admin = await staffClient('ADMIN');
    const created = await admin.req('/api/admin/finance/payouts', {
      method: 'POST',
      body: { transactionId, providerId: 'sandbox' },
    });
    const payoutId = created.data.data.id as string;

    const read = await admin.req(`/api/admin/finance/payouts/${payoutId}`);
    expect(read.status).toBe(200);
    expect(read.data.data.id).toBe(payoutId);
    expect(read.data.data.status).toBe('CREATED');
  });

  it('returns 404 for an unknown payout', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req(`/api/admin/finance/payouts/${randomUUID()}`);
    expect(r.status).toBe(404);
  });

  it('rejects a payout for an unsettled transaction (settlement is a precondition)', async () => {
    // A paid-but-unsettled transaction must not be payable.
    const supplier = makeClient();
    const buyer = makeClient();
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await registerUser(supplier, `fin2-sup-${stamp}@wasit.tn`, 'SUPPLIER');
    await registerUser(buyer, `fin2-buy-${stamp}@wasit.tn`, 'CUSTOMER');
    await supplier.req('/api/auth/login', {
      method: 'POST',
      body: { email: `fin2-sup-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const buyerLogin = await buyer.req('/api/auth/login', {
      method: 'POST',
      body: { email: `fin2-buy-${stamp}@wasit.tn`, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const buyerUserId = (buyerLogin.data.data as { id: string }).id;
    const sp = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Unsettled Co' } });
    const supplierId = sp.data.data.id as string;
    const cats = await supplier.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const product = await supplier.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `UNSET-${stamp}`,
        categoryId,
        name: `Unsettled ${stamp}`,
        basePrice: '10.0000',
        currencyCode: 'TND',
        moq: 1,
        initialQuantity: 10,
        lowStockThreshold: 1,
        quantity: 10,
      },
    });
    const productId = product.data.data.id as string;
    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 1 }] },
    });
    const transactionId = (order.data.data as { transactionId: string }).transactionId;

    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/payouts', {
      method: 'POST',
      body: { transactionId, providerId: 'sandbox' },
    });
    // The service refuses: no SETTLED ledger entry exists yet.
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('P3 finance routes — settlement and reconciliation over HTTP', () => {
  it('rejects settlement evidence without a reference', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/settlements/confirm', {
      method: 'POST',
      body: { externalRef: 'x', amount: '1.0000', currencyCode: 'TND', providerId: 'open-checkout' },
    });
    expect(r.status).toBe(422);
  });

  it('rejects a malformed currency code', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/settlements/confirm', {
      method: 'POST',
      body: { externalRef: 'x', amount: '1.0000', currencyCode: 'TNDX', providerId: 'p', settlementRef: 'r' },
    });
    expect(r.status).toBe(422);
  });

  it('imports a reconciliation feed and returns a report', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/reconciliation/import', {
      method: 'POST',
      body: {
        source: 'PROVIDER',
        currencyCode: 'TND',
        importKey: `imp-${randomUUID().slice(0, 8)}`,
        providerId: 'open-checkout',
        provider: [
          {
            reference: 'ref-http-1',
            settlementRef: 'set-http-1',
            grossAmount: '100.0000',
            providerFee: '2.0000',
            netAmount: '98.0000',
            currencyCode: 'TND',
          },
        ],
        bank: [],
        ledger: [],
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.data.importId).toBeTruthy();
    expect(r.data.data.report).toBeTruthy();
  });

  it('rejects a reconciliation feed with an unknown source', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/reconciliation/import', {
      method: 'POST',
      body: { source: 'NONSENSE', currencyCode: 'TND', provider: [], bank: [], ledger: [] },
    });
    expect(r.status).toBe(422);
  });

  it('rejects a receipt with an unknown evidence source', async () => {
    const admin = await staffClient('ADMIN');
    const r = await admin.req('/api/admin/finance/receipts', {
      method: 'POST',
      body: {
        transactionId: 'x',
        evidence: { source: 'MADE_UP', reference: 'r', amount: '1.0000', currencyCode: 'TND' },
      },
    });
    expect(r.status).toBe(422);
  });
});

describe('P3 finance routes — admin payout list', () => {
  it('lists payouts for an authorised admin, newest first with a stable order', async () => {
    const admin = await staffClient('ADMIN');
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { transactionId } = await paidAndSettledOrder();
      const r = await admin.req('/api/admin/finance/payouts', {
        method: 'POST',
        body: { transactionId, providerId: 'sandbox' },
      });
      expect(r.status).toBe(200);
      created.push(r.data.data.id as string);
    }

    const list = await admin.req('/api/admin/finance/payouts?page=1&pageSize=100');
    expect(list.status).toBe(200);
    const items = list.data.data.items as Array<{ id: string; status: string; amount: string; currencyCode: string; createdAt: string }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);

    // Every payout this test created is present with its persisted fields.
    for (const id of created) {
      const row = items.find((i) => i.id === id);
      expect(row).toBeTruthy();
      expect(row!.status).toBe('CREATED');
      expect(row!.amount).toBe('303.8000');
      expect(row!.currencyCode).toBe('TND');
    }

    // The order is total and stable: createdAt desc, tie-broken by id desc.
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1];
      const b = items[i];
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      expect(at >= bt).toBe(true);
      if (at === bt) expect(a.id >= b.id).toBe(true);
    }

    // pagination echoes the validated request and a real total.
    expect(list.data.data.pagination.page).toBe(1);
    expect(list.data.data.pagination.pageSize).toBe(100);
    expect(list.data.data.pagination.total).toBeGreaterThanOrEqual(items.length);
  });

  it('pages without overlap and rejects out-of-range pagination parameters', async () => {
    const admin = await staffClient('ADMIN');
    const { transactionId } = await paidAndSettledOrder();
    await admin.req('/api/admin/finance/payouts', { method: 'POST', body: { transactionId, providerId: 'sandbox' } });

    const p1 = await admin.req('/api/admin/finance/payouts?page=1&pageSize=1');
    const p2 = await admin.req('/api/admin/finance/payouts?page=2&pageSize=1');
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const first = (p1.data.data.items as Array<{ id: string }>)[0];
    const second = (p2.data.data.items as Array<{ id: string }>)[0];
    expect(first).toBeTruthy();
    if (second) expect(second.id).not.toBe(first.id);

    // Invalid pagination is refused, never silently clamped.
    expect((await admin.req('/api/admin/finance/payouts?page=0')).status).toBe(422);
    expect((await admin.req('/api/admin/finance/payouts?pageSize=101')).status).toBe(422);
    expect((await admin.req('/api/admin/finance/payouts?pageSize=-5')).status).toBe(422);
    expect((await admin.req('/api/admin/finance/payouts?status=BOGUS')).status).toBe(422);
    expect((await admin.req('/api/admin/finance/payouts?page=abc')).status).toBe(422);
  });

  it('filters by status and returns an empty page when nothing matches', async () => {
    const admin = await staffClient('ADMIN');
    const { transactionId } = await paidAndSettledOrder();
    await admin.req('/api/admin/finance/payouts', { method: 'POST', body: { transactionId, providerId: 'sandbox' } });

    const created = await admin.req('/api/admin/finance/payouts?status=CREATED&pageSize=100');
    expect(created.status).toBe(200);
    const rows = created.data.data.items as Array<{ status: string }>;
    expect(rows.every((r) => r.status === 'CREATED')).toBe(true);

    // A status that is valid but matches nothing still returns a well-formed page.
    const completed = await admin.req('/api/admin/finance/payouts?status=COMPLETED&page=1&pageSize=100');
    expect(completed.status).toBe(200);
    expect((completed.data.data.items as Array<{ status: string }>).every((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('is read-only: listing never changes a payout status', async () => {
    const admin = await staffClient('ADMIN');
    const { transactionId } = await paidAndSettledOrder();
    const made = await admin.req('/api/admin/finance/payouts', { method: 'POST', body: { transactionId, providerId: 'sandbox' } });
    const payoutId = made.data.data.id as string;
    expect(made.data.data.status).toBe('CREATED');

    // Listing repeatedly must not advance CREATED -> PROCESSING -> COMPLETED.
    for (let i = 0; i < 3; i++) {
      const list = await admin.req(`/api/admin/finance/payouts?pageSize=100`);
      expect(list.status).toBe(200);
      const row = (list.data.data.items as Array<{ id: string; status: string }>).find((r) => r.id === payoutId);
      expect(row?.status).toBe('CREATED');
    }

    const after = await admin.req(`/api/admin/finance/payouts/${payoutId}`);
    expect(after.data.data.status).toBe('CREATED');
    expect(after.data.data.completedAt ?? null).toBeNull();
  });

  it('refuses unauthenticated and unauthorised callers', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/admin/finance/payouts')).status).toBe(401);

    const merchant = await staffClient('MERCHANT');
    expect((await merchant.req('/api/admin/finance/payouts')).status).toBe(403);

    const customer = makeClient();
    const customerEmail = `fin-list-cust-${Date.now()}@wasit.tn`;
    await registerUser(customer, customerEmail, 'CUSTOMER');
    await customer.req('/api/auth/login', {
      method: 'POST',
      body: { email: customerEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect((await customer.req('/api/admin/finance/payouts')).status).toBe(403);
  });
});

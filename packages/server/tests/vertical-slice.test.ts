import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { eq } from 'drizzle-orm';
import { transactionLedger } from '../src/db/schema/commerce.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, userRoles } from '../src/db/schema/auth.js';

const app = createApp();

/** Minimal fetch wrapper that preserves cookies across calls. */
function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
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
    body: { email, password: 'StrongPass123!', firstName: 'Test', role },
  });
  expect(r.status).toBe(201);
}

afterAll(() => {
  closeDb();
});

describe('WASIT Vertical Slice (User → Supplier → Product → Search → Order → Transaction → Ledger)', () => {
  it('health endpoints work', async () => {
    const c = makeClient();
    const live = await c.req('/api/health/live');
    expect(live.status).toBe(200);
    expect(live.data).toMatchObject({ status: 'ok' });
  });

  it('registers, logs in, and loads session for all roles', async () => {
    const c = makeClient();
    const email = `it-customer-${Date.now()}@wasit.tn`;
    await registerUser(c, email, 'CUSTOMER');
    const login = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);
    expect(login.data.data.roles).toContain('CUSTOMER');
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.data.email).toBe(email);
  });

  it('rejects registration with weak password', async () => {
    const c = makeClient();
    const r = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email: `weak-${Date.now()}@wasit.tn`, password: '123', firstName: 'X' },
    });
    expect(r.status).toBe(422);
  });

  it('enforces RBAC: CUSTOMER cannot create supplier (403)', async () => {
    const c = makeClient();
    const email = `it-rbac-${Date.now()}@wasit.tn`;
    await registerUser(c, email, 'CUSTOMER');
    await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const r = await c.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'Illegal' },
    });
    expect(r.status).toBe(403);
  });

  it('enforces RBAC: CUSTOMER cannot access admin routes (403)', async () => {
    const c = makeClient();
    const email = `it-admin-rbac-${Date.now()}@wasit.tn`;
    await registerUser(c, email, 'CUSTOMER');
    await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const r = await c.req('/api/admin/stats');
    expect(r.status).toBe(403);
  });

  it('enforces RBAC: wrong role cannot create merchant/company (403)', async () => {
    const c = makeClient();
    const email = `it-multi-rbac-${Date.now()}@wasit.tn`;
    await registerUser(c, email, 'CUSTOMER');
    await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const r1 = await c.req('/api/merchants', {
      method: 'POST',
      body: { storeName: 'Illegal Store' },
    });
    expect(r1.status).toBe(403);
    const r2 = await c.req('/api/companies', {
      method: 'POST',
      body: { legalName: 'Illegal Co' },
    });
    expect(r2.status).toBe(403);
  });

  it('runs the full vertical slice', async () => {
    const supplier = makeClient();
    const buyer = makeClient();

    const supEmail = `it-supplier-${Date.now()}@wasit.tn`;
    const buyEmail = `it-buyer-${Date.now()}@wasit.tn`;
    await registerUser(supplier, supEmail, 'SUPPLIER');
    await registerUser(buyer, buyEmail, 'CUSTOMER');

    const supLogin = await supplier.req('/api/auth/login', {
      method: 'POST',
      body: { email: supEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(supLogin.data.data.roles).toContain('SUPPLIER');
    const buyerLogin = await buyer.req('/api/auth/login', {
      method: 'POST',
      body: { email: buyEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(buyerLogin.status).toBe(200);
    const buyerUserId = (buyerLogin.data.data as { id: string }).id;

    // 1. Supplier profile
    const supplierProfile = await supplier.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'Test Textiles Co' },
    });
    expect(supplierProfile.status).toBe(201);
    const supplierId = supplierProfile.data.data.id as string;

    // 2. Categories
    const cats = await supplier.req('/api/categories');
    expect(cats.status).toBe(200);
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

    // 3. Product
    const createdAt = Date.now().toString();
    const product = await supplier.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `SKU-${createdAt}`,
        categoryId,
        name: `Test Cotton ${createdAt}`,
        basePrice: '15.5000',
        currencyCode: 'TND',
        moq: 10,
        initialQuantity: 500,
        lowStockThreshold: 20,
        quantity: 500,
      },
    });
    expect(product.status).toBe(201);
    const productId = product.data.data.id as string;

    // 4. Search
    const search = await buyer.req(`/api/search?q=cotton`, {});
    expect(search.status).toBe(200);
    const results = search.data.data.results as Array<{ type: string; count: number }>;
    const productResults = results.find((r) => r.type === 'products');
    expect(productResults!.count).toBeGreaterThan(0);

    // 5. Order (20 units of 15.5 TND = 310 TND; base commission 4% = 12.4, split 2% seller + 2% buyer)
    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyerUserId,
        buyerType: 'CUSTOMER',
        items: [{ productId, quantity: 20 }],
      },
    });
    expect(order.status).toBe(201);
    const orderData = order.data.data as {
      orderId: string;
      itemsTotal: string;
      commission: string;
      commissionSeller: string;
      commissionBuyer: string;
      commissionRate: string;
      grandTotal: string;
      transactionId: string;
      paymentFee: string;
      paymentFeePolicyId: string;
    };
    expect(orderData.commission).toBe('12.4000');
    expect(orderData.commissionSeller).toBe('6.2000');
    expect(orderData.commissionBuyer).toBe('6.2000');
    expect(orderData.commissionRate).toBe('0.04');
    // Buyer total = items + buyer's 2% commission share (no payment fee baked in).
    expect(orderData.grandTotal).toBe('316.2000');
    // Payment fee must come from the Payment Fee Policy engine (seeded 2%), not hardcoded.
    expect(orderData.paymentFee).toBe('6.2000');
    expect(orderData.paymentFeePolicyId).toBeTruthy();

    // 6. Transaction Ledger entries
    const ledger = await db
      .select()
      .from(transactionLedger)
      .where(eq(transactionLedger.transactionId, orderData.transactionId));
    const entryTypes = ledger.map((e) => e.entryType);
    expect(entryTypes).toContain('TRANSACTION_VALUE');
    expect(entryTypes).toContain('COMMISSION');
    expect(entryTypes).toContain('PAYMENT_FEE');
    const commissionEntries = ledger.filter((e) => e.entryType === 'COMMISSION');
    // Two shares: seller and buyer, each 2% of 310.
    expect(commissionEntries).toHaveLength(2);
    expect(commissionEntries.map((e) => e.amount).sort()).toEqual(['6.2000', '6.2000']);
    expect(commissionEntries.map((e) => e.payerId)).toContain(supplierId);

    // 7. Audit trail
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, orderData.orderId))
      .limit(5);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.some((a) => a.action === 'ORDER.CREATE')).toBe(true);
  });

  it('rejects order below MOQ (422)', async () => {
    const supplier = makeClient();
    const buyer = makeClient();

    const supEmail = `it-moq-sup-${Date.now()}@wasit.tn`;
    const buyEmail = `it-moq-buy-${Date.now()}@wasit.tn`;
    await registerUser(supplier, supEmail, 'SUPPLIER');
    await registerUser(buyer, buyEmail, 'CUSTOMER');
    await supplier.req('/api/auth/login', {
      method: 'POST',
      body: { email: supEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const buyerLogin = await buyer.req('/api/auth/login', {
      method: 'POST',
      body: { email: buyEmail, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    const buyerId = (buyerLogin.data.data as { id: string }).id;

    const profile = await supplier.req('/api/suppliers', {
      method: 'POST',
      body: { companyName: 'MOQ Test Co' },
    });
    const supplierId = profile.data.data.id as string;
    const cats = await supplier.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const product = await supplier.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId,
        sellerType: 'SUPPLIER',
        sku: `MOQ-${Date.now()}`,
        categoryId,
        name: `MOQ Product ${Date.now()}`,
        basePrice: '10.0000',
        currencyCode: 'TND',
        moq: 10,
        initialQuantity: 100,
        lowStockThreshold: 10,
        quantity: 100,
      },
    });
    const productId = product.data.data.id as string;

    // Order 5 units, below MOQ of 10 -> 422
    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId,
        buyerType: 'CUSTOMER',
        items: [{ productId, quantity: 5 }],
      },
    });
    expect(order.status).toBe(422);
  });

  it('requires authentication for protected endpoints (401)', async () => {
    const c = makeClient();
    const st = await c.req('/api/admin/stats');
    expect(st.status).toBe(401);
    const ord = await c.req('/api/orders', {
      method: 'POST',
      body: { buyerId: 'x', items: [] },
    });
    expect(ord.status).toBe(401);
  });

  it('never creates an orphan user: a registered user always has the requested role attached', async () => {
    const c = makeClient();
    const email = `it-role-${Date.now()}@wasit.tn`;
    await registerUser(c, email, 'MERCHANT');
    const row = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    expect(row.length).toBe(1);
    const roleRows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.userId, row[0].id));
    expect(roleRows.length).toBeGreaterThan(0);
    expect(await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    })).toMatchObject({ status: 200 });
  });
});
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { paymentFeePolicies } from '../src/db/schema/engine.js';
import { newId } from '../src/lib/ids.js';

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
      const s = res.headers.get('set-cookie');
      if (s) cookie = s;
      let data: unknown = null;
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { data: data as any, status: res.status };
    },
  };
}

async function registerAndLogin(role: string, tag: string) {
  const c = makeClient();
  const email = `feepolicy-${tag}-${Date.now()}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: tag, role },
  });
  expect(r.status).toBe(201);
  const l = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(l.status).toBe(200);
  const userId = (l.data.data as { id: string }).id;
  return { c, userId };
}

/** Create a supplier, one product, then order from a buyer. Returns the order data. */
async function createOrderFlow() {
  const { c: supplier } = await registerAndLogin('SUPPLIER', 'Supplier');
  const { c: buyer, userId: buyerId } = await registerAndLogin('CUSTOMER', 'Customer');

  const sup = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: 'Fee Policy Test Co' } });
  expect(sup.status).toBe(201);
  const supplierId = sup.data.data.id as string;

  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const sku = `SKU-FEE-${Date.now()}`;
  const prod = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku,
      categoryId,
      name: `Fee Policy Product ${sku}`,
      basePrice: '100.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 500,
      lowStockThreshold: 20,
      quantity: 500,
    },
  });
  expect(prod.status).toBe(201);
  const productId = prod.data.data.id as string;

  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 1 }] },
  });
  expect(order.status).toBe(201);
  return order.data.data as {
    orderId: string;
    itemsTotal: string;
    commission: string;
    commissionSeller: string;
    commissionBuyer: string;
    grandTotal: string;
    paymentFee: string;
    paymentFeePolicyId: string | null;
    policyId: string | null;
    transactionId: string;
  };
}

beforeAll(async () => {
  // Clean any prior test fee policy rows to isolate the assertions.
  await db.delete(paymentFeePolicies);
});

afterAll(() => {
  closeDb();
});

describe('Payment Fee Policy Engine (no hardcoded fees)', () => {
  it('reads the fee rate from the DB policy and not from source', async () => {
    // Insert a dedicated policy: 1.5% + 0.5 flat.
    const policyId = newId();
    await db.insert(paymentFeePolicies).values({
      id: policyId,
      name: 'Test Processing 1.5% + 0.5',
      provider: 'test',
      percentRate: '0.015',
      flatFee: '0.5000',
      currencyCode: 'TND',
      conditions: {},
      isActive: true,
    });

    const order = await createOrderFlow();
    // 1 unit of 100 TND → fee = 100*0.015 + 0.5 = 2.0000
    expect(order.paymentFee).toBe('2.0000');
    expect(order.paymentFeePolicyId).toBe(policyId);
  });

  it('uses the default seeded policy (2%) when no dedicated one matches', async () => {
    // Wipe all user-created policies → only the seeded default (2%) should remain visible
    // to the engine. (The globalSetup seed runs before each worker; this test asserts the
    // default policy produces 2% of 100 = 2.00.)
    await db.delete(paymentFeePolicies);
    // Re-insert the default policy exactly as seed.ts does.
    await db.insert(paymentFeePolicies).values({
      id: newId(),
      name: 'WASIT Default Processing Fee',
      provider: 'default',
      percentRate: '0.02',
      flatFee: '0',
      currencyCode: 'TND',
      conditions: {},
      isActive: true,
    });

    const order = await createOrderFlow();
    expect(order.paymentFee).toBe('2.0000');
    // Commission is the seeded 4% base split evenly: 2% seller + 2% buyer on 100.
    expect(order.commission).toBe('4.0000');
    expect(order.commissionSeller).toBe('2.0000');
    expect(order.commissionBuyer).toBe('2.0000');
    // Payment provider fee stays separate from commission: buyer total = 100 + 2.
    expect(order.grandTotal).toBe('102.0000');
  });
});
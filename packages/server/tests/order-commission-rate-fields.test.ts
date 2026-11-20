import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/db/client.js';

/**
 * The order-create response must carry the Commission Engine's RATE breakdown,
 * not just the amounts. The multi-seller rewrite (M2) collapsed the return object
 * to amounts only and dropped `commissionSellerRate` / `commissionBuyerRate`,
 * which the checkout UI and the functional-audit E2E reconcile against — with the
 * fields gone, `Number(undefined)` is `NaN` and the split can no longer be proven.
 *
 * These assertions pin the contract: the rates are present, and the amounts equal
 * `itemsTotal x rate` for the seller and the buyer parts, summing to the total.
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
      const s = res.headers.get('set-cookie');
      if (s) cookie = s;
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

async function registerAndLogin(role: string, tag: string) {
  const c = makeClient();
  const email = `commrate-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
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
  return { c, userId: (l.data.data as { id: string }).id as string };
}

async function makeSellerProduct(tag: string, price: string) {
  const { c: seller } = await registerAndLogin('SUPPLIER', tag);
  const sup = await seller.req('/api/suppliers', { method: 'POST', body: { companyName: `CommRate ${tag}` } });
  expect(sup.status).toBe(201);
  const sellerId = sup.data.data.id as string;
  const cats = await seller.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const sku = `SKU-COMMRATE-${tag}-${Date.now()}`;
  const prod = await seller.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: 'SUPPLIER',
      sku,
      categoryId,
      name: `CommRate Product ${sku}`,
      basePrice: price,
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 500,
      lowStockThreshold: 20,
      quantity: 500,
    },
  });
  expect(prod.status).toBe(201);
  return prod.data.data.id as string;
}

interface OrderCommission {
  itemsTotal: string;
  commission: string;
  commissionSeller: string;
  commissionBuyer: string;
  commissionRate: string;
  commissionSellerRate?: string;
  commissionBuyerRate?: string;
}

/** Places an order and returns the raw commission fields from the response. */
async function placeOrder(items: Array<{ productId: string; quantity: number }>): Promise<OrderCommission> {
  const { c: buyer, userId: buyerId } = await registerAndLogin('CUSTOMER', 'Buyer');
  const order = await buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, buyerType: 'CUSTOMER', items },
  });
  expect(order.status).toBe(201);
  return order.data.data as OrderCommission;
}

/** Asserts the rate/amount contract holds for one order response. */
function expectRatesReconcile(order: OrderCommission) {
  expect(typeof order.commissionSellerRate, 'commissionSellerRate must be present').toBe('string');
  expect(typeof order.commissionBuyerRate, 'commissionBuyerRate must be present').toBe('string');

  const itemsTotal = Number(order.itemsTotal);
  const totalRate = Number(order.commissionRate);
  const sellerRate = Number(order.commissionSellerRate);
  const buyerRate = Number(order.commissionBuyerRate);

  expect(Number.isFinite(sellerRate)).toBe(true);
  expect(Number.isFinite(buyerRate)).toBe(true);
  // The engine's split must add up to the engine's own total rate.
  expect(sellerRate + buyerRate).toBeCloseTo(totalRate, 6);
  // Each part is the basket value times its own rate.
  expect(Number(order.commissionSeller)).toBeCloseTo(itemsTotal * sellerRate, 4);
  expect(Number(order.commissionBuyer)).toBeCloseTo(itemsTotal * buyerRate, 4);
  expect(Number(order.commission)).toBeCloseTo(itemsTotal * totalRate, 4);
}

afterAll(() => {
  closeDb();
});

describe('order-create commission rate contract', () => {
  it('returns the seller and buyer commission rates for a single-seller order', async () => {
    const productId = await makeSellerProduct('single', '100.0000');
    const order = await placeOrder([{ productId, quantity: 1 }]);
    expectRatesReconcile(order);
  });

  it('returns the aggregated rates for a multi-seller order', async () => {
    const [p1, p2] = await Promise.all([makeSellerProduct('multiA', '50.0000'), makeSellerProduct('multiB', '75.0000')]);
    const order = await placeOrder([
      { productId: p1, quantity: 2 },
      { productId: p2, quantity: 1 },
    ]);
    expectRatesReconcile(order);
  });
});

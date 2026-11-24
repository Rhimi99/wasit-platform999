import { describe, it, expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { orders, orderItems, sellerOrders } from '../src/db/schema/commerce.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { products } from '../src/db/schema/products.js';

/**
 * CART-01 — a real multi-product cart, driven through the real HTTP surface.
 *
 * The cart lives in the browser, so what these specs prove is the contract the
 * cart depends on: the server prices the basket (never the client), reports
 * stock and availability per line, groups lines by seller without mixing their
 * money, and refuses a basket it cannot fulfil without leaving reservations
 * behind. No mocks: real PostgreSQL, real services, real policy rows.
 */

const app = createApp();

let ipCounter = 200;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function makeClient(ip = nextIp()) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
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

type Client = ReturnType<typeof makeClient>;

async function register(c: Client, role: 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY'): Promise<string> {
  const email = `cart-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Cart', lastName: role, role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await c.req('/api/auth/me');
  expect(me.status).toBe(200);
  return (me.data.data as { id: string }).id;
}

async function firstCategoryId(client: Client): Promise<string> {
  const cats = await client.req('/api/categories');
  expect(cats.status).toBe(200);
  return (cats.data.data as Array<{ id: string }>)[0].id;
}

async function createEntity(client: Client, kind: 'merchants' | 'companies', name: string): Promise<string> {
  const body = kind === 'merchants' ? { storeName: name } : { legalName: name };
  const res = await client.req(`/api/${kind}`, { method: 'POST', body });
  expect(res.status).toBe(201);
  return res.data.data.id as string;
}

function uniqueSku(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createProduct(
  seller: Client,
  opts: {
    sellerId: string;
    sellerType?: 'SUPPLIER' | 'MERCHANT' | 'COMPANY';
    sku?: string;
    price?: string;
    currency?: string;
    moq?: number;
    stock?: number;
    publish?: boolean;
  },
): Promise<string> {
  const categoryId = await firstCategoryId(seller);
  const res = await seller.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: opts.sellerId,
      sellerType: opts.sellerType ?? 'MERCHANT',
      categoryId,
      name: `Cart Item ${opts.sku ?? uniqueSku('C')}`,
      sku: opts.sku ?? uniqueSku('C'),
      basePrice: opts.price ?? '10.0000',
      currencyCode: opts.currency ?? 'TND',
      moq: opts.moq ?? 1,
      initialQuantity: opts.stock ?? 50,
      lowStockThreshold: 2,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const productId = res.data.data.id as string;
  if (opts.publish !== false) {
    const publish = await seller.req(`/api/products/${productId}/status`, {
      method: 'PATCH',
      body: { status: 'ACTIVE' },
    });
    expect(publish.status).toBe(200);
  }
  return productId;
}

/** A merchant with its own product catalogue, ready to be bought from. */
async function seedSeller(
  products_: { price?: string; stock?: number; currency?: string; moq?: number }[] = [{}],
) {
  const seller = makeClient();
  await register(seller, 'MERCHANT');
  const sellerId = await createEntity(seller, 'merchants', `Cart Store ${uniqueSku('S')}`);
  const ids: string[] = [];
  for (const spec of products_) {
    ids.push(await createProduct(seller, { sellerId, ...spec }));
  }
  return { seller, sellerId, productIds: ids };
}

function quote(buyer: Client, items: { productId: string; quantity: number }[]) {
  return buyer.req('/api/orders/quote', { method: 'POST', body: { items } });
}

function place(
  buyer: Client,
  buyerId: string,
  items: { productId: string; quantity: number }[],
  extra: Record<string, unknown> = {},
) {
  return buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, buyerType: 'CUSTOMER', items, ...extra },
  });
}

async function reservedOf(productId: string, sellerId: string): Promise<number> {
  const rows = await db
    .select({ reserved: inventoryItems.reservedQuantity })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.productId, productId), eq(inventoryItems.merchantId, sellerId)));
  return rows[0]?.reserved ?? 0;
}

async function orderCountOf(buyerId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.buyerId, buyerId));
  return rows[0]?.count ?? 0;
}

describe('CART-01 — the cart is priced and validated by the server', () => {
  it('requires a session and refuses an empty basket', async () => {
    const anonymous = makeClient();
    const anon = await quote(anonymous, [{ productId: 'x', quantity: 1 }]);
    expect(anon.status).toBe(401);

    const { productIds } = await seedSeller();
    const buyer = makeClient();
    await register(buyer, 'CUSTOMER');
    const empty = await quote(buyer, []);
    expect(empty.status).toBe(422);
    // A zero/negative quantity is not a cart line.
    expect((await quote(buyer, [{ productId: productIds[0], quantity: 0 }])).status).toBe(422);
  });

  it('prices one product from the database, and the order charges exactly that', async () => {
    const { sellerId, productIds } = await seedSeller([{ price: '12.5000', stock: 20 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [{ productId: productIds[0], quantity: 3 }]);
    expect(q.status, JSON.stringify(q.data)).toBe(200);
    const quoted = q.data.data;
    expect(quoted.sellerCount).toBe(1);
    expect(quoted.itemsTotal).toBe('37.5000');
    expect(quoted.sellers[0].lines[0].unitPrice).toBe('12.5000');
    expect(quoted.sellers[0].lines[0].available).toBe(20);
    expect(quoted.issues).toEqual([]);
    // The buyer pays their commission share; the grand total is items + that share.
    expect(Number(quoted.grandTotal)).toBeCloseTo(Number(quoted.itemsTotal) + Number(quoted.commissionBuyer), 4);

    const created = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 3 }]);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    // Quote and order can never disagree on money.
    expect(created.data.data.itemsTotal).toBe(quoted.itemsTotal);
    expect(created.data.data.commissionBuyer).toBe(quoted.commissionBuyer);
    expect(created.data.data.paymentFee).toBe(quoted.paymentFee);
    expect(created.data.data.grandTotal).toBe(quoted.grandTotal);
    expect(await reservedOf(productIds[0], sellerId)).toBe(3);
  });

  it('prices several products from the same seller as one group and one suborder', async () => {
    const { sellerId, productIds } = await seedSeller([{ price: '10.0000' }, { price: '4.2500' }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [
      { productId: productIds[0], quantity: 2 },
      { productId: productIds[1], quantity: 4 },
    ]);
    expect(q.status).toBe(200);
    expect(q.data.data.sellerCount).toBe(1);
    expect(q.data.data.sellers[0].lines).toHaveLength(2);
    expect(q.data.data.itemsTotal).toBe('37.0000');

    const created = await place(buyer, buyerId, [
      { productId: productIds[0], quantity: 2 },
      { productId: productIds[1], quantity: 4 },
    ]);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect(created.data.data.sellerCount).toBe(1);
    expect(created.data.data.itemsTotal).toBe('37.0000');

    const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, created.data.data.orderId));
    expect(subs).toHaveLength(1);
    expect(subs[0].sellerId).toBe(sellerId);
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, created.data.data.orderId));
    expect(lines).toHaveLength(2);
    expect(await reservedOf(productIds[0], sellerId)).toBe(2);
    expect(await reservedOf(productIds[1], sellerId)).toBe(4);
  });

  it('keeps two sellers in separate suborders, commission and stock', async () => {
    const a = await seedSeller([{ price: '10.0000' }, { price: '2.5000' }]);
    const b = await seedSeller([{ price: '30.0000' }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const items = [
      { productId: a.productIds[0], quantity: 1 },
      { productId: a.productIds[1], quantity: 2 },
      { productId: b.productIds[0], quantity: 1 },
    ];
    const q = await quote(buyer, items);
    expect(q.status).toBe(200);
    expect(q.data.data.sellerCount).toBe(2);
    const groupA = q.data.data.sellers.find((s: { sellerId: string }) => s.sellerId === a.sellerId);
    const groupB = q.data.data.sellers.find((s: { sellerId: string }) => s.sellerId === b.sellerId);
    expect(groupA.itemsTotal).toBe('15.0000');
    expect(groupB.itemsTotal).toBe('30.0000');
    // Commission is resolved per seller on that seller's own subtotal, not on
    // the basket total: each group must match the quote for that group alone.
    const aloneA = await quote(buyer, [
      { productId: a.productIds[0], quantity: 1 },
      { productId: a.productIds[1], quantity: 2 },
    ]);
    const aloneB = await quote(buyer, [{ productId: b.productIds[0], quantity: 1 }]);
    expect(groupA.commission).toBe(aloneA.data.data.commission);
    expect(groupB.commission).toBe(aloneB.data.data.commission);
    expect(Number(q.data.data.commission)).toBeCloseTo(
      Number(aloneA.data.data.commission) + Number(aloneB.data.data.commission),
      4,
    );
    expect(q.data.data.itemsTotal).toBe('45.0000');

    const created = await place(buyer, buyerId, items);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect(created.data.data.sellerCount).toBe(2);
    expect(created.data.data.grandTotal).toBe(q.data.data.grandTotal);

    const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, created.data.data.orderId));
    expect(subs).toHaveLength(2);
    expect(new Set(subs.map((s) => s.sellerId))).toEqual(new Set([a.sellerId, b.sellerId]));
    // Each line belongs to the suborder of the seller that owns the product.
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, created.data.data.orderId));
    for (const line of lines) {
      const sub = subs.find((s) => s.id === line.sellerOrderId)!;
      expect(sub.sellerId).toBe(line.sellerId);
    }
    expect(await reservedOf(a.productIds[0], a.sellerId)).toBe(1);
    expect(await reservedOf(b.productIds[0], b.sellerId)).toBe(1);
    // The other seller's stock is untouched.
    expect(await reservedOf(b.productIds[0], a.sellerId)).toBe(0);
  });

  it('re-prices when the quantity changes', async () => {
    const { productIds } = await seedSeller([{ price: '7.0000' }]);
    const buyer = makeClient();
    await register(buyer, 'CUSTOMER');

    const one = await quote(buyer, [{ productId: productIds[0], quantity: 1 }]);
    const five = await quote(buyer, [{ productId: productIds[0], quantity: 5 }]);
    expect(one.data.data.itemsTotal).toBe('7.0000');
    expect(five.data.data.itemsTotal).toBe('35.0000');
    expect(Number(five.data.data.grandTotal)).toBeGreaterThan(Number(one.data.data.grandTotal));
  });

  it('follows a price change on the server and ignores any price in the payload', async () => {
    const { productIds } = await seedSeller([{ price: '10.0000' }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    await db.update(products).set({ basePrice: '19.9900' }).where(eq(products.id, productIds[0]));

    const q = await quote(buyer, [{ productId: productIds[0], quantity: 1 }]);
    expect(q.data.data.sellers[0].lines[0].unitPrice).toBe('19.9900');
    expect(q.data.data.itemsTotal).toBe('19.9900');

    // The client tries to dictate the money: every one of these is ignored.
    const tampered = await buyer.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId,
        buyerType: 'CUSTOMER',
        grandTotal: '0.0100',
        itemsTotal: '0.0100',
        commission: '0',
        items: [{ productId: productIds[0], quantity: 1, unitPrice: '0.0100', lineTotal: '0.0100' }],
      },
    });
    expect(tampered.status, JSON.stringify(tampered.data)).toBe(201);
    expect(tampered.data.data.itemsTotal).toBe('19.9900');
    expect(tampered.data.data.grandTotal).toBe(q.data.data.grandTotal);
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, tampered.data.data.orderId));
    expect(lines[0].unitPrice).toBe('19.9900');
  });

  it('reports short stock and refuses the order without reserving anything', async () => {
    const { sellerId, productIds } = await seedSeller([{ stock: 4 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [{ productId: productIds[0], quantity: 10 }]);
    expect(q.status).toBe(200);
    const issue = q.data.data.issues.find((i: { code: string }) => i.code === 'INSUFFICIENT_STOCK');
    expect(issue).toBeTruthy();
    expect(issue.available).toBe(4);
    // The line is excluded from the totals rather than priced as if it were fine.
    expect(q.data.data.itemsTotal).toBe('0.0000');

    const created = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 10 }]);
    expect(created.status).toBe(409);
    expect(created.data.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await orderCountOf(buyerId)).toBe(0);
    expect(await reservedOf(productIds[0], sellerId)).toBe(0);
  });

  it('reports an unpublished product and refuses it', async () => {
    const seller = makeClient();
    await register(seller, 'MERCHANT');
    const sellerId = await createEntity(seller, 'merchants', `Cart Store ${uniqueSku('S')}`);
    const productId = await createProduct(seller, { sellerId });
    // Unpublish it: still in the catalogue rows, no longer on sale.
    const draft = await seller.req(`/api/products/${productId}/status`, {
      method: 'PATCH',
      body: { status: 'INACTIVE' },
    });
    expect(draft.status).toBe(200);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [{ productId, quantity: 1 }]);
    expect(q.status).toBe(200);
    expect(q.data.data.issues[0].code).toBe('PRODUCT_UNAVAILABLE');
    expect(q.data.data.sellers).toEqual([]);

    const created = await place(buyer, buyerId, [{ productId, quantity: 1 }]);
    expect(created.status).toBe(409);
    expect(await orderCountOf(buyerId)).toBe(0);
  });

  it('reports a product that no longer exists and refuses it', async () => {
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');
    const missing = '00000000-0000-4000-8000-000000000000';

    const q = await quote(buyer, [{ productId: missing, quantity: 1 }]);
    expect(q.status).toBe(200);
    expect(q.data.data.issues[0].code).toBe('PRODUCT_NOT_FOUND');

    const created = await place(buyer, buyerId, [{ productId: missing, quantity: 1 }]);
    expect(created.status).toBe(404);
    expect(await orderCountOf(buyerId)).toBe(0);
  });

  it('reports a mixed-currency cart instead of pricing it in one currency', async () => {
    const seller = makeClient();
    await register(seller, 'MERCHANT');
    const sellerId = await createEntity(seller, 'merchants', `Cart Store ${uniqueSku('S')}`);
    const tnd = await createProduct(seller, { sellerId, currency: 'TND' });
    const eur = await createProduct(seller, { sellerId, currency: 'EUR' });
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [{ productId: tnd, quantity: 1 }, { productId: eur, quantity: 1 }]);
    expect(q.status).toBe(200);
    expect(q.data.data.currencyCode).toBe('TND');
    expect(q.data.data.sellerCount).toBe(1);
    expect(q.data.data.issues.map((i: { code: string }) => i.code)).toContain('CURRENCY_MISMATCH');

    const created = await place(buyer, buyerId, [{ productId: tnd, quantity: 1 }, { productId: eur, quantity: 1 }]);
    expect(created.status).toBe(409);
    expect(await orderCountOf(buyerId)).toBe(0);
  });

  it('reports a broken minimum order quantity', async () => {
    const { productIds } = await seedSeller([{ moq: 5 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const q = await quote(buyer, [{ productId: productIds[0], quantity: 2 }]);
    expect(q.data.data.issues[0].code).toBe('MOQ_VIOLATION');
    expect(q.data.data.issues[0].moq).toBe(5);

    const created = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 2 }]);
    expect(created.status).toBe(422);
    expect(await orderCountOf(buyerId)).toBe(0);
  });

  it('creates one order for a repeated submit with the same idempotency key', async () => {
    const { sellerId, productIds } = await seedSeller([{ stock: 10 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');
    const key = `cart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const first = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 2 }], { idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(first.data.data.replayed).toBeUndefined();

    // A retried request (double click, network retry) must not order twice.
    const second = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 2 }], { idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.data.data.orderId).toBe(first.data.data.orderId);
    expect(second.data.data.replayed).toBe(true);
    expect(second.data.data.grandTotal).toBe(first.data.data.grandTotal);

    expect(await orderCountOf(buyerId)).toBe(1);
    expect(await reservedOf(productIds[0], sellerId)).toBe(2);
  });

  it('creates one order when the same key arrives concurrently', async () => {
    const { productIds } = await seedSeller([{ stock: 10 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');
    const key = `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const [a, b] = await Promise.all([
      place(buyer, buyerId, [{ productId: productIds[0], quantity: 1 }], { idempotencyKey: key }),
      place(buyer, buyerId, [{ productId: productIds[0], quantity: 1 }], { idempotencyKey: key }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.data.data.orderId).toBe(b.data.data.orderId);
    expect(await orderCountOf(buyerId)).toBe(1);
  });

  it('does not write anything when only quoting', async () => {
    const { sellerId, productIds } = await seedSeller([{ stock: 8 }]);
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    await quote(buyer, [{ productId: productIds[0], quantity: 5 }]);
    await quote(buyer, [{ productId: productIds[0], quantity: 5 }]);
    expect(await orderCountOf(buyerId)).toBe(0);
    expect(await reservedOf(productIds[0], sellerId)).toBe(0);
  });

  it('keeps a company order a company order through the cart path', async () => {
    const { productIds } = await seedSeller();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'COMPANY');
    const companyId = await createEntity(buyer, 'companies', `Cart Company ${uniqueSku('C')}`);

    const asCompany = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 1 }], {
      buyerType: 'COMPANY',
      companyId,
    });
    expect(asCompany.status).toBe(201);
    const stored = await buyer.req(`/api/orders/${asCompany.data.data.orderId}`);
    expect(stored.data.data.buyerType).toBe('COMPANY');
    expect(stored.data.data.metadata.buyer.companyId).toBe(companyId);

    const asIndividual = await place(buyer, buyerId, [{ productId: productIds[0], quantity: 1 }], {
      buyerType: 'CUSTOMER',
    });
    expect(asIndividual.status).toBe(201);
    const individual = await buyer.req(`/api/orders/${asIndividual.data.data.orderId}`);
    expect(individual.data.data.buyerType).toBe('CUSTOMER');
    expect(individual.data.data.metadata.buyer.companyId).toBeUndefined();
  });

  it('keeps one buyer\'s cart and orders out of another buyer\'s reach', async () => {
    const { productIds } = await seedSeller([{ stock: 20 }]);
    const alice = makeClient();
    const aliceId = await register(alice, 'CUSTOMER');
    const bob = makeClient();
    await register(bob, 'CUSTOMER');

    const created = await place(alice, aliceId, [{ productId: productIds[0], quantity: 3 }]);
    expect(created.status).toBe(201);

    // Bob cannot read Alice's order, and his own list stays empty.
    const peek = await bob.req(`/api/orders/${created.data.data.orderId}`);
    expect([403, 404]).toContain(peek.status);
    const bobList = await bob.req('/api/orders');
    expect(bobList.data.data).toEqual([]);

    // Bob's quote reflects only what he asked for.
    const bobQuote = await quote(bob, [{ productId: productIds[0], quantity: 1 }]);
    expect(bobQuote.data.data.itemsTotal).toBe('10.0000');
  });

  it('does not let a buyer order in another account\'s name from the cart', async () => {
    const { productIds } = await seedSeller();
    const alice = makeClient();
    const aliceId = await register(alice, 'CUSTOMER');
    const bob = makeClient();
    await register(bob, 'CUSTOMER');

    const stolen = await bob.req('/api/orders', {
      method: 'POST',
      body: { buyerId: aliceId, buyerType: 'CUSTOMER', items: [{ productId: productIds[0], quantity: 1 }] },
    });
    expect(stolen.status).toBe(403);
    expect(await orderCountOf(aliceId)).toBe(0);
  });
});

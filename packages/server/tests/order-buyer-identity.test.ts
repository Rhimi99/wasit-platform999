import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

// Distinct IPs keep each case in its own rate-limit bucket (mirrors other suites).
let ipCounter = 140;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/** Minimal fetch wrapper that preserves the session cookie across calls. */
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
  const email = `it-ord-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Ord', lastName: role, role },
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

async function createEntity(
  client: Client,
  kind: 'suppliers' | 'merchants' | 'companies',
  name: string,
): Promise<string> {
  const body = kind === 'suppliers'
    ? { companyName: name }
    : kind === 'merchants'
      ? { storeName: name }
      : { legalName: name };
  const res = await client.req(`/api/${kind}`, { method: 'POST', body });
  expect(res.status).toBe(201);
  return res.data.data.id as string;
}

async function createActiveProduct(
  client: Client,
  opts: { sellerId: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; sku: string },
): Promise<string> {
  const categoryId = await firstCategoryId(client);
  const res = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: opts.sellerId,
      sellerType: opts.sellerType,
      categoryId,
      name: `Buyer Identity Item ${opts.sku}`,
      sku: opts.sku,
      basePrice: '10.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 50,
      lowStockThreshold: 5,
    },
  });
  expect(res.status).toBe(201);
  const productId = res.data.data.id as string;
  const publish = await client.req(`/api/products/${productId}/status`, {
    method: 'PATCH',
    body: { status: 'ACTIVE' },
  });
  expect(publish.status).toBe(200);
  return productId;
}

function uniqueSku(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A seller (merchant) with one published product, ready to be bought. */
async function seedSellerWithProduct(): Promise<{ productId: string; sellerId: string }> {
  const seller = makeClient();
  await register(seller, 'MERCHANT');
  const sellerId = await createEntity(seller, 'merchants', `Buyer Identity Store ${uniqueSku('S')}`);
  const productId = await createActiveProduct(seller, {
    sellerId,
    sellerType: 'MERCHANT',
    sku: uniqueSku('BI'),
  });
  return { productId, sellerId };
}

function placeOrder(
  buyer: Client,
  buyerId: string,
  body: Record<string, unknown>,
) {
  return buyer.req('/api/orders', {
    method: 'POST',
    body: { buyerId, ...body },
  });
}

describe('ORDER-01 — the buyer identity is proven, not trusted', () => {
  it('stores an individual order as CUSTOMER and leaves no company on it', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    // No buyerType at all: the historical contract keeps working unchanged.
    const res = await placeOrder(buyer, buyerId, { items: [{ productId, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.data)).toBe(201);

    const order = await buyer.req(`/api/orders/${res.data.data.orderId}`);
    expect(order.status).toBe(200);
    expect(order.data.data.buyerType).toBe('CUSTOMER');
    expect(order.data.data.metadata.buyer).toEqual({ type: 'CUSTOMER' });
    expect(order.data.data.metadata.buyer.companyId).toBeUndefined();
  });

  it('stores a company order as COMPANY and links it to the buyer\'s own company', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'COMPANY');
    const companyId = await createEntity(buyer, 'companies', `Buyer Identity Company ${uniqueSku('C')}`);

    const res = await placeOrder(buyer, buyerId, {
      buyerType: 'COMPANY',
      items: [{ productId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);

    const order = await buyer.req(`/api/orders/${res.data.data.orderId}`);
    expect(order.status).toBe(200);
    expect(order.data.data.buyerType).toBe('COMPANY');
    expect(order.data.data.metadata.buyer.companyId).toBe(companyId);

    // The same claim, stated explicitly, resolves to the same company.
    const explicit = await placeOrder(buyer, buyerId, {
      buyerType: 'COMPANY',
      companyId,
      items: [{ productId, quantity: 1 }],
    });
    expect(explicit.status).toBe(201);
    const explicitOrder = await buyer.req(`/api/orders/${explicit.data.data.orderId}`);
    expect(explicitOrder.data.data.buyerType).toBe('COMPANY');
    expect(explicitOrder.data.data.metadata.buyer.companyId).toBe(companyId);
  });

  it('refuses a COMPANY order from an account that owns no company', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    const res = await placeOrder(buyer, buyerId, {
      buyerType: 'COMPANY',
      items: [{ productId, quantity: 1 }],
    });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('FORBIDDEN');

    // Nothing was written: the buyer has no orders.
    const mine = await buyer.req('/api/orders');
    expect(mine.status).toBe(200);
    expect(mine.data.data).toEqual([]);
  });

  it('refuses an attempt to order in another company\'s name by editing the payload', async () => {
    const { productId } = await seedSellerWithProduct();

    const victim = makeClient();
    await register(victim, 'COMPANY');
    const victimCompanyId = await createEntity(victim, 'companies', `Victim Co ${uniqueSku('V')}`);

    const attacker = makeClient();
    const attackerId = await register(attacker, 'COMPANY');
    const attackerCompanyId = await createEntity(attacker, 'companies', `Attacker Co ${uniqueSku('A')}`);

    const stolen = await placeOrder(attacker, attackerId, {
      buyerType: 'COMPANY',
      companyId: victimCompanyId,
      items: [{ productId, quantity: 1 }],
    });
    expect(stolen.status).toBe(403);
    expect(stolen.data.error.code).toBe('FORBIDDEN');

    // A plain customer cannot borrow a company id either.
    const individual = makeClient();
    const individualId = await register(individual, 'CUSTOMER');
    const mismatch = await placeOrder(individual, individualId, {
      buyerType: 'CUSTOMER',
      companyId: victimCompanyId,
      items: [{ productId, quantity: 1 }],
    });
    expect(mismatch.status).toBe(422);

    // The victim's name never reached an order: the attacker's own orders are
    // the only ones they can see, and none of them carries the victim company.
    const attackerOrders = await attacker.req('/api/orders');
    expect(attackerOrders.status).toBe(200);
    expect(attackerOrders.data.data).toEqual([]);

    // ...and the attacker's own company is still usable, proving the refusal is
    // about the other company, not about the account.
    const own = await placeOrder(attacker, attackerId, {
      buyerType: 'COMPANY',
      companyId: attackerCompanyId,
      items: [{ productId, quantity: 1 }],
    });
    expect(own.status).toBe(201);
  });

  it('refuses a buyer type the caller has no entity for, and an unknown one', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'CUSTOMER');

    // A CUSTOMER account with no merchant/supplier profile cannot claim to be a
    // business buyer.
    const asMerchant = await placeOrder(buyer, buyerId, {
      buyerType: 'MERCHANT',
      items: [{ productId, quantity: 1 }],
    });
    expect(asMerchant.status).toBe(403);
    expect(asMerchant.data.error.code).toBe('FORBIDDEN');

    const unknown = await placeOrder(buyer, buyerId, {
      buyerType: 'SUPERADMIN',
      items: [{ productId, quantity: 1 }],
    });
    expect(unknown.status).toBe(422);
  });

  it('lets a supplier entity order as a business buyer and stores MERCHANT', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'SUPPLIER');
    await createEntity(buyer, 'suppliers', `Buyer Identity Supplier ${uniqueSku('P')}`);

    const res = await placeOrder(buyer, buyerId, {
      buyerType: 'MERCHANT',
      items: [{ productId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);

    const order = await buyer.req(`/api/orders/${res.data.data.orderId}`);
    expect(order.data.data.buyerType).toBe('MERCHANT');
    expect(order.data.data.metadata.buyer).toEqual({ type: 'MERCHANT' });
  });

  it('keeps a company order private to its buyer and sellers', async () => {
    const { productId, sellerId } = await seedSellerWithProduct();
    const buyer = makeClient();
    const buyerId = await register(buyer, 'COMPANY');
    await createEntity(buyer, 'companies', `Private Co ${uniqueSku('R')}`);

    const res = await placeOrder(buyer, buyerId, {
      buyerType: 'COMPANY',
      items: [{ productId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    const orderId = res.data.data.orderId as string;

    const stranger = makeClient();
    await register(stranger, 'COMPANY');
    await createEntity(stranger, 'companies', `Stranger Co ${uniqueSku('X')}`);
    const denied = await stranger.req(`/api/orders/${orderId}`);
    expect(denied.status).toBe(403);

    // The buyer keeps the full view, and the order still resolves to the seller
    // entity that has to fulfil it.
    const ownerView = await buyer.req(`/api/orders/${orderId}`);
    expect(ownerView.status).toBe(200);
    expect(ownerView.data.data.viewerRole).toBe('BUYER');
    expect(ownerView.data.data.seller.id).toBe(sellerId);
  });

  it('records a multi-seller basket as one COMPANY order with the company attached', async () => {
    const first = await seedSellerWithProduct();
    const second = await seedSellerWithProduct();

    const buyer = makeClient();
    const buyerId = await register(buyer, 'COMPANY');
    const companyId = await createEntity(buyer, 'companies', `Multi Co ${uniqueSku('M')}`);

    const res = await placeOrder(buyer, buyerId, {
      buyerType: 'COMPANY',
      companyId,
      items: [
        { productId: first.productId, quantity: 1 },
        { productId: second.productId, quantity: 2 },
      ],
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);

    const order = await buyer.req(`/api/orders/${res.data.data.orderId}`);
    expect(order.status).toBe(200);
    expect(order.data.data.buyerType).toBe('COMPANY');
    expect(order.data.data.metadata.buyer.companyId).toBe(companyId);
    expect(order.data.data.isMultiSeller).toBe(true);
    expect(order.data.data.sellerOrders).toHaveLength(2);
  });

  it('still refuses an order placed for another user', async () => {
    const { productId } = await seedSellerWithProduct();
    const buyer = makeClient();
    await register(buyer, 'CUSTOMER');
    const other = makeClient();
    const otherId = await register(other, 'CUSTOMER');

    const res = await placeOrder(buyer, otherId, { items: [{ productId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });
});

describe('ORDER-01 — the buyer company context endpoint', () => {
  it('returns the caller\'s own company and null for an account without one', async () => {
    const owner = makeClient();
    await register(owner, 'COMPANY');
    const companyId = await createEntity(owner, 'companies', `Context Co ${uniqueSku('K')}`);

    const mine = await owner.req('/api/companies/mine');
    expect(mine.status).toBe(200);
    expect(mine.data.data.company.id).toBe(companyId);
    expect(mine.data.data.company.isActive).toBe(true);

    const individual = makeClient();
    await register(individual, 'CUSTOMER');
    const none = await individual.req('/api/companies/mine');
    expect(none.status).toBe(200);
    expect(none.data.data.company).toBeNull();

    const anonymous = makeClient();
    const denied = await anonymous.req('/api/companies/mine');
    expect(denied.status).toBe(401);
  });
});

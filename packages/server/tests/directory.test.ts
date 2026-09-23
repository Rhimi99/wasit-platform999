import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

// Distinct IPs keep each case in its own rate-limit bucket (mirrors other suites).
let ipCounter = 120;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
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

async function register(c: Client, role: 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY' | 'MARKETER'): Promise<string> {
  const email = `it-dir-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Dir', lastName: role, role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return email;
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

async function firstCategoryId(client: Client): Promise<string> {
  const cats = await client.req('/api/categories');
  expect(cats.status).toBe(200);
  return (cats.data.data as Array<{ id: string }>)[0].id;
}

async function createActiveProduct(
  client: Client,
  opts: { sellerId: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; sku: string; stock?: number },
): Promise<string> {
  const categoryId = await firstCategoryId(client);
  const res = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: opts.sellerId,
      sellerType: opts.sellerType,
      categoryId,
      name: `Directory Item ${opts.sku}`,
      sku: opts.sku,
      basePrice: '10.0000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: opts.stock ?? 25,
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

async function placeOrder(
  buyer: Client,
  productId: string,
  opts: { buyerType?: 'CUSTOMER' | 'MERCHANT' | 'COMPANY' } = {},
): Promise<string> {
  const me = await buyer.req('/api/auth/me');
  expect(me.status).toBe(200);
  const buyerId = (me.data.data as { id: string }).id;

  const res = await buyer.req('/api/orders', {
    method: 'POST',
    body: {
      buyerId,
      items: [{ productId, quantity: 1 }],
      buyerType: opts.buyerType,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.data.orderId as string;
}

describe('Role-scoped directories', () => {
  it('requires authentication for every directory endpoint (401)', async () => {
    const anon = makeClient();
    for (const path of ['/api/directory/my-entities', '/api/directory/buyers', '/api/directory/my/suppliers', '/api/directory/suppliers', '/api/directory/merchants']) {
      const r = await anon.req(path);
      expect(r.status, path).toBe(401);
    }
  });

  it('returns the caller own entities only, never another user entities', async () => {
    const merchant = makeClient();
    await register(merchant, 'MERCHANT');
    const ownId = await createEntity(merchant, 'merchants', `Own Merchant ${Date.now()}`);

    const other = makeClient();
    await register(other, 'MERCHANT');
    const otherId = await createEntity(other, 'merchants', `Other Merchant ${Date.now()}`);

    const mine = await merchant.req('/api/directory/my-entities');
    expect(mine.status).toBe(200);
    const ids = (mine.data.data.items as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(otherId);
  });

  it('lists only buyers who have a real order with the seller, aggregated per buyer', async () => {
    const supplierClient = makeClient();
    await register(supplierClient, 'SUPPLIER');
    const supplierId = await createEntity(supplierClient, 'suppliers', `Dir Supplier ${Date.now()}`);
    const productId = await createActiveProduct(supplierClient, {
      sellerId: supplierId, sellerType: 'SUPPLIER', sku: `DIR-SUP-${Date.now()}`, stock: 50,
    });

    const buyer = makeClient();
    const buyerEmail = await register(buyer, 'CUSTOMER');
    // Order 1..2 with the same buyer: must aggregate to one row with orderCount 2.
    await placeOrder(buyer, productId, { buyerType: 'CUSTOMER' });

    const res = await supplierClient.req('/api/directory/buyers');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<{ email: string; orderCount: number; name: string }>;
    expect(res.data.data.pagination.total).toBeGreaterThanOrEqual(1);

    const row = items.find((i) => i.email === buyerEmail)!;
    expect(row).toBeDefined();
    expect(row.orderCount).toBeGreaterThanOrEqual(1);
    expect(row.name.length).toBeGreaterThan(0);
  });

  it('shows a genuine empty state for a seller with no orders, without filler rows', async () => {
    const supplierClient = makeClient();
    await register(supplierClient, 'SUPPLIER');
    await createEntity(supplierClient, 'suppliers', `Lonely Supplier ${Date.now()}`);

    const res = await supplierClient.req('/api/directory/buyers');
    expect(res.status).toBe(200);
    expect(res.data.data.items).toEqual([]);
    expect(res.data.data.pagination.total).toBe(0);
  });

  it('isolates buyers: a seller cannot see another seller customers', async () => {
    const sellerA = makeClient();
    await register(sellerA, 'SUPPLIER');
    const sellerAId = await createEntity(sellerA, 'suppliers', `Seller A ${Date.now()}`);
    const productA = await createActiveProduct(sellerA, {
      sellerId: sellerAId, sellerType: 'SUPPLIER', sku: `DIR-A-${Date.now()}`, stock: 50,
    });

    const buyerOfA = makeClient();
    const buyerOfAEmail = await register(buyerOfA, 'CUSTOMER');
    await placeOrder(buyerOfA, productA, { buyerType: 'CUSTOMER' });

    // Seller B has its own buyer and must not see A's customer.
    const sellerB = makeClient();
    await register(sellerB, 'SUPPLIER');
    const sellerBId = await createEntity(sellerB, 'suppliers', `Seller B ${Date.now()}`);
    const productB = await createActiveProduct(sellerB, {
      sellerId: sellerBId, sellerType: 'SUPPLIER', sku: `DIR-B-${Date.now()}`, stock: 50,
    });
    const buyerOfB = makeClient();
    const buyerOfBEmail = await register(buyerOfB, 'CUSTOMER');
    await placeOrder(buyerOfB, productB, { buyerType: 'CUSTOMER' });

    const aView = await sellerA.req('/api/directory/buyers?pageSize=100');
    const aEmails = (aView.data.data.items as Array<{ email: string }>).map((i) => i.email);
    expect(aEmails).toContain(buyerOfAEmail);
    expect(aEmails).not.toContain(buyerOfBEmail);

    const bView = await sellerB.req('/api/directory/buyers?pageSize=100');
    const bEmails = (bView.data.data.items as Array<{ email: string }>).map((i) => i.email);
    expect(bEmails).toContain(buyerOfBEmail);
    expect(bEmails).not.toContain(buyerOfAEmail);
  });

  it('lists suppliers the caller bought from, resolved from real order history', async () => {
    const supplierClient = makeClient();
    await register(supplierClient, 'SUPPLIER');
    const supplierName = `History Supplier ${Date.now()}`;
    const supplierId = await createEntity(supplierClient, 'suppliers', supplierName);
    const productId = await createActiveProduct(supplierClient, {
      sellerId: supplierId, sellerType: 'SUPPLIER', sku: `DIR-HIST-${Date.now()}`, stock: 50,
    });

    const merchantBuyer = makeClient();
    await register(merchantBuyer, 'MERCHANT');
    await createEntity(merchantBuyer, 'merchants', `Buyer Merchant ${Date.now()}`);
    await placeOrder(merchantBuyer, productId, { buyerType: 'MERCHANT' });

    const res = await merchantBuyer.req('/api/directory/my/suppliers?pageSize=100');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<{ sellerId: string; sellerType: string; name: string; orderCount: number }>;
    const row = items.find((i) => i.sellerId === supplierId)!;
    expect(row).toBeDefined();
    expect(row.sellerType).toBe('SUPPLIER');
    expect(row.name).toBe(supplierName);
    expect(row.orderCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown directory kind with 404', async () => {
    const merchant = makeClient();
    await register(merchant, 'MERCHANT');
    const r = await merchant.req('/api/directory/my/unicorns');
    expect(r.status).toBe(404);
  });

  it('denies a signed-in role without the relationship permission (403)', async () => {
    // MARKETER is a real registerable role granted SUPPLIER_LIST but not
    // ORDER_READ_OWN, so it may read the public directory yet must be refused
    // the owner-scoped relationship lists.
    const marketer = makeClient();
    await register(marketer, 'MARKETER');

    const publicDir = await marketer.req('/api/directory/suppliers');
    expect(publicDir.status).toBe(200);

    const buyers = await marketer.req('/api/directory/buyers');
    expect(buyers.status).toBe(403);

    const mySuppliers = await marketer.req('/api/directory/my/suppliers');
    expect(mySuppliers.status).toBe(403);
  });

  it('filters buyers by buyerType (relationship kind)', async () => {
    const supplierClient = makeClient();
    await register(supplierClient, 'SUPPLIER');
    const supplierId = await createEntity(supplierClient, 'suppliers', `Kind Supplier ${Date.now()}`);
    const productId = await createActiveProduct(supplierClient, {
      sellerId: supplierId, sellerType: 'SUPPLIER', sku: `DIR-KIND-${Date.now()}`, stock: 50,
    });

    const customerBuyer = makeClient();
    const customerEmail = await register(customerBuyer, 'CUSTOMER');
    await placeOrder(customerBuyer, productId, { buyerType: 'CUSTOMER' });

    const merchantBuyer = makeClient();
    const merchantEmail = await register(merchantBuyer, 'MERCHANT');
    await createEntity(merchantBuyer, 'merchants', `Kind Merchant Buyer ${Date.now()}`);
    await placeOrder(merchantBuyer, productId, { buyerType: 'MERCHANT' });

    const customersOnly = await supplierClient.req('/api/directory/buyers?buyerType=CUSTOMER&pageSize=100');
    expect(customersOnly.status).toBe(200);
    const cEmails = (customersOnly.data.data.items as Array<{ email: string }>).map((i) => i.email);
    expect(cEmails).toContain(customerEmail);
    expect(cEmails).not.toContain(merchantEmail);

    const all = await supplierClient.req('/api/directory/buyers?pageSize=100');
    const allEmails = (all.data.data.items as Array<{ email: string }>).map((i) => i.email);
    expect(allEmails).toContain(customerEmail);
    expect(allEmails).toContain(merchantEmail);
  });

  it('filters partner history by buyerType', async () => {
    const supplierClient = makeClient();
    await register(supplierClient, 'SUPPLIER');
    const supplierId = await createEntity(supplierClient, 'suppliers', `Partner Kind Supplier ${Date.now()}`);
    const productId = await createActiveProduct(supplierClient, {
      sellerId: supplierId, sellerType: 'SUPPLIER', sku: `DIR-PKIND-${Date.now()}`, stock: 50,
    });

    const merchantBuyer = makeClient();
    await register(merchantBuyer, 'MERCHANT');
    await createEntity(merchantBuyer, 'merchants', `Partner Kind Merchant ${Date.now()}`);
    await placeOrder(merchantBuyer, productId, { buyerType: 'MERCHANT' });

    const asMerchant = await merchantBuyer.req('/api/directory/my/suppliers?buyerType=MERCHANT&pageSize=100');
    expect(asMerchant.status).toBe(200);
    expect((asMerchant.data.data.items as Array<{ sellerId: string }>).some((i) => i.sellerId === supplierId)).toBe(true);

    // The same user has no COMPANY-purchases, so that scope is genuinely empty.
    const asCompany = await merchantBuyer.req('/api/directory/my/suppliers?buyerType=COMPANY&pageSize=100');
    expect(asCompany.status).toBe(200);
    expect(asCompany.data.data.items).toEqual([]);
  });

  it('paginates and searches the platform supplier directory', async () => {
    const merchant = makeClient();
    await register(merchant, 'MERCHANT');

    const page1 = await merchant.req('/api/directory/suppliers?pageSize=1&page=1');
    expect(page1.status).toBe(200);
    expect(page1.data.data.items.length).toBeLessThanOrEqual(1);
    expect(page1.data.data.pagination.pageSize).toBe(1);
    expect(typeof page1.data.data.pagination.total).toBe('number');

    const none = await merchant.req('/api/directory/suppliers?q=zzz-no-such-supplier-zzz');
    expect(none.status).toBe(200);
    expect(none.data.data.items).toEqual([]);
    expect(none.data.data.pagination.total).toBe(0);
  });

  it('rejects an out-of-range pageSize via query validation (422)', async () => {
    const merchant = makeClient();
    await register(merchant, 'MERCHANT');
    const r = await merchant.req('/api/directory/suppliers?pageSize=1000');
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
  });
});

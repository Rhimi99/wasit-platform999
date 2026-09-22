import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

// Distinct IPs keep each case in its own rate-limit bucket (mirrors other suites);
// this spec registers several sellers to build real multi-seller comparisons.
let ipCounter = 40;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/** Minimal fetch wrapper that preserves cookies across calls. */
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

async function register(c: ReturnType<typeof makeClient>, role: 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT') {
  const email = `it-cmp-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Cmp', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return email;
}

async function createSupplierEntity(client: ReturnType<typeof makeClient>): Promise<string> {
  const profile = await client.req('/api/suppliers', {
    method: 'POST',
    body: { companyName: `Cmp Supplier ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  expect(profile.status).toBe(201);
  return profile.data.data.id as string;
}

async function createMerchantEntity(client: ReturnType<typeof makeClient>): Promise<string> {
  const profile = await client.req('/api/merchants', {
    method: 'POST',
    body: { storeName: `Cmp Merchant ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  expect(profile.status).toBe(201);
  return profile.data.data.id as string;
}

async function firstCategoryId(client: ReturnType<typeof makeClient>): Promise<string> {
  const cats = await client.req('/api/categories');
  expect(cats.status).toBe(200);
  return (cats.data.data as Array<{ id: string }>)[0].id;
}

/**
 * Creates a supplier product and a merchant product that share a barcode — i.e.
 * two real offers of the same item at different prices from different sellers.
 */
async function createComparablePair(opts: {
  barcode: string;
  supplierPrice: string;
  merchantPrice: string;
  currency?: string;
  supplierStock?: number;
}) {
  const supplier = makeClient();
  await register(supplier, 'SUPPLIER');
  const supplierId = await createSupplierEntity(supplier);
  const merchant = makeClient();
  await register(merchant, 'MERCHANT');
  const merchantId = await createMerchantEntity(merchant);
  const categoryId = await firstCategoryId(supplier);

  const name = `Comparable Widget ${opts.barcode}`;
  const createdAt = Date.now().toString();

  const sp = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId, sellerType: 'SUPPLIER', categoryId, name,
      sku: `CMP-SUP-${createdAt}`, barcode: opts.barcode,
      basePrice: opts.supplierPrice, currencyCode: opts.currency ?? 'TND',
      moq: 1, initialQuantity: opts.supplierStock ?? 50, lowStockThreshold: 5,
    },
  });
  expect(sp.status).toBe(201);

  const mp = await merchant.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: merchantId, sellerType: 'MERCHANT', categoryId, name,
      sku: `CMP-MER-${createdAt}`, barcode: opts.barcode,
      basePrice: opts.merchantPrice, currencyCode: opts.currency ?? 'TND',
      moq: 1, initialQuantity: 20, lowStockThreshold: 5,
    },
  });
  expect(mp.status).toBe(201);

  return { supplier, merchant, supplierId, merchantId, name, supplierProductId: sp.data.data.id as string, merchantProductId: mp.data.data.id as string };
}

function groupFor(body: { data: { items: Array<{ barcode: string | null; key: string }> } }, barcode: string) {
  return body.data.items.find((g) => g.barcode === barcode);
}

describe('Price Comparison Engine', () => {
  it('is publicly readable without authentication', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/price-comparison');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data.items)).toBe(true);
  });

  it('groups offers of the same barcode across different sellers and ranks them by price', async () => {
    const barcode = `EAN-${Date.now()}`;
    await createComparablePair({ barcode, supplierPrice: '120.0000', merchantPrice: '99.5000' });

    const anon = makeClient();
    const r = await anon.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}`);
    expect(r.status).toBe(200);

    const group = groupFor(r.data, barcode);
    expect(group, 'a comparison group must be returned for the shared barcode').toBeDefined();
    const g = group as unknown as {
      matchedBy: string;
      sellerCount: number;
      offerCount: number;
      lowestPrice: string;
      highestPrice: string;
      priceSpread: string;
      currencyCode: string;
      offers: Array<{ basePrice: string; isLowestPrice: boolean; priceDeltaFromLowest: string; seller: { id: string; type: string } }>;
    };

    expect(g.matchedBy).toBe('BARCODE');
    expect(g.sellerCount).toBe(2);
    expect(g.offerCount).toBe(2);
    expect(g.currencyCode).toBe('TND');

    // Sorted cheapest first, with the real lowest flagged and deltas computed.
    expect(g.offers[0].basePrice).toBe('99.5000');
    expect(g.offers[0].isLowestPrice).toBe(true);
    expect(g.offers[0].priceDeltaFromLowest).toBe('0.0000');
    expect(g.offers[1].basePrice).toBe('120.0000');
    expect(g.offers[1].isLowestPrice).toBe(false);
    expect(g.offers[1].priceDeltaFromLowest).toBe('20.5000');

    expect(g.lowestPrice).toBe('99.5000');
    expect(g.highestPrice).toBe('120.0000');
    expect(g.priceSpread).toBe('20.5000');

    // Two distinct sellers, neither of which is the anon caller.
    const sellerIds = g.offers.map((o) => o.seller.id);
    expect(new Set(sellerIds).size).toBe(2);
    expect(g.offers.map((o) => o.seller.type).sort()).toEqual(['MERCHANT', 'SUPPLIER']);
  });

  it('does not group equal prices from different currencies', async () => {
    const barcode = `EAN-FX-${Date.now()}`;
    // Same barcode, deliberately different currencies: must never be merged.
    const supplier = makeClient();
    await register(supplier, 'SUPPLIER');
    const supplierId = await createSupplierEntity(supplier);
    const merchant = makeClient();
    await register(merchant, 'MERCHANT');
    const merchantId = await createMerchantEntity(merchant);
    const categoryId = await firstCategoryId(supplier);
    const createdAt = Date.now().toString();

    await supplier.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: supplierId, sellerType: 'SUPPLIER', categoryId, name: `FX Item ${barcode}`,
        sku: `FX-SUP-${createdAt}`, barcode, basePrice: '100.0000', currencyCode: 'TND', moq: 1, initialQuantity: 5,
      },
    });
    await merchant.req('/api/products', {
      method: 'POST',
      body: {
        sellerId: merchantId, sellerType: 'MERCHANT', categoryId, name: `FX Item ${barcode}`,
        sku: `FX-MER-${createdAt}`, barcode, basePrice: '100.0000', currencyCode: 'EUR', moq: 1, initialQuantity: 5,
      },
    });

    const anon = makeClient();
    const r = await anon.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}`);
    expect(r.status).toBe(200);

    const groups = (r.data.data.items as Array<{ barcode: string | null; currencyCode: string; sellerCount: number }>)
      .filter((g) => g.barcode === barcode);
    // Each currency is its own group with a single seller, so neither passes the
    // comparable-only filter (2+ sellers) — they must not be merged into one.
    expect(groups.length).toBe(0);

    const all = await anon.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}&comparableOnly=false`);
    const allGroups = (all.data.data.items as Array<{ barcode: string | null; currencyCode: string; sellerCount: number }>)
      .filter((g) => g.barcode === barcode);
    expect(allGroups.length).toBe(2);
    expect(allGroups.map((g) => g.currencyCode).sort()).toEqual(['EUR', 'TND']);
    for (const g of allGroups) expect(g.sellerCount).toBe(1);
  });

  it('exposes only a coarse availability band, never exact seller stock', async () => {
    const barcode = `EAN-STOCK-${Date.now()}`;
    const { supplierProductId } = await createComparablePair({
      barcode,
      supplierPrice: '10.0000',
      merchantPrice: '12.0000',
      supplierStock: 3, // at/below the low-stock threshold of 5
    });

    const anon = makeClient();
    const r = await anon.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}`);
    const group = groupFor(r.data, barcode) as unknown as {
      offers: Array<{ productId: string; availability: string } & Record<string, unknown>>;
    };
    expect(group).toBeDefined();

    const offer = group.offers.find((o) => o.productId === supplierProductId)!;
    expect(offer.availability).toBe('LOW_STOCK');
    // No raw quantity field may leak on a public, unauthenticated response.
    expect(offer).not.toHaveProperty('quantity');
    expect(offer).not.toHaveProperty('availableQuantity');
    expect(JSON.stringify(group)).not.toMatch(/"quantity"\s*:/);
  });

  it('hides unpublished or non-active offers from the comparison', async () => {
    const barcode = `EAN-HIDDEN-${Date.now()}`;
    const { supplier, supplierProductId } = await createComparablePair({
      barcode,
      supplierPrice: '10.0000',
      merchantPrice: '12.0000',
    });

    const unpublish = await supplier.req(`/api/products/${supplierProductId}/status`, {
      method: 'PATCH',
      body: { status: 'INACTIVE' },
    });
    expect(unpublish.status).toBe(200);

    const anon = makeClient();
    const r = await anon.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}`);
    const group = groupFor(r.data, barcode) as unknown as { sellerCount: number } | undefined;
    // The supplier went inactive, so the group is no longer "comparable" (1 seller).
    expect(group).toBeUndefined();
  });

  it('never leaks seller-private fields and returns no private data for customers', async () => {
    const barcode = `EAN-PRIV-${Date.now()}`;
    const { supplierProductId } = await createComparablePair({ barcode, supplierPrice: '5.0000', merchantPrice: '6.0000' });

    // A CUSTOMER token is irrelevant here (public route) — but confirm the
    // response shape is identical and contains no ownership/secret fields.
    const customer = makeClient();
    await register(customer, 'CUSTOMER');
    const asCustomer = await customer.req(`/api/price-comparison?query=${encodeURIComponent(barcode)}`);
    expect(asCustomer.status).toBe(200);

    const group = groupFor(asCustomer.data, barcode) as unknown as { offers: Array<Record<string, unknown>> };
    const offer = group.offers.find((o) => o.productId === supplierProductId)!;
    const serialized = JSON.stringify(offer);
    for (const forbidden of ['cost', 'margin', 'wholesale', 'purchasePrice', 'quantity', 'reservedQuantity']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('filters by search query and by currency, and paginates groups', async () => {
    const anon = makeClient();
    const page1 = await anon.req('/api/price-comparison?pageSize=1&page=1');
    expect(page1.status).toBe(200);
    expect(page1.data.data.items.length).toBeLessThanOrEqual(1);
    expect(page1.data.data.pagination.pageSize).toBe(1);
    expect(typeof page1.data.data.pagination.total).toBe('number');

    const filtered = await anon.req(`/api/price-comparison?query=${encodeURIComponent('zzz-no-such-product-zzz')}`);
    expect(filtered.status).toBe(200);
    expect(filtered.data.data.items).toEqual([]);
    expect(filtered.data.data.pagination.total).toBe(0);

    const eur = await anon.req('/api/price-comparison?currencyCode=EUR');
    expect(eur.status).toBe(200);
    for (const g of eur.data.data.items as Array<{ currencyCode: string }>) {
      expect(g.currencyCode).toBe('EUR');
    }
  });

  it('rejects an invalid currency code via query validation (422)', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/price-comparison?currencyCode=TNDX');
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists active categories for the comparison filter', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/price-comparison/categories');
    expect(r.status).toBe(200);
    expect((r.data.data as unknown[]).length).toBeGreaterThan(0);
  });
});

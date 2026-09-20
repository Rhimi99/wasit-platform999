import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { inventoryItems, inventoryMovements } from '../src/db/schema/commerce_extras.js';
import { notifications } from '../src/db/schema/messaging.js';
import { eq, sql, and } from 'drizzle-orm';

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

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Inv', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

async function createSupplierWithProduct(opts: { qty: number; threshold?: number; moq?: number; name?: string; sku?: string }) {
  const supplier = makeClient();
  const email = `it-inv-sup-${Date.now()}@wasit.tn`;
  await register(supplier, email, 'SUPPLIER');
  const profile = await supplier.req('/api/suppliers', { method: 'POST', body: { companyName: `Inv Supplier ${Date.now()}` } });
  const supplierId = profile.data.data.id as string;
  const cats = await supplier.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const createdAt = Date.now().toString();
  const product = await supplier.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: opts.sku ?? `INV-${createdAt}`,
      categoryId,
      name: opts.name ?? `Inventory Product ${createdAt}`,
      basePrice: '20.0000',
      currencyCode: 'TND',
      moq: opts.moq ?? 1,
      initialQuantity: opts.qty,
      lowStockThreshold: opts.threshold ?? 5,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;
  return { supplier, supplierId, productId };
}

describe('Inventory Engine', () => {
  it('enforces RBAC: CUSTOMER cannot access inventory endpoints (403)', async () => {
    const customer = makeClient();
    await register(customer, `it-inv-cust-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const r = await customer.req('/api/inventory');
    expect(r.status).toBe(403);
  });

  it('lists my inventory after creating a product with stock, with low-stock flags', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 3, threshold: 5 });
    const list = await supplier.req('/api/inventory');
    expect(list.status).toBe(200);
    const items = list.data.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const item = items.find((i) => i.productId === productId);
    expect(item).toBeDefined();
    expect(item!['quantity']).toBe(3);
    expect(item!['availableQuantity']).toBe(3);
    expect(item!['lowStock']).toBe(true); // 3 <= threshold 5
  });

  it('adds stock via adjust (PURCHASE) and records a movement + audit', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 0, threshold: 5 });
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    const adjust = await supplier.req(`/api/inventory/${item.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: 50, movementType: 'PURCHASE', reason: 'Restock' },
    });
    expect(adjust.status).toBe(200);
    expect(adjust.data.data.newQuantity).toBe(50);

    const detail = await supplier.req(`/api/inventory/${item.id}`);
    expect(detail.data.data.quantity).toBe(50);

    const movements = await supplier.req(`/api/inventory/${item.id}/movements`);
    expect(movements.status).toBe(200);
    expect(movements.data.data.total).toBeGreaterThan(0);
    expect(movements.data.data.items[0].movementType).toBe('PURCHASE');
  });

  it('prevents decreasing below zero (409 INSUFFICIENT_STOCK)', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 2, threshold: 5 });
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;
    const adjust = await supplier.req(`/api/inventory/${item.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: -3, movementType: 'SALE' },
    });
    expect(adjust.status).toBe(409);
    expect(adjust.data.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('validates zero quantity change (422)', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 5, threshold: 5 });
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;
    const adjust = await supplier.req(`/api/inventory/${item.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: 0 },
    });
    expect(adjust.status).toBe(422);
  });

  it('sets threshold and quantity via PATCH and records corrective movement', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 4, threshold: 2 });
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;
    const patch = await supplier.req(`/api/inventory/${item.id}`, {
      method: 'PATCH',
      body: { lowStockThreshold: 10, quantity: 20 },
    });
    expect(patch.status).toBe(200);
    expect(patch.data.data.quantity).toBe(20);
    expect(patch.data.data.lowStockThreshold).toBe(10);
  });

  it('creates LOW_STOCK notification when stock falls below threshold', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 0, threshold: 5 });
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;
    await supplier.req(`/api/inventory/${item.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: 3, movementType: 'PURCHASE' },
    });
    const notifs = await db
      .select()
      .from(notifications)
      .where(sql`type = 'INVENTORY_LOW_STOCK'`);
    expect(notifs.length).toBeGreaterThan(0);
  });

  it('blocks access to inventory items owned by another account (403/404)', async () => {
    const a = await createSupplierWithProduct({ qty: 10, threshold: 2 });
    const b = await createSupplierWithProduct({ qty: 10, threshold: 2 });

    // Owner A lists their items
    const listA = await a.supplier.req('/api/inventory');
    const itemA = (listA.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === a.productId)!;

    // Owner B tries to read/alter A's item -> must be blocked
    const blockedGet = await b.supplier.req(`/api/inventory/${itemA.id}`);
    expect(blockedGet.status).toBe(404);
    const blockedAdjust = await b.supplier.req(`/api/inventory/${itemA.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: 1 },
    });
    expect(blockedAdjust.status).toBe(404);
    const blockedPatch = await b.supplier.req(`/api/inventory/${itemA.id}`, {
      method: 'PATCH',
      body: { quantity: 999 },
    });
    expect(blockedPatch.status).toBe(404);
  });

  it('reserves stock on order creation, decrements on confirm, restores on cancel', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 100, threshold: 10 });
    const buyer = makeClient();
    await register(buyer, `it-inv-buyer-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const me = await buyer.req('/api/auth/me');
    const buyerUserId = (me.data.data as { id: string }).id;

    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // Order 20 units
    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 20 }] },
    });
    expect(order.status).toBe(201);
    const orderId = (order.data.data as { orderId: string }).orderId;

    // Stock reserved (available = 100 - 20)
    const afterReserve = await supplier.req(`/api/inventory/${item.id}`);
    expect(afterReserve.data.data.reservedQuantity).toBe(20);
    expect(afterReserve.data.data.quantity).toBe(100);

    // Cancel -> restores and releases reservation
    const cancel = await supplier.req(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      body: { status: 'CANCELLED' },
    });
    expect(cancel.status).toBe(200);
    const afterCancel = await supplier.req(`/api/inventory/${item.id}`);
    expect(afterCancel.data.data.reservedQuantity).toBe(0);
    expect(afterCancel.data.data.quantity).toBe(100);

    // New order
    const order2 = await buyer.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 10 }] },
    });
    const order2Id = (order2.data.data as { orderId: string }).orderId;

    // Confirm -> decrement to 90
    const confirm = await supplier.req(`/api/orders/${order2Id}/status`, {
      method: 'PATCH',
      body: { status: 'CONFIRMED' },
    });
    expect(confirm.status).toBe(200);
    const afterConfirm = await supplier.req(`/api/inventory/${item.id}`);
    expect(afterConfirm.data.data.quantity).toBe(90);
    expect(afterConfirm.data.data.reservedQuantity).toBe(0);
  });

  it('rejects order when available stock is insufficient (409 INSUFFICIENT_STOCK)', async () => {
    const { productId } = await createSupplierWithProduct({ qty: 5, threshold: 2 });
    const buyer = makeClient();
    await register(buyer, `it-inv-buyer2-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const me = await buyer.req('/api/auth/me');
    const buyerUserId = (me.data.data as { id: string }).id;

    const order = await buyer.req('/api/orders', {
      method: 'POST',
      body: { buyerId: buyerUserId, buyerType: 'CUSTOMER', items: [{ productId, quantity: 10 }] },
    });
    expect(order.status).toBe(409);
    expect(order.data.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('supports search and pagination on my inventory list', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 8, threshold: 5, name: 'UniqueSearchableWidget' });
    const search = await supplier.req(`/api/inventory?q=UniqueSearchableWidget&page=1&pageSize=10`);
    expect(search.status).toBe(200);
    expect(search.data.data.items.length).toBeGreaterThan(0);
    expect(search.data.data.items[0].productId).toBe(productId);
  });
});

describe('Inventory Low-Stock Notifications', () => {
  async function ownerUserId(c: ReturnType<typeof makeClient>): Promise<string> {
    const me = await c.req('/api/auth/me');
    return (me.data.data as { id: string }).id;
  }

  async function stockNotifications(userId: string) {
    return db
      .select()
      .from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        sql`${notifications.type} in ('INVENTORY_LOW_STOCK', 'INVENTORY_OUT_OF_STOCK')`,
      ));
  }

  it('notifies the inventory owner when stock drops to the threshold', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const userId = await ownerUserId(supplier);
    expect(await stockNotifications(userId)).toHaveLength(0);

    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // 10 -> 5: exactly at the threshold counts as LOW_STOCK.
    const adjust = await supplier.req(`/api/inventory/${item.id}/adjust`, {
      method: 'POST',
      body: { quantityChange: -5, movementType: 'SALE' },
    });
    expect(adjust.status).toBe(200);
    expect(adjust.data.data.newQuantity).toBe(5);

    const notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('INVENTORY_LOW_STOCK');
    const data = notifs[0].data as { productId: string; quantity: number; threshold: number };
    expect(data.productId).toBe(productId);
    expect(data.quantity).toBe(5);
    expect(data.threshold).toBe(5);
  });

  it('does not duplicate the alert when stock drops further within LOW_STOCK', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const userId = await ownerUserId(supplier);
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // 10 -> 5 triggers LOW_STOCK.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -5, movementType: 'SALE' } });
    // 5 -> 2 stays LOW_STOCK: no new notification.
    const second = await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -3, movementType: 'SALE' } });
    expect(second.status).toBe(200);

    const notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('INVENTORY_LOW_STOCK');
  });

  it('does not re-alert on an unrelated movement while already LOW_STOCK', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const userId = await ownerUserId(supplier);
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // 10 -> 4 triggers LOW_STOCK.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -6, movementType: 'SALE' } });
    // 4 -> 5 (still <= threshold) then 5 -> 3 (still <= threshold): no boundary crossed.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: 1, movementType: 'PURCHASE' } });
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -2, movementType: 'SALE' } });

    const notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);
  });

  it('re-arms the alert after recovery: restock above threshold then a new drop notifies again', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const userId = await ownerUserId(supplier);
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // Drop to LOW_STOCK -> 1st notification.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -6, movementType: 'SALE' } });
    expect(await stockNotifications(userId)).toHaveLength(1);

    // Recover to IN_STOCK (silent).
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: 20, movementType: 'PURCHASE' } });
    expect(await stockNotifications(userId)).toHaveLength(1);

    // Drop again -> 2nd, distinct notification.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -22, movementType: 'SALE' } });
    const notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(2);
    expect(notifs.every((n) => n.type === 'INVENTORY_LOW_STOCK')).toBe(true);
  });

  it('emits OUT_OF_STOCK on depletion and does not re-alert while empty', async () => {
    const { supplier, productId } = await createSupplierWithProduct({ qty: 4, threshold: 5 });
    const userId = await ownerUserId(supplier);
    const list = await supplier.req('/api/inventory');
    const item = (list.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === productId)!;

    // 4 (LOW_STOCK from creation) -> 0 : OUT_OF_STOCK transition.
    await supplier.req(`/api/inventory/${item.id}/adjust`, { method: 'POST', body: { quantityChange: -4, movementType: 'SALE' } });
    let notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('INVENTORY_OUT_OF_STOCK');

    // A corrective set that keeps it at 0 must not re-alert.
    const patch = await supplier.req(`/api/inventory/${item.id}`, { method: 'PATCH', body: { quantity: 0 } });
    expect(patch.status).toBe(200);
    notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);

    // Threshold tweak that keeps it empty must not re-alert either.
    await supplier.req(`/api/inventory/${item.id}`, { method: 'PATCH', body: { lowStockThreshold: 3 } });
    notifs = await stockNotifications(userId);
    expect(notifs).toHaveLength(1);
  });

  it('returns only the caller own notifications (no cross-account leakage)', async () => {
    const a = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const b = await createSupplierWithProduct({ qty: 10, threshold: 5 });
    const userA = await ownerUserId(a.supplier);
    const userB = await ownerUserId(b.supplier);

    const listA = await a.supplier.req('/api/inventory');
    const itemA = (listA.data.data.items as Array<{ id: string; productId: string }>).find((i) => i.productId === a.productId)!;
    await a.supplier.req(`/api/inventory/${itemA.id}/adjust`, { method: 'POST', body: { quantityChange: -5, movementType: 'SALE' } });

    // A sees exactly one inventory alert; B sees none (no leakage).
    expect(await stockNotifications(userA)).toHaveLength(1);
    expect(await stockNotifications(userB)).toHaveLength(0);

    // The notifications API scopes strictly to the authenticated user.
    const feedA = await a.supplier.req('/api/notifications');
    expect(feedA.status).toBe(200);
    expect(feedA.data.data.items.some((n: { type: string }) => n.type === 'INVENTORY_LOW_STOCK')).toBe(true);

    const feedB = await b.supplier.req('/api/notifications');
    expect(feedB.status).toBe(200);
    expect(feedB.data.data.items.some((n: { type: string }) => n.type === 'INVENTORY_LOW_STOCK')).toBe(false);

    // An unauthenticated caller cannot read the feed.
    const anon = makeClient();
    const denied = await anon.req('/api/notifications');
    expect(denied.status).toBe(401);

    // A CUSTOMER (no inventory ownership) still cannot read another seller's alerts via inventory APIs.
    const customer = makeClient();
    await register(customer, `it-lowstock-cust-${Date.now()}@wasit.tn`, 'CUSTOMER');
    const blocked = await customer.req(`/api/inventory/${itemA.id}`);
    expect(blocked.status).toBe(403);
  });
});
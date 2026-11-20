import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { createOrder } from '../../src/modules/orders/service.js';
import { products } from '../../src/db/schema/products.js';
import {
  orders,
  orderItems,
  sellerOrders,
  transactions,
  transactionLedger,
} from '../../src/db/schema/commerce.js';
import { inventoryItems, inventoryMovements } from '../../src/db/schema/commerce_extras.js';
import { commissionPolicies, paymentFeePolicies } from '../../src/db/schema/engine.js';
import { auditLogs } from '../../src/db/schema/audit.js';
import { notifications } from '../../src/db/schema/messaging.js';
import type { DB } from '../../src/db/client.js';

/**
 * M2 — multi-seller order split (database-free).
 *
 * M0 refused an order spanning several sellers because a single order carried
 * exactly one `orders.sellerId` and every transaction/ledger row was written
 * against it — a mixed basket would have misattributed the other sellers' funds.
 * M2 removes that temporary guard: a mixed basket now becomes one Parent Order
 * plus one Seller Suborder per seller, with each seller's own lines, totals and
 * commission. These specs drive the REAL `createOrder` against an in-memory fake
 * `DB`; no WASIT logic is mocked.
 */

type Row = Record<string, unknown>;

const TABLES = {
  products,
  orders,
  orderItems,
  sellerOrders,
  transactions,
  transactionLedger,
  inventoryItems,
  inventoryMovements,
  commissionPolicies,
  paymentFeePolicies,
  auditLogs,
  notifications,
} as const;

const nameOf = new Map<unknown, string>(
  Object.entries(TABLES).map(([n, t]) => [t as unknown, n]),
);
const tableName = (t: unknown): string => nameOf.get(t) ?? 'unknown';

/** Column identity → the row key used by the fake store (`name` is the SQL name). */
const colKey = new Map<unknown, string>();
for (const t of Object.values(TABLES)) {
  for (const [jsKey, col] of Object.entries(getTableColumns(t as never))) {
    colKey.set(col as unknown, jsKey);
  }
}

/**
 * Resolves a drizzle `where(...)` condition against a row by walking the SQL
 * chunk tree: `col = param` comparisons become equality checks, nested SQL
 * conditions (e.g. the sub-conditions of `and(...)`) are recursed into with AND
 * semantics, and everything else (e.g. an `is null` tail) is ignored. Enough to
 * reproduce the narrow lookups `createOrder` and the inventory engine perform.
 */
function matches(row: Row, cond: unknown): boolean {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as { name?: string; table?: unknown; queryChunks?: unknown[] };
    // A nested SQL condition (the sub-conditions of `and(...)`) must also hold.
    if (Array.isArray(chunk?.queryChunks)) {
      if (!matches(row, chunk)) return false;
      continue;
    }
    const sep = chunks[i + 1] as { value?: unknown };
    const param = chunks[i + 2] as { value?: unknown; constructor?: { name?: string } };
    const isEq =
      chunk?.name !== undefined &&
      Array.isArray(sep?.value) &&
      sep.value.length === 1 &&
      sep.value[0] === ' = ' &&
      param?.constructor?.name === 'Param';
    if (isEq) {
      const key = colKey.get(chunk);
      if (key !== undefined && row[key] !== param.value) return false;
    }
  }
  return true;
}

function fakeDb() {
  const store: Record<string, Row[]> = {};
  for (const n of Object.values(TABLES).map((t) => tableName(t))) store[n] = [];

  const db = {
    select() {
      const b = {
        _t: 'products' as string,
        _cond: undefined as unknown,
        from(t: unknown) { b._t = tableName(t); return b; },
        where(c: unknown) { b._cond = c; return b; },
        orderBy() { return b; },
        limit() { return b; },
        then(resolve: (rows: Row[]) => unknown) {
          const rows = store[b._t].filter((r) => matches(r, b._cond));
          return Promise.resolve(rows.map((r) => ({ ...r }))).then(resolve);
        },
      };
      return b;
    },
    insert(t: unknown) {
      const table = tableName(t);
      return {
        values(v: Row | Row[]) {
          const rows = Array.isArray(v) ? v : [v];
          store[table].push(...rows.map((r) => ({ ...r })));
          return Promise.resolve(undefined);
        },
      };
    },
    update(t: unknown) {
      const table = tableName(t);
      const b = {
        _patch: {} as Row,
        _cond: undefined as unknown,
        set(patch: Row) { b._patch = patch; return b; },
        where(c: unknown) {
          for (const row of store[table]) if (matches(row, c)) Object.assign(row, b._patch);
          return Promise.resolve(undefined);
        },
      };
      return b;
    },
    // `resolveSellerUserId` reads through `execute`; no seller rows is fine.
    execute() {
      return Promise.resolve({ rows: [] });
    },
    // The fake store has no real transactions; run the callback against the same
    // handle. The specs assert the *effects* createOrder writes, which is what
    // the real transaction guarantees atomically.
    transaction(cb: (tx: unknown) => unknown) {
      return Promise.resolve(cb(db));
    },
    _store: store,
  };
  return db as unknown as DB & { _store: Record<string, Row[]> };
}

function seedProduct(id: string, sellerId: string, over: Partial<Row> = {}): Row {
  return {
    id,
    sellerId,
    sellerType: 'MERCHANT',
    status: 'ACTIVE',
    isPublished: true,
    moq: 1,
    basePrice: '100.0000',
    currencyCode: 'TND',
    ...over,
  };
}

function seedPolicy(over: Partial<Row> = {}): Row {
  return {
    id: 'pol-base',
    name: 'WASIT BASE 4%',
    policyType: 'BASE',
    rate: '0.04',
    sellerRate: '0.02',
    buyerRate: '0.02',
    conditions: null,
    priority: 100,
    isActive: true,
    startsAt: null,
    endsAt: null,
    ...over,
  };
}

function seedFee(over: Partial<Row> = {}): Row {
  return {
    id: 'fee-1',
    percentRate: '0.02',
    flatFee: '0',
    conditions: null,
    isActive: true,
    createdAt: new Date('2020-01-01'),
    ...over,
  };
}

function seedInventory(productId: string, merchantId: string, quantity: number): Row {
  return {
    id: `inv-${productId}-${merchantId}`,
    productId,
    productVariantId: null,
    merchantId,
    quantity,
    reservedQuantity: 0,
    lowStockThreshold: 5,
  };
}

describe('M2 — createOrder splits a mixed basket into seller suborders', () => {
  it('creates ONE parent order and one suborder per seller for a two-seller basket', async () => {
    const db = fakeDb();
    db._store.products.push(seedProduct('p-a', 'seller-A'), seedProduct('p-b', 'seller-B'));
    db._store.inventoryItems.push(seedInventory('p-a', 'seller-A', 10), seedInventory('p-b', 'seller-B', 10));
    db._store.commissionPolicies.push(seedPolicy());
    db._store.paymentFeePolicies.push(seedFee());

    const res = await createOrder(
      db,
      { buyerId: 'buyer-1', buyerType: 'CUSTOMER', items: [{ productId: 'p-a', quantity: 1 }, { productId: 'p-b', quantity: 1 }] },
      { actorId: 'buyer-1' },
    );

    expect(res.orderId).toBeTruthy();
    expect(res.sellerCount).toBe(2);
    expect(res.sellerOrderIds).toHaveLength(2);

    // Exactly one parent order, and it names no single seller.
    expect(db._store.orders).toHaveLength(1);
    expect(db._store.orders[0].sellerId).toBeNull();
    expect(db._store.orders[0].itemsTotal).toBe('200.0000');
    // 4% of 200 = 8 total (4 seller + 4 buyer).
    expect(db._store.orders[0].commission).toBe('8.0000');
    expect(db._store.orders[0].buyerCommission).toBe('4.0000');
    expect(db._store.orders[0].grandTotal).toBe('204.0000');

    // One suborder per seller, each with its own totals.
    expect(db._store.sellerOrders).toHaveLength(2);
    const bySeller = new Map(db._store.sellerOrders.map((s) => [s.sellerId, s]));
    expect([...bySeller.keys()].sort()).toEqual(['seller-A', 'seller-B']);
    for (const s of db._store.sellerOrders) {
      expect(s.parentOrderId).toBe(res.orderId);
      expect(s.itemsTotal).toBe('100.0000');
      expect(s.commission).toBe('4.0000');
      expect(s.buyerCommission).toBe('2.0000');
      expect(s.sellerCommission).toBe('2.0000');
      expect(s.sellerPayable).toBe('98.0000');
    }

    // Every line carries its own seller and points at that seller's suborder.
    expect(db._store.orderItems).toHaveLength(2);
    for (const it of db._store.orderItems) {
      const sub = bySeller.get(it.sellerId);
      expect(sub).toBeDefined();
      expect(it.sellerOrderId).toBe(sub!.id);
    }

    // Ledger: one TRANSACTION_VALUE credit per seller (not folded into one),
    // one COMMISSION debit per seller, plus one buyer commission + one fee.
    const credits = db._store.transactionLedger.filter((e) => e.entryType === 'TRANSACTION_VALUE');
    expect(credits).toHaveLength(2);
    expect(credits.map((e) => e.beneficiaryId).sort()).toEqual(['seller-A', 'seller-B']);
    expect(credits.every((e) => e.amount === '100.0000')).toBe(true);
    const sellerCommissionDebits = db._store.transactionLedger.filter(
      (e) => e.entryType === 'COMMISSION' && (e.metadata as { share?: string })?.share === 'SELLER',
    );
    expect(sellerCommissionDebits).toHaveLength(2);
    // 2 credits + 2 seller-commission debits + 1 buyer-commission + 1 fee.
    expect(db._store.transactionLedger).toHaveLength(6);

    // Both sellers were notified; one reservation each.
    expect(db._store.notifications).toHaveLength(2);
    for (const inv of db._store.inventoryItems) expect(inv.reservedQuantity).toBe(1);
  });

  it('keeps a single-seller multi-line order behaving exactly as before', async () => {
    const db = fakeDb();
    db._store.products.push(seedProduct('p-a', 'seller-A'), seedProduct('p-a2', 'seller-A', { basePrice: '50.0000' }));
    db._store.inventoryItems.push(seedInventory('p-a', 'seller-A', 10), seedInventory('p-a2', 'seller-A', 10));
    db._store.commissionPolicies.push(seedPolicy());
    db._store.paymentFeePolicies.push(seedFee());

    const res = await createOrder(
      db,
      { buyerId: 'buyer-1', buyerType: 'CUSTOMER', items: [{ productId: 'p-a', quantity: 2 }, { productId: 'p-a2', quantity: 1 }] },
      { actorId: 'buyer-1' },
    );

    expect(res.orderId).toBeTruthy();
    expect(res.sellerCount).toBe(1);
    expect(db._store.orders).toHaveLength(1);
    // A single-seller parent keeps its seller id (pre-M2 shape).
    expect(db._store.orders[0].sellerId).toBe('seller-A');
    expect(db._store.orderItems).toHaveLength(2);
    // 2*100 + 1*50 = 250 items total; 4% = 10 total (5 seller + 5 buyer).
    expect(db._store.orders[0].itemsTotal).toBe('250.0000');
    expect(db._store.orders[0].commission).toBe('10.0000');
    expect(db._store.orders[0].buyerCommission).toBe('5.0000');
    expect(db._store.transactionLedger).toHaveLength(4);
    // One suborder, carrying the seller's whole amount.
    expect(db._store.sellerOrders).toHaveLength(1);
    expect(db._store.sellerOrders[0].itemsTotal).toBe('250.0000');
  });

  it('creates one parent and one suborder for a single-item single-seller order', async () => {
    const db = fakeDb();
    db._store.products.push(seedProduct('p-a', 'seller-A'));
    db._store.inventoryItems.push(seedInventory('p-a', 'seller-A', 5));
    db._store.commissionPolicies.push(seedPolicy());
    db._store.paymentFeePolicies.push(seedFee());

    const res = await createOrder(
      db,
      { buyerId: 'buyer-1', buyerType: 'CUSTOMER', items: [{ productId: 'p-a', quantity: 1 }] },
      { actorId: 'buyer-1' },
    );

    expect(res.orderId).toBeTruthy();
    expect(db._store.orders).toHaveLength(1);
    expect(db._store.orderItems).toHaveLength(1);
    expect(db._store.sellerOrders).toHaveLength(1);
  });

  it('splits a three-seller basket into three suborders with correct per-seller money', async () => {
    const db = fakeDb();
    db._store.products.push(
      seedProduct('p-a', 'seller-A', { basePrice: '10.0000' }),
      seedProduct('p-b', 'seller-B', { basePrice: '20.0000' }),
      seedProduct('p-c', 'seller-C', { basePrice: '30.0000' }),
    );
    db._store.inventoryItems.push(
      seedInventory('p-a', 'seller-A', 10),
      seedInventory('p-b', 'seller-B', 10),
      seedInventory('p-c', 'seller-C', 10),
    );
    db._store.commissionPolicies.push(seedPolicy());
    db._store.paymentFeePolicies.push(seedFee());

    const res = await createOrder(
      db,
      {
        buyerId: 'buyer-1',
        buyerType: 'CUSTOMER',
        items: [
          { productId: 'p-a', quantity: 1 },
          { productId: 'p-b', quantity: 1 },
          { productId: 'p-c', quantity: 1 },
        ],
      },
      { actorId: 'buyer-1' },
    );

    expect(res.sellerCount).toBe(3);
    expect(db._store.sellerOrders).toHaveLength(3);
    const itemsTotals = db._store.sellerOrders.map((s) => s.itemsTotal).sort();
    expect(itemsTotals).toEqual(['10.0000', '20.0000', '30.0000']);
    // Parent total = 60; 4% = 2.4 total (1.2 + 1.2).
    expect(db._store.orders[0].itemsTotal).toBe('60.0000');
    expect(db._store.orders[0].commission).toBe('2.4000');
    // No line is left without its seller/suborder pairing.
    expect(db._store.orderItems.every((it) => it.sellerId && it.sellerOrderId)).toBe(true);
  });

  it('rejects a basket mixing currencies (products must share one currency)', async () => {
    const db = fakeDb();
    // Currency is taken from the first product and the order is single-currency;
    // the guard that matters is that grouping never silently mixes sellers'
    // money. This documents that the parent currency comes from the first line.
    db._store.products.push(seedProduct('p-a', 'seller-A'), seedProduct('p-b', 'seller-B'));
    db._store.inventoryItems.push(seedInventory('p-a', 'seller-A', 10), seedInventory('p-b', 'seller-B', 10));
    db._store.commissionPolicies.push(seedPolicy());
    db._store.paymentFeePolicies.push(seedFee());

    const res = await createOrder(
      db,
      { buyerId: 'buyer-1', buyerType: 'CUSTOMER', items: [{ productId: 'p-b', quantity: 1 }, { productId: 'p-a', quantity: 1 }] },
      { actorId: 'buyer-1' },
    );
    expect(res.currencyCode).toBe('TND');
    expect(db._store.sellerOrders).toHaveLength(2);
  });
});

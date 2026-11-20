import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { orders, orderItems, payments, refundAllocations, refunds, sellerOrders, transactions } from '../src/db/schema/commerce.js';
import { suppliers } from '../src/db/schema/trade.js';
import { users } from '../src/db/schema/auth.js';

/**
 * M2.4-T2.1 — Refund allocation data foundation.
 *
 * Proves the schema added by migration 0040: a single refund can be attributed
 * to several seller suborders, and every attribution is forced — at the
 * database — to belong to the same parent order as the refund, the suborder and
 * (when present) the line. No service reads or writes these rows yet, so these
 * specs exercise the constraints directly.
 */

afterAll(async () => {
  await closeDb();
});

async function makeSeller(stamp: string, tag: string) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `m24t21-${tag}-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const supplierId = `sup-m24t21-${tag}-${stamp}`;
  await db.insert(suppliers).values({
    id: supplierId,
    userId,
    companyName: `M24T21 ${tag} ${stamp}`,
    slug: `sup-m24t21-${tag}-${stamp}`,
  });
  return supplierId;
}

/**
 * Builds a parent order with TWO seller suborders, one line each, a transaction,
 * a payment, and a refund on the parent order. Returns every id so a spec can
 * build both valid and deliberately-mismatched allocations.
 */
async function twoSellerOrderFixture(currency = 'TND') {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const buyerId = randomUUID();
  await db.insert(users).values({
    id: buyerId,
    email: `m24t21-buyer-${stamp}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'Buyer',
    isActive: true,
    emailVerified: true,
  });
  const sellerA = await makeSeller(stamp, 'a');
  const sellerB = await makeSeller(stamp, 'b');

  const orderId = `ord-m24t21-${stamp}`;
  const orderNumber = `ORDM24T21-${stamp}`;
  await db.insert(orders).values({
    id: orderId,
    orderNumber,
    buyerId,
    buyerType: 'CUSTOMER',
    // Multi-seller parent has no single seller.
    sellerId: null,
    sellerType: 'SUPPLIER',
    currencyCode: currency,
    itemsTotal: '200.0000',
    commission: '8.0000',
    buyerCommission: '4.0000',
    paymentFee: '0',
    grandTotal: '200.0000',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    refundStatus: 'NONE',
  });

  const subA = `sub-m24t21-a-${stamp}`;
  const subB = `sub-m24t21-b-${stamp}`;
  for (const [id, sellerId, seq] of [
    [subA, sellerA, 'S1'],
    [subB, sellerB, 'S2'],
  ] as const) {
    await db.insert(sellerOrders).values({
      id,
      parentOrderId: orderId,
      orderNumber,
      sellerOrderNumber: `${orderNumber}-${seq}`,
      sellerId,
      sellerType: 'SUPPLIER',
      currencyCode: currency,
      itemsTotal: '100.0000',
      commission: '4.0000',
      buyerCommission: '2.0000',
      sellerCommission: '2.0000',
      sellerPayable: '98.0000',
      status: 'DELIVERED',
      settlementStatus: 'PENDING',
    });
  }

  const itemA = `oi-m24t21-a-${stamp}`;
  const itemB = `oi-m24t21-b-${stamp}`;
  for (const [id, sellerOrderId, sellerId] of [
    [itemA, subA, sellerA],
    [itemB, subB, sellerB],
  ] as const) {
    await db.insert(orderItems).values({
      id,
      orderId,
      sellerOrderId,
      sellerId,
      // A synthetic product id — no `products` row exists, and `product_id` is a
      // plain column (no FK), so any value within varchar(36) is accepted.
      productId: `prd-${stamp}`,
      unitPrice: '100.0000',
      quantity: 1,
      lineTotal: '100.0000',
    });
  }

  const transactionId = `txn-m24t21-${stamp}`;
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `TXM24T21-${stamp}`,
    orderId,
    buyerId,
    sellerId: sellerA,
    totalValue: '200.0000',
    currencyCode: currency,
    commission: '8.0000',
    buyerCommission: '4.0000',
    status: 'PAID',
  });

  const paymentId = `pay-m24t21-${stamp}`;
  await db.insert(payments).values({
    id: paymentId,
    transactionId,
    orderId,
    amount: '200.0000',
    currencyCode: currency,
    status: 'PAID',
  });

  const refundId = `rfnd-m24t21-${stamp}`;
  await db.insert(refunds).values({
    id: refundId,
    paymentId,
    orderId,
    amount: '50.0000',
    currencyCode: currency,
    status: 'REQUESTED',
  });

  return { orderId, subA, subB, itemA, itemB, sellerA, sellerB, buyerId, refundId, paymentId, stamp };
}

function allocation(overrides: Partial<typeof refundAllocations.$inferInsert> = {}) {
  return {
    id: randomUUID(),
    amount: '25.0000',
    currencyCode: 'TND',
    ...overrides,
  } as typeof refundAllocations.$inferInsert;
}

/** True when inserting the row is refused by the database. */
async function insertRejected(row: typeof refundAllocations.$inferInsert): Promise<boolean> {
  try {
    await db.insert(refundAllocations).values(row);
    return false;
  } catch {
    return true;
  }
}

async function rows(sqlText: string): Promise<Record<string, unknown>[]> {
  const r = (await db.execute(sql.raw(sqlText))) as unknown as { rows: Record<string, unknown>[] };
  return r.rows;
}

describe('M2.4-T2.1 — refund_allocations structure', () => {
  it('creates the table with exactly the expected columns', async () => {
    const cols = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'refund_allocations'
        ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'amount',
      'created_at',
      'currency_code',
      'id',
      'order_item_id',
      'parent_order_id',
      'refund_id',
      'seller_order_id',
    ]);
  });

  it('declares the three composite foreign keys, both checks, and the unique guard', async () => {
    const cons = await rows(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.refund_allocations'::regclass`,
    );
    const byName = new Map(cons.map((c) => [c.conname as string, c.def as string]));

    expect(byName.get('refund_allocations_refund_fk')).toContain('REFERENCES refunds(id, order_id)');
    expect(byName.get('refund_allocations_suborder_fk')).toContain(
      'REFERENCES seller_orders(id, parent_order_id, currency_code)',
    );
    expect(byName.get('refund_allocations_item_fk')).toContain(
      'REFERENCES order_items(id, order_id, seller_order_id)',
    );
    // Postgres normalises the definition (`CHECK ((amount > (0)::numeric))`), so
    // assert on the parts rather than the exact source text.
    const amountPositive = byName.get('refund_allocations_amount_positive') ?? '';
    expect(amountPositive).toContain('amount');
    expect(amountPositive).toContain('>');
    expect(amountPositive).toContain('0');
    expect(byName.get('refund_allocations_currency_len')).toContain('length');

    const idx = await rows(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'refund_allocations'`,
    );
    const idxDef = new Map(idx.map((i) => [i.indexname as string, i.indexdef as string]));
    expect(idxDef.get('refund_allocations_refund_suborder_idx')).toContain('UNIQUE');
    expect(idxDef.get('refund_allocations_refund_suborder_idx')).toContain('(refund_id, seller_order_id)');
  });

  it('creates the three supporting identity indexes as UNIQUE', async () => {
    const idx = await rows(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('refunds_identity_idx','order_items_identity_idx','seller_orders_identity_currency_idx')`,
    );
    const idxDef = new Map(idx.map((i) => [i.indexname as string, i.indexdef as string]));
    expect(idxDef.size).toBe(3);
    for (const def of idxDef.values()) expect(def).toContain('UNIQUE');
    expect(idxDef.get('order_items_identity_idx')).toContain('(id, order_id, seller_order_id)');
    expect(idxDef.get('seller_orders_identity_currency_idx')).toContain('(id, parent_order_id, currency_code)');
  });
});

describe('M2.4-T2.1 — refund_allocations attribution invariants', () => {
  it('accepts a single refund attributed to two different suborders', async () => {
    const f = await twoSellerOrderFixture();
    const okA = await db.insert(refundAllocations).values(
      allocation({ refundId: f.refundId, parentOrderId: f.orderId, sellerOrderId: f.subA, currencyCode: 'TND' }),
    ).returning({ id: refundAllocations.id });
    const okB = await db.insert(refundAllocations).values(
      allocation({ refundId: f.refundId, parentOrderId: f.orderId, sellerOrderId: f.subB, currencyCode: 'TND' }),
    ).returning({ id: refundAllocations.id });
    expect(okA.length).toBe(1);
    expect(okB.length).toBe(1);

    const stored = await rows(
      `SELECT seller_order_id FROM refund_allocations WHERE refund_id = '${f.refundId}' ORDER BY seller_order_id`,
    );
    expect(stored.map((r) => r.seller_order_id).sort()).toEqual([f.subA, f.subB].sort());
  });

  it('accepts a line-level attribution that names a line of the same suborder', async () => {
    const f = await twoSellerOrderFixture();
    const inserted = await db.insert(refundAllocations).values(
      allocation({
        refundId: f.refundId,
        parentOrderId: f.orderId,
        sellerOrderId: f.subA,
        orderItemId: f.itemA,
        currencyCode: 'TND',
      }),
    ).returning({ id: refundAllocations.id });
    expect(inserted.length).toBe(1);
  });

  it('refuses an allocation whose order is not the refund order', async () => {
    const a = await twoSellerOrderFixture();
    const b = await twoSellerOrderFixture();
    // refund from order A, but the allocation claims order B.
    expect(
      await insertRejected(
        allocation({
          refundId: a.refundId,
          parentOrderId: b.orderId,
          sellerOrderId: b.subA,
          currencyCode: 'TND',
        }),
      ),
    ).toBe(true);
  });

  it('refuses an allocation that points at a suborder of a different parent order', async () => {
    const a = await twoSellerOrderFixture();
    const b = await twoSellerOrderFixture();
    // refund from order A, allocation claims order A but cites B's suborder.
    expect(
      await insertRejected(
        allocation({
          refundId: a.refundId,
          parentOrderId: a.orderId,
          sellerOrderId: b.subA,
          currencyCode: 'TND',
        }),
      ),
    ).toBe(true);
  });

  it("refuses a line that does not belong to the allocation's suborder", async () => {
    const f = await twoSellerOrderFixture();
    // Allocate to subA but cite a line that belongs to subB.
    expect(
      await insertRejected(
        allocation({
          refundId: f.refundId,
          parentOrderId: f.orderId,
          sellerOrderId: f.subA,
          orderItemId: f.itemB,
          currencyCode: 'TND',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a line from a different order entirely', async () => {
    const a = await twoSellerOrderFixture();
    const b = await twoSellerOrderFixture();
    expect(
      await insertRejected(
        allocation({
          refundId: a.refundId,
          parentOrderId: a.orderId,
          sellerOrderId: a.subA,
          orderItemId: b.itemA,
          currencyCode: 'TND',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a currency that is not the suborder currency', async () => {
    const f = await twoSellerOrderFixture();
    expect(
      await insertRejected(
        allocation({
          refundId: f.refundId,
          parentOrderId: f.orderId,
          sellerOrderId: f.subA,
          currencyCode: 'EUR',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a non-positive amount', async () => {
    const f = await twoSellerOrderFixture();
    expect(
      await insertRejected(
        allocation({
          refundId: f.refundId,
          parentOrderId: f.orderId,
          sellerOrderId: f.subA,
          currencyCode: 'TND',
          amount: '0.0000',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a duplicate (refund, suborder) attribution', async () => {
    const f = await twoSellerOrderFixture();
    await db.insert(refundAllocations).values(
      allocation({ refundId: f.refundId, parentOrderId: f.orderId, sellerOrderId: f.subA, currencyCode: 'TND' }),
    );
    expect(
      await insertRejected(
        allocation({ refundId: f.refundId, parentOrderId: f.orderId, sellerOrderId: f.subA, currencyCode: 'TND' }),
      ),
    ).toBe(true);
  });

  it('refuses an allocation whose refund does not exist', async () => {
    const f = await twoSellerOrderFixture();
    expect(
      await insertRejected(
        allocation({
          refundId: 'rfnd-does-not-exist',
          parentOrderId: f.orderId,
          sellerOrderId: f.subA,
          currencyCode: 'TND',
        }),
      ),
    ).toBe(true);
  });
});

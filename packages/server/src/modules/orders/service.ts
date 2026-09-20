import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import {
  orderItems,
  orders,
  transactionLedger,
  transactions,
} from '../../db/schema/commerce.js';
import { products } from '../../db/schema/products.js';
import { paymentFeePolicies } from '../../db/schema/engine.js';
import { newId } from '../../lib/ids.js';
import {
  generateOrderNumber,
  generateTransactionNumber,
} from '../../lib/ids.js';
import { toDecimal, roundMoney } from '../../lib/money.js';
import { writeAudit } from '../../lib/audit.js';
import { createNotification } from '../../lib/notifications-service.js';
import { reserveStock, commitReservationToSale, restoreStockForCancelledOrder, releaseReservation } from '../../lib/inventory-engine.js';
import { resolveCommission } from '../../lib/commission.js';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  buyerId: string;
  buyerType: 'CUSTOMER' | 'MERCHANT' | 'COMPANY';
  items: OrderItemInput[];
  currencyCode?: string;
  notes?: string;
}

async function getPaymentFeeRate(db: DB, opts: { currencyCode: string }): Promise<{
  percentRate: string;
  flatFee: string;
  policyId: string | null;
}> {
  const policies = await db
    .select()
    .from(paymentFeePolicies)
    .where(eq(paymentFeePolicies.isActive, true))
    .orderBy(paymentFeePolicies.createdAt);

  for (const p of policies) {
    const cond = (p.conditions ?? {}) as Record<string, unknown>;
    if (cond.currencyCode && cond.currencyCode !== opts.currencyCode) continue;
    return { percentRate: p.percentRate, flatFee: p.flatFee, policyId: p.id };
  }
  // No policy configured → no fee (explicit business decision, never a hardcoded rate).
  return { percentRate: '0', flatFee: '0', policyId: null };
}

/** Creates an order, calculates commission and payment fees via the Policy Engine, and records the transaction + ledger. */
export async function createOrder(
  db: DB,
  input: CreateOrderInput,
  ctx: { actorId: string; ipAddress?: string | null },
) {
  if (input.items.length === 0) {
    throw ApiError.validation([{ field: 'items', message: 'At least one item required', code: 'VALIDATION_FAILED' }]);
  }

  // Load product details
  const loaded = new Map<string, typeof products.$inferSelect>();
  for (const item of input.items) {
    const found = await db.select().from(products).where(eq(products.id, item.productId)).limit(1);
    if (found.length === 0) throw ApiError.notFound(`Product ${item.productId} not found`);
    if (found[0].status !== 'ACTIVE' || !found[0].isPublished) {
      throw ApiError.conflict(`Product ${item.productId} is not available`);
    }
    if (item.quantity < (found[0].moq ?? 1)) {
      throw ApiError.validation([{
        field: `items.${item.productId}.quantity`,
        message: `Minimum order quantity is ${found[0].moq}`,
        code: 'MOQ_VIOLATION',
      }]);
    }
    loaded.set(item.productId, found[0]);
  }

  const firstProduct = loaded.values().next().value;
  if (!firstProduct) throw ApiError.validation([{ field: 'items', message: 'No valid products', code: 'VALIDATION_FAILED' }]);

  // Reserve stock for every line item atomically. This is done BEFORE writing the order so we
  // never have an order that cannot be fulfilled due to insufficient stock.
  for (const item of input.items) {
    const prod = loaded.get(item.productId)!;
    await reserveStock(db, prod.id, prod.sellerId, item.quantity, undefined, input.buyerId);
  }

  const currencyCode = firstProduct.currencyCode;
  const orderId = newId();
  const orderNumber = generateOrderNumber();

  // Build order items + totals
  let itemsTotal = toDecimal('0');
  const itemsRows = [];
  for (const item of input.items) {
    const prod = loaded.get(item.productId)!;
    const price = toDecimal(prod.basePrice);
    const lineTotal = price.mul(item.quantity);
    itemsTotal = itemsTotal.add(lineTotal);
    itemsRows.push({
      id: newId(),
      orderId,
      productId: item.productId,
      unitPrice: price.toFixed(4),
      quantity: item.quantity,
      lineTotal: lineTotal.toFixed(4),
    });
  }

  // Commission via Policy Engine. The engine throws COMMISSION_POLICY_MISSING
  // (422) when no active policy matches — there is no fallback rate in code.
  // The total is split: the seller bears sellerAmount, the buyer buyerAmount.
  const commission = await resolveCommission(db, {
    accountType: 'seller',
    b2bB2c: 'B2B',
    transactionValue: itemsTotal.toFixed(4),
    currencyCode,
  });
  const commissionAmount = commission.totalAmount;
  const buyerCommissionAmount = commission.buyerAmount;

  // Payment processing fee via Policy Engine (separate from WASIT commission; never hardcoded)
  const { percentRate, flatFee, policyId: feePolicyId } = await getPaymentFeeRate(db, {
    currencyCode,
  });
  const feeAmount = roundMoney(itemsTotal.mul(percentRate).add(toDecimal(flatFee))).toFixed(4);
  const paymentFee = feeAmount;

  // The buyer pays the items total plus their share of the commission; the seller
  // is charged their share when the transaction settles. Amounts are rounded
  // separately then summed, so the stored parts reconcile to grandTotal exactly.
  const grandTotal = roundMoney(itemsTotal.add(toDecimal(buyerCommissionAmount))).toFixed(4);

  await db.insert(orders).values({
    id: orderId,
    orderNumber,
    buyerId: input.buyerId,
    buyerType: input.buyerType,
    sellerId: firstProduct.sellerId,
    sellerType: firstProduct.sellerType,
    currencyCode,
    itemsTotal: itemsTotal.toFixed(4),
    commission: commissionAmount,
    buyerCommission: buyerCommissionAmount,
    paymentFee,
    grandTotal,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    notes: input.notes ?? null,
  });

  await db.insert(orderItems).values(itemsRows);

  // Transaction
  const transactionId = newId();
  const transactionNumber = generateTransactionNumber();

  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber,
    orderId,
    buyerId: input.buyerId,
    sellerId: firstProduct.sellerId,
    productId: firstProduct.id,
    quantity: input.items.reduce((acc, i) => acc + i.quantity, 0),
    unitPrice: firstProduct.basePrice,
    totalValue: grandTotal,
    currencyCode,
    commission: commissionAmount,
    buyerCommission: buyerCommissionAmount,
    paymentFee,
    status: 'PAID',
  });

  // Two commission shares (seller and buyer) keep payer/beneficiary explicit and
  // reconcile to the policy total; the provider fee is a separate entry. The
  // TRANSACTION_VALUE credit is the trade value owed to the seller (items only) —
  // the buyer's commission is a separate debit, never folded into the seller credit.
  await db.insert(transactionLedger).values([
    {
      id: newId(),
      transactionId,
      entryType: 'TRANSACTION_VALUE',
      direction: 'CREDIT',
      amount: itemsTotal.toFixed(4),
      currencyCode,
      beneficiaryId: firstProduct.sellerId,
      status: 'PENDING',
    },
    {
      id: newId(),
      transactionId,
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: commission.sellerAmount,
      currencyCode,
      payerId: firstProduct.sellerId,
      beneficiaryId: 'wasit',
      status: 'PENDING',
      metadata: { share: 'SELLER', policyId: commission.policyId, rate: commission.sellerRate } as never,
    },
    {
      id: newId(),
      transactionId,
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: buyerCommissionAmount,
      currencyCode,
      payerId: input.buyerId,
      beneficiaryId: 'wasit',
      status: 'PENDING',
      metadata: { share: 'BUYER', policyId: commission.policyId, rate: commission.buyerRate } as never,
    },
    {
      id: newId(),
      transactionId,
      entryType: 'PAYMENT_FEE',
      direction: 'DEBIT',
      amount: paymentFee,
      currencyCode,
      payerId: input.buyerId,
      beneficiaryId: 'payment-provider',
      status: 'PENDING',
    },
  ] as never[]);

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress }, {
    action: 'ORDER.CREATE',
    entityType: 'ORDER',
    entityId: orderId,
    after: {
      orderNumber,
      itemsTotal: itemsTotal.toFixed(4),
      commission: commissionAmount,
      commissionSeller: commission.sellerAmount,
      commissionBuyer: buyerCommissionAmount,
      commissionRate: commission.totalRate,
      policyId: commission.policyId,
      paymentFee,
      feePolicyId,
      currencyCode,
    },
  });

  // Notify seller
  await createNotification(db, {
    userId: firstProduct.sellerId,
    type: 'ORDER_CREATED',
    title: 'New order',
    body: `Order ${orderNumber} received`,
    data: { orderId },
  });

  return {
    orderId,
    orderNumber,
    itemsTotal,
    commission: commissionAmount,
    commissionSeller: commission.sellerAmount,
    commissionBuyer: buyerCommissionAmount,
    commissionRate: commission.totalRate,
    commissionSellerRate: commission.sellerRate,
    commissionBuyerRate: commission.buyerRate,
    policyId: commission.policyId,
    paymentFee,
    paymentFeePolicyId: feePolicyId,
    grandTotal,
    currencyCode,
    transactionId,
  };
}

export async function getOrder(db: DB, orderId: string, actorId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');
  // Buyer or seller (entity owner) only.
  const owned = await ownedSellerIds(db, actorId);
  if (order[0].buyerId !== actorId && !owned.includes(order[0].sellerId) && order[0].sellerId !== actorId) {
    throw ApiError.forbidden();
  }
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  // إثراء كل عنصر باسم المنتج لتقديم شاشات تفصيلية جاهزة للاستهلاك.
  const productIds = [...new Set(items.map((it) => it.productId))];
  const productRows = productIds.length
    ? await db.select({ id: products.id, name: products.name })
        .from(products)
        .where(sql`${products.id} IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const productMap = new Map(productRows.map((p) => [p.id, p.name]));
  const enrichedItems = items.map((it) => ({
    ...it,
    productName: productMap.get(it.productId) ?? null,
  }));
  return { ...order[0], items: enrichedItems };
}

/** Returns the seller entity ids (supplier/merchant/company) owned by a user. */
async function ownedSellerIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where user_id = ${userId}
  `) as never;
  const r = rows as unknown as { rows: { id: string }[] };
  return r.rows.map((row) => row.id);
}

export async function listMyOrders(db: DB, userId: string) {
  const sellerIds = await ownedSellerIds(db, userId);
  if (sellerIds.length === 0) {
    return db.select().from(orders).where(eq(orders.buyerId, userId)).orderBy(sql`created_at desc`).limit(100);
  }
  return db
    .select()
    .from(orders)
    .where(sql`buyer_id = ${userId} OR seller_id in (${sql.join(sellerIds.map((id) => sql`${id}`), sql`, `)})`)
    .orderBy(sql`created_at desc`)
    .limit(100);
}

export async function updateOrderStatus(
  db: DB,
  orderId: string,
  status: string,
  actorId: string,
) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');

  // Authorization: the buyer owns their orders; a seller may manage orders for
  // entities (supplier/merchant/company) they own.
  const owned = await ownedSellerIds(db, actorId);
  const isBuyer = order[0].buyerId === actorId;
  const isSeller = owned.includes(order[0].sellerId);
  if (!isBuyer && !isSeller) throw ApiError.forbidden();

  const valid: string[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
  if (!valid.includes(status)) {
    throw ApiError.validation([{ field: 'status', message: `Invalid status: ${status}`, code: 'VALIDATION_FAILED' }]);
  }

  // Inventory side-effects are applied atomically on confirmation/cancellation.
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const productRows = items.length
    ? await db.select().from(products).where(sql`${products.id} in (${sql.join(items.map(() => sql`${products.id}`), sql`, `)})`)
    : [];
  const productMap = new Map(productRows.map((p) => [p.id, p]));

  if (status === 'CONFIRMED' && order[0].status !== 'CONFIRMED' && order[0].status !== 'COMPLETED') {
    for (const it of items) {
      const prod = productMap.get(it.productId);
      if (!prod) continue;
      await commitReservationToSale(db, prod.id, prod.sellerId, it.quantity, orderId);
    }
  } else if (status === 'CANCELLED' && order[0].status !== 'CANCELLED') {
    const wasCommitted = order[0].status !== 'PENDING' && order[0].status !== 'PROCESSING';
    for (const it of items) {
      const prod = productMap.get(it.productId);
      if (!prod) continue;
      if (wasCommitted) {
        // Stock was already decremented at confirmation — reinstate it and release the reservation.
        await restoreStockForCancelledOrder(db, prod.id, prod.sellerId, it.quantity, orderId);
      } else {
        // Only a reservation exists — release it without changing on-hand stock.
        await releaseReservation(db, prod.id, prod.sellerId, it.quantity, orderId);
      }
    }
  }

  await db.update(orders).set({ status: status as never, updatedAt: new Date() }).where(eq(orders.id, orderId));
  await writeAudit(db, { actorId }, {
    action: 'ORDER.STATUS_CHANGE',
    entityType: 'ORDER',
    entityId: orderId,
    before: { status: order[0].status },
    after: { status },
  });
}
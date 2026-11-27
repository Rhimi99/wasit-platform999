import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';
import {
  orderItems,
  orders,
  payments,
  sellerOrders,
  transactionLedger,
  transactions,
} from '../../db/schema/commerce.js';
import { paymentIntents } from '../../db/schema/payments_extras.js';
import { productImages, products } from '../../db/schema/products.js';
import { inventoryItems } from '../../db/schema/commerce_extras.js';
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
import { settleSellerSuborder } from '../settlements/service.js';
import { resolveBuyerIdentity, type BuyerType } from './buyer-identity.js';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreatedOrder {
  orderId: string;
  orderNumber: string;
  itemsTotal: string;
  commission: string;
  commissionSeller: string;
  commissionBuyer: string;
  commissionRate: string;
  commissionSellerRate: string;
  commissionBuyerRate: string;
  policyId: string | null;
  paymentFee: string;
  paymentFeePolicyId: string | null;
  grandTotal: string;
  currencyCode: string;
  transactionId: string;
  sellerOrderIds: string[];
  sellerCount: number;
  /** True when this answer replays an order already created for the same key. */
  replayed?: boolean;
}

export interface CreateOrderInput {
  buyerId: string;
  buyerType: BuyerType;
  /**
   * Optional assertion of which company the order is for. When present it must
   * be the caller's own company; it never selects a company on its own.
   */
  companyId?: string;
  items: OrderItemInput[];
  currencyCode?: string;
  notes?: string;
  /**
   * Client-generated key that makes a retried submit return the original order
   * instead of creating a second one. Optional so existing callers are unaffected.
   */
  idempotencyKey?: string;
  /**
   * Internal only. Never populated from an HTTP body — the orders route strips
   * unknown keys and the RFQ acceptance path builds this from the stored quote
   * lines it already validated. It carries the agreed unit prices so an awarded
   * RFQ is billed at the negotiated price instead of the catalog price, without
   * a second pricing implementation: `priceBasket` stays the only place where an
   * order total is computed.
   */
  negotiated?: {
    rfqId: string;
    quoteId: string;
    revision: number;
    sellerId: string;
    /** productId -> unit price, as stored on the accepted quote revision. */
    unitPrices: Record<string, string>;
  };
}

export interface SellerGroupInput {
  sellerType: string;
  products: { productId: string; quantity: number }[];
}

/**
 * Order statuses that imply the order was confirmed and may be fulfilled.
 *
 * Reaching any of these decrements on-hand stock (CONFIRMED) or ships/delivers
 * goods on the strength of that confirmation, so they all require the same proof
 * of payment. Gating only CONFIRMED would leave a hole: a seller could jump
 * `PENDING → PROCESSING` and fulfil an order whose payment never happened.
 */
const PAYMENT_REQUIRED_STATUSES: readonly string[] = [
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
];

/**
 * Proves that an order has been paid before it may be fulfilled.
 *
 * The source of truth is the order's own `paymentStatus`, which is written in
 * exactly one place — `applyPaymentSucceeded` in the payments module, driven by a
 * signature-verified provider webhook whose amount and currency were matched to
 * the intent. A value supplied by the buyer or the seller is never consulted, and
 * a created intent / redirect / UI "success" is never treated as payment.
 *
 * Defence in depth: the trusted state must also be backed by a SUCCEEDED intent
 * and a PAID provider payment bound to *this* order, for the exact amount and
 * currency of the order. That makes the check fail closed even if some future
 * code path were to set `paymentStatus` directly.
 */
async function assertPaymentConfirmedForOrder(
  db: DB,
  order: typeof orders.$inferSelect,
): Promise<void> {
  if (order.paymentStatus !== 'PAID') {
    throw ApiError.conflict(
      `Order cannot be fulfilled before its payment is confirmed (payment status: ${order.paymentStatus})`,
    );
  }

  const intents = await db
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.orderId, order.id), eq(paymentIntents.status, 'SUCCEEDED')))
    .limit(1);
  if (intents.length === 0) {
    throw ApiError.conflict('Order payment has no confirmed payment intent');
  }
  if (!toDecimal(intents[0].amount).equals(toDecimal(order.grandTotal))) {
    throw ApiError.conflict('Confirmed payment amount does not match the order total');
  }
  if (intents[0].currencyCode !== order.currencyCode) {
    throw ApiError.conflict('Confirmed payment currency does not match the order currency');
  }

  const paid = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, 'PAID')))
    .limit(1);
  if (paid.length === 0) {
    throw ApiError.conflict('Order has no confirmed provider payment');
  }
  if (!toDecimal(paid[0].amount).equals(toDecimal(order.grandTotal))) {
    throw ApiError.conflict('Confirmed payment amount does not match the order total');
  }
  if (paid[0].currencyCode !== order.currencyCode) {
    throw ApiError.conflict('Confirmed payment currency does not match the order currency');
  }
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

interface PricedSeller {
  id: string;
  sellerId: string;
  sellerType: string;
  itemsTotal: ReturnType<typeof toDecimal>;
  commission: Awaited<ReturnType<typeof resolveCommission>>;
  sellerOrderNumber: string;
  items: (typeof orderItems.$inferInsert)[];
}

/**
 * Prices a basket from its seller groupings: line totals, per-seller commission
 * (Policy Engine) and the one payment fee for the whole basket.
 *
 * Order creation and the cart quote both call this, so a cart can never show one
 * total and then charge another. Nothing here writes; the ids it stamps on the
 * line rows are only used by the caller that inserts them.
 */
async function priceBasket(
  db: DB,
  opts: {
    groups: Map<string, SellerGroupInput>;
    loaded: Map<string, typeof products.$inferSelect>;
    currencyCode: string;
    orderId: string;
    orderNumber: string;
    /** Agreed unit prices; absent for a normal catalog-priced basket. */
    unitPrices?: Record<string, string>;
  },
) {
  const { groups, loaded, currencyCode, orderId, orderNumber, unitPrices } = opts;

  const sellerGroups: PricedSeller[] = [];
  let itemsTotal = toDecimal('0');
  let commissionAmount = toDecimal('0');
  let buyerCommissionAmount = toDecimal('0');
  let sellerCommissionAmount = toDecimal('0');
  let commissionTotalRate = '0';
  let commissionSellerRate = '0';
  let commissionBuyerRate = '0';
  let commissionPolicyId: string | null = null;

  let sellerIndex = 0;
  for (const [sellerId, group] of groups) {
    sellerIndex += 1;
    const sellerOrderId = newId();
    const sellerOrderNumber = `${orderNumber}-S${sellerIndex}`;

    let groupItemsTotal = toDecimal('0');
    const groupItemRows: (typeof orderItems.$inferInsert)[] = [];
    for (const { productId, quantity } of group.products) {
      const prod = loaded.get(productId)!;
      const agreed = unitPrices?.[productId];
      if (unitPrices && !agreed) {
        throw ApiError.conflict(`No agreed price for product ${productId}`);
      }
      const price = toDecimal(agreed ?? prod.basePrice);
      const lineTotal = price.mul(quantity);
      groupItemsTotal = groupItemsTotal.add(lineTotal);
      groupItemRows.push({
        id: newId(),
        orderId,
        sellerOrderId,
        sellerId,
        productId,
        unitPrice: price.toFixed(4),
        quantity,
        lineTotal: lineTotal.toFixed(4),
      });
    }

    // Commission via Policy Engine, resolved per seller on that seller's own
    // subtotal. The engine throws COMMISSION_POLICY_MISSING (422) when no
    // active policy matches — there is no fallback rate in code.
    const commission = await resolveCommission(db, {
      accountType: 'seller',
      b2bB2c: 'B2B',
      transactionValue: groupItemsTotal.toFixed(4),
      currencyCode,
    });

    sellerGroups.push({
      id: sellerOrderId,
      sellerId,
      sellerType: group.sellerType,
      itemsTotal: groupItemsTotal,
      commission,
      sellerOrderNumber,
      items: groupItemRows,
    });

    itemsTotal = itemsTotal.add(groupItemsTotal);
    commissionAmount = commissionAmount.add(commission.totalAmount);
    buyerCommissionAmount = buyerCommissionAmount.add(commission.buyerAmount);
    sellerCommissionAmount = sellerCommissionAmount.add(commission.sellerAmount);
    commissionTotalRate = commission.totalRate;
    commissionSellerRate = commission.sellerRate;
    commissionBuyerRate = commission.buyerRate;
    commissionPolicyId = commission.policyId;
  }

  // Payment processing fee via Policy Engine (separate from WASIT commission;
  // never hardcoded). One payment, so one fee, computed on the whole basket.
  const { percentRate, flatFee, policyId: feePolicyId } = await getPaymentFeeRate(db, { currencyCode });
  const paymentFee = roundMoney(itemsTotal.mul(percentRate).add(toDecimal(flatFee))).toFixed(4);

  return {
    sellerGroups,
    itemsTotal,
    commissionAmount,
    buyerCommissionAmount,
    sellerCommissionAmount,
    commissionTotalRate,
    commissionSellerRate,
    commissionBuyerRate,
    commissionPolicyId,
    paymentFee,
    feePolicyId,
  };
}

export interface QuoteIssue {
  productId: string;
  code: 'PRODUCT_NOT_FOUND' | 'PRODUCT_UNAVAILABLE' | 'MOQ_VIOLATION' | 'INSUFFICIENT_STOCK' | 'CURRENCY_MISMATCH';
  message: string;
  /** Stock currently free to reserve, when the issue is INSUFFICIENT_STOCK. */
  available?: number;
  moq?: number;
}

export interface QuoteLine {
  productId: string;
  name: string;
  sku: string;
  image: string | null;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
  moq: number;
  available: number;
}

export interface QuoteSeller {
  sellerId: string;
  sellerType: string;
  itemsTotal: string;
  commission: string;
  commissionSeller: string;
  commissionBuyer: string;
  lines: QuoteLine[];
}

export interface QuoteResult {
  currencyCode: string | null;
  itemsTotal: string;
  commission: string;
  commissionSeller: string;
  commissionBuyer: string;
  paymentFee: string;
  grandTotal: string;
  sellerCount: number;
  sellers: QuoteSeller[];
  issues: QuoteIssue[];
}

/**
 * Prices a cart without writing anything, for the cart/checkout screens.
 *
 * Unlike order creation this is lenient: a deleted or unpublished product, a
 * broken MOQ or a short stock line is reported in `issues` and excluded from the
 * totals, so the buyer can see exactly which line to fix instead of getting one
 * opaque error. Order creation stays authoritative and refuses the basket.
 */
export async function quoteBasket(db: DB, items: OrderItemInput[]): Promise<QuoteResult> {
  const issues: QuoteIssue[] = [];

  const lineByProduct = new Map<string, number>();
  for (const item of items) {
    lineByProduct.set(item.productId, (lineByProduct.get(item.productId) ?? 0) + item.quantity);
  }

  const loaded = new Map<string, typeof products.$inferSelect>();
  for (const [productId, quantity] of lineByProduct) {
    const found = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    if (found.length === 0) {
      issues.push({ productId, code: 'PRODUCT_NOT_FOUND', message: 'This product no longer exists' });
      continue;
    }
    const prod = found[0];
    if (prod.status !== 'ACTIVE' || !prod.isPublished) {
      issues.push({ productId, code: 'PRODUCT_UNAVAILABLE', message: 'This product is no longer on sale' });
      continue;
    }
    const moq = prod.moq ?? 1;
    if (quantity < moq) {
      issues.push({ productId, code: 'MOQ_VIOLATION', message: `Minimum order quantity is ${moq}`, moq });
      continue;
    }
    loaded.set(productId, prod);
  }

  // One order is paid in one currency; lines in any other currency are reported
  // rather than silently priced in the first line's currency.
  const firstLoaded = loaded.values().next().value as (typeof products.$inferSelect) | undefined;
  const currencyCode = firstLoaded?.currencyCode ?? null;
  if (currencyCode) {
    for (const [productId, prod] of [...loaded]) {
      if (prod.currencyCode !== currencyCode) {
        issues.push({
          productId,
          code: 'CURRENCY_MISMATCH',
          message: `This cart is priced in ${currencyCode}; remove this line or buy it separately`,
        });
        loaded.delete(productId);
      }
    }
  }

  // Free-to-reserve stock per line, read from the seller's own inventory row.
  // A line that cannot be fulfilled is reported and left out of the totals, so
  // the buyer never sees a payable amount for goods that cannot ship.
  const available = new Map<string, number>();
  const outOfStock: string[] = [];
  for (const [productId, prod] of loaded) {
    const rows = await db
      .select({ quantity: inventoryItems.quantity, reserved: inventoryItems.reservedQuantity })
      .from(inventoryItems)
      .where(and(
        eq(inventoryItems.productId, productId),
        eq(inventoryItems.merchantId, prod.sellerId),
        isNull(inventoryItems.productVariantId),
      ))
      .limit(1);
    const free = rows.length > 0 ? Math.max(0, rows[0].quantity - rows[0].reserved) : 0;
    available.set(productId, free);
    const requested = lineByProduct.get(productId) ?? 0;
    if (free < requested) {
      issues.push({
        productId,
        code: 'INSUFFICIENT_STOCK',
        message: free === 0 ? 'Out of stock' : `Only ${free} left`,
        available: free,
      });
      outOfStock.push(productId);
    }
  }
  for (const productId of outOfStock) loaded.delete(productId);

  if (loaded.size === 0) {
    return {
      currencyCode: null,
      itemsTotal: '0.0000',
      commission: '0.0000',
      commissionSeller: '0.0000',
      commissionBuyer: '0.0000',
      paymentFee: '0.0000',
      grandTotal: '0.0000',
      sellerCount: 0,
      sellers: [],
      issues,
    };
  }

  const groups = new Map<string, SellerGroupInput>();
  for (const [productId, quantity] of lineByProduct) {
    const prod = loaded.get(productId);
    if (!prod) continue;
    const group = groups.get(prod.sellerId) ?? { sellerType: prod.sellerType, products: [] };
    group.products.push({ productId, quantity });
    groups.set(prod.sellerId, group);
  }

  const pricing = await priceBasket(db, {
    groups,
    loaded,
    currencyCode: currencyCode!,
    orderId: '',
    orderNumber: 'QUOTE',
  });

  const images = new Map<string, string>();
  const ids = [...loaded.keys()];
  if (ids.length > 0) {
    const rows = await db
      .select({ productId: productImages.productId, url: productImages.url, isPrimary: productImages.isPrimary, sortOrder: productImages.sortOrder })
      .from(productImages)
      .where(inArray(productImages.productId, ids));
    for (const row of rows) {
      const current = images.get(row.productId);
      if (!current) images.set(row.productId, row.url);
      else if (row.isPrimary) images.set(row.productId, row.url);
    }
  }

  const sellers: QuoteSeller[] = pricing.sellerGroups.map((group) => ({
    sellerId: group.sellerId,
    sellerType: group.sellerType,
    itemsTotal: group.itemsTotal.toFixed(4),
    commission: group.commission.totalAmount,
    commissionSeller: group.commission.sellerAmount,
    commissionBuyer: group.commission.buyerAmount,
    lines: group.items.map((line) => {
      const prod = loaded.get(line.productId)!;
      return {
        productId: line.productId,
        name: prod.name,
        sku: prod.sku,
        image: images.get(line.productId) ?? null,
        unitPrice: line.unitPrice!,
        quantity: line.quantity!,
        lineTotal: line.lineTotal!,
        moq: prod.moq ?? 1,
        available: available.get(line.productId) ?? 0,
      };
    }),
  }));

  return {
    currencyCode,
    itemsTotal: pricing.itemsTotal.toFixed(4),
    commission: pricing.commissionAmount.toFixed(4),
    commissionSeller: pricing.sellerCommissionAmount.toFixed(4),
    commissionBuyer: pricing.buyerCommissionAmount.toFixed(4),
    paymentFee: pricing.paymentFee,
    grandTotal: roundMoney(pricing.itemsTotal.add(pricing.buyerCommissionAmount)).toFixed(4),
    sellerCount: pricing.sellerGroups.length,
    sellers,
    issues,
  };
}

/** Creates an order, calculates commission and payment fees via the Policy Engine, and records the transaction + ledger. */
export async function createOrder(
  db: DB,
  input: CreateOrderInput,
  ctx: { actorId: string; ipAddress?: string | null },
): Promise<CreatedOrder> {
  if (input.items.length === 0) {
    throw ApiError.validation([{ field: 'items', message: 'At least one item required', code: 'VALIDATION_FAILED' }]);
  }
  if (input.buyerId !== ctx.actorId) {
    throw ApiError.forbidden('You can only create orders for yourself');
  }

  // The declared buyer identity is proven against the caller's own entities
  // before anything is reserved or written, so an order can never be recorded in
  // a company's name by editing the payload.
  const identity = await resolveBuyerIdentity(db, {
    userId: ctx.actorId,
    buyerType: input.buyerType,
    companyId: input.companyId,
  });

  if (input.negotiated && input.buyerType !== 'COMPANY') {
    throw ApiError.validation([{
      field: 'buyerType',
      message: 'A negotiated order must be placed as a company',
      code: 'BUYER_TYPE_CONFLICT',
    }]);
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

  // One order is settled in exactly one currency (the parent carries a single
  // `currencyCode`, and one payment covers the whole basket). A basket mixing
  // currencies could not be paid or settled correctly, so it is refused rather
  // than silently priced in the first line's currency.
  const orderCurrency = firstProduct.currencyCode;
  for (const product of loaded.values()) {
    if (product.currencyCode !== orderCurrency) {
      throw ApiError.conflict('All products in an order must share one currency');
    }
  }

  // M2 — group the lines by seller. A basket spanning several sellers becomes one
  // Parent Order plus one Seller Suborder per seller; a single-seller basket
  // becomes one parent + one suborder and behaves exactly as before.
  //
  // The same product may legitimately appear on more than one line (e.g. two
  // lines that only differ by variant), so lines are grouped by productId and
  // the quantities summed. That keeps one reservation and one order_items row
  // per product — which is also what makes a retried create idempotent.
  const lineByProduct = new Map<string, number>();
  for (const item of input.items) {
    lineByProduct.set(item.productId, (lineByProduct.get(item.productId) ?? 0) + item.quantity);
  }

  const groups = new Map<string, { sellerType: string; products: { productId: string; quantity: number }[] }>();
  for (const [productId, quantity] of lineByProduct) {
    const prod = loaded.get(productId)!;
    const group = groups.get(prod.sellerId) ?? { sellerType: prod.sellerType, products: [] };
    group.products.push({ productId, quantity });
    groups.set(prod.sellerId, group);
  }

  const orderId = newId();
  const orderNumber = generateOrderNumber();
  const currencyCode = firstProduct.currencyCode;

  // Everything below — stock reservations, the parent order, every suborder,
  // every line, the transaction, the ledger and the audit entry — runs inside one
  // database transaction. A failure at any point (a suborder, a ledger row, a
  // stock reservation) rolls the WHOLE thing back, so there are never partial
  // reservations and never an order without its financial records.
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as DB;

    // A double click or a retried request must not create a second order or a
    // second stock reservation. The advisory lock serialises concurrent requests
    // that carry the same key; the stored answer makes the replay identical.
    if (input.idempotencyKey) {
      await tdb.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`wasit:order:${input.buyerId}:${input.idempotencyKey}`}))`,
      );
      const prior = await tdb
        .select({ metadata: orders.metadata })
        .from(orders)
        .where(and(
          eq(orders.buyerId, input.buyerId),
          sql`${orders.metadata}->>'idempotencyKey' = ${input.idempotencyKey}`,
        ))
        .limit(1);
      const stored = (prior[0]?.metadata as
        | { idempotency?: { response?: CreatedOrder } }
        | undefined)?.idempotency?.response;
      if (stored) return { ...stored, replayed: true };
    }

    // Reserve stock for every line atomically, before any order row is written,
    // so we never persist an order that cannot be fulfilled.
    for (const item of input.items) {
      const prod = loaded.get(item.productId)!;
      await reserveStock(tdb, prod.id, prod.sellerId, item.quantity, undefined, input.buyerId);
    }

    // Prices — line totals, per-seller commission and the basket payment fee —
    // come from the same function the cart quote uses, so the two cannot drift.
    const pricing = await priceBasket(tdb, {
      groups,
      loaded,
      currencyCode,
      orderId,
      orderNumber,
      unitPrices: input.negotiated?.unitPrices,
    });
    const {
      sellerGroups,
      itemsTotal,
      commissionAmount,
      buyerCommissionAmount,
      sellerCommissionAmount,
      commissionTotalRate,
      commissionSellerRate,
      commissionBuyerRate,
      commissionPolicyId,
      paymentFee,
      feePolicyId,
    } = pricing;

    // Parent order. When the basket has a single seller the parent keeps that
    // seller (matching the pre-M2 shape); a multi-seller parent has no single
    // seller and leaves `sellerId`/`sellerType` null.
    const soleSeller = groups.size === 1 ? [...groups.keys()][0] : null;
    const soleSellerType = soleSeller ? groups.get(soleSeller)!.sellerType : null;

    // The buyer pays the items total plus their share of the commission; the
    // seller is charged their share when the transaction settles. Amounts are
    // rounded separately then summed, so the stored parts reconcile to
    // grandTotal exactly.
    const grandTotal = roundMoney(itemsTotal.add(buyerCommissionAmount)).toFixed(4);

    await tdb.insert(orders).values({
      id: orderId,
      orderNumber,
      buyerId: input.buyerId,
      buyerType: identity.buyerType,
      sellerId: soleSeller,
      sellerType: soleSellerType as never,
      currencyCode,
      itemsTotal: itemsTotal.toFixed(4),
      commission: commissionAmount.toFixed(4),
      buyerCommission: buyerCommissionAmount.toFixed(4),
      paymentFee,
      grandTotal,
      status: 'PENDING',
      paymentStatus: 'UNPAID',
      notes: input.notes ?? null,
      metadata: {
        sellerCount: sellerGroups.length,
        ...(input.negotiated
          ? {
              rfq: {
                id: input.negotiated.rfqId,
                quoteId: input.negotiated.quoteId,
                revision: input.negotiated.revision,
                sellerId: input.negotiated.sellerId,
              },
            }
          : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        buyer: {
          type: identity.buyerType,
          ...(identity.company
            ? { companyId: identity.company.id, companyName: identity.company.legalName }
            : {}),
        },
      } as never,
    });

    // Seller suborders + their line items.
    for (const g of sellerGroups) {
      const sellerCommission = g.commission.sellerAmount;
      const sellerPayable = roundMoney(g.itemsTotal.sub(sellerCommission)).toFixed(4);
      await tdb.insert(sellerOrders).values({
        id: g.id,
        parentOrderId: orderId,
        orderNumber,
        sellerOrderNumber: g.sellerOrderNumber,
        sellerId: g.sellerId,
        sellerType: g.sellerType as never,
        currencyCode,
        itemsTotal: g.itemsTotal.toFixed(4),
        commission: g.commission.totalAmount,
        buyerCommission: g.commission.buyerAmount,
        sellerCommission,
        sellerPayable,
        status: 'PENDING',
        settlementStatus: 'PENDING',
      });
      await tdb.insert(orderItems).values(g.items);
    }

    // Transaction — one per parent order (one buyer payment), attributed to the
    // single seller when there is one. It is created PENDING and promoted only
    // when the provider confirms payment (see applyPaymentSucceeded).
    const transactionId = newId();
    const transactionNumber = generateTransactionNumber();

    await tdb.insert(transactions).values({
      id: transactionId,
      transactionNumber,
      orderId,
      buyerId: input.buyerId,
      sellerId: soleSeller ?? firstProduct.sellerId,
      productId: firstProduct.id,
      quantity: [...lineByProduct.values()].reduce((acc, q) => acc + q, 0),
      unitPrice: input.negotiated?.unitPrices[firstProduct.id] ?? firstProduct.basePrice,
      totalValue: grandTotal,
      currencyCode,
      commission: commissionAmount.toFixed(4),
      buyerCommission: buyerCommissionAmount.toFixed(4),
      paymentFee,
      status: 'PENDING',
    });

    // Ledger — one TRANSACTION_VALUE credit PER SELLER (each seller is owed their
    // own items total), one COMMISSION debit per seller for the seller's share,
    // and exactly one buyer-commission debit and one payment-fee debit for the
    // whole basket. The buyer's commission is never folded into a seller credit.
    const ledgerRows: (typeof transactionLedger.$inferInsert)[] = [];
    for (const g of sellerGroups) {
      ledgerRows.push({
        id: newId(),
        transactionId,
        entryType: 'TRANSACTION_VALUE',
        direction: 'CREDIT',
        amount: g.itemsTotal.toFixed(4),
        currencyCode,
        beneficiaryId: g.sellerId,
        status: 'PENDING',
        metadata: { sellerOrderId: g.id } as never,
      });
      ledgerRows.push({
        id: newId(),
        transactionId,
        entryType: 'COMMISSION',
        direction: 'DEBIT',
        amount: g.commission.sellerAmount,
        currencyCode,
        payerId: g.sellerId,
        beneficiaryId: 'wasit',
        status: 'PENDING',
        metadata: {
          share: 'SELLER',
          policyId: g.commission.policyId,
          rate: g.commission.sellerRate,
          sellerOrderId: g.id,
        } as never,
      });
    }
    ledgerRows.push({
      id: newId(),
      transactionId,
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: buyerCommissionAmount.toFixed(4),
      currencyCode,
      payerId: input.buyerId,
      beneficiaryId: 'wasit',
      status: 'PENDING',
      metadata: { share: 'BUYER', policyId: commissionPolicyId, rate: commissionBuyerRate } as never,
    });
    ledgerRows.push({
      id: newId(),
      transactionId,
      entryType: 'PAYMENT_FEE',
      direction: 'DEBIT',
      amount: paymentFee,
      currencyCode,
      payerId: input.buyerId,
      beneficiaryId: 'payment-provider',
      status: 'PENDING',
    });
    await tdb.insert(transactionLedger).values(ledgerRows as never[]);

    await writeAudit(tdb, { actorId: ctx.actorId, ipAddress: ctx.ipAddress }, {
      action: 'ORDER.CREATE',
      entityType: 'ORDER',
      entityId: orderId,
      after: {
        orderNumber,
        itemsTotal: itemsTotal.toFixed(4),
        commission: commissionAmount.toFixed(4),
        commissionSeller: sellerCommissionAmount.toFixed(4),
        commissionBuyer: buyerCommissionAmount.toFixed(4),
        commissionRate: commissionTotalRate,
        commissionSellerRate,
        commissionBuyerRate,
        policyId: commissionPolicyId,
        paymentFee,
        feePolicyId,
        currencyCode,
        sellerCount: sellerGroups.length,
        sellerOrderIds: sellerGroups.map((g) => g.id),
      },
    });

    // Notify every seller that has a suborder in this basket.
    for (const g of sellerGroups) {
      await createNotification(tdb, {
        userId: g.sellerId,
        type: 'ORDER_CREATED',
        title: 'New order',
        body: `Order ${g.sellerOrderNumber} received`,
        data: { orderId, sellerOrderId: g.id },
      });
    }

    const response: CreatedOrder = {
      orderId,
      orderNumber,
      itemsTotal: itemsTotal.toFixed(4),
      // Strings, matching the pre-M2 response shape the callers/tests rely on.
      commission: commissionAmount.toFixed(4),
      commissionSeller: sellerCommissionAmount.toFixed(4),
      commissionBuyer: buyerCommissionAmount.toFixed(4),
      commissionRate: commissionTotalRate,
      commissionSellerRate,
      commissionBuyerRate,
      policyId: commissionPolicyId,
      paymentFee,
      paymentFeePolicyId: feePolicyId,
      grandTotal,
      currencyCode,
      transactionId,
      sellerOrderIds: sellerGroups.map((g) => g.id),
      sellerCount: sellerGroups.length,
    };

    // Keep the answer with the order so a retried submit can return exactly it.
    if (input.idempotencyKey) {
      await tdb
        .update(orders)
        .set({
          metadata: sql`coalesce(${orders.metadata}, '{}'::jsonb) || ${JSON.stringify({
            idempotency: { key: input.idempotencyKey, response },
          })}::jsonb`,
        })
        .where(eq(orders.id, orderId));
    }

    return response;
  });
}


export async function getOrder(db: DB, orderId: string, actorId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');
  // Buyer, the order's single seller (legacy shape), or the owner of any seller
  // entity that has a suborder in this basket.
  const owned = await ownedSellerIds(db, actorId);
  const suborders = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  const isBuyer = order[0].buyerId === actorId;
  const isSoleSeller = order[0].sellerId !== null && (owned.includes(order[0].sellerId) || order[0].sellerId === actorId);
  const isSuborderSeller = suborders.some((s) => owned.includes(s.sellerId) || s.sellerId === actorId);
  if (!isBuyer && !isSoleSeller && !isSuborderSeller) {
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
  // The UI needs the seller's display identity and the viewer's side (buyer vs
  // seller) to render the right lifecycle actions without re-deriving entity
  // ownership client-side.
  const isSeller = isSoleSeller || isSuborderSeller;
  const sellerName = order[0].sellerId ? await resolveSellerDisplayName(db, order[0].sellerId) : null;
  // Per-seller view: each suborder carries its own seller identity, totals and
  // fulfilment state, and only its own lines. A seller viewing a multi-seller
  // parent must see their own suborder, not the whole basket.
  const sellerSuborders = await Promise.all(
    suborders.map(async (s) => ({
      ...s,
      sellerName: await resolveSellerDisplayName(db, s.sellerId),
      items: enrichedItems.filter((it) => it.sellerOrderId === s.id),
    })),
  );
  return {
    ...order[0],
    items: enrichedItems,
    seller: order[0].sellerId ? { id: order[0].sellerId, type: order[0].sellerType, name: sellerName } : null,
    sellerOrders: sellerSuborders,
    isMultiSeller: suborders.length > 1,
    viewerRole: isSeller ? 'SELLER' : isBuyer ? 'BUYER' : 'NONE',
  };
}

/** Resolves a seller entity's public display name across the three seller tables. */
async function resolveSellerDisplayName(db: DB, sellerId: string): Promise<string | null> {
  const rows = await db.execute<{ name: string | null }>(sql`
    select name from (
      select company_name as name from suppliers where id = ${sellerId}
      union all
      select store_name as name from merchants where id = ${sellerId}
      union all
      select legal_name as name from companies where id = ${sellerId}
    ) s limit 1
  `) as unknown as { rows: { name: string | null }[] };
  return rows.rows?.[0]?.name ?? null;
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
  const ids = sql.join(sellerIds.map((id) => sql`${id}`), sql`, `);
  return db
    .select()
    .from(orders)
    .where(
      sql`buyer_id = ${userId}
          OR seller_id in (${ids})
          OR id in (select parent_order_id from seller_orders where seller_id in (${ids}))`,
    )
    .orderBy(sql`created_at desc`)
    .limit(100);
}

/**
 * Aggregates a Parent Order's fulfilment status from its seller suborders.
 *
 * This is the one place the parent status is derived for a multi-seller order,
 * so the parent always reflects what its sellers have actually done. The rules
 * are deliberately conservative and use only the existing statuses:
 *  - Every suborder cancelled (or every one completed) ⇒ the parent matches the
 *    whole basket.
 *  - Otherwise, CANCELLED suborders are excluded from the summary: a partially
 *    cancelled basket must NOT read PENDING while a confirmed sibling is still
 *    live. The parent then reflects the remaining active suborders — COMPLETED if
 *    all are, else DELIVERED if any delivered, SHIPPED if any shipped, PROCESSING
 *    if any processing, CONFIRMED once every active suborder is confirmed, and
 *    PENDING until at least one confirmed.
 *
 * Kept in code (not the DB) so the rule is auditable next to the transitions it
 * summarises.
 */
function aggregateParentStatus(subStatuses: string[]): string {
  if (subStatuses.length === 0) return 'PENDING';
  if (subStatuses.every((s) => s === 'CANCELLED')) return 'CANCELLED';
  if (subStatuses.every((s) => s === 'COMPLETED')) return 'COMPLETED';
  // Cancelled parts no longer describe the parent's progress; the active parts do.
  const active = subStatuses.filter((s) => s !== 'CANCELLED');
  if (active.length === 0) return 'CANCELLED';
  if (active.every((s) => s === 'COMPLETED')) return 'COMPLETED';
  // DELIVERED must outrank SHIPPED: a delivered part has moved past shipping, so
  // collapsing it into SHIPPED would freeze the parent one step behind its own
  // suborder and strand the seller with no way to reach COMPLETED.
  if (active.some((s) => s === 'DELIVERED')) return 'DELIVERED';
  if (active.some((s) => s === 'SHIPPED')) return 'SHIPPED';
  if (active.some((s) => s === 'PROCESSING')) return 'PROCESSING';
  if (active.every((s) => s === 'CONFIRMED' || s === 'COMPLETED')) return 'CONFIRMED';
  return 'PENDING';
}

/**
 * Moves an order (or one of its seller suborders) through the fulfilment
 * lifecycle, applying the matching inventory side-effect atomically.
 *
 * Targeting rules (M2):
 *  - `opts.sellerOrderId` names one seller suborder; the actor must own that
 *    seller. Only that suborder's lines drive the inventory change.
 *  - With no target and exactly one suborder, that suborder is updated — this is
 *    the single-seller case and keeps the previous observable behaviour.
 *  - With no target and several suborders, the buyer may CANCELLED the whole
 *    order (every suborder is cancelled); a seller must name their suborder.
 *  - An order with no suborders at all (a pre-M2 record) updates the parent
 *    directly, exactly as before, so legacy records keep working.
 *
 * The parent's status is always recomputed from its suborders afterwards, so the
 * parent never drifts from what the sellers actually did.
 */
export async function updateOrderStatus(
  db: DB,
  orderId: string,
  status: string,
  actorId: string,
  opts: { sellerOrderId?: string } = {},
) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');

  // Authorization: the buyer owns their orders; a seller may manage orders for
  // entities (supplier/merchant/company) they own — including via a suborder.
  const owned = await ownedSellerIds(db, actorId);
  const suborders = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  const isBuyer = order[0].buyerId === actorId;
  const isSoleSeller = order[0].sellerId !== null && owned.includes(order[0].sellerId);
  const ownedSuborders = suborders.filter((s) => owned.includes(s.sellerId));
  const isSuborderSeller = ownedSuborders.length > 0;
  if (!isBuyer && !isSoleSeller && !isSuborderSeller) throw ApiError.forbidden();

  const valid: string[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
  if (!valid.includes(status)) {
    throw ApiError.validation([{ field: 'status', message: `Invalid status: ${status}`, code: 'VALIDATION_FAILED' }]);
  }

  // Resolve which suborder this transition applies to, if any.
  let target = opts.sellerOrderId ? suborders.find((s) => s.id === opts.sellerOrderId) : undefined;
  if (opts.sellerOrderId && !target) {
    throw ApiError.notFound('Seller suborder not found for this order');
  }
  if (target && !isBuyer && !owned.includes(target.sellerId)) {
    throw ApiError.forbidden();
  }
  if (!opts.sellerOrderId && suborders.length === 1) {
    target = suborders[0];
  }
  if (!opts.sellerOrderId && suborders.length > 1) {
    if (isBuyer && status === 'CANCELLED') {
      // The buyer cancels the whole basket: handled below across every suborder.
      target = undefined;
    } else if (isSuborderSeller && ownedSuborders.length === 1) {
      target = ownedSuborders[0];
    } else {
      throw ApiError.validation([{
        field: 'sellerOrderId',
        message: 'Specify which seller suborder this status applies to',
        code: 'VALIDATION_FAILED',
      }]);
    }
  }

  const fromStatus = order[0].status;

  // Fulfilment requires a confirmed payment. This runs before any inventory
  // side-effect, so an unpaid order can never reach CONFIRMED/PROCESSING/... nor
  // have its stock decremented. A no-op transition (same status) is ignored so
  // re-sending the current status stays idempotent and never trips the guard.
  if (status !== fromStatus && PAYMENT_REQUIRED_STATUSES.includes(status)) {
    await assertPaymentConfirmedForOrder(db, order[0]);
  }

  const allItems = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const productRows = allItems.length
    ? await db.select().from(products).where(sql`${products.id} in (${sql.join(allItems.map(() => sql`${products.id}`), sql`, `)})`)
    : [];
  const productMap = new Map(productRows.map((p) => [p.id, p]));

  // The status change and its inventory side-effects run in one transaction, so a
  // stock failure rolls the status back rather than leaving an order marked
  // CONFIRMED with the stock still reserved. Every claim below is a guarded
  // UPDATE that only matches while the row is still in its prior status, so a
  // retried or concurrent request sees zero rows for an already-moved row and
  // does nothing — that is what keeps a double cancel from restoring stock twice.
  //
  // `priorStatus` is ALWAYS the status of the record being moved: the targeted
  // suborder, or the parent for a pre-M2 order. It is never the parent's status
  // when a suborder is targeted, because a suborder's stock must be decided by
  // that suborder's own lifecycle, not by its siblings'.
  // Suborders that this transition moved to a fulfilled state. Collected inside
  // the transaction and settled AFTER it commits, so the settlement call (which
  // opens its own transaction and takes the suborder + transaction locks) can
  // never deadlock against the locks this fulfilment transaction holds.
  const fulfilledSuborderIds: string[] = [];

  await db.transaction(async (tx) => {
    const tdb = tx as unknown as DB;

    // Stock is decremented exactly once, by the CONFIRMED transition
    // (`commitReservationToSale`). So a record leaving PENDING/PROCESSING still
    // holds only a reservation and is released; a record leaving CONFIRMED or
    // beyond already had its stock deducted and is reinstated.
    const applyInventory = async (items: typeof allItems, priorStatus: string) => {
      if (status === 'CONFIRMED' && priorStatus !== 'CONFIRMED' && priorStatus !== 'COMPLETED') {
        for (const it of items) {
          const prod = productMap.get(it.productId);
          if (!prod) continue;
          await commitReservationToSale(tdb, prod.id, prod.sellerId, it.quantity, orderId);
        }
      } else if (status === 'CANCELLED' && priorStatus !== 'CANCELLED') {
        const wasCommitted = priorStatus !== 'PENDING' && priorStatus !== 'PROCESSING';
        for (const it of items) {
          const prod = productMap.get(it.productId);
          if (!prod) continue;
          if (wasCommitted) {
            // Stock was already decremented at confirmation — reinstate it and release the reservation.
            await restoreStockForCancelledOrder(tdb, prod.id, prod.sellerId, it.quantity, orderId);
          } else {
            // Only a reservation exists — release it without changing on-hand stock.
            await releaseReservation(tdb, prod.id, prod.sellerId, it.quantity, orderId);
          }
        }
      }
    };

    // Recomputes the parent from its suborders' fresh values, so the parent can
    // never drift from what the sellers actually did.
    const recomputeParentStatus = async () => {
      const fresh = await tx.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
      const parentStatus = aggregateParentStatus(fresh.map((s) => s.status));
      await tx
        .update(orders)
        .set({ status: parentStatus as never, updatedAt: new Date() })
        .where(eq(orders.id, orderId));
    };

    if (target) {
      // One suborder: claim it on its own prior status, then move only its lines
      // so a sibling's reservation/stock is never touched.
      const claimed = await tx
        .update(sellerOrders)
        .set({ status: status as never, updatedAt: new Date() })
        .where(and(eq(sellerOrders.id, target.id), eq(sellerOrders.status, target.status as never)))
        .returning({ id: sellerOrders.id });
      if (claimed.length === 0) return;

      await applyInventory(allItems.filter((it) => it.sellerOrderId === target.id), target.status);
      await recomputeParentStatus();
      if (status === 'DELIVERED' || status === 'COMPLETED') fulfilledSuborderIds.push(target.id);
    } else if (suborders.length === 0) {
      // Pre-M2 order: the parent row IS the record; there are no suborders to
      // keep in step, and the parent's own prior status drives the decision.
      const claimed = await tx
        .update(orders)
        .set({ status: status as never, updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.status, fromStatus as never)))
        .returning({ id: orders.id });
      if (claimed.length === 0) return;

      await applyInventory(allItems, fromStatus);
    } else {
      // Whole-order transition (e.g. the buyer cancels the basket). Each suborder
      // is claimed and its stock decided INDIVIDUALLY from its own prior status,
      // so a confirmed suborder is reinstated while a still-pending one is only
      // released, and an already-cancelled sibling is skipped rather than
      // processed a second time.
      for (const sub of suborders) {
        const claimed = await tx
          .update(sellerOrders)
          .set({ status: status as never, updatedAt: new Date() })
          .where(and(eq(sellerOrders.id, sub.id), eq(sellerOrders.status, sub.status as never)))
          .returning({ id: sellerOrders.id });
        if (claimed.length === 0) continue;
        await applyInventory(allItems.filter((it) => it.sellerOrderId === sub.id), sub.status);
      }
      await recomputeParentStatus();
    }

    // The audit records the prior status of the record actually moved: the
    // suborder's own status when one is targeted, otherwise the parent's. Using
    // the parent's status for a suborder transition would misreport the change.
    await writeAudit(tdb, { actorId }, {
      action: 'ORDER.STATUS_CHANGE',
      entityType: 'ORDER',
      entityId: orderId,
      before: { status: target ? target.status : fromStatus, sellerOrderId: target?.id ?? null },
      after: { status, sellerOrderId: target?.id ?? null },
    });
  });

  // Auto-link each fulfilled seller suborder to the parent transaction's EXISTING
  // settlement evidence (M2.3). Runs after commit and is best-effort: a suborder
  // whose parent is not yet settled stays PENDING and is picked up by the admin
  // re-processing path, so a fulfilment is never failed by a settlement
  // precondition. Idempotent — a re-delivery is a no-op.
  for (const subId of fulfilledSuborderIds) {
    await settleSellerSuborder(db, subId, { actorId, actorType: 'USER' });
  }
}
import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders } from '../../db/schema/commerce';
import { products } from '../../db/schema/products';
import { rfqItems, rfqQuoteLines, rfqQuotes, rfqRecipients, rfqs } from '../../db/schema/rfq';
import { createOrder, type CreatedOrder } from '../orders/service';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service';
import { toDecimal } from '../../lib/money';
import { assertQuoteTransition, assertRfqTransition } from './lifecycle';
import { assertRfqAccess, requireBuyer, resolveSellerEntities } from './access';
import { expireLapsedQuotes, expireRfqIfDue } from './expiry';
import { recordRfqEvent } from './events';

export interface AcceptQuoteResult {
  rfqId: string;
  rfqNumber: string;
  status: 'AWARDED';
  quoteId: string;
  revision: number;
  sellerId: string;
  sellerName: string;
  order: CreatedOrder;
  /** True when this answer replays an award that had already been made. */
  replayed: boolean;
  rejectedQuoteIds: string[];
}

/**
 * The order key is derived, never supplied. Binding it to (buyer, RFQ, quote,
 * revision) means a retried acceptance — a double click, a network retry, a
 * second tab — resolves to the same order instead of a second one, and there is
 * no client-chosen key that could be used to fork the award.
 */
function acceptanceKey(buyerUserId: string, rfqId: string, quoteId: string, revision: number): string {
  const digest = createHash('sha256')
    .update(`${buyerUserId}:${rfqId}:${quoteId}:${revision}`)
    .digest('hex')
    .slice(0, 40);
  return `rfq-accept-${digest}`;
}

/**
 * Buyer accepts one quote revision and the platform records a real order.
 *
 * Everything that must be true together is written in one transaction: the
 * order (through the same `createOrder` the checkout uses), the accepted quote,
 * the rejection of the competing live quotes, the award on the RFQ, the timeline
 * entries, the audit row and the in-app notifications. If any step fails the
 * whole thing rolls back, so a failed conversion can never leave an accepted
 * quote without an order — or an order without an award.
 *
 * `createOrder` is handed this transaction as its database handle. It opens a
 * nested transaction (a savepoint) internally, which is why the order's rows
 * belong to the outer unit of work rather than to a separate commit.
 */
export async function acceptQuote(
  db: DB,
  userId: string,
  rfqId: string,
  quoteId: string,
  ctx: AuditContext,
): Promise<AcceptQuoteResult> {
  const access = requireBuyer(await assertRfqAccess(db, rfqId, userId));

  // A retried acceptance must return the original answer, not "already awarded".
  // The award columns are written in the same transaction as the order, so their
  // presence is a complete record of a finished conversion.
  const replay = await replayIfAwarded(db, access.rfq.id, quoteId, userId);
  if (replay) return replay;

  const rfq = (await expireRfqIfDue(db, access.rfq)).rfq;
  await expireLapsedQuotes(db, rfq.id);
  if (rfq.status !== 'OPEN') {
    throw ApiError.conflict(`An RFQ in ${rfq.status} state cannot be awarded`);
  }

  const [quoteRow] = await db
    .select()
    .from(rfqQuotes)
    .where(and(eq(rfqQuotes.id, quoteId), eq(rfqQuotes.rfqId, rfqId)))
    .limit(1);
  if (!quoteRow) throw ApiError.notFound('Quote');

  return db.transaction(async (tx) => {
    const tdb = tx as unknown as DB;

    // Row lock on the RFQ: every acceptance of this request is serialised here,
    // so the state read below cannot be invalidated by a concurrent winner.
    const [locked] = await tdb.execute<{ id: string }>(
      sql`select id from rfqs where id = ${rfqId} for update`,
    ).then((r) => (r as unknown as { rows: { id: string }[] }).rows);

    if (!locked) throw ApiError.notFound('RFQ');

    const [current] = await tdb.select().from(rfqs).where(eq(rfqs.id, rfqId)).limit(1);
    if (!current) throw ApiError.notFound('RFQ');

    // A concurrent retry of the *same* award waits here for the winner, then
    // finds the award already recorded against this very quote: that is a
    // replay, not a conflict, so it answers with the same order.
    if (current.status === 'AWARDED' && current.awardedQuoteId === quoteId) {
      const settled = await replayIfAwarded(tdb, rfqId, quoteId, userId);
      if (settled) return settled;
    }

    // The clock is re-read inside the lock: the window may have closed while we
    // were waiting for it, and an award after the deadline is not an award.
    const afterExpiry = (await expireRfqIfDue(tdb, current)).rfq;
    await expireLapsedQuotes(tdb, rfqId);
    if (afterExpiry.status !== 'OPEN') {
      throw ApiError.conflict(`An RFQ in ${afterExpiry.status} state cannot be awarded`);
    }

    const [quote] = await tdb
      .select()
      .from(rfqQuotes)
      .where(and(eq(rfqQuotes.id, quoteId), eq(rfqQuotes.rfqId, rfqId)))
      .for('update')
      .limit(1);
    if (!quote) throw ApiError.notFound('Quote');
    if (quote.quoteStatus !== 'SUBMITTED') {
      throw ApiError.conflict(`A quote in ${quote.quoteStatus} state cannot be accepted`);
    }
    if (quote.validUntil.getTime() <= Date.now()) {
      throw ApiError.conflict('This offer has passed its validity date');
    }
    assertQuoteTransition(quote.quoteStatus, 'ACCEPTED');
    assertRfqTransition(afterExpiry.status, 'AWARDED');

    // The accepted revision must be the seller's current one: accepting an older
    // revision would bill a price the seller has already replaced.
    const [latest] = await tdb
      .select({ revision: sql<number>`max(${rfqQuotes.revision})` })
      .from(rfqQuotes)
      .where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.sellerId, quote.sellerId)));
    if ((latest?.revision ?? quote.revision) !== quote.revision) {
      throw ApiError.conflict(
        `Revision ${latest?.revision ?? quote.revision} of this seller's offer is the current one`,
      );
    }

    if (quote.currencyCode !== afterExpiry.currencyCode) {
      throw ApiError.conflict('The offer currency does not match the request');
    }

    // The seller must still be the entity that was invited, still owned by the
    // user who quoted, and still active — a deactivated supplier cannot be
    // awarded an order it can no longer fulfil.
    const [entity] = await resolveSellerEntities(tdb, [quote.sellerId]);
    if (!entity || !entity.isActive) {
      throw ApiError.conflict('The supplier is no longer active');
    }
    if (entity.userId !== quote.sellerUserId) {
      throw ApiError.conflict('The supplier account no longer matches the offer');
    }
    const [recipient] = await tdb
      .select({ id: rfqRecipients.id, sellerUserId: rfqRecipients.sellerUserId })
      .from(rfqRecipients)
      .where(and(eq(rfqRecipients.rfqId, rfqId), eq(rfqRecipients.sellerId, quote.sellerId)))
      .limit(1);
    if (!recipient || recipient.sellerUserId !== quote.sellerUserId) {
      throw ApiError.conflict('The supplier was not invited to this request');
    }

    const lines = await tdb.select().from(rfqQuoteLines).where(eq(rfqQuoteLines.quoteId, quoteId));
    const items = await tdb.select().from(rfqItems).where(eq(rfqItems.rfqId, rfqId));
    const lineByItem = new Map(lines.map((line) => [line.rfqItemId, line]));

    if (items.length === 0) throw ApiError.conflict('The request has no lines to order');
    if (lines.length !== items.length) {
      throw ApiError.conflict('The offer does not cover every requested line');
    }

    const orderItems: { productId: string; quantity: number }[] = [];
    const unitPrices: Record<string, string> = {};
    const seenProducts = new Set<string>();

    for (const item of items) {
      if (!item.productId) {
        throw ApiError.conflict(
          `Line "${item.freeTextName ?? item.id}" is not linked to a catalogue product and cannot become an order`,
        );
      }
      const line = lineByItem.get(item.id);
      if (!line) throw ApiError.conflict('The offer does not cover every requested line');

      // The stored quote is the price authority; these comparisons only detect a
      // row that contradicts itself, they never take a number from a caller.
      const quotedQty = toDecimal(line.quantity);
      if (!quotedQty.eq(toDecimal(item.quantity))) {
        throw ApiError.conflict('The offer quantity does not match the request');
      }
      const unitPrice = toDecimal(line.unitPrice);
      if (!unitPrice.gt(0)) {
        throw ApiError.conflict('The offer has a non-positive unit price');
      }
      if (!unitPrice.mul(quotedQty).eq(toDecimal(line.lineTotal))) {
        throw ApiError.conflict('The offer line total does not match its price and quantity');
      }
      if (!quotedQty.isInteger() || quotedQty.lt(1)) {
        throw ApiError.conflict(
          'The agreed quantity is not a whole number and cannot be ordered',
        );
      }

      const [product] = await tdb.select().from(products).where(eq(products.id, item.productId)).limit(1);
      if (!product || product.status !== 'ACTIVE' || !product.isPublished) {
        throw ApiError.conflict(`Product ${item.productId} is not available`);
      }
      if (product.sellerId !== quote.sellerId) {
        throw ApiError.conflict('The offer includes a product from another seller');
      }
      if (product.currencyCode !== quote.currencyCode) {
        throw ApiError.conflict('The product currency does not match the offer');
      }
      if (seenProducts.has(product.id)) {
        throw ApiError.conflict('The request lists the same product twice');
      }
      seenProducts.add(product.id);

      orderItems.push({ productId: product.id, quantity: quotedQty.toNumber() });
      unitPrices[product.id] = unitPrice.toFixed(4);
    }

    // Same order service as the checkout: identity, commission from the policy
    // engine, stock reservation, suborders, ledger and audit all live there.
    const order = await createOrder(
      tdb,
      {
        buyerId: userId,
        buyerType: 'COMPANY',
        companyId: afterExpiry.buyerCompanyId,
        items: orderItems,
        notes: `Awarded RFQ ${afterExpiry.rfqNumber} — quote revision ${quote.revision}`,
        idempotencyKey: acceptanceKey(userId, rfqId, quoteId, quote.revision),
        negotiated: {
          rfqId,
          quoteId,
          revision: quote.revision,
          sellerId: quote.sellerId,
          unitPrices,
        },
      },
      { actorId: userId, ipAddress: ctx.ipAddress },
    );

    const now = new Date();

    const accepted = await tdb
      .update(rfqQuotes)
      .set({ quoteStatus: 'ACCEPTED', decidedAt: now, decidedByUserId: userId, updatedAt: now })
      .where(and(eq(rfqQuotes.id, quoteId), eq(rfqQuotes.quoteStatus, 'SUBMITTED')))
      .returning({ id: rfqQuotes.id });
    if (accepted.length === 0) {
      throw ApiError.conflict('The offer changed while it was being accepted');
    }

    // The losing offers are closed, not deleted: their reason is recorded so a
    // seller sees why it lost instead of a quote that silently vanished.
    const losers = await tdb
      .update(rfqQuotes)
      .set({
        quoteStatus: 'REJECTED',
        decidedAt: now,
        decidedByUserId: userId,
        decisionReason: 'Another offer was accepted for this request',
        updatedAt: now,
      })
      .where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.quoteStatus, 'SUBMITTED'), ne(rfqQuotes.id, quoteId)))
      .returning({
        id: rfqQuotes.id,
        sellerId: rfqQuotes.sellerId,
        sellerUserId: rfqQuotes.sellerUserId,
        revision: rfqQuotes.revision,
      });

    const awarded = await tdb
      .update(rfqs)
      .set({
        status: 'AWARDED',
        awardedAt: now,
        awardedQuoteId: quoteId,
        orderId: order.orderId,
        updatedAt: now,
      })
      .where(and(eq(rfqs.id, rfqId), eq(rfqs.status, 'OPEN')))
      .returning({ id: rfqs.id });
    if (awarded.length === 0) {
      throw ApiError.conflict('The request changed while it was being awarded');
    }

    await recordRfqEvent(tdb, {
      rfqId,
      eventType: 'QUOTE_ACCEPTED',
      actorUserId: userId,
      payload: {
        revision: quote.revision,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        itemsTotal: order.itemsTotal,
        currencyCode: order.currencyCode,
      },
      visibleToBuyer: true,
      visibleToSeller: true,
      sellerId: quote.sellerId,
      quoteId,
      quoteRevision: quote.revision,
    });

    for (const loser of losers) {
      await recordRfqEvent(tdb, {
        rfqId,
        eventType: 'QUOTE_REJECTED',
        actorUserId: userId,
        payload: { revision: loser.revision, reason: 'AWARDED_ELSEWHERE' },
        visibleToBuyer: true,
        visibleToSeller: true,
        sellerId: loser.sellerId,
        quoteId: loser.id,
        quoteRevision: loser.revision,
      });
    }

    await writeAudit(
      tdb,
      { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      {
        action: 'RFQ.QUOTE_ACCEPTED',
        entityType: 'RFQ',
        entityId: rfqId,
        before: { status: 'OPEN', awardedQuoteId: null },
        after: {
          status: 'AWARDED',
          awardedQuoteId: quoteId,
          revision: quote.revision,
          sellerId: quote.sellerId,
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          itemsTotal: order.itemsTotal,
          grandTotal: order.grandTotal,
          currencyCode: order.currencyCode,
          rejectedQuoteIds: losers.map((l) => l.id),
        },
      },
    );

    await createNotification(tdb, {
      userId: quote.sellerUserId,
      type: 'RFQ_QUOTE_ACCEPTED',
      title: 'Your offer was accepted',
      body: `Revision ${quote.revision} of your offer on ${afterExpiry.rfqNumber} was accepted. Order ${order.orderNumber} was created.`,
      data: { rfqId, quoteId, orderId: order.orderId },
    });
    for (const loser of losers) {
      await createNotification(tdb, {
        userId: loser.sellerUserId,
        type: 'RFQ_QUOTE_REJECTED',
        title: 'Another offer was accepted',
        body: `${afterExpiry.rfqNumber} was awarded to another supplier.`,
        data: { rfqId, quoteId: loser.id },
      });
    }
    await createNotification(tdb, {
      userId: afterExpiry.buyerUserId,
      type: 'RFQ_AWARDED',
      title: 'Request awarded',
      body: `${afterExpiry.rfqNumber} was awarded and order ${order.orderNumber} was created.`,
      data: { rfqId, quoteId, orderId: order.orderId },
    });

    return {
      rfqId,
      rfqNumber: afterExpiry.rfqNumber,
      status: 'AWARDED' as const,
      quoteId,
      revision: quote.revision,
      sellerId: quote.sellerId,
      sellerName: entity.name,
      order,
      replayed: false,
      rejectedQuoteIds: losers.map((l) => l.id),
    };
  });
}

/**
 * A finished award is answered from the order it produced. The stored response
 * is the one `createOrder` kept for its idempotency key, so a retry after a
 * dropped connection returns byte-identical totals rather than recomputing them
 * against prices that may have moved since.
 */
async function replayIfAwarded(
  db: DB,
  rfqId: string,
  quoteId: string,
  userId: string,
): Promise<AcceptQuoteResult | null> {
  const [row] = await db
    .select({
      status: rfqs.status,
      rfqNumber: rfqs.rfqNumber,
      awardedQuoteId: rfqs.awardedQuoteId,
      orderId: rfqs.orderId,
      buyerUserId: rfqs.buyerUserId,
    })
    .from(rfqs)
    .where(eq(rfqs.id, rfqId))
    .limit(1);
  if (!row || row.status !== 'AWARDED' || row.awardedQuoteId !== quoteId || !row.orderId) return null;
  if (row.buyerUserId !== userId) return null;

  const [order] = await db
    .select({ metadata: orders.metadata })
    .from(orders)
    .where(eq(orders.id, row.orderId))
    .limit(1);
  const stored = (order?.metadata as { idempotency?: { response?: CreatedOrder } } | null)?.idempotency?.response;
  if (!stored) {
    throw ApiError.conflict('The awarded order could not be found');
  }

  const [quote] = await db
    .select({ id: rfqQuotes.id, revision: rfqQuotes.revision, sellerId: rfqQuotes.sellerId })
    .from(rfqQuotes)
    .where(and(eq(rfqQuotes.id, quoteId), eq(rfqQuotes.rfqId, rfqId)))
    .limit(1);
  if (!quote) return null;

  const [entity] = await resolveSellerEntities(db, [quote.sellerId]);
  const losers = await db
    .select({ id: rfqQuotes.id })
    .from(rfqQuotes)
    .where(and(
      eq(rfqQuotes.rfqId, rfqId),
      eq(rfqQuotes.quoteStatus, 'REJECTED'),
      eq(rfqQuotes.decisionReason, 'Another offer was accepted for this request'),
    ));

  return {
    rfqId,
    rfqNumber: row.rfqNumber,
    status: 'AWARDED',
    quoteId,
    revision: quote.revision,
    sellerId: quote.sellerId,
    sellerName: entity?.name ?? quote.sellerId,
    order: stored,
    replayed: true,
    rejectedQuoteIds: losers.map((l) => l.id),
  };
}

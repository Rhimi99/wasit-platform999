import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import {
  orderItems,
  orders,
  payments,
  refundAllocations,
  refunds,
  sellerOrders,
  transactionLedger,
  transactions,
} from '../../db/schema/commerce';
import { paymentIntents, paymentWebhookEvents } from '../../db/schema/payments_extras';
import { newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service.js';
import { resolvePaymentProvider, resolvePaymentProviderById } from '../../lib/payments/resolve';
import {
  canProveRefund,
  evidenceMatchesRefund,
  isTrustedEvidenceProvider,
  isTrustedEvidenceSource,
  type RefundEvidence,
} from '../../lib/payments/refund-integrity';
import { demoPaymentMode } from '../../lib/env';
import { ManualPaymentProvider } from '../../lib/payments/providers';
import type { PaymentMethod, PaymentProvider } from '../../lib/payments/port';
import { confirmSettlement } from '../settlements/service.js';
import {
  applyInvoicePaymentSucceeded,
  applyInvoicePaymentFailed,
} from '../subscriptions/collection.js';

/** Rejects a method the active provider cannot accept, with a precise reason. */
function assertMethodSupported(provider: PaymentProvider, method: PaymentMethod): void {
  const caps = provider.supportedMethods();
  const match = caps.find(
    (c) => c.method.type === method.type && (method.scheme === undefined || c.method.scheme === method.scheme),
  );
  if (!match) {
    throw ApiError.validation([
      {
        field: 'method',
        message: `Provider '${provider.id}' does not support ${method.type}${method.scheme ? `/${method.scheme}` : ''}`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
  if (!match.available) {
    throw ApiError.serviceUnavailable(match.reason ?? `${method.type} is not available on provider '${provider.id}'`);
  }
}

/** Loads an order without an ownership check (caller must be authorized). */
async function loadOrder(db: DB, orderId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');
  return order[0];
}

/** Loads an order and ensures the actor owns it (buyer) or owns the seller entity. */
async function assertOrderAccess(db: DB, orderId: string, actorId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order not found');
  const owned = (await db.execute<{ id: string }>(sql`
    select id from (
      select id, user_id from suppliers
      union all
      select id, user_id from merchants
      union all
      select id, user_id from companies
    ) owned where user_id = ${actorId}
  `)) as unknown as { rows: { id: string }[] };
  const ownedIds = owned.rows.map((r) => r.id);
  const isBuyer = order[0].buyerId === actorId;
  const isSeller = order[0].sellerId !== null && ownedIds.includes(order[0].sellerId);
  // A multi-seller parent has no single `sellerId`; a seller who owns a suborder
  // is a party to the order too.
  let isSuborderSeller = false;
  if (!isBuyer && !isSeller) {
    const sub = await db.execute<{ id: string }>(sql`
      select id from seller_orders
      where parent_order_id = ${order[0].id}
        and seller_id in (${sql.join(ownedIds.length ? ownedIds.map((i) => sql`${i}`) : [sql`null`], sql`, `)})
      limit 1
    `) as unknown as { rows: { id: string }[] };
    isSuborderSeller = sub.rows.length > 0;
  }
  if (!isBuyer && !isSeller && !isSuborderSeller) throw ApiError.forbidden();
  return order[0];
}

/**
 * Creates (or returns an existing) payment intent for an order. Idempotent by
 * `idempotencyKey`: replaying the same key returns the original intent rather
 * than charging twice.
 */
export async function createPaymentIntent(
  db: DB,
  input: {
    orderId: string;
    idempotencyKey?: string;
    actorId: string;
    ipAddress?: string | null;
    method?: PaymentMethod;
  },
  provider: PaymentProvider = resolvePaymentProvider(),
) {
  const order = await assertOrderAccess(db, input.orderId, input.actorId);

  if (order.paymentStatus === 'PAID') {
    throw ApiError.conflict('Order is already paid');
  }

  // A requested method must be one the active provider can actually accept;
  // otherwise the payer would be handed a rail that cannot work. A non-functional
  // harness (noop, no provider configured) advertises no methods and is left to
  // reject the intent itself with the proper 503.
  const method = input.method ?? { type: 'CARD' as const };
  if (provider.isFunctional) assertMethodSupported(provider, method);

  const idempotencyKey = input.idempotencyKey?.trim() || `ord_${order.id}`;

  const existing = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing.length > 0) {
    return { intent: existing[0], checkoutUrl: null, reused: true };
  }

  if (!provider.isFunctional || !provider.isAvailable()) {
    throw ApiError.serviceUnavailable('No payment provider is configured');
  }

  const tx = await db.select().from(transactions).where(eq(transactions.orderId, order.id)).limit(1);
  if (tx.length === 0) throw ApiError.conflict('Order has no transaction record');

  const created = await provider.createIntent({
    orderId: order.id,
    amount: order.grandTotal,
    currencyCode: order.currencyCode,
    idempotencyKey,
    description: `WASIT order ${order.orderNumber}`,
    method,
  });

  const intentId = newId();
  await db.insert(paymentIntents).values({
    id: intentId,
    orderId: order.id,
    transactionId: tx[0].id,
    amount: order.grandTotal,
    currencyCode: order.currencyCode,
    provider: provider.id,
    method: method.type,
    scheme: method.scheme ?? null,
    idempotencyKey,
    externalRef: created.externalRef,
    status: created.status === 'SUCCEEDED' ? 'SUCCEEDED' : created.status === 'FAILED' ? 'FAILED' : 'PENDING',
    metadata: (created.raw ?? null) as never,
  });

  // A provider record is kept purely for reconciliation; it is NOT a user wallet.
  const existingPayment = await db
    .select()
    .from(payments)
    .where(eq(payments.transactionId, tx[0].id))
    .limit(1);
  if (existingPayment.length === 0) {
    await db.insert(payments).values({
      id: newId(),
      transactionId: tx[0].id,
      orderId: order.id,
      amount: order.grandTotal,
      currencyCode: order.currencyCode,
      provider: provider.id,
      externalRef: created.externalRef,
      status: 'PENDING',
    });
  } else {
    await db
      .update(payments)
      .set({ provider: provider.id, externalRef: created.externalRef, status: 'PENDING', updatedAt: new Date() })
      .where(eq(payments.id, existingPayment[0].id));
  }

  await db
    .update(orders)
    .set({ paymentStatus: 'PENDING', updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'PAYMENT.INTENT_CREATE',
    entityType: 'ORDER',
    entityId: order.id,
    after: {
      intentId,
      provider: provider.id,
      externalRef: created.externalRef,
      amount: order.grandTotal,
      currencyCode: order.currencyCode,
      idempotencyKey,
    },
  });

  return {
    intent: {
      id: intentId,
      orderId: order.id,
      amount: order.grandTotal,
      currencyCode: order.currencyCode,
      provider: provider.id,
      externalRef: created.externalRef,
      status: created.status,
    },
    checkoutUrl: created.checkoutUrl,
    reused: false,
  };
}

/**
 * Processes a provider webhook. Signature is verified first, then the event is
 * persisted behind a unique (provider, eventId) guard so a replay can never
 * apply a side-effect twice.
 */
export async function handlePaymentWebhook(
  db: DB,
  input: { rawBody: string; signature?: string; ipAddress?: string | null },
  provider: PaymentProvider = resolvePaymentProvider(),
) {
  if (!provider.isFunctional) {
    throw ApiError.serviceUnavailable('No payment provider is configured');
  }
  const event = provider.verifyAndNormalizeWebhook(input.rawBody, input.signature);

  if (!event.eventId) throw ApiError.validation([{ field: 'eventId', message: 'Event id missing', code: 'VALIDATION_FAILED' }]);

  // Every provider that claims a payment succeeded must have that claim checked
  // against the amount and currency the platform actually asked for. A webhook
  // that proves 500 TND was paid can never be allowed to mark a 1020 TND intent
  // as paid. This is enforced here for *all* providers, not just the ones that
  // re-check status, so a forged or mismatched payload fails closed.
  //
  // Providers with `requiresStatusRecheck` (Flouci, ClicToPay) document no
  // webhook signature, so the provider's own status endpoint is the decisive
  // evidence and is what supplies the amount for the comparison below.
  let effectiveType = event.eventType;
  let effectiveRef = event.externalRef;
  if (provider.requiresStatusRecheck) {
    if (!event.externalRef) {
      throw ApiError.validation([{ field: 'externalRef', message: 'Webhook has no transaction reference', code: 'VALIDATION_FAILED' }]);
    }
    if (!provider.getStatus) {
      throw ApiError.serviceUnavailable('Provider requires status recheck but exposes no status endpoint');
    }
    const status = await provider.getStatus(event.externalRef);
    effectiveRef = status.externalRef;
    const intent = await db.select().from(paymentIntents).where(eq(paymentIntents.externalRef, effectiveRef)).limit(1);
    if (intent.length === 0) throw ApiError.notFound('Payment intent');
    if (status.amount != null && !toDecimal(status.amount).equals(toDecimal(intent[0].amount))) {
      throw ApiError.conflict('Provider-reported amount does not match the payment intent');
    }
    if (status.currencyCode != null && status.currencyCode !== intent[0].currencyCode) {
      throw ApiError.conflict('Provider-reported currency does not match the payment intent');
    }
    effectiveType =
      status.status === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : status.status === 'FAILED' ? 'PAYMENT_FAILED' : 'UNKNOWN';
  } else if (effectiveType === 'PAYMENT_SUCCEEDED' && effectiveRef && event.amount != null && event.currencyCode != null) {
    // Signature-verified webhook. Payment confirmation is NOT settlement, so a
    // missing amount does not fabricate a terminal money state here — but when
    // the provider does state an amount and currency, they must match the intent
    // we asked for, or a 500 TND confirmation could mark a 1020 TND intent paid.
    await assertEvidenceMatchesIntent(db, effectiveRef, event.amount, event.currencyCode);
  }

  // Only a terminal, actionable event may claim the (provider, eventId) key.
  // A non-actionable event (UNKNOWN / unrecognized) is acknowledged but never
  // recorded, so a later terminal event carrying the same id — the common
  // `pending` → `succeeded` provider sequence — is still applied instead of
  // being silently swallowed as a "duplicate". Terminal replays stay idempotent
  // because the key is claimed exactly once, on the terminal event.
  const isTerminal =
    effectiveType === 'PAYMENT_SUCCEEDED' ||
    effectiveType === 'PAYMENT_FAILED' ||
    effectiveType === 'REFUND_SUCCEEDED' ||
    effectiveType === 'SETTLEMENT_CONFIRMED';

  // Settlement evidence is a distinct capability. A provider that cannot see
  // funds leave the acquirer (the offline demo desk, for instance) can never
  // assert it, whatever it puts in a signed payload — so the claim is rejected
  // rather than trusted.
  if (effectiveType === 'SETTLEMENT_CONFIRMED' && !provider.capabilities?.settlementEvidence) {
    throw ApiError.validation([
      {
        field: 'type',
        message: `Provider '${provider.id}' cannot assert settlement: it exposes no settlement evidence`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  if (!isTerminal || !effectiveRef) {
    return { duplicate: false, applied: false, eventType: effectiveType };
  }

  // Out-of-order guard: money states are monotonic, so a terminal event that
  // would move an intent backwards is stale and must not be applied. The classic
  // case is a delayed `payment.failed` (a provider retrying an old failure)
  // arriving after the payment already succeeded — applying it would flip a paid
  // order to failed. The stale event is acknowledged, recorded and never applied.
  const stale = await isStaleTerminalEvent(db, effectiveType, effectiveRef);
  if (stale.stale) {
    await recordStaleEvent(db, provider.id, event.eventId, effectiveType, event.raw, stale.reason);
    return { duplicate: false, applied: false, eventType: effectiveType, stale: true, reason: stale.reason };
  }

  const inserted = await db
    .insert(paymentWebhookEvents)
    .values({
      id: newId(),
      provider: provider.id,
      eventId: event.eventId,
      eventType: effectiveType,
      payload: event.raw as never,
      signatureValid: 'true',
      status: 'RECEIVED',
    })
    .onConflictDoNothing()
    .returning({ id: paymentWebhookEvents.id });

  if (inserted.length === 0) {
    // The claim already exists. Whether this is a no-op or a retry depends on
    // where the previous attempt left it: a PROCESSED claim is a genuine
    // duplicate; a DEAD_LETTERED claim is refused (the platform already gave up
    // and an operator must intervene); a RECEIVED/FAILED claim is an incomplete
    // attempt that this delivery may retry.
    const [existing] = await db
      .select({ status: paymentWebhookEvents.status })
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, provider.id), eq(paymentWebhookEvents.eventId, event.eventId)))
      .limit(1);

    if (!existing) {
      // Raced with a concurrent delete; treat as duplicate to stay idempotent.
      return { duplicate: true, applied: false, eventType: effectiveType };
    }
    if (existing.status === 'PROCESSED') {
      return { duplicate: true, applied: false, eventType: effectiveType };
    }
    if (existing.status === 'DEAD_LETTERED') {
      return { duplicate: false, applied: false, eventType: effectiveType, deadLettered: true };
    }
    // RECEIVED / FAILED: fall through and retry the side-effect below.
  }

  let applied = false;
  try {
    if (effectiveType === 'PAYMENT_SUCCEEDED' && effectiveRef) {
      const target = await intentTarget(db, effectiveRef);
      if (target === 'SUBSCRIPTION') {
        await applyInvoicePaymentSucceeded(db, effectiveRef, provider.id, input.ipAddress ?? null);
      } else {
        await applyPaymentSucceeded(db, provider.id, effectiveRef, input.ipAddress ?? null);
      }
      applied = true;
    } else if (effectiveType === 'PAYMENT_FAILED' && effectiveRef) {
      const target = await intentTarget(db, effectiveRef);
      if (target === 'SUBSCRIPTION') {
        await applyInvoicePaymentFailed(db, effectiveRef, input.ipAddress ?? null);
      } else {
        await applyPaymentFailed(db, effectiveRef, input.ipAddress ?? null);
      }
      applied = true;
    } else if (effectiveType === 'REFUND_SUCCEEDED' && effectiveRef) {
      await applyRefundSucceeded(db, effectiveRef, input.ipAddress ?? null, provider);
      applied = true;
    } else if (effectiveType === 'SETTLEMENT_CONFIRMED' && effectiveRef) {
      // Settlement is applied by the dedicated settlement layer, which owns the
      // only SETTLED writer and the SETTLEMENT ledger entry. It re-checks the
      // amount/currency against the intent and requires a transfer reference.
      if (event.amount == null || event.currencyCode == null) {
        throw ApiError.validation([
          {
            field: 'amount',
            message: 'Settlement evidence must include both amount and currencyCode',
            code: 'VALIDATION_FAILED',
          },
        ]);
      }
      const result = await confirmSettlement(db, {
        externalRef: effectiveRef,
        amount: event.amount,
        currencyCode: event.currencyCode,
        providerId: provider.id,
        settlementRef: event.settlementRef ?? '',
        providerRef: event.settlementRef ?? null,
        ipAddress: input.ipAddress ?? null,
      });
      applied = result.applied;
    }
  } catch (err) {
    // The side-effect failed. The claim is NOT deleted — deleting it was how the
    // failure became invisible and how an unbounded retry loop stayed silent.
    // It is now recorded: the attempt count rises, the reason is kept, and once
    // the cap is reached the row is dead-lettered so operators can see exactly
    // which event is stuck and why. A retry may still claim it below the cap.
    const failure = await recordWebhookFailure(db, provider.id, event.eventId, err);
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { webhook: failure });
  }

  await db
    .update(paymentWebhookEvents)
    .set({ processedAt: new Date(), status: 'PROCESSED' })
    .where(and(eq(paymentWebhookEvents.provider, provider.id), eq(paymentWebhookEvents.eventId, event.eventId)));

  return { duplicate: false, applied, eventType: effectiveType };
}

/** How many failed apply attempts a terminal event gets before it is dead-lettered. */
export const MAX_WEBHOOK_ATTEMPTS = 5;

/**
 * A terminal event is stale when applying it would move the target backwards.
 * Only `payment.failed` vs an already-SUCCEEDED intent is monotonically wrong;
 * a `payment.succeeded` after a failure is a legitimate correction (the provider
 * may have failed then recovered) and is deliberately NOT treated as stale.
 */
async function isStaleTerminalEvent(
  db: DB,
  eventType: string,
  externalRef: string,
): Promise<{ stale: boolean; reason?: string }> {
  if (eventType !== 'PAYMENT_FAILED') return { stale: false };
  const [intent] = await db
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(eq(paymentIntents.externalRef, externalRef))
    .limit(1);
  if (intent?.status === 'SUCCEEDED') {
    return { stale: true, reason: 'payment.failed arrived after the intent already succeeded' };
  }
  return { stale: false };
}

/**
 * Records a stale event for audit without applying it. Kept under the same
 * (provider, eventId) idempotency key so a replay stays a no-op, and marked
 * PROCESSED so it is never retried.
 */
async function recordStaleEvent(
  db: DB,
  providerId: string,
  eventId: string,
  eventType: string,
  raw: unknown,
  reason?: string,
): Promise<void> {
  await db
    .insert(paymentWebhookEvents)
    .values({
      id: newId(),
      provider: providerId,
      eventId,
      eventType,
      payload: raw as never,
      signatureValid: 'true',
      status: 'PROCESSED',
      attempts: 1,
      lastError: reason ?? 'stale event',
      processedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Records one failed apply attempt and returns the resulting retry state. Once
 * the attempt cap is reached the event is dead-lettered and will not be retried.
 */
async function recordWebhookFailure(
  db: DB,
  providerId: string,
  eventId: string,
  err: unknown,
): Promise<{ attempts: number; deadLettered: boolean; message: string }> {
  const message = err instanceof Error ? err.message : String(err);
  const [row] = await db
    .select({ attempts: paymentWebhookEvents.attempts })
    .from(paymentWebhookEvents)
    .where(and(eq(paymentWebhookEvents.provider, providerId), eq(paymentWebhookEvents.eventId, eventId)))
    .limit(1);
  const attempts = (row?.attempts ?? 0) + 1;
  const deadLettered = attempts >= MAX_WEBHOOK_ATTEMPTS;
  await db
    .update(paymentWebhookEvents)
    .set({
      attempts,
      lastError: message.slice(0, 2000),
      status: deadLettered ? 'DEAD_LETTERED' : 'FAILED',
      deadLetteredAt: deadLettered ? new Date() : null,
    })
    .where(and(eq(paymentWebhookEvents.provider, providerId), eq(paymentWebhookEvents.eventId, eventId)));
  return { attempts, deadLettered, message };
}

/**
 * Lists terminal webhook events that are failing or were given up on, so an
 * operator can see and replay them. Read-only; replay goes through the normal
 * webhook path (a new delivery below the cap is retried automatically).
 *
 * `offset` exists so an operator can reach failures older than the newest page —
 * without it, anything past the first `limit` rows is invisible. The total is
 * returned alongside so the UI can page and show a real count.
 */
export async function listWebhookFailures(db: DB, opts: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = sql`${paymentWebhookEvents.status} in ('FAILED','DEAD_LETTERED')`;
  const [items, totalRow] = await Promise.all([
    db
      .select({
        id: paymentWebhookEvents.id,
        provider: paymentWebhookEvents.provider,
        eventId: paymentWebhookEvents.eventId,
        eventType: paymentWebhookEvents.eventType,
        status: paymentWebhookEvents.status,
        attempts: paymentWebhookEvents.attempts,
        lastError: paymentWebhookEvents.lastError,
        deadLetteredAt: paymentWebhookEvents.deadLetteredAt,
        createdAt: paymentWebhookEvents.createdAt,
      })
      .from(paymentWebhookEvents)
      .where(where)
      .orderBy(desc(paymentWebhookEvents.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(paymentWebhookEvents).where(where),
  ]);
  return { items, total: totalRow[0]?.count ?? 0 };
}

/**
 * Explicitly resets a DEAD_LETTERED event so the next delivery can retry it.
 * This is an operator action, not an automatic loop: it clears the attempt
 * counter back to zero and returns the event to RECEIVED.
 */
export async function replayDeadLetter(db: DB, eventRowId: string): Promise<{ replayed: boolean }> {
  const updated = await db
    .update(paymentWebhookEvents)
    .set({ status: 'RECEIVED', attempts: 0, deadLetteredAt: null })
    .where(and(eq(paymentWebhookEvents.id, eventRowId), eq(paymentWebhookEvents.status, 'DEAD_LETTERED')))
    .returning({ id: paymentWebhookEvents.id });
  return { replayed: updated.length > 0 };
}

/**
 * Verifies that a provider's payment-confirmation evidence names the same amount
 * and currency as the stored intent. This is the check that stops a 500 TND
 * confirmation from marking a 1020 TND intent as paid: the platform only ever
 * accepts a payment it asked for, for the full amount, in the right currency.
 */
async function assertEvidenceMatchesIntent(
  db: DB,
  externalRef: string,
  amount: string,
  currencyCode: string,
): Promise<void> {
  const intent = await db.select().from(paymentIntents).where(eq(paymentIntents.externalRef, externalRef)).limit(1);
  if (intent.length === 0) throw ApiError.notFound('Payment intent');
  if (!toDecimal(amount).equals(toDecimal(intent[0].amount))) {
    throw ApiError.conflict('Payment-confirmation amount does not match the payment intent');
  }
  if (currencyCode !== intent[0].currencyCode) {
    throw ApiError.conflict('Payment-confirmation currency does not match the payment intent');
  }
}

/** Distinguishes a subscription-invoice intent from an order intent by its ref. */
async function intentTarget(db: DB, externalRef: string): Promise<'ORDER' | 'SUBSCRIPTION'> {
  const rows = await db
    .select({ orderId: paymentIntents.orderId, subscriptionId: paymentIntents.subscriptionId })
    .from(paymentIntents)
    .where(eq(paymentIntents.externalRef, externalRef))
    .limit(1);
  if (rows.length === 0) throw ApiError.notFound('Payment intent');
  return rows[0].orderId ? 'ORDER' : 'SUBSCRIPTION';
}

/**
 * Cumulative COMPLETED-refund amount attributed to each seller suborder of an
 * order. Only COMPLETED refunds count: a REQUESTED/PROCESSING refund has not
 * moved money yet, so it must not drive a commission reversal or a status change.
 *
 * Returns a map keyed by `seller_order_id`; a suborder with no completed
 * allocation is simply absent (callers treat absence as zero).
 */
async function attributedRefundsBySuborder(
  db: DB,
  orderId: string,
): Promise<Map<string, ReturnType<typeof toDecimal>>> {
  const rows = await db
    .select({
      sellerOrderId: refundAllocations.sellerOrderId,
      total: sql<string>`coalesce(sum(${refundAllocations.amount}),0)::text`,
    })
    .from(refundAllocations)
    .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
    .where(and(eq(refundAllocations.parentOrderId, orderId), eq(refunds.status, 'COMPLETED')))
    .groupBy(refundAllocations.sellerOrderId);
  return new Map(rows.map((r) => [r.sellerOrderId, toDecimal(r.total)]));
}

/**
 * Reverses WASIT's COMMISSION and PAYMENT_FEE ledger entries when a refund
 * completes, attributing each reversal to the party whose money it is.
 *
 * M2.4-T2.3 — the reversal is now split by whose money it is:
 *
 *  - A SELLER's commission share is reversed in proportion to **that seller
 *    suborder's own** refunded share (its attributed completed refunds over its
 *    own refundable cap). A seller whose goods were not refunded keeps their
 *    commission; a seller fully refunded has it reversed in full. This is what
 *    makes the reversal correct per seller rather than a blanket split.
 *  - The BUYER's commission and the PAYMENT_FEE stay on the order-level policy:
 *    reversed in proportion to the order's cumulative completed refunds over what
 *    the buyer paid. This is the approved rule and is deliberately unchanged.
 *
 * A seller entry whose suborder cannot be resolved falls back to the order-level
 * ratio, so legacy data keeps its previous behaviour rather than silently
 * skipping the reversal.
 *
 * Idempotent by construction: the target reversal for each original entry is a
 * pure function of the cumulative refunded amounts, and only the delta still
 * missing is written. Replaying a refund therefore writes nothing new, and a full
 * refund reverses exactly the original amount — never more.
 */
async function reverseCommissionAndFee(
  db: DB,
  input: {
    transactionId: string;
    currencyCode: string;
    refundId: string;
    orderId: string;
    /** Total completed refunds for the whole order, including this refund. */
    cumulativeRefunded: ReturnType<typeof toDecimal>;
    paidAmount: ReturnType<typeof toDecimal>;
    providerId: string;
    /** Completed refunds attributed to each suborder, including this refund. */
    attributedBySub: Map<string, ReturnType<typeof toDecimal>>;
  },
) {
  if (input.paidAmount.lte(0) || input.cumulativeRefunded.lte(0)) return;

  const original = await db
    .select()
    .from(transactionLedger)
    .where(
      and(
        eq(transactionLedger.transactionId, input.transactionId),
        sql`${transactionLedger.entryType} in ('COMMISSION','PAYMENT_FEE')`,
        eq(transactionLedger.direction, 'DEBIT'),
      ),
    );
  if (original.length === 0) return;

  // Per-suborder caps, needed only to size a seller's own reversal.
  const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, input.orderId));
  const capBySub = new Map(subs.map((s) => [s.id, suborderRefundableCap(s)]));
  const orderRatio = input.cumulativeRefunded.dividedBy(input.paidAmount);

  const rows: (typeof transactionLedger.$inferInsert)[] = [];

  for (const entry of original) {
    const meta = (entry.metadata ?? {}) as { share?: string; sellerOrderId?: string };
    let ratio: ReturnType<typeof toDecimal>;
    if (entry.entryType === 'COMMISSION' && meta.share === 'SELLER' && meta.sellerOrderId) {
      const cap = capBySub.get(meta.sellerOrderId);
      if (cap && cap.gt(0)) {
        // A known suborder reverses strictly by its own attributed share: no
        // attribution means nothing to reverse (not a fallback to the order).
        const attributed = input.attributedBySub.get(meta.sellerOrderId) ?? toDecimal(0);
        ratio = Decimal.min(attributed.dividedBy(cap), toDecimal(1));
      } else {
        // Unknown suborder (legacy data): keep the order-level policy.
        ratio = orderRatio;
      }
    } else {
      ratio = orderRatio;
    }
    if (ratio.lte(0)) continue;

    const target = roundMoney(toDecimal(entry.amount).mul(ratio));
    const reversed = await db
      .select({ v: sql<string>`coalesce(sum(${transactionLedger.amount}),0)::text` })
      .from(transactionLedger)
      .where(
        and(
          eq(transactionLedger.transactionId, input.transactionId),
          eq(transactionLedger.entryType, entry.entryType),
          eq(transactionLedger.direction, 'CREDIT'),
          sql`${transactionLedger.metadata}->>'reversalOf' = ${entry.id}`,
        ),
      );
    const already = toDecimal(reversed[0]?.v ?? 0);
    const delta = target.minus(already);
    if (delta.lte(0)) continue;

    rows.push({
      id: newId(),
      transactionId: input.transactionId,
      entryType: entry.entryType,
      direction: 'CREDIT',
      amount: delta.toFixed(4),
      currencyCode: input.currencyCode,
      payerId: entry.beneficiaryId,
      beneficiaryId: entry.payerId,
      paymentProvider: input.providerId,
      // A reversal is a book entry, not a movement of money: it starts PENDING
      // like every other entry and is promoted only by settlement evidence.
      status: 'PENDING',
      metadata: { reversalOf: entry.id, refundId: input.refundId } as never,
    } as never);
  }

  if (rows.length > 0) await db.insert(transactionLedger).values(rows);
}

/**
 * M2.4-T2.3 — marks each fully-refunded seller suborder as `REFUNDED`, computed
 * on its OWN attributed completed refunds, so a suborder's status reflects its
 * own money rather than the parent's.
 *
 * A partially-refunded suborder keeps its fulfilment status: a partial refund
 * does not mean the seller's part was cancelled. A `REFUNDED` suborder is, by its
 * status alone, ineligible for settlement (`evaluateSuborderRow` requires
 * DELIVERED/COMPLETED), so a refunded seller can never be paid out. Its
 * `settlement_status` is left untouched — the enum has no refunded value, and the
 * status gate plus the parent-refund gate already block settlement.
 *
 * Idempotent: the write is guarded on the status not already being `REFUNDED`, so
 * a replay — or a second refund that still leaves the suborder fully refunded —
 * is a no-op. Returns the ids actually moved, for the audit trail.
 */
async function markRefundedSuborders(
  db: DB,
  orderId: string,
  attributedBySub: Map<string, ReturnType<typeof toDecimal>>,
): Promise<string[]> {
  const subs = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
  const moved: string[] = [];
  for (const sub of subs) {
    const cap = suborderRefundableCap(sub);
    if (cap.lte(0)) continue;
    const attributed = attributedBySub.get(sub.id) ?? toDecimal(0);
    if (attributed.lt(cap)) continue;
    const claimed = await db
      .update(sellerOrders)
      .set({ status: 'REFUNDED' as never, updatedAt: new Date() })
      .where(and(eq(sellerOrders.id, sub.id), sql`${sellerOrders.status} <> 'REFUNDED'`))
      .returning({ id: sellerOrders.id });
    if (claimed.length > 0) moved.push(sub.id);
  }
  return moved;
}

async function applyPaymentSucceeded(db: DB, providerId: string, externalRef: string, ipAddress: string | null) {
  const intentRows = await db.select().from(paymentIntents).where(eq(paymentIntents.externalRef, externalRef)).limit(1);
  if (intentRows.length === 0) throw ApiError.notFound('Payment intent');
  const intent = intentRows[0];
  if (intent.status === 'SUCCEEDED') return;

  // Defense-in-depth: a subscription intent must never be settled as an order.
  if (!intent.orderId) {
    await applyInvoicePaymentSucceeded(db, externalRef, providerId, ipAddress);
    return;
  }
  const orderId = intent.orderId;
  if (!intent.transactionId) throw ApiError.conflict('Payment intent has no transaction');
  const transactionId = intent.transactionId;

  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order');

  await db
    .update(paymentIntents)
    .set({ status: 'SUCCEEDED', updatedAt: new Date() })
    .where(eq(paymentIntents.id, intent.id));

  await db
    .update(payments)
    .set({ status: 'PAID', updatedAt: new Date() })
    .where(eq(payments.transactionId, transactionId));

  await db.update(transactions).set({ status: 'PAID' }).where(eq(transactions.id, transactionId));

  // Payment confirmation only. The ledger entries stay PENDING: a confirmed
  // payment means the money reached the provider, NOT that it settled. A ledger
  // entry is promoted to SETTLED later, and only, by `applySettlementConfirmed`
  // on the strength of real settlement evidence. Writing SETTLED here is exactly
  // the Payment = Settlement conflation this system must not have.
  await db
    .update(transactionLedger)
    .set({ paymentProvider: providerId } as never)
    .where(eq(transactionLedger.transactionId, transactionId));

  await db
    .update(orders)
    .set({ paymentStatus: 'PAID', updatedAt: new Date() })
    .where(eq(orders.id, orderId));

  await writeAudit(db, { actorId: order[0].buyerId, ipAddress }, {
    action: 'PAYMENT.SUCCEEDED',
    entityType: 'ORDER',
    entityId: orderId,
    before: { paymentStatus: order[0].paymentStatus },
    after: { paymentStatus: 'PAID', intentId: intent.id, provider: providerId },
  });

  await createNotification(db, {
    userId: order[0].buyerId,
    type: 'PAYMENT_SUCCEEDED',
    title: 'Payment confirmed',
    body: `Payment for order ${order[0].orderNumber} was confirmed.`,
    data: { orderId, intentId: intent.id },
  });
}

async function applyPaymentFailed(db: DB, externalRef: string, ipAddress: string | null) {
  const intentRows = await db.select().from(paymentIntents).where(eq(paymentIntents.externalRef, externalRef)).limit(1);
  if (intentRows.length === 0) throw ApiError.notFound('Payment intent');
  const intent = intentRows[0];
  if (intent.status === 'FAILED') return;

  if (!intent.orderId) {
    await applyInvoicePaymentFailed(db, externalRef, ipAddress);
    return;
  }
  const orderId = intent.orderId;
  if (!intent.transactionId) throw ApiError.conflict('Payment intent has no transaction');
  const transactionId = intent.transactionId;

  await db
    .update(paymentIntents)
    .set({ status: 'FAILED', failureReason: 'provider_reported_failure', updatedAt: new Date() })
    .where(eq(paymentIntents.id, intent.id));
  await db.update(payments).set({ status: 'FAILED', updatedAt: new Date() }).where(eq(payments.transactionId, transactionId));
  await db.update(orders).set({ paymentStatus: 'FAILED', updatedAt: new Date() }).where(eq(orders.id, orderId));
  await db.update(transactions).set({ status: 'FAILED' }).where(eq(transactions.id, transactionId));

  await writeAudit(db, { actorId: null, ipAddress }, {
    action: 'PAYMENT.FAILED',
    entityType: 'ORDER',
    entityId: orderId,
    after: { paymentStatus: 'FAILED', intentId: intent.id },
  });
}

async function applyRefundSucceeded(db: DB, externalRef: string, ipAddress: string | null, provider: PaymentProvider) {
  // A refund webhook is only proof when it comes from a provider that can move
  // real money. A demonstration harness (`noop`/`manual`/`sandbox`) reporting
  // success proves nothing — its signed payload is a local marker, not a bank
  // movement — so it is refused before any lookup or state change.
  if (!canProveRefund(provider)) {
    throw ApiError.validation([
      {
        field: 'type',
        message: `Provider '${provider.id}' cannot prove a refund moved: its success is not external evidence`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }
  const rows = await db.select().from(refunds).where(eq(refunds.externalRef, externalRef)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Refund');
  await completeRefundWithEvidence(db, rows[0].id, {
    source: 'PROVIDER_WEBHOOK',
    providerId: provider.id,
    externalRef,
    amount: rows[0].amount,
    currencyCode: rows[0].currencyCode,
  }, { actorId: null, ipAddress });
}

/**
 * Completes a refund against *trusted external evidence*. This is the ONLY
 * writer of a refund's terminal `COMPLETED` state, the `REFUND` ledger entry,
 * the commission/fee reversal, and the order/transaction refund state.
 *
 * It is deliberately a separate step from `createRefund`: requesting a refund is
 * not the same fact as money having moved. Nothing reaches this routine except a
 * provider that can actually move funds (enforced by `canProveRefund` at every
 * call site) presenting evidence that matches this refund's amount and currency.
 *
 * Idempotency and races: the refund row is locked `FOR UPDATE` inside the
 * transaction and its status re-read under the lock, so two concurrent
 * completions (a provider API reply racing its own webhook, or a replayed
 * webhook) serialise — the first writes the money side-effects, the second sees
 * `COMPLETED` and returns without a second ledger entry.
 */
export async function completeRefundWithEvidence(
  db: DB,
  refundId: string,
  evidence: RefundEvidence,
  ctx: { actorId: string | null; ipAddress?: string | null },
): Promise<{ completed: boolean; reused: boolean; refundId: string }> {
  const externalRef = evidence.externalRef?.trim();
  if (!externalRef) {
    throw ApiError.validation([
      { field: 'externalRef', message: 'Refund evidence must carry a provider reference', code: 'VALIDATION_FAILED' },
    ]);
  }
  // Defence in depth. The call sites already gate on `canProveRefund`, but this
  // routine is the sole writer of a completed refund, so it refuses to trust the
  // *named* provider on faith: the evidence must name a source that can prove a
  // reversal, and that provider must resolve to a real, configured acquirer.
  // Otherwise a future caller could hand a demo provider's marker straight in
  // and have it written as a completed refund — the exact bypass this rail
  // exists to prevent.
  if (!isTrustedEvidenceSource(evidence.source)) {
    throw ApiError.validation([
      { field: 'source', message: 'Refund evidence has an unrecognised source', code: 'VALIDATION_FAILED' },
    ]);
  }
  let evidenceProvider: PaymentProvider;
  try {
    evidenceProvider = resolvePaymentProviderById(evidence.providerId);
  } catch {
    throw ApiError.validation([
      { field: 'providerId', message: `Refund evidence names an unknown provider '${evidence.providerId}'`, code: 'VALIDATION_FAILED' },
    ]);
  }
  if (!isTrustedEvidenceProvider(evidenceProvider)) {
    throw ApiError.validation([
      {
        field: 'providerId',
        message: `Provider '${evidence.providerId}' cannot prove a refund moved: its success is not external evidence`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  return db.transaction(async (tx) => {
    // Lock the refund row so concurrent completions cannot both pass the guard.
    const locked = await tx.select().from(refunds).where(eq(refunds.id, refundId)).limit(1).for('update');
    if (locked.length === 0) throw ApiError.notFound('Refund');
    const refund = locked[0];

    if (refund.status === 'COMPLETED') {
      return { completed: false, reused: true, refundId };
    }
    if (refund.status === 'FAILED' || refund.status === 'REJECTED') {
      throw ApiError.conflict(`Refund is ${refund.status} and cannot be completed`);
    }

    // Evidence must match this refund exactly: a proof of some other amount,
    // currency or order is not proof of this reversal.
    const match = evidenceMatchesRefund({ amount: refund.amount, currencyCode: refund.currencyCode }, evidence);
    if (!match.ok) {
      throw ApiError.conflict(`Refund evidence rejected: ${match.reason}`);
    }

    const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId)).limit(1);
    if (!order) throw ApiError.notFound('Order');
    const [payment] = await tx.select().from(payments).where(eq(payments.id, refund.paymentId)).limit(1);
    if (!payment) throw ApiError.conflict('No payment record for this refund');

    await tx
      .update(refunds)
      .set({ status: 'COMPLETED', externalRef, updatedAt: new Date() })
      .where(eq(refunds.id, refundId));

    const requested = toDecimal(refund.amount);

    // A refund reverses value: recorded as a DEBIT so the revenue ledger's
    // (CREDIT − DEBIT) math correctly reduces net refunds. PENDING until
    // settlement evidence confirms the reversal actually moved; this is
    // independent of `refunds.status`, which tracks the refund itself.
    await tx.insert(transactionLedger).values({
      id: newId(),
      transactionId: payment.transactionId,
      entryType: 'REFUND',
      direction: 'DEBIT',
      amount: requested.toFixed(4),
      currencyCode: order.currencyCode,
      payerId: 'wasit',
      beneficiaryId: order.buyerId,
      paymentProvider: evidence.providerId,
      status: 'PENDING',
    } as never);

    // Cumulative completed refunds, including this one, so the order's state and
    // the commission reversal are computed from one source of truth.
    const prior = await tx
      .select({ total: sql<string>`coalesce(sum(${refunds.amount}),0)::text` })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), eq(refunds.status, 'COMPLETED')));
    const newRefundedTotal = toDecimal(prior[0]?.total ?? 0);
    const paidAmount = toDecimal(order.grandTotal);

    // M2.4-T2.3 — per-seller attribution of the completed refunds. The refund row
    // above is already COMPLETED, so this read includes it. A seller's commission
    // is reversed against their own attributed share, not the order's.
    const attributedBySub = await attributedRefundsBySuborder(tx as unknown as DB, order.id);

    await reverseCommissionAndFee(tx as unknown as DB, {
      transactionId: payment.transactionId,
      currencyCode: order.currencyCode,
      refundId,
      orderId: order.id,
      cumulativeRefunded: newRefundedTotal,
      paidAmount,
      providerId: evidence.providerId,
      attributedBySub,
    });

    // M2.4-T2.3 — move each fully-refunded seller suborder to REFUNDED on its own
    // attributed amount, so a refunded seller is individually marked and becomes
    // ineligible for settlement (its status is no longer DELIVERED/COMPLETED).
    const refundedSuborders = await markRefundedSuborders(tx as unknown as DB, order.id, attributedBySub);

    const fullyRefunded = newRefundedTotal.gte(paidAmount);
    await tx
      .update(orders)
      .set({
        refundStatus: fullyRefunded ? 'COMPLETED' : 'PROCESSING',
        paymentStatus: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        status: fullyRefunded ? ('REFUNDED' as never) : (order.status as never),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    // Keep the transaction's own payment state consistent with the order.
    await tx
      .update(transactions)
      .set({ status: fullyRefunded ? ('REFUNDED' as never) : ('PARTIALLY_REFUNDED' as never), updatedAt: new Date() })
      .where(eq(transactions.id, payment.transactionId));

    // The audit entry records WHAT proved the movement, not just that it
    // happened: source, provider, the provider reference, and that the evidence
    // was verified against this refund. No card data or secrets are stored.
    await writeAudit(tx as unknown as DB, { actorId: ctx.actorId, ipAddress: ctx.ipAddress ?? null }, {
      action: 'REFUND.COMPLETED',
      entityType: 'ORDER',
      entityId: order.id,
      after: {
        refundId,
        amount: requested.toFixed(4),
        currencyCode: order.currencyCode,
        fullyRefunded,
        refundedSuborders,
        provider: evidence.providerId,
        evidenceSource: evidence.source,
        evidenceRef: externalRef,
        evidenceVerified: true,
      },
    });

    await createNotification(tx as unknown as DB, {
      userId: order.buyerId,
      type: 'REFUND_COMPLETED',
      title: 'Refund processed',
      body: `A refund of ${requested.toFixed(4)} ${order.currencyCode} was processed for order ${order.orderNumber}.`,
      data: { orderId: order.id, refundId },
    });

    return { completed: true, reused: false, refundId };
  });
}

/**
 * A caller-named slice of a refund: this much of the refund is attributed to
 * this seller suborder, and — when `orderItemId` is given — to this line.
 */
export interface RefundAllocationInput {
  sellerOrderId: string;
  orderItemId?: string | null;
  amount: string;
}

/**
 * A validated, fully-resolved allocation: every id is taken from the LOCKED
 * database rows, never echoed from the caller, and the amount is already
 * rounded to the stored scale.
 */
interface ResolvedRefundAllocation {
  sellerOrderId: string;
  orderItemId: string | null;
  amount: Decimal;
}

/**
 * A seller suborder may not be refunded beyond what the buyer actually paid for
 * its lines. We use the suborder's `itemsTotal` (line totals plus the buyer's
 * share of the commission, which is how the buyer was charged) as the cap —
 * never `sellerPayable`, which is the seller's net payout and a different
 * number. It is the total the buyer can be made whole on for that suborder.
 */
function suborderRefundableCap(sub: typeof sellerOrders.$inferSelect): Decimal {
  return roundMoney(toDecimal(sub.itemsTotal).add(toDecimal(sub.buyerCommission)));
}

/** How much of an order's total has already been committed to refunds. */
function committedRefundTotal(rows: { total: string | null }[]): Decimal {
  return toDecimal(rows[0]?.total ?? 0);
}

/**
 * Refund statuses that hold a reservation against the refundable cap. A FAILED
 * or REJECTED refund frees its amount — and, consistently, its allocation rows
 * are no longer counted against a suborder or line.
 */
const RESERVED_REFUND_STATUS_SQL = sql`${refunds.status} in ('REQUESTED','APPROVED','PROCESSING','COMPLETED')`;

function badField(field: string, message: string): never {
  throw ApiError.validation([{ field, message, code: 'VALIDATION_FAILED' }]);
}

/** True when Postgres rejected the write on a unique constraint. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Validates the caller's requested allocations against the order's real
 * structure and returns them resolved against locked rows.
 *
 * A partial refund (one that does not cover the whole order) must name its
 * seller suborders precisely — we never guess which seller a partial refund
 * belongs to. When the caller supplies no allocations at all, the request is
 * treated as a FULL refund and attributed across every suborder by its own
 * actual refundable amount, never by an equal or arbitrary split.
 *
 * `db` must be a transaction handle: every referenced suborder and line is read
 * with `SELECT … FOR UPDATE`, so the per-suborder "already allocated" totals
 * below cannot change under us.
 */
async function resolveRefundAllocations(
  db: DB,
  order: typeof orders.$inferSelect,
  requested: Decimal,
  rawAllocations: RefundAllocationInput[] | undefined,
): Promise<ResolvedRefundAllocation[]> {
  const subRows = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, order.id));
  const subsById = new Map(subRows.map((s) => [s.id, s]));

  // --- No explicit allocation. ---
  if (!rawAllocations || rawAllocations.length === 0) {
    if (subRows.length === 0) return []; // legacy single-seller order, no suborders

    // Lock the suborders in a stable order (by id) so two concurrent full
    // refunds of the same order cannot deadlock and cannot both read a stale
    // "already allocated" total.
    const lockedSubs = await db
      .select()
      .from(sellerOrders)
      .where(eq(sellerOrders.parentOrderId, order.id))
      .orderBy(asc(sellerOrders.id))
      .for('update');
    const subIds = lockedSubs.map((s) => s.id);
    const priorRows = subIds.length
      ? await db
          .select({ sellerOrderId: refundAllocations.sellerOrderId, total: sql<string>`coalesce(sum(${refundAllocations.amount}),0)::text` })
          .from(refundAllocations)
          .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
          .where(and(inArray(refundAllocations.sellerOrderId, subIds), RESERVED_REFUND_STATUS_SQL))
          .groupBy(refundAllocations.sellerOrderId)
      : [];
    const priorBySub = new Map(priorRows.map((r) => [r.sellerOrderId, toDecimal(r.total)]));

    const caps = lockedSubs.map((s) => ({
      sub: s,
      cap: suborderRefundableCap(s),
      prior: priorBySub.get(s.id) ?? toDecimal(0),
    }));
    const totalRemaining = caps.reduce((acc, c) => acc.plus(c.cap.sub(c.prior)), toDecimal(0));

    // Single-seller order: there is no ambiguity about which seller a partial
    // refund belongs to, so an un-attributed partial refund is attributed to
    // that one suborder. This preserves the pre-M2 single-seller behaviour.
    if (lockedSubs.length === 1) {
      const only = caps[0];
      const remaining = only.cap.sub(only.prior);
      if (remaining.lte(0)) badField('amount', 'This order has no refundable amount left on its seller suborder');
      if (requested.gt(remaining)) {
        badField('amount', `Refund exceeds the remaining refundable amount of the seller suborder (${remaining.toFixed(4)})`);
      }
      return [{ sellerOrderId: only.sub.id, orderItemId: null, amount: roundMoney(requested) }];
    }

    // Multi-seller order: only a FULL refund may be distributed automatically.
    // A partial refund must name its suborders — we never guess how a partial
    // amount splits between sellers.
    if (requested.lt(totalRemaining)) {
      badField(
        'allocations',
        'A partial refund of a multi-seller order must name the seller suborder (and line, when known) for each allocation',
      );
    }
    if (totalRemaining.lte(0)) {
      badField('amount', 'This order has no refundable amount left on its seller suborders');
    }
    if (requested.gt(totalRemaining)) {
      badField(
        'amount',
        `Refund exceeds the total refundable amount of the seller suborders (${totalRemaining.toFixed(4)})`,
      );
    }

    // Full refund: distribute by each suborder's own remaining refundable amount
    // (largest-remainder split). The result sums exactly to `requested` and never
    // exceeds any suborder's remaining amount.
    const shares = caps.map((c) => {
      const remaining = c.cap.sub(c.prior);
      const exact = requested.mul(remaining).div(totalRemaining);
      const floored = exact.toDecimalPlaces(4, Decimal.ROUND_DOWN);
      return { id: c.sub.id, remaining, exact, floored, frac: exact.sub(floored) };
    });
    let leftoverUnits = requested
      .sub(shares.reduce((acc, s) => acc.plus(s.floored), toDecimal(0)))
      .mul(10000)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();
    const byFracDesc = [...shares].sort((a, b) => b.frac.comparedTo(a.frac));
    for (const s of byFracDesc) {
      if (leftoverUnits <= 0) break;
      const room = s.remaining.sub(s.floored);
      const add = Decimal.min(room, new Decimal(leftoverUnits).div(10000));
      const addUnits = add.mul(10000).toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber();
      s.floored = s.floored.add(new Decimal(addUnits).div(10000));
      leftoverUnits -= addUnits;
    }
    // Any residual sub-cent unit (rounding noise) lands on the largest remaining.
    if (leftoverUnits > 0) {
      const target = byFracDesc.find((s) => s.remaining.gt(s.floored)) ?? byFracDesc[0];
      target.floored = target.floored.add(new Decimal(leftoverUnits).div(10000));
    }

    const resolved: ResolvedRefundAllocation[] = [];
    for (const s of shares) {
      if (s.floored.lte(0)) continue;
      if (s.floored.gt(s.remaining)) badField('amount', 'Refund allocation exceeds a suborder refundable amount');
      resolved.push({ sellerOrderId: s.id, orderItemId: null, amount: roundMoney(s.floored) });
    }
    return resolved;
  }

  // --- Explicit allocations. ---
  // A partial refund must name its suborders precisely: we refuse to guess.
  const anyNamed = rawAllocations.some((a) => a.sellerOrderId);
  if (!anyNamed) {
    badField(
      'allocations',
      'A partial refund must name the seller suborder (and line, when known) for each allocation',
    );
  }

  // Lock every referenced suborder first (stable order), then every referenced
  // line — the same suborder-before-transaction order the settlement and payout
  // paths use, so refund creation can never deadlock against them. The locked
  // rows are the authoritative source for every value below.
  const subIds = [...new Set(rawAllocations.map((a) => a.sellerOrderId))].sort();
  const lockedSubRows = await db
    .select()
    .from(sellerOrders)
    .where(inArray(sellerOrders.id, subIds))
    .orderBy(asc(sellerOrders.id))
    .for('update');
  const lockedSubsById = new Map(lockedSubRows.map((s) => [s.id, s]));
  const itemIds = [...new Set(rawAllocations.map((a) => a.orderItemId).filter((x): x is string => Boolean(x)))].sort();
  const lockedItemRows = itemIds.length
    ? await db.select().from(orderItems).where(inArray(orderItems.id, itemIds)).orderBy(asc(orderItems.id)).for('update')
    : [];
  const itemsById = new Map(lockedItemRows.map((i) => [i.id, i]));

  // Prior allocations, per suborder and per line, read under the locks above.
  // Only reservations from non-failed refunds count — a FAILED refund frees its
  // amount, consistently with the order-level cap.
  const priorSubRows = subIds.length
    ? await db
        .select({ sellerOrderId: refundAllocations.sellerOrderId, total: sql<string>`coalesce(sum(${refundAllocations.amount}),0)::text` })
        .from(refundAllocations)
        .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
        .where(and(inArray(refundAllocations.sellerOrderId, subIds), RESERVED_REFUND_STATUS_SQL))
        .groupBy(refundAllocations.sellerOrderId)
    : [];
  const priorBySub = new Map(priorSubRows.map((r) => [r.sellerOrderId, toDecimal(r.total)]));
  const priorItemRows = itemIds.length
    ? await db
        .select({ orderItemId: refundAllocations.orderItemId, total: sql<string>`coalesce(sum(${refundAllocations.amount}),0)::text` })
        .from(refundAllocations)
        .innerJoin(refunds, eq(refunds.id, refundAllocations.refundId))
        .where(and(inArray(refundAllocations.orderItemId, itemIds), RESERVED_REFUND_STATUS_SQL))
        .groupBy(refundAllocations.orderItemId)
    : [];
  const priorByItem = new Map(priorItemRows.map((r) => [r.orderItemId as string, toDecimal(r.total)]));

  const seenSub = new Set<string>();
  const seenItem = new Set<string>();
  const resolved: ResolvedRefundAllocation[] = [];

  for (let idx = 0; idx < rawAllocations.length; idx++) {
    const raw = rawAllocations[idx];
    const field = `allocations[${idx}]`;

    if (!raw.sellerOrderId) badField(`${field}.sellerOrderId`, 'sellerOrderId is required');

    // 5. The suborder must belong to THIS parent order and share its currency.
    const sub = lockedSubsById.get(raw.sellerOrderId) ?? subsById.get(raw.sellerOrderId);
    if (!sub || sub.parentOrderId !== order.id) {
      badField(`${field}.sellerOrderId`, 'The seller suborder does not belong to this order');
    }
    if (sub.currencyCode !== order.currencyCode) {
      badField(`${field}.sellerOrderId`, 'The seller suborder currency does not match the order currency');
    }

    // 8. One allocation per suborder — no duplicate attributions.
    if (seenSub.has(sub.id)) badField(`${field}.sellerOrderId`, 'Duplicate allocation for the same seller suborder');
    seenSub.add(sub.id);

    const amount = roundMoney(toDecimal(raw.amount));
    if (amount.lte(0)) badField(`${field}.amount`, 'Allocation amount must be positive');

    // 4. When a line is named it must belong to the named suborder (and order).
    let orderItemId: string | null = null;
    if (raw.orderItemId) {
      const item = itemsById.get(raw.orderItemId);
      if (!item || item.orderId !== order.id || item.sellerOrderId !== sub.id) {
        badField(`${field}.orderItemId`, 'The line does not belong to the named seller suborder');
      }
      if (seenItem.has(item.id)) badField(`${field}.orderItemId`, 'Duplicate allocation for the same line');
      seenItem.add(item.id);
      orderItemId = item.id;

      // 6. A line can never be refunded beyond its own line total.
      const itemCap = roundMoney(toDecimal(item.lineTotal));
      const itemPrior = priorByItem.get(item.id) ?? toDecimal(0);
      if (amount.gt(itemCap.sub(itemPrior))) {
        badField(
          `${field}.amount`,
          `Allocation exceeds the refundable amount of the line (${itemCap.sub(itemPrior).toFixed(4)})`,
        );
      }
    }

    // 6. A suborder can never be refunded beyond its own refundable cap.
    const subCap = suborderRefundableCap(sub);
    const subPrior = priorBySub.get(sub.id) ?? toDecimal(0);
    if (amount.gt(subCap.sub(subPrior))) {
      badField(
        `${field}.amount`,
        `Allocation exceeds the refundable amount of the seller suborder (${subCap.sub(subPrior).toFixed(4)})`,
      );
    }

    resolved.push({ sellerOrderId: sub.id, orderItemId, amount });
  }

  const sum = resolved.reduce((acc, r) => acc.plus(r.amount), toDecimal(0));
  if (!sum.equals(requested)) {
    badField('amount', `The allocations (${sum.toFixed(4)}) must sum exactly to the refund amount (${requested.toFixed(4)})`);
  }

  return resolved;
}

/**
 * Creates a refund *request* against a paid order and, when a provider that can
 * actually move money is configured, attempts the reversal and completes the
 * refund only on its trusted evidence.
 *
 * The request is separated from completion on purpose. The refund row is written
 * first as `PROCESSING` (in flight) or `REQUESTED` (no trusted rail available);
 * it becomes `COMPLETED` — with the ledger reversal, commission reversal and
 * order state — only through `completeRefundWithEvidence`. A demonstration
 * harness (`noop`/`manual`/`sandbox`) or an unconfigured provider therefore
 * leaves the refund pending: it never fabricates a completed refund, never flips
 * the order to `REFUNDED`, and never writes a `REFUND` ledger entry.
 *
 * Idempotent by `idempotencyKey`, and guarded against over-refunding.
 */
export async function createRefund(
  db: DB,
  input: {
    orderId: string;
    amount?: string;
    reason?: string;
    idempotencyKey?: string;
    actorId: string;
    ipAddress?: string | null;
    /**
     * Optional per-seller-suborder attribution. When omitted, the refund is
     * treated as a full refund of the order and attributed across every seller
     * suborder by its own actual refundable amount. When supplied, the
     * allocations must sum exactly to the refund amount and every referenced
     * suborder/line must belong to this order.
     */
    allocations?: RefundAllocationInput[];
    /** True when the caller holds the privileged `refund:manage` permission. */
    isOperator?: boolean;
  },
  provider: PaymentProvider = resolvePaymentProvider(),
) {
  // Refunds are privileged: an operator (refund:manage) may refund any order;
  // otherwise the actor must be a party to the order.
  const order = input.isOperator
    ? await loadOrder(db, input.orderId)
    : await assertOrderAccess(db, input.orderId, input.actorId);

  // Idempotency is checked before the state guard: a replayed request must
  // return the original refund even though the order has since been refunded.
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const seen = await db.select().from(refunds).where(eq(refunds.idempotencyKey, idempotencyKey)).limit(1);
    if (seen.length > 0) return { refund: seen[0], reused: true };
  }

  if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED') {
    throw ApiError.conflict('Only paid orders can be refunded');
  }

  const payment = await db.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
  if (payment.length === 0) throw ApiError.conflict('No payment record to refund');

  const paidAmount = toDecimal(order.grandTotal);
  const requested = input.amount ? roundMoney(input.amount) : null;
  if (requested && requested.lte(0)) {
    throw ApiError.validation([{ field: 'amount', message: 'Refund amount must be positive', code: 'VALIDATION_FAILED' }]);
  }

  const refundId = newId();
  // The provider reference to reverse against is the acquirer's payment
  // reference, which lives on the payment intent (the payments row does not
  // carry it). Without it there is nothing to reverse.
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, order.id)).limit(1);
  const providerPaymentRef = payment[0].externalRef ?? intent?.externalRef ?? null;
  // No trusted rail → the refund stays a REQUEST. A trusted rail that we are
  // about to call is PROCESSING. Neither is a completed refund.
  const canAttempt = canProveRefund(provider) && Boolean(providerPaymentRef);

  // Validation, the reservation and the allocation rows are one atomic unit: the
  // over-refund cap is read and written under the same transaction, and every
  // referenced suborder/line is locked (`SELECT … FOR UPDATE`) before the caps
  // are read, so two concurrent refunds can never both spend the same remaining
  // amount. Only the refund row is inserted here — the ledger reversal and order
  // state remain the exclusive job of `completeRefundWithEvidence`.
  let requestedAmount = toDecimal(0);
  try {
    requestedAmount = await db.transaction(async (tx) => {
      const tdb = tx as unknown as DB;

      // 7. Serialize concurrent refunds of the same order on the order row
      //    itself: a fixed first lock that the settlement/payout paths do not
      //    take, so no cycle can form against them.
      await tdb.select().from(orders).where(eq(orders.id, order.id)).limit(1).for('update');

      // Every non-failed refund reserves its amount against the refundable cap,
      // so a still-pending request cannot be silently double-spent by a second.
      const prior = await tdb
        .select({ total: sql<string>`coalesce(sum(${refunds.amount}),0)::text` })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), RESERVED_REFUND_STATUS_SQL));
      const alreadyRefunded = committedRefundTotal(prior);
      const remaining = paidAmount.minus(alreadyRefunded);

      const amount = requested ?? remaining;
      if (amount.lte(0)) {
        throw ApiError.validation([{ field: 'amount', message: 'Refund amount must be positive', code: 'VALIDATION_FAILED' }]);
      }
      if (amount.gt(remaining)) {
        throw ApiError.validation([{ field: 'amount', message: `Refund exceeds remaining refundable amount ${remaining.toFixed(4)}`, code: 'VALIDATION_FAILED' }]);
      }

      const resolved = await resolveRefundAllocations(tdb, order, amount, input.allocations);

      // Reserve the amount FIRST, then write the allocations. Both are in this
      // transaction: a concurrent request either sees this reservation (and is
      // refused) or waits on the order lock until we commit — never both
      // spending the same remainder. A concurrent request with the SAME
      // idempotency key is rejected at commit by `refunds_idem_idx`.
      await tdb.insert(refunds).values({
        id: refundId,
        paymentId: payment[0].id,
        orderId: order.id,
        amount: amount.toFixed(4),
        currencyCode: order.currencyCode,
        reason: input.reason ?? null,
        status: canAttempt ? 'PROCESSING' : 'REQUESTED',
        requestedById: input.actorId,
        idempotencyKey,
      });

      if (resolved.length > 0) {
        await tdb.insert(refundAllocations).values(
          resolved.map((r) => ({
            id: newId(),
            refundId,
            parentOrderId: order.id,
            sellerOrderId: r.sellerOrderId,
            orderItemId: r.orderItemId,
            amount: r.amount.toFixed(4),
            currencyCode: order.currencyCode,
          })),
        );
      }

      return amount;
    });
  } catch (err) {
    // A concurrent request with the SAME idempotency key won the race: the
    // unique index rejected ours. Return the original refund instead of a 500 —
    // the same "replay returns the original" contract as the pre-check above.
    if (idempotencyKey && isUniqueViolation(err)) {
      const seen = await db.select().from(refunds).where(eq(refunds.idempotencyKey, idempotencyKey)).limit(1);
      if (seen.length > 0) return { refund: seen[0], reused: true };
    }
    throw err;
  }

  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'REFUND.REQUESTED',
    entityType: 'ORDER',
    entityId: order.id,
    after: {
      refundId,
      amount: requestedAmount.toFixed(4),
      currencyCode: order.currencyCode,
      provider: provider.id,
      canAttempt,
      reason: canAttempt
        ? 'Attempting reversal with the configured acquirer'
        : `No trusted refund rail: provider '${provider.id}' cannot prove a reversal moved funds`,
    },
  });

  if (!canAttempt) {
    // Fail closed: no evidence path, so no completion. The refund stays
    // REQUESTED and the order's payment state is untouched.
    const saved = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
    return { refund: saved[0], reused: false };
  }

  let evidence: RefundEvidence | null = null;
  let failureReason: string | null = null;
  try {
    const result = await provider.refund({
      externalRef: providerPaymentRef!,
      amount: requestedAmount.toFixed(4),
      currencyCode: order.currencyCode,
      idempotencyKey: idempotencyKey ?? refundId,
      reason: input.reason,
    });
    if (result.status === 'SUCCEEDED' && result.externalRef) {
      evidence = {
        source: 'PROVIDER_API',
        providerId: provider.id,
        externalRef: result.externalRef,
        amount: requestedAmount.toFixed(4),
        currencyCode: order.currencyCode,
      };
    } else {
      failureReason = `Provider '${provider.id}' did not confirm the reversal`;
    }
  } catch (err) {
    // A provider we could not reach is NOT a successful refund. The refund stays
    // pending rather than being marked completed or failed on a network error.
    failureReason = err instanceof Error ? err.message : 'Provider error during refund';
  }

  if (evidence) {
    await completeRefundWithEvidence(db, refundId, evidence, { actorId: input.actorId, ipAddress: input.ipAddress ?? null });
  } else {
    await db
      .update(refunds)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(refunds.id, refundId));
    await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
      action: 'REFUND.FAILED',
      entityType: 'ORDER',
      entityId: order.id,
      after: { refundId, provider: provider.id, reason: failureReason },
    });
  }

  const saved = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  return { refund: saved[0], reused: false };
}

export async function listOrderRefunds(
  db: DB,
  orderId: string,
  actorId: string,
  opts: { isOperator?: boolean } = {},
) {
  if (opts.isOperator) await loadOrder(db, orderId);
  else await assertOrderAccess(db, orderId, actorId);
  return db.select().from(refunds).where(eq(refunds.orderId, orderId));
}

/** One seller's slice of an order's refund picture (see `getOrderRefundAttribution`). */
export interface RefundAttributionSeller {
  sellerOrderId: string;
  sellerOrderNumber: string;
  sellerId: string;
  sellerType: string;
  /** Fulfilment state of the suborder — `REFUNDED` once it is fully refunded. */
  status: string;
  settlementStatus: string;
  /** What the buyer actually paid for this seller's lines: `items_total + buyer_commission`. */
  refundableCap: string;
  /** Sum of COMPLETED refund allocations attributed to this suborder. */
  refundedAmount: string;
  /** `refundableCap − refundedAmount`, floored at zero. */
  remainingAmount: string;
  /** The seller's own commission share recorded for this suborder at order time. */
  sellerCommission: string;
  /** How much of that commission a COMPLETED refund has already reversed in the ledger. */
  sellerCommissionReversed: string;
  /** True once the suborder's own attributed refunds reach its cap. */
  fullyRefunded: boolean;
  /** Per-line attribution, when a refund was attributed at line level. */
  lineItems: Array<{ orderItemId: string; refundedAmount: string }>;
  /** Each refund that touches this seller, with its own status and timestamps. */
  refunds: Array<{
    refundId: string;
    status: string;
    amount: string;
    /** True only for COMPLETED refunds — pending/failed refunds are not money back. */
    counted: boolean;
    reason: string | null;
    externalRef: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** The read-only, per-seller refund attribution view for one order. */
export interface OrderRefundAttribution {
  order: {
    id: string;
    orderNumber: string;
    currencyCode: string;
    status: string;
    paymentStatus: string;
    refundStatus: string;
    grandTotal: string;
    /** Parent-level sum of COMPLETED refunds. */
    refundedTotal: string;
    remainingTotal: string;
    fullyRefunded: boolean;
  };
  /** Every refund on the order, newest first, with its own status and references. */
  refunds: Array<{
    id: string;
    amount: string;
    currencyCode: string;
    status: string;
    reason: string | null;
    externalRef: string | null;
    requestedById: string | null;
    processedById: string | null;
    createdAt: string;
    updatedAt: string;
    /** The suborders this refund was attributed to (empty for a legacy refund). */
    allocatedTo: string[];
  }>;
  sellers: RefundAttributionSeller[];
  /** True when the order has no seller suborders (a legacy single-seller shape). */
  legacy: boolean;
}

/**
 * M2.4-T2.4 — the read-only, per-seller refund attribution view.
 *
 * Answers, for one order: which sellers exist, what each was owed, how much of
 * that a completed refund returned, whether the suborder is now `REFUNDED`, and
 * how much of each seller's commission a completed refund has reversed.
 *
 * Every number is read from the database — allocations, refund statuses, suborder
 * rows and the commission reversals already written in the ledger. Nothing is
 * recomputed as an accounting figure here: `refundedAmount` is the sum of
 * COMPLETED allocations, and `sellerCommissionReversed` is the sum of the ledger
 * reversal entries that point back at that seller's commission entry. Only
 * COMPLETED refunds count; a REQUESTED/PROCESSING/FAILED refund is shown with its
 * status but never added to the money returned.
 *
 * Read-only: it writes nothing and changes no order, refund or ledger state. It
 * reuses the same access rule as `listOrderRefunds` (an order party may read their
 * own order; PAYMENT_READ operators may read any).
 */
export async function getOrderRefundAttribution(
  db: DB,
  orderId: string,
  actorId: string,
  opts: { isOperator?: boolean } = {},
): Promise<OrderRefundAttribution> {
  const order = await loadOrder(db, orderId);
  if (!opts.isOperator) await assertOrderAccess(db, order.id, actorId);

  const [subs, refundRows, allocRows, txnRows] = await Promise.all([
    db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, order.id)),
    db.select().from(refunds).where(eq(refunds.orderId, order.id)).orderBy(desc(refunds.createdAt)),
    db.select().from(refundAllocations).where(eq(refundAllocations.parentOrderId, order.id)),
    db.select({ id: transactions.id }).from(transactions).where(eq(transactions.orderId, order.id)).limit(1),
  ]);

  const transactionId = txnRows[0]?.id ?? null;

  // Seller commission entries recorded at order time (one per seller suborder),
  // and the ledger reversals that reference them. A reversal row carries only
  // `{ reversalOf, refundId }`; its seller is recovered through the original
  // entry's `metadata.sellerOrderId`, which is exactly how the money was booked.
  const commissionBySub = new Map<string, { entryId: string; amount: string }>();
  const reversedByEntry = new Map<string, number>();
  if (transactionId) {
    const ledgerRows = await db
      .select({
        id: transactionLedger.id,
        entryType: transactionLedger.entryType,
        direction: transactionLedger.direction,
        amount: transactionLedger.amount,
        metadata: transactionLedger.metadata,
      })
      .from(transactionLedger)
      .where(eq(transactionLedger.transactionId, transactionId));

    for (const row of ledgerRows) {
      const meta = (row.metadata ?? {}) as { share?: string; sellerOrderId?: string; reversalOf?: string };
      if (
        row.entryType === 'COMMISSION' &&
        row.direction === 'DEBIT' &&
        meta.share === 'SELLER' &&
        meta.sellerOrderId
      ) {
        commissionBySub.set(meta.sellerOrderId, { entryId: row.id, amount: row.amount });
      }
      if (row.direction === 'CREDIT' && meta.reversalOf) {
        reversedByEntry.set(meta.reversalOf, (reversedByEntry.get(meta.reversalOf) ?? 0) + Number(row.amount));
      }
    }
  }

  const refundById = new Map(refundRows.map((r) => [r.id, r]));
  const allocationsBySub = new Map<string, typeof allocRows>();
  for (const alloc of allocRows) {
    const list = allocationsBySub.get(alloc.sellerOrderId) ?? [];
    list.push(alloc);
    allocationsBySub.set(alloc.sellerOrderId, list);
  }

  const sellers: RefundAttributionSeller[] = subs.map((sub) => {
    const cap = suborderRefundableCap(sub);
    const allocs = allocationsBySub.get(sub.id) ?? [];

    let refunded = toDecimal(0);
    const lineTotals = new Map<string, ReturnType<typeof toDecimal>>();
    const perRefund = new Map<string, ReturnType<typeof toDecimal>>();
    for (const alloc of allocs) {
      const refund = refundById.get(alloc.refundId);
      const amount = toDecimal(alloc.amount);
      if (alloc.orderItemId) {
        lineTotals.set(alloc.orderItemId, (lineTotals.get(alloc.orderItemId) ?? toDecimal(0)).plus(amount));
      }
      perRefund.set(alloc.refundId, (perRefund.get(alloc.refundId) ?? toDecimal(0)).plus(amount));
      // Only money that actually went back counts toward the refunded amount.
      if (refund?.status === 'COMPLETED') refunded = refunded.plus(amount);
    }

    const remaining = cap.minus(refunded);
    const commission = commissionBySub.get(sub.id);
    const reversed = commission ? reversedByEntry.get(commission.entryId) ?? 0 : 0;

    return {
      sellerOrderId: sub.id,
      sellerOrderNumber: sub.sellerOrderNumber,
      sellerId: sub.sellerId,
      sellerType: sub.sellerType,
      status: sub.status,
      settlementStatus: sub.settlementStatus,
      refundableCap: cap.toFixed(4),
      refundedAmount: refunded.toFixed(4),
      remainingAmount: (remaining.gt(0) ? remaining : toDecimal(0)).toFixed(4),
      sellerCommission: commission?.amount ?? '0.0000',
      sellerCommissionReversed: roundMoney(toDecimal(reversed)).toFixed(4),
      fullyRefunded: cap.gt(0) && refunded.gte(cap),
      lineItems: [...lineTotals.entries()].map(([orderItemId, amount]) => ({
        orderItemId,
        refundedAmount: amount.toFixed(4),
      })),
      refunds: [...perRefund.entries()]
        .map(([refundId, amount]) => {
          const refund = refundById.get(refundId)!;
          return {
            refundId,
            status: refund.status,
            amount: amount.toFixed(4),
            counted: refund.status === 'COMPLETED',
            reason: refund.reason,
            externalRef: refund.externalRef,
            createdAt: refund.createdAt.toISOString(),
            updatedAt: refund.updatedAt.toISOString(),
          };
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    };
  });

  const refundedTotal = refundRows
    .filter((r) => r.status === 'COMPLETED')
    .reduce((sum, r) => sum.plus(toDecimal(r.amount)), toDecimal(0));
  const grandTotal = toDecimal(order.grandTotal);
  const remainingTotal = grandTotal.minus(refundedTotal);

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      currencyCode: order.currencyCode,
      status: order.status,
      paymentStatus: order.paymentStatus,
      refundStatus: order.refundStatus,
      grandTotal: grandTotal.toFixed(4),
      refundedTotal: refundedTotal.toFixed(4),
      remainingTotal: (remainingTotal.gt(0) ? remainingTotal : toDecimal(0)).toFixed(4),
      fullyRefunded: grandTotal.gt(0) && refundedTotal.gte(grandTotal),
    },
    refunds: refundRows.map((r) => ({
      id: r.id,
      amount: r.amount,
      currencyCode: r.currencyCode,
      status: r.status,
      reason: r.reason,
      externalRef: r.externalRef,
      requestedById: r.requestedById,
      processedById: r.processedById,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      allocatedTo: allocRows.filter((a) => a.refundId === r.id).map((a) => a.sellerOrderId),
    })),
    sellers,
    legacy: subs.length === 0,
  };
}

export async function getOrderPayment(
  db: DB,
  orderId: string,
  actorId: string,
  opts: { isOperator?: boolean } = {},
) {
  if (opts.isOperator) await loadOrder(db, orderId);
  else await assertOrderAccess(db, orderId, actorId);
  const intent = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, orderId)).limit(1);
  const payment = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  return { intent: intent[0] ?? null, payment: payment[0] ?? null };
}

/** The result of a manual (offline-desk) payment completion. */
export interface ManualCompletionResult {
  orderId: string;
  intentId: string;
  externalRef: string;
  paymentReference: string;
  amount: string;
  currencyCode: string;
  /** True when the intent was already SUCCEEDED — the call was a no-op, not an error. */
  alreadyPaid: boolean;
}

/**
 * PS-02 — Manual payment completion (offline desk).
 *
 * Lets an operator record that an offline/manual payment was received, so the
 * intent/payment/order move to PAID through the *same* writer the webhook path
 * uses (`applyPaymentSucceeded`). It adds no new money rule of its own: it only
 * supplies the human-supplied reference and the guardrails the webhook path does
 * not need.
 *
 * Deliberately narrow, and every guard fails closed:
 *  - Refused unless this deployment is a demo (`demoPaymentMode()`), because a
 *    human attesting to money is not evidence and must never run on real money.
 *  - Refused unless the order's intent was created by the offline `manual`
 *    provider — this route can never confirm an intent belonging to a real rail.
 *  - A payment reference is mandatory; it is recorded on the audit entry as the
 *    operator's attestation, not as bank evidence.
 *
 * It never writes `SETTLED`, never creates a SETTLEMENT/Payout row, and never
 * touches a wallet — completion means "paid", not "settled".
 */
export async function completeManualPayment(
  db: DB,
  input: {
    orderId: string;
    paymentReference: string;
    actorId: string;
    ipAddress?: string | null;
  },
): Promise<ManualCompletionResult> {
  if (!demoPaymentMode()) {
    throw ApiError.serviceUnavailable(
      'Manual payment completion is available only in demo payment mode (DEMO_PAYMENT_MODE=true).',
    );
  }

  const paymentReference = input.paymentReference?.trim();
  if (!paymentReference) {
    throw ApiError.validation([
      {
        field: 'paymentReference',
        message: 'A payment reference is required to complete a manual payment',
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  const order = await loadOrder(db, input.orderId);
  const intentRows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, order.id))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) throw ApiError.notFound('Payment intent');
  if (!intent.externalRef) throw ApiError.conflict('Payment intent has no provider reference');

  // This route exists only for the offline desk. A real rail's intent must be
  // confirmed by that rail's own evidence (webhook / status recheck), never by a
  // human clicking a button.
  if (intent.provider !== 'manual') {
    throw ApiError.conflict(
      `Order intent was created by provider '${intent.provider}'; manual completion applies only to the offline 'manual' provider`,
    );
  }

  const alreadyPaid = intent.status === 'SUCCEEDED';

  // Reuse the single, trusted PAID writer. It is idempotent by externalRef, so a
  // replay is a no-op rather than a double side-effect.
  await applyPaymentSucceeded(db, intent.provider, intent.externalRef, input.ipAddress ?? null);

  // The audit entry carries the operator's identity and the reference they
  // attested to. A separate action name keeps a human completion distinguishable
  // from a provider-verified `PAYMENT.SUCCEEDED` in the trail.
  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'PAYMENT.MANUAL_COMPLETED',
    entityType: 'ORDER',
    entityId: order.id,
    before: { intentStatus: intent.status, paymentStatus: order.paymentStatus },
    after: {
      intentId: intent.id,
      provider: intent.provider,
      externalRef: intent.externalRef,
      paymentReference,
      amount: intent.amount,
      currencyCode: intent.currencyCode,
      alreadyPaid,
    },
  });

  return {
    orderId: order.id,
    intentId: intent.id,
    externalRef: intent.externalRef,
    paymentReference,
    amount: intent.amount,
    currencyCode: intent.currencyCode,
    alreadyPaid,
  };
}

/**
 * Whether manual payment completion is offered right now, and why not when it is
 * not. The admin desk reads this so the action is hidden/disabled rather than
 * offered and then refused by the server.
 */
export function manualCompletionAvailability(): { demoMode: boolean; provider: string } {
  return { demoMode: demoPaymentMode(), provider: new ManualPaymentProvider().id };
}

/**
 * Read-only view the manual-completion desk needs to decide whether an order is
 * eligible: the order's payment state, its intent's provider/status, and whether
 * the action is currently offered. Pure read — it writes nothing.
 */
export async function getManualPaymentView(db: DB, orderId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (order.length === 0) throw ApiError.notFound('Order');
  const intentRows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orderId, orderId))
    .limit(1);
  const intent = intentRows[0] ?? null;
  const paymentRows = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  const payment = paymentRows[0] ?? null;
  return {
    order: {
      id: order[0].id,
      orderNumber: order[0].orderNumber,
      paymentStatus: order[0].paymentStatus,
      settlementStatus: order[0].settlementStatus,
      grandTotal: order[0].grandTotal,
      currencyCode: order[0].currencyCode,
    },
    intent: intent
      ? { id: intent.id, provider: intent.provider, status: intent.status, externalRef: intent.externalRef }
      : null,
    payment: payment ? { id: payment.id, provider: payment.provider, status: payment.status } : null,
    demoMode: demoPaymentMode(),
    eligible:
      demoPaymentMode() &&
      intent !== null &&
      intent.provider === 'manual' &&
      intent.status !== 'SUCCEEDED',
  };
}
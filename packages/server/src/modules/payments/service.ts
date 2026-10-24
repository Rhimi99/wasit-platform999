import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import {
  orders,
  payments,
  refunds,
  transactionLedger,
  transactions,
} from '../../db/schema/commerce';
import { paymentIntents, paymentWebhookEvents } from '../../db/schema/payments_extras';
import { newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service.js';
import { resolvePaymentProvider } from '../../lib/payments/resolve';
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
  const isSeller = ownedIds.includes(order[0].sellerId);
  if (!isBuyer && !isSeller) throw ApiError.forbidden();
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
      await applyRefundSucceeded(db, effectiveRef, input.ipAddress ?? null);
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
 */
export async function listWebhookFailures(db: DB, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return db
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
    .where(sql`${paymentWebhookEvents.status} in ('FAILED','DEAD_LETTERED')`)
    .orderBy(desc(paymentWebhookEvents.createdAt))
    .limit(limit);
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
 * Reverses WASIT's COMMISSION and PAYMENT_FEE ledger entries proportionally to
 * the refunded share of the order.
 *
 * Idempotent by construction: the target reversal for each original entry is a
 * pure function of the *cumulative* refunded amount, and we only write the
 * delta still missing. Replaying a refund therefore writes nothing new, and a
 * full refund reverses exactly the original amount — never more.
 */
async function reverseCommissionAndFee(
  db: DB,
  input: {
    transactionId: string;
    currencyCode: string;
    refundId: string;
    /** Total refunded so far, including this refund. */
    cumulativeRefunded: ReturnType<typeof toDecimal>;
    paidAmount: ReturnType<typeof toDecimal>;
    providerId: string;
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

  const ratio = input.cumulativeRefunded.dividedBy(input.paidAmount);
  const rows: (typeof transactionLedger.$inferInsert)[] = [];

  for (const entry of original) {
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

async function applyRefundSucceeded(db: DB, externalRef: string, ipAddress: string | null) {
  const rows = await db.select().from(refunds).where(eq(refunds.externalRef, externalRef)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Refund');
  if (rows[0].status === 'COMPLETED') return;
  await db.update(refunds).set({ status: 'COMPLETED', updatedAt: new Date() }).where(eq(refunds.id, rows[0].id));
  await writeAudit(db, { actorId: null, ipAddress }, {
    action: 'REFUND.COMPLETED',
    entityType: 'ORDER',
    entityId: rows[0].orderId,
    after: { refundId: rows[0].id, amount: rows[0].amount },
  });
}

/**
 * Creates a full or partial refund against a paid order. Idempotent by
 * `idempotencyKey`, and guarded against over-refunding beyond the paid amount.
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
  const prior = await db
    .select({ total: sql<string>`coalesce(sum(${refunds.amount}),0)::text` })
    .from(refunds)
    .where(and(eq(refunds.orderId, order.id), sql`${refunds.status} in ('COMPLETED','PROCESSING','APPROVED')`));
  const alreadyRefunded = toDecimal(prior[0]?.total ?? 0);
  const remaining = paidAmount.minus(alreadyRefunded);

  const requested = input.amount ? roundMoney(input.amount) : remaining;
  if (requested.lte(0)) throw ApiError.validation([{ field: 'amount', message: 'Refund amount must be positive', code: 'VALIDATION_FAILED' }]);
  if (requested.gt(remaining)) {
    throw ApiError.validation([{ field: 'amount', message: `Refund exceeds remaining refundable amount ${remaining.toFixed(4)}`, code: 'VALIDATION_FAILED' }]);
  }

  const refundId = newId();
  await db.insert(refunds).values({
    id: refundId,
    paymentId: payment[0].id,
    orderId: order.id,
    amount: requested.toFixed(4),
    currencyCode: order.currencyCode,
    reason: input.reason ?? null,
    status: 'PROCESSING',
    requestedById: input.actorId,
    idempotencyKey,
  });

  let externalRef: string | null = null;
  let finalStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED';
  if (provider.isFunctional && provider.isAvailable() && payment[0].externalRef) {
    const result = await provider.refund({
      externalRef: payment[0].externalRef,
      amount: requested.toFixed(4),
      currencyCode: order.currencyCode,
      idempotencyKey: idempotencyKey ?? refundId,
      reason: input.reason,
    });
    externalRef = result.externalRef;
    finalStatus = result.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
  }

  await db
    .update(refunds)
    .set({ status: finalStatus, externalRef, updatedAt: new Date() })
    .where(eq(refunds.id, refundId));

  if (finalStatus === 'COMPLETED') {
    // A refund reverses value: recorded as a DEBIT so the revenue ledger's
    // (CREDIT − DEBIT) math correctly reduces net refunds.
    await db.insert(transactionLedger).values({
      id: newId(),
      transactionId: payment[0].transactionId,
      entryType: 'REFUND',
      direction: 'DEBIT',
      amount: requested.toFixed(4),
      currencyCode: order.currencyCode,
      payerId: 'wasit',
      beneficiaryId: order.buyerId,
      paymentProvider: provider.id,
      // PENDING until settlement evidence confirms the reversal actually moved;
      // this is independent of `refunds.status`, which tracks the refund itself.
      status: 'PENDING',
    } as never);

    const newRefundedTotal = alreadyRefunded.add(requested);

    await reverseCommissionAndFee(db, {
      transactionId: payment[0].transactionId,
      currencyCode: order.currencyCode,
      refundId,
      cumulativeRefunded: newRefundedTotal,
      paidAmount,
      providerId: provider.id,
    });

    const fullyRefunded = newRefundedTotal.gte(paidAmount);
    await db
      .update(orders)
      .set({
        refundStatus: fullyRefunded ? 'COMPLETED' : 'PROCESSING',
        paymentStatus: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        status: fullyRefunded ? ('REFUNDED' as never) : (order.status as never),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    // Keep the transaction's own payment state consistent with the order.
    await db
      .update(transactions)
      .set({ status: fullyRefunded ? ('REFUNDED' as never) : ('PARTIALLY_REFUNDED' as never), updatedAt: new Date() })
      .where(eq(transactions.id, payment[0].transactionId));

    await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
      action: 'REFUND.COMPLETED',
      entityType: 'ORDER',
      entityId: order.id,
      after: {
        refundId,
        amount: requested.toFixed(4),
        currencyCode: order.currencyCode,
        fullyRefunded,
        provider: provider.id,
      },
    });

    await createNotification(db, {
      userId: order.buyerId,
      type: 'REFUND_COMPLETED',
      title: 'Refund processed',
      body: `A refund of ${requested.toFixed(4)} ${order.currencyCode} was processed for order ${order.orderNumber}.`,
      data: { orderId: order.id, refundId },
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

/**
 * Operator completion of an offline/`manual` payment.
 *
 * A `manual` rail (bank transfer, cash, or an out-of-band wallet) has no signed
 * provider callback, so nothing would ever move the order past PENDING — every
 * offline transaction was stuck with no way out of the UI. This is the
 * "settlement desk" entry point: an operator who has confirmed the money arrived
 * out of band records that fact here.
 *
 * It is a privileged money-path action (`REFUND_MANAGE`, the same permission the
 * refund and webhook-replay paths already use). It is deliberately limited:
 *
 *  - only the offline `manual` rail qualifies — a real acquirer (Flouci,
 *    ClicToPay, open-checkout) must confirm through its signed webhook, never a
 *    human assertion;
 *  - the provider must actually be the active rail, and it must still be refused
 *    outside demo mode by `resolvePaymentProvider()`, so this can never fabricate
 *    a payment on a live stack;
 *  - a real intent with a real externalRef must exist (the operator cannot
 *    conjure a payment out of nothing).
 *
 * The state transition itself is delegated to `applyPaymentSucceeded`, so the
 * manual path and the webhook path can never diverge. Critically, that means
 * completion records the *payment* only: it does NOT write SETTLED and does NOT
 * move the ledger — settlement stays a separate, evidence-gated step.
 *
 * The whole operation runs in one transaction behind a `SELECT … FOR UPDATE` on
 * the order row. Without that lock the "is it still PENDING?" check and the
 * update are a check-then-act race: concurrent completions all read PENDING and
 * each applies the transition, writing duplicate PAYMENT.SUCCEEDED audit entries
 * (observed under load before the lock was added). The lock makes the second and
 * later callers see PAID and fail closed with 409.
 */
export async function completeManualPayment(
  db: DB,
  input: { orderId: string; actorId: string; ipAddress?: string | null },
) {
  return db.transaction(async (tx) => {
    // Serialise concurrent completions for the same order.
    const locked = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1)
      .for('update');
    if (locked.length === 0) throw ApiError.notFound('Order not found');
    const order = locked[0];

    if (order.paymentStatus === 'PAID') throw ApiError.conflict('Order is already paid');
    if (order.paymentStatus !== 'PENDING') {
      throw ApiError.conflict('Order has no payment in progress to complete');
    }

    const intentRows = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.orderId, input.orderId))
      .limit(1);
    const intent = intentRows[0];
    if (!intent) throw ApiError.notFound('Payment intent');
    if (intent.status === 'SUCCEEDED') throw ApiError.conflict('Payment intent is already succeeded');
    if (intent.status === 'FAILED') throw ApiError.conflict('Payment intent has failed and cannot be completed');
    if (!intent.externalRef) throw ApiError.conflict('Payment intent has no provider reference');

    // Only the offline rail has no callback to confirm it; a real acquirer must go
    // through its signed webhook.
    if (intent.provider !== 'manual') {
      throw ApiError.validation([
        {
          field: 'provider',
          message: `Provider '${intent.provider}' is confirmed by its signed webhook, not manually`,
          code: 'VALIDATION_FAILED',
        },
      ]);
    }

    // Refuses the manual harness outside demo mode (503) and confirms the intent's
    // provider is the rail this deployment is actually running.
    const provider = resolvePaymentProvider();
    if (provider.id !== intent.provider) {
      throw ApiError.serviceUnavailable(
        `The active payment provider is '${provider.id}', not '${intent.provider}'`,
      );
    }

    await applyPaymentSucceeded(tx as unknown as DB, intent.provider, intent.externalRef, input.ipAddress ?? null);

    // A separate, operator-attributed audit line on top of the PAYMENT.SUCCEEDED
    // entry `applyPaymentSucceeded` writes (which is attributed to the buyer), so
    // "who completed this offline payment" is answerable.
    await writeAudit(tx as unknown as DB, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
      action: 'PAYMENT.MANUAL_COMPLETE',
      entityType: 'ORDER',
      entityId: input.orderId,
      before: { paymentStatus: 'PENDING' },
      after: { paymentStatus: 'PAID', provider: intent.provider, intentId: intent.id, externalRef: intent.externalRef },
    });

    return { orderId: input.orderId, paymentStatus: 'PAID' as const, provider: intent.provider };
  });
}
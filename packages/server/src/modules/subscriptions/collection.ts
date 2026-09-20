import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { invoices, subscriptions } from '../../db/schema/subscriptions';
import { paymentIntents } from '../../db/schema/payments_extras';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { resolvePaymentProvider } from '../../lib/payments/resolve';
import type { PaymentMethod, PaymentProvider } from '../../lib/payments/port';
import type { InvoiceView } from './types';

const DAY_MS = 86_400_000;

/** A charge against a subscription invoice, created through the provider port. */
export interface InvoiceIntentResult {
  intentId: string;
  invoiceId: string;
  amount: string;
  currencyCode: string;
  provider: string;
  externalRef: string;
  status: string;
  checkoutUrl: string | null;
  reused: boolean;
}

export interface CollectResult {
  invoiceId: string;
  subscriptionId: string;
  amount: string;
  currencyCode: string;
  paidAt: string;
  subscriptionStatus: string;
  periodEnd: string;
}

function toInvoiceView(row: typeof invoices.$inferSelect): InvoiceView {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    invoiceNumber: row.invoiceNumber,
    amount: row.amount,
    currencyCode: row.currencyCode,
    status: row.status,
    externalRef: row.externalRef,
    dueAt: row.dueAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates a payment intent for a subscription invoice through the active
 * provider. This is the ONLY way a subscription charge is initiated: the invoice
 * is never marked paid directly by a caller, so every settlement has a provider
 * reference and can be reconciled.
 *
 * Idempotent by `idempotencyKey` (default `subinv_<invoiceId>`): replaying the
 * request returns the original intent rather than charging twice.
 */
export async function startInvoicePayment(
  db: DB,
  input: {
    invoiceId: string;
    actorId: string;
    /** True when the caller holds `subscription:manage` and may act on any invoice. */
    isOperator?: boolean;
    method?: PaymentMethod;
    idempotencyKey?: string;
    ipAddress?: string | null;
  },
  provider: PaymentProvider = resolvePaymentProvider(),
): Promise<InvoiceIntentResult> {
  const invoiceRows = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) throw ApiError.notFound('Invoice');

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, invoice.subscriptionId))
    .limit(1);
  const subscription = subRows[0];
  if (!subscription) throw ApiError.notFound('Subscription');
  if (!input.isOperator && subscription.userId !== input.actorId) {
    throw ApiError.forbidden('This subscription is not yours');
  }

  const idempotencyKey = input.idempotencyKey?.trim() || `subinv_${invoice.id}`;
  const existing = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing.length > 0) {
    return {
      intentId: existing[0].id,
      invoiceId: invoice.id,
      amount: existing[0].amount,
      currencyCode: existing[0].currencyCode,
      provider: existing[0].provider,
      externalRef: existing[0].externalRef ?? '',
      status: existing[0].status,
      checkoutUrl: null,
      reused: true,
    };
  }

  if (invoice.status !== 'PENDING') throw ApiError.conflict(`Invoice is already ${invoice.status}`);
  if (!provider.isFunctional || !provider.isAvailable()) {
    throw ApiError.serviceUnavailable('No payment provider is configured');
  }

  const method = input.method ?? { type: 'CARD' as const };
  const created = await provider.createIntent({
    // The intent is keyed by the invoice so providers that only carry an opaque
    // `reference` still round-trip a value WASIT can reconcile.
    orderId: `subinv_${invoice.id}`,
    amount: invoice.amount,
    currencyCode: invoice.currencyCode,
    idempotencyKey,
    description: `WASIT subscription invoice ${invoice.invoiceNumber}`,
    method,
  });

  const intentId = newId();
  await db.insert(paymentIntents).values({
    id: intentId,
    orderId: null,
    subscriptionId: subscription.id,
    transactionId: null,
    amount: invoice.amount,
    currencyCode: invoice.currencyCode,
    provider: provider.id,
    method: method.type,
    scheme: method.scheme ?? null,
    idempotencyKey,
    externalRef: created.externalRef,
    status: created.status === 'SUCCEEDED' ? 'SUCCEEDED' : created.status === 'FAILED' ? 'FAILED' : 'PENDING',
    metadata: (created.raw ?? null) as never,
  });

  await writeAudit(db, { actorId: input.actorId, ipAddress: input.ipAddress ?? null }, {
    action: 'SUBSCRIPTION.INVOICE_INTENT_CREATE',
    entityType: 'INVOICE',
    entityId: invoice.id,
    after: {
      intentId,
      provider: provider.id,
      externalRef: created.externalRef,
      amount: invoice.amount,
      currencyCode: invoice.currencyCode,
      idempotencyKey,
    },
  });

  return {
    intentId,
    invoiceId: invoice.id,
    amount: invoice.amount,
    currencyCode: invoice.currencyCode,
    provider: provider.id,
    externalRef: created.externalRef,
    status: created.status,
    checkoutUrl: created.checkoutUrl,
    reused: false,
  };
}

/**
 * Marks an invoice immediately paid through the active provider. Used by the
 * offline settlement desk (and the `manual` provider): the charge still goes
 * through the provider port, so a real acquirer is never bypassed and the
 * settlement always carries a provider reference.
 */
export async function collectInvoicePayment(
  db: DB,
  input: {
    invoiceId: string;
    actorId: string;
    isOperator?: boolean;
    method?: PaymentMethod;
    idempotencyKey?: string;
    ipAddress?: string | null;
  },
  provider: PaymentProvider = resolvePaymentProvider(),
): Promise<CollectResult> {
  // The state guard runs before the idempotency short-circuit: a collect request
  // against an already-paid invoice is a conflict, not a silent success.
  const existing = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (existing.length === 0) throw ApiError.notFound('Invoice');
  if (existing[0].status !== 'PENDING') throw ApiError.conflict(`Invoice is already ${existing[0].status}`);

  const intent = await startInvoicePayment(
    db,
    {
      invoiceId: input.invoiceId,
      actorId: input.actorId,
      isOperator: input.isOperator,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      ipAddress: input.ipAddress,
    },
    provider,
  );
  if (!intent.externalRef) throw ApiError.serviceUnavailable('Provider returned no reference for the charge');
  return applyInvoicePaymentSucceeded(db, intent.externalRef, provider.id, input.ipAddress ?? null);
}

/**
 * Settles a subscription invoice after the provider confirms payment. Idempotent:
 * the invoice only transitions from PENDING, so a replayed webhook cannot extend
 * a period twice. Invoked by the payment webhook when the intent targets an
 * invoice rather than an order.
 */
export async function applyInvoicePaymentSucceeded(
  db: DB,
  externalRef: string,
  providerId: string,
  ipAddress: string | null,
): Promise<CollectResult> {
  const intentRows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.externalRef, externalRef))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) throw ApiError.notFound('Payment intent');
  if (!intent.subscriptionId) throw ApiError.conflict('Payment intent is not a subscription charge');

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, intent.subscriptionId), eq(invoices.status, 'PENDING')))
    .limit(1);
  const invoice = invoiceRows[0];

  // The intent may already be SUCCEEDED (replay); fall back to the latest invoice
  // so the call is a no-op rather than an error.
  if (!invoice) {
    const anyInvoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, intent.subscriptionId))
      .orderBy(invoices.createdAt)
      .limit(1);
    if (anyInvoice.length === 0) throw ApiError.notFound('Invoice');
    if (intent.status === 'SUCCEEDED') {
      const sub = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, intent.subscriptionId))
        .limit(1);
      return {
        invoiceId: anyInvoice[0].id,
        subscriptionId: intent.subscriptionId,
        amount: anyInvoice[0].amount,
        currencyCode: anyInvoice[0].currencyCode,
        paidAt: (anyInvoice[0].paidAt ?? new Date()).toISOString(),
        subscriptionStatus: sub[0]?.status ?? 'ACTIVE',
        periodEnd: (sub[0]?.endsAt ?? new Date()).toISOString(),
      };
    }
    throw ApiError.conflict('No pending invoice to settle');
  }

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, invoice.subscriptionId))
    .limit(1);
  const subscription = subRows[0];
  if (!subscription) throw ApiError.notFound('Subscription');

  const now = new Date();

  await db
    .update(paymentIntents)
    .set({ status: 'SUCCEEDED', updatedAt: now })
    .where(eq(paymentIntents.id, intent.id));

  // The conditional update is the idempotency guard: a concurrent settlement of
  // the same invoice makes this a no-op instead of a double period extension.
  const paid = await db
    .update(invoices)
    .set({ status: 'PAID', paidAt: now, externalRef: externalRef })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.status, 'PENDING')))
    .returning({ id: invoices.id });
  if (paid.length === 0) throw ApiError.conflict('Invoice was already paid');

  // Extend from the current end (or now if it had lapsed), so paid-for time is
  // never lost when a renewal is collected late.
  const periodStart =
    subscription.endsAt && subscription.endsAt.getTime() > now.getTime() ? subscription.endsAt : now;
  const periodEnd = new Date(
    periodStart.getTime() + (subscription.billingCycle === 'YEARLY' ? 365 : 30) * DAY_MS,
  );
  await db
    .update(subscriptions)
    .set({ status: 'ACTIVE', endsAt: periodEnd, updatedAt: now })
    .where(eq(subscriptions.id, subscription.id));

  // Subscription revenue is recorded on the invoice row (PAID + paidAt +
  // externalRef) and is deliberately NOT written into `transactions`: that table
  // is order-scoped and feeds GMV, so mixing fee income into it would corrupt
  // the marketplace metrics.

  await writeAudit(db, { actorId: subscription.userId, ipAddress }, {
    action: 'SUBSCRIPTION.INVOICE_PAID',
    entityType: 'INVOICE',
    entityId: invoice.id,
    after: { status: 'PAID', periodEnd: periodEnd.toISOString() },
    metadata: {
      subscriptionId: subscription.id,
      amount: invoice.amount,
      currencyCode: invoice.currencyCode,
      provider: providerId,
      externalRef,
    },
  });

  return {
    invoiceId: invoice.id,
    subscriptionId: subscription.id,
    amount: invoice.amount,
    currencyCode: invoice.currencyCode,
    paidAt: now.toISOString(),
    subscriptionStatus: 'ACTIVE',
    periodEnd: periodEnd.toISOString(),
  };
}

/** Marks an invoice failed and moves the subscription to PAST_DUE (dunning). */
export async function applyInvoicePaymentFailed(
  db: DB,
  externalRef: string,
  ipAddress: string | null,
): Promise<{ invoiceId: string; subscriptionId: string }> {
  const intentRows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.externalRef, externalRef))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) throw ApiError.notFound('Payment intent');
  if (!intent.subscriptionId) throw ApiError.conflict('Payment intent is not a subscription charge');

  const now = new Date();
  await db
    .update(paymentIntents)
    .set({ status: 'FAILED', failureReason: 'provider_reported_failure', updatedAt: now })
    .where(eq(paymentIntents.id, intent.id));

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, intent.subscriptionId), eq(invoices.status, 'PENDING')))
    .limit(1);
  if (invoiceRows.length === 0) {
    return { invoiceId: '', subscriptionId: intent.subscriptionId };
  }
  const invoice = invoiceRows[0];
  await db
    .update(invoices)
    .set({ status: 'FAILED', externalRef })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.status, 'PENDING')));
  await db
    .update(subscriptions)
    .set({ status: 'PAST_DUE', updatedAt: now })
    .where(eq(subscriptions.id, intent.subscriptionId));

  await writeAudit(db, { actorId: null, ipAddress }, {
    action: 'SUBSCRIPTION.INVOICE_FAILED',
    entityType: 'INVOICE',
    entityId: invoice.id,
    after: { status: 'FAILED' },
    metadata: { subscriptionId: intent.subscriptionId, amount: invoice.amount, externalRef },
  });

  return { invoiceId: invoice.id, subscriptionId: intent.subscriptionId };
}

/** Admin lists all PENDING invoices, e.g. for a dunning queue. */
export async function listPendingInvoices(db: DB): Promise<InvoiceView[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.status, 'PENDING'))
    .orderBy(invoices.dueAt);
  return rows.map(toInvoiceView);
}

/**
 * Advances the subscription lifecycle for lapsed rows:
 *  - ACTIVE/TRIAL with autoRenew=false and a past `endsAt` -> EXPIRED;
 *  - PAST_DUE for more than `graceDays` past due -> EXPIRED (and autoRenew off).
 * Idempotent: it only touches rows still in the source status.
 */
export async function expireLapsedSubscriptions(
  db: DB,
  opts: { graceDays?: number } = {},
): Promise<{ expired: number; expiredIds: string[] }> {
  const graceDays = opts.graceDays ?? 14;
  const cutoff = new Date(Date.now() - graceDays * DAY_MS);
  const expiredIds: string[] = [];

  const lapsed = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        sql`${subscriptions.status} in ('ACTIVE','TRIAL')`,
        eq(subscriptions.autoRenew, false),
        sql`${subscriptions.endsAt} is not null and ${subscriptions.endsAt} < now()`,
      ),
    );
  for (const row of lapsed) {
    const updated = await db
      .update(subscriptions)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(and(eq(subscriptions.id, row.id), sql`${subscriptions.status} in ('ACTIVE','TRIAL')`))
      .returning({ id: subscriptions.id });
    if (updated.length > 0) expiredIds.push(row.id);
  }

  const pastDue = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, 'PAST_DUE'),
        sql`${subscriptions.updatedAt} < ${cutoff}`,
      ),
    );
  for (const row of pastDue) {
    const updated = await db
      .update(subscriptions)
      .set({ status: 'EXPIRED', autoRenew: false, updatedAt: new Date() })
      .where(and(eq(subscriptions.id, row.id), eq(subscriptions.status, 'PAST_DUE')))
      .returning({ id: subscriptions.id });
    if (updated.length > 0) expiredIds.push(row.id);
  }

  return { expired: expiredIds.length, expiredIds };
}

export { toInvoiceView };
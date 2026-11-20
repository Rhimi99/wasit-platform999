import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { requirePermission } from '../../middleware/auth';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { confirmSettlement, reconcileSellerSettlements } from '../settlements/service';
import { createPayout, getPayout } from '../payouts/service';
import { dispatchPayoutToProvider, syncPayoutFromProvider } from '../payouts/provider-service';
import { describePayoutProviders } from '../../lib/payments/payout-resolve';
import { importReconciliationFeed } from '../reconciliation/service';
import { recordReceipt } from '../reconciliation/receipt-service';
import {
  completeManualPayment,
  getManualPaymentView,
  manualCompletionAvailability,
} from '../payments/service';

/**
 * P3 — HTTP surface for the money-movement layers (settlement, payout,
 * reconciliation).
 *
 * These routes add NO new business rules: each one validates input, enforces the
 * existing permission, then calls the same service the platform already trusts.
 * The services remain the only writers of `SETTLED`, `COMPLETED` and receipt
 * rows, so exposing them over HTTP cannot bypass an invariant.
 *
 * Permission choice is deliberate: these are money-movement operations, so they
 * reuse `payment:read` / `commission:manage` rather than inventing new
 * permissions that no role currently holds.
 */

const settlementSchema = z.object({
  externalRef: z.string().min(1),
  amount: z.string().min(1),
  currencyCode: z.string().length(3),
  providerId: z.string().min(1),
  settlementRef: z.string().min(1),
  providerRef: z.string().nullish(),
  occurredAt: z.string().nullish(),
});

const payoutSchema = z.object({
  transactionId: z.string().min(1),
  providerId: z.string().min(1),
  // M2.2 — required when the order is settled per seller suborder; must be
  // omitted for a legacy order that has no suborders. Enforced in the service.
  sellerOrderId: z.string().min(1).nullish(),
  idempotencyKey: z.string().nullish(),
});

const dispatchSchema = z.object({
  beneficiaryRef: z.string().min(1),
  providerId: z.string().min(1).optional(),
});

const feedSchema = z.object({
  source: z.enum(['PROVIDER', 'BANK']),
  currencyCode: z.string().length(3),
  importKey: z.string().nullish(),
  providerId: z.string().nullish(),
  provider: z
    .array(
      z.object({
        reference: z.string().min(1),
        settlementRef: z.string().nullish(),
        payoutRef: z.string().nullish(),
        grossAmount: z.string().min(1),
        providerFee: z.string().min(1),
        netAmount: z.string().min(1),
        currencyCode: z.string().length(3),
        occurredAt: z.string().nullish(),
      }),
    )
    .default([]),
  bank: z
    .array(
      z.object({
        reference: z.string().min(1),
        settlementRef: z.string().nullish(),
        payoutRef: z.string().nullish(),
        amount: z.string().min(1),
        currencyCode: z.string().length(3),
        occurredAt: z.string().nullish(),
      }),
    )
    .default([]),
  ledger: z
    .array(
      z.object({
        reference: z.string().min(1),
        grossAmount: z.string().min(1),
        providerFee: z.string().min(1),
        netAmount: z.string().min(1),
        currencyCode: z.string().length(3),
        settled: z.boolean(),
      }),
    )
    .default([]),
});

const receiptSchema = z.object({
  transactionId: z.string().min(1),
  evidence: z.object({
    source: z.enum(['BANK_STATEMENT', 'ACQUIRER', 'PROVIDER']),
    reference: z.string().min(1),
    amount: z.string().min(1),
    currencyCode: z.string().length(3),
  }),
});

/** PS-02 — manual completion: an order plus the operator's payment reference. */
const manualCompletionSchema = z.object({
  orderId: z.string().min(1),
  paymentReference: z.string().min(1).max(200),
});

/** Parses an optional ISO timestamp into a Date, ignoring an unparseable value. */
function isoOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const financeRoutes = new Hono();

/**
 * Confirms settlement from provider evidence. Returns the service's own result
 * so the caller can see whether the settlement was applied or was a duplicate.
 */
financeRoutes.post(
  '/settlements/confirm',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  validateBody(settlementSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof settlementSchema>>(c);
    const ctx = getContext(c);
    const result = await confirmSettlement(ctx.db, {
      externalRef: body.externalRef,
      amount: body.amount,
      currencyCode: body.currencyCode,
      providerId: body.providerId,
      settlementRef: body.settlementRef,
      providerRef: body.providerRef ?? null,
      occurredAt: isoOrNull(body.occurredAt),
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Lists the configured payout rails and what each can prove. */
financeRoutes.get(
  '/payout-providers',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  (c) => c.json({ success: true, data: describePayoutProviders() }),
);

/**
 * M2.3 — admin re-processing of seller-suborder settlements.
 *
 * Settles every eligible suborder of one order (when `orderId` is given) or every
 * still-pending suborder (when it is omitted). Idempotent: an already-settled
 * suborder is reported as a duplicate, and a rejected one carries the reason
 * instead of failing the whole batch. Writes NO ledger entry — it only attributes
 * an existing parent SETTLEMENT to each seller.
 */
const reconcileSettlementsSchema = z.object({
  orderId: z.string().min(1).nullish(),
});

financeRoutes.post(
  '/settlements/suborders/reconcile',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(reconcileSettlementsSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof reconcileSettlementsSchema>>(c);
    const ctx = getContext(c);
    const results = await reconcileSellerSettlements(ctx.db, body.orderId ?? null, {
      actorId: ctx.user?.id ?? null,
      actorType: 'USER',
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: results });
  },
);

/** Creates the seller payout for a settled transaction. Amount is derived, never supplied. */
financeRoutes.post(
  '/payouts',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(payoutSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof payoutSchema>>(c);
    const ctx = getContext(c);
    const payout = await createPayout(ctx.db, {
      transactionId: body.transactionId,
      providerId: body.providerId,
      sellerOrderId: body.sellerOrderId ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: payout });
  },
);

financeRoutes.get(
  '/payouts/:id',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const payout = await getPayout(ctx.db, c.req.param('id')!);
    return c.json({ success: true, data: payout });
  },
);

/** Dispatches a CREATED payout to its rail. Can only reach PROCESSING. */
financeRoutes.post(
  '/payouts/:id/dispatch',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(dispatchSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof dispatchSchema>>(c);
    const ctx = getContext(c);
    const result = await dispatchPayoutToProvider(ctx.db, {
      payoutId: c.req.param('id')!,
      beneficiaryRef: body.beneficiaryRef,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/**
 * Re-checks a payout with the rail. Completion still requires the rail's
 * transfer reference and an exact amount/currency match, so this route cannot
 * force a payout to COMPLETED.
 */
financeRoutes.post(
  '/payouts/:id/sync',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  async (c) => {
    const ctx = getContext(c);
    const result = await syncPayoutFromProvider(ctx.db, {
      payoutId: c.req.param('id')!,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Imports a provider/bank reconciliation feed and returns the match report. */
financeRoutes.post(
  '/reconciliation/import',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(feedSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof feedSchema>>(c);
    const ctx = getContext(c);
    const result = await importReconciliationFeed(ctx.db, {
      source: body.source,
      currencyCode: body.currencyCode,
      importKey: body.importKey ?? null,
      providerId: body.providerId ?? null,
      provider: body.provider,
      bank: body.bank,
      ledger: body.ledger,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Records that WASIT's commission funds actually landed. */
financeRoutes.post(
  '/receipts',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(receiptSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof receiptSchema>>(c);
    const ctx = getContext(c);
    const result = await recordReceipt(ctx.db, {
      transactionId: body.transactionId,
      evidence: {
        source: body.evidence.source,
        reference: body.evidence.reference,
        amount: body.evidence.amount,
        currencyCode: body.evidence.currencyCode,
      },
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/**
 * PS-02 — Manual payment completion desk.
 *
 * Lets an operator record that an offline `manual` payment was received. The
 * write itself lives in the payments service (`completeManualPayment`), which
 * reuses the single trusted PAID writer and refuses everything outside demo mode
 * or belonging to another provider. These routes add no money rule: they
 * validate input, enforce the permission, then call that service.
 *
 * Permission choice mirrors the sibling money-movement routes: these are
 * money-movement acts, so they reuse `payment:read` / `commission:manage` rather
 * than inventing a permission no role holds. The `/api/admin` blanket guard
 * (ADMIN/SUPER_ADMIN) already sits in front, so no trading role — not even a
 * MERCHANT that holds `payment:read` — can reach them.
 */
financeRoutes.get(
  '/manual-completions/:orderId',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const view = await getManualPaymentView(ctx.db, c.req.param('orderId')!);
    return c.json({ success: true, data: view });
  },
);

/** Reports whether the manual-completion action is offered on this deployment. */
financeRoutes.get(
  '/manual-payment-availability',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  (c) => c.json({ success: true, data: manualCompletionAvailability() }),
);

financeRoutes.post(
  '/manual-completions',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(manualCompletionSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof manualCompletionSchema>>(c);
    const ctx = getContext(c);
    const result = await completeManualPayment(ctx.db, {
      orderId: body.orderId,
      paymentReference: body.paymentReference,
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

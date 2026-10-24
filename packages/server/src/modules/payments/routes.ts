import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS, userHasAnyRole } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { describePaymentProviders } from '../../lib/payments/resolve.js';
import { writeAudit } from '../../lib/audit.js';
import { parsePositiveIntParam } from '../../lib/query.js';
import {
  createPaymentIntent,
  createRefund,
  getOrderPayment,
  listOrderRefunds,
  handlePaymentWebhook,
  listWebhookFailures,
  replayDeadLetter,
  completeManualPayment,
} from './service.js';

const methodSchema = z.object({
  type: z.enum(['CARD', 'MOBILE_WALLET']),
  scheme: z.enum(['VISA', 'MASTERCARD', 'CIB', 'D17', 'FLOUCI_WALLET']).optional(),
});

const intentSchema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
  method: methodSchema.optional(),
});

const refundSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  reason: z.string().max(1000).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const paymentsRoutes = new Hono();

// Webhook endpoint: mounted on a sibling router in app.ts so it can run
// WITHOUT a session (the provider is the caller) while still being signature-verified.
export const paymentWebhookRoutes = new Hono();

paymentWebhookRoutes.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-wasit-signature') ?? c.req.header('stripe-signature');
  const ctx = getContext(c);
  const result = await handlePaymentWebhook(ctx.db, { rawBody, signature, ipAddress: ctx.ipAddress });
  return c.json({ success: true, data: result });
});

paymentsRoutes.use('*', requireAuth);

// Describes the configured providers and which payment methods are usable now.
// Read-only and credential-free; lets checkout render only working rails.
paymentsRoutes.get('/methods', async (c) => {
  return c.json({ success: true, data: describePaymentProviders() });
});

// Any authenticated party to the order (buyer or owning seller) may start payment.
paymentsRoutes.post('/orders/:orderId/intent', validateBody(intentSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof intentSchema>>(c);
  const ctx = getContext(c);
  const result = await createPaymentIntent(ctx.db, {
    orderId: c.req.param('orderId')!,
    idempotencyKey: body.idempotencyKey,
    method: body.method,
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
  });
  return c.json({ success: true, data: result }, 201 as never);
});

// Operator completion of an offline/`manual` payment. Only the offline rail
// qualifies (a real acquirer confirms via its signed webhook); the service
// refuses anything else. Same privileged permission as refunds/webhook replay.
paymentsRoutes.post(
  '/orders/:orderId/complete-manual',
  requirePermission(PERMISSIONS.REFUND_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const result = await completeManualPayment(ctx.db, {
      orderId: c.req.param('orderId')!,
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
    });
    return c.json({ success: true, data: result });
  },
);

// Read access is ownership-scoped inside the service (getOrderPayment /
// listOrderRefunds call assertOrderAccess): an order party may read its own
// payment, and PAYMENT_READ holders (operators) may read any. Gating these with
// PAYMENT_READ here would wrongly block the buyer/seller from their own order.
paymentsRoutes.get('/orders/:orderId', async (c) => {
  const ctx = getContext(c);
  const result = await getOrderPayment(ctx.db, c.req.param('orderId')!, ctx.user!.id, {
    isOperator: userHasAnyRole(ctx.user!.roles, PERMISSIONS.PAYMENT_READ),
  });
  return c.json({ success: true, data: result });
});

paymentsRoutes.get('/orders/:orderId/refunds', async (c) => {
  const ctx = getContext(c);
  const result = await listOrderRefunds(ctx.db, c.req.param('orderId')!, ctx.user!.id, {
    isOperator: userHasAnyRole(ctx.user!.roles, PERMISSIONS.PAYMENT_READ),
  });
  return c.json({ success: true, data: result });
});

// Refunds are a privileged operation (refund:manage), matching the RBAC matrix.
paymentsRoutes.post('/orders/:orderId/refunds', requirePermission(PERMISSIONS.REFUND_MANAGE), validateBody(refundSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof refundSchema>>(c);
  const ctx = getContext(c);
  const roles = ctx.user!.roles;
  const result = await createRefund(ctx.db, {
    orderId: c.req.param('orderId')!,
    amount: body.amount,
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
    actorId: ctx.user!.id,
    ipAddress: ctx.ipAddress,
    // Operators (support/risk/dispute/admin) may refund orders they are not party to.
    isOperator: userHasAnyRole(roles, PERMISSIONS.REFUND_MANAGE),
  });
  return c.json({ success: true, data: result }, 201 as never);
});

// Webhook failure surface. Failed and dead-lettered provider events must be
// visible so a stuck payment is an operator-observable incident, not silent.
paymentsRoutes.get('/webhook-failures', requirePermission(PERMISSIONS.REFUND_MANAGE), async (c) => {
  const ctx = getContext(c);
  const { limit } = c.req.query();
  const items = await listWebhookFailures(ctx.db, { limit: parsePositiveIntParam(limit) });
  return c.json({ success: true, data: { items } });
});

// Explicit operator replay of a dead-lettered event: resets the attempt counter
// so the next provider delivery is retried instead of refused as dead-lettered.
paymentsRoutes.post('/webhook-failures/:id/replay', requirePermission(PERMISSIONS.REFUND_MANAGE), async (c) => {
  const ctx = getContext(c);
  const result = await replayDeadLetter(ctx.db, c.req.param('id')!);
  if (!result.replayed) throw ApiError.notFound('Dead-lettered webhook event');
  await writeAudit(ctx.db, ctx, {
    action: 'PAYMENT.WEBHOOK_REPLAY',
    entityType: 'PAYMENT_WEBHOOK_EVENT',
    entityId: c.req.param('id')!,
  });
  return c.json({ success: true, data: result });
});
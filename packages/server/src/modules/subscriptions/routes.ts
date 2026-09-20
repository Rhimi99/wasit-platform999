import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { writeAudit } from '../../lib/audit';
import {
  listPlans,
  getMySubscription,
  subscribeToPlan,
  changeMyPlan,
  cancelMySubscription,
  listMyInvoices,
  setPlanActive,
  adminListPlans,
  adminListSubscriptions,
  adminListInvoices,
  rolloverDueSubscriptions,
} from './service';
import {
  collectInvoicePayment,
  startInvoicePayment,
  listPendingInvoices,
  expireLapsedSubscriptions,
} from './collection';

const subscribeSchema = z.object({
  planId: z.string().min(1),
  billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
});

const changePlanSchema = z.object({
  planId: z.string().min(1),
  billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
});

const planActiveSchema = z.object({
  isActive: z.boolean(),
});

const collectSchema = z.object({
  method: z
    .object({
      type: z.enum(['CARD', 'MOBILE_WALLET']),
      scheme: z.enum(['VISA', 'MASTERCARD', 'CIB', 'D17', 'FLOUCI_WALLET']).optional(),
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const PLAN_TARGETS = ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'GLOBAL'] as const;

export const subscriptionRoutes = new Hono();

subscriptionRoutes.get('/plans', requireAuth, async (c) => {
  const ctx = getContext(c);
  const target = c.req.query('target');
  if (target && !(PLAN_TARGETS as readonly string[]).includes(target)) {
    throw ApiError.validation([{ field: 'target', message: 'Invalid plan target', code: 'INVALID_ENUM' }]);
  }
  const items = await listPlans(ctx.db, target as (typeof PLAN_TARGETS)[number] | undefined);
  return c.json({ success: true, data: { items } });
});

subscriptionRoutes.get('/me', requireAuth, async (c) => {
  const ctx = getContext(c);
  const subscription = await getMySubscription(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { subscription } });
});

subscriptionRoutes.post(
  '/subscribe',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_CREATE),
  validateBody(subscribeSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof subscribeSchema>>(c);
    const subscription = await subscribeToPlan(ctx.db, ctx.user!.id, body.planId, body.billingCycle);
    await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'SUBSCRIPTION.SUBSCRIBED',
      entityType: 'SUBSCRIPTION',
      entityId: subscription.id,
      metadata: { planId: body.planId, billingCycle: body.billingCycle },
    });
    return c.json({ success: true, data: { subscription } });
  },
);

subscriptionRoutes.patch(
  '/me/plan',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_UPDATE),
  validateBody(changePlanSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof changePlanSchema>>(c);
    const subscription = await changeMyPlan(ctx.db, ctx.user!.id, body.planId, body.billingCycle);
    await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'SUBSCRIPTION.PLAN_CHANGED',
      entityType: 'SUBSCRIPTION',
      entityId: subscription.id,
      metadata: { planId: body.planId, billingCycle: body.billingCycle },
    });
    return c.json({ success: true, data: { subscription } });
  },
);

subscriptionRoutes.post(
  '/me/cancel',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_CANCEL),
  async (c) => {
    const ctx = getContext(c);
    const result = await cancelMySubscription(ctx.db, ctx.user!.id);
    await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'SUBSCRIPTION.CANCELLED',
      entityType: 'SUBSCRIPTION',
      entityId: null,
      metadata: result,
    });
    return c.json({ success: true, data: result });
  },
);

subscriptionRoutes.get(
  '/me/invoices',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_READ_OWN),
  async (c) => {
    const ctx = getContext(c);
    const items = await listMyInvoices(ctx.db, ctx.user!.id);
    return c.json({ success: true, data: { items } });
  },
);

subscriptionRoutes.patch(
  '/admin/plans/:id/active',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validateBody(planActiveSchema),
  async (c) => {
    const ctx = getContext(c);
    const id = c.req.param('id')!;
    const body = getValidatedBody<z.infer<typeof planActiveSchema>>(c);
    const plan = await setPlanActive(ctx.db, id, body.isActive);
    await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'SUBSCRIPTION.PLAN_ACTIVE_TOGGLED',
      entityType: 'SUBSCRIPTION_PLAN',
      entityId: plan.id,
      before: { isActive: !body.isActive },
      after: { isActive: body.isActive },
    });
    return c.json({ success: true, data: { plan } });
  },
);

subscriptionRoutes.get(
  '/admin/plans',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const items = await adminListPlans(ctx.db);
    return c.json({ success: true, data: { items } });
  },
);

subscriptionRoutes.get(
  '/admin/subscriptions',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const items = await adminListSubscriptions(ctx.db);
    return c.json({ success: true, data: { items } });
  },
);

subscriptionRoutes.get(
  '/admin/invoices',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const items = await adminListInvoices(ctx.db);
    return c.json({ success: true, data: { items } });
  },
);

/**
 * Runs the auto-renew rollover on demand (the scheduler calls the same service).
 * Idempotent: renewing an already-advanced row is an optimistic-lock miss, so
 * repeated calls plus concurrent workers never double-extend or double-invoice.
 */
subscriptionRoutes.post(
  '/admin/rollover',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const result = await rolloverDueSubscriptions(ctx.db);
    if (result.renewed > 0) {
      await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
        action: 'SUBSCRIPTION.ROLLOVER_RUN',
        entityType: 'SUBSCRIPTION',
        after: { renewed: result.renewed, skipped: result.skipped },
        metadata: { subscriptionIds: result.renewedIds },
      });
    }
    return c.json({ success: true, data: result });
  },
);

/** Lists PENDING invoices so an operator can work the dunning queue. */
subscriptionRoutes.get(
  '/admin/invoices/pending',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const items = await listPendingInvoices(ctx.db);
    return c.json({ success: true, data: { items } });
  },
);

/**
 * Starts payment for one of the caller's own subscription invoices through the
 * active payment provider, returning the checkout URL when the provider uses
 * hosted checkout. Ownership is enforced in the service. Idempotent by key.
 */
subscriptionRoutes.post(
  '/me/invoices/:id/pay',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_READ_OWN),
  validateBody(collectSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof collectSchema>>(c);
    const result = await startInvoicePayment(ctx.db, {
      invoiceId: c.req.param('id')!,
      actorId: ctx.user!.id,
      method: body.method,
      idempotencyKey: body.idempotencyKey,
      ipAddress: ctx.ipAddress,
    });
    return c.json({ success: true, data: result }, 201 as never);
  },
);

/**
 * Collects a subscription invoice through the active provider. This is the
 * offline/manual settlement desk path; the online path is the provider webhook,
 * which settles the same invoice via `applyInvoicePaymentSucceeded`. Both go
 * through the provider port, so a live acquirer is never bypassed. Idempotent:
 * only a PENDING invoice can be paid.
 */
subscriptionRoutes.post(
  '/admin/invoices/:id/collect',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validateBody(collectSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof collectSchema>>(c);
    const result = await collectInvoicePayment(ctx.db, {
      invoiceId: c.req.param('id')!,
      actorId: ctx.user!.id,
      isOperator: true,
      method: body.method,
      idempotencyKey: body.idempotencyKey,
      ipAddress: ctx.ipAddress,
    });
    return c.json({ success: true, data: result });
  },
);

/** Advances lapsed subscriptions to EXPIRED (cancelled-past-end, or PAST_DUE beyond grace). */
subscriptionRoutes.post(
  '/admin/expire-lapsed',
  requireAuth,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const result = await expireLapsedSubscriptions(ctx.db);
    if (result.expired > 0) {
      await writeAudit(ctx.db, { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
        action: 'SUBSCRIPTION.EXPIRE_LAPSED_RUN',
        entityType: 'SUBSCRIPTION',
        after: { expired: result.expired },
        metadata: { subscriptionIds: result.expiredIds },
      });
    }
    return c.json({ success: true, data: result });
  },
);
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import {
  subscriptionPlans,
  subscriptions,
  invoices,
  planTargetEnum,
  subscriptionStatusEnum,
} from '../../db/schema/subscriptions.js';
import { generateInvoiceNumber, newId } from '../../lib/ids';
import type {
  InvoiceView,
  MySubscriptionView,
  PlanTarget,
  SubscriptionPlanView,
  SubscriptionStatus,
} from './types';

function toDecimal(v: string | number | Decimal): Decimal {
  return new Decimal(v.toString());
}

function toPlanView(row: typeof subscriptionPlans.$inferSelect): SubscriptionPlanView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameAr: row.nameAr,
    nameFr: row.nameFr,
    planTarget: row.planTarget as PlanTarget,
    priceMonthly: row.priceMonthly.toString(),
    priceYearly: row.priceYearly.toString(),
    currencyCode: row.currencyCode,
    features: row.features as Record<string, unknown> | null,
    limits: row.limits as Record<string, unknown> | null,
    isActive: row.isActive,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
  };
}

function toMySubscriptionView(
  sub: typeof subscriptions.$inferSelect,
  plan: typeof subscriptionPlans.$inferSelect,
): MySubscriptionView {
  return {
    id: sub.id,
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    planNameAr: plan.nameAr,
    planNameFr: plan.nameFr,
    status: sub.status as SubscriptionStatus,
    billingCycle: sub.billingCycle,
    autoRenew: sub.autoRenew,
    startsAt: sub.startsAt?.toISOString() ?? null,
    endsAt: sub.endsAt?.toISOString() ?? null,
    cancelledAt: sub.cancelledAt?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
    updatedAt: sub.updatedAt.toISOString(),
  };
}

function toInvoiceView(row: typeof invoices.$inferSelect): InvoiceView {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    invoiceNumber: row.invoiceNumber,
    amount: row.amount.toString(),
    currencyCode: row.currencyCode,
    status: row.status,
    externalRef: row.externalRef,
    dueAt: row.dueAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listPlans(db: DB, target?: PlanTarget): Promise<SubscriptionPlanView[]> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.isActive, true),
        target ? eq(subscriptionPlans.planTarget, target) : undefined,
      ),
    )
    .orderBy(asc(subscriptionPlans.sortOrder));
  return rows.map(toPlanView);
}

export async function getMySubscription(db: DB, userId: string): Promise<MySubscriptionView | null> {
  const rows = await db
    .select({
      sub: subscriptions,
      plan: subscriptionPlans,
    })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.cancelledAt),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  return toMySubscriptionView(rows[0].sub, rows[0].plan);
}

export async function subscribeToPlan(
  db: DB,
  userId: string,
  planId: string,
  billingCycle: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
): Promise<MySubscriptionView>{
  const planRows = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true)))
    .limit(1);
  const plan = planRows[0];
  if (!plan) throw ApiError.notFound('Plan');

  const existing = await getMySubscription(db, userId);
  if (existing) return existing;

  const id = newId();
  const amount = billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;


  await db.insert(subscriptions).values({
    id,
    userId,
    planId: plan.id,
    status: 'ACTIVE',
    billingCycle,
    autoRenew: true,
    startsAt: new Date(),
  });

  await db.insert(invoices).values({
    id: newId(),
    subscriptionId: id,
    invoiceNumber: generateInvoiceNumber(),
    amount,
    currencyCode: plan.currencyCode,
    status: 'PENDING',
    dueAt: new Date(Date.now() + 3 * DAY_MS),
  });

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .limit(1);
  return toMySubscriptionView(subRows[0], plan);
}

export async function changeMyPlan(
  db: DB,
  userId: string,
  planId: string,
  billingCycle: 'MONTHLY' | 'YEARLY' = 'MONTHLY',
): Promise<MySubscriptionView>{
  const planRows = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true)))
    .limit(1);
  const plan = planRows[0];
  if (!plan) throw ApiError.notFound('Plan');

  const existing = await getMySubscription(db, userId);
  if (!existing) throw ApiError.notFound('Active subscription');

  const currentPlanRows = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, existing.planId))
    .limit(1);
  const currentPlan = currentPlanRows[0] ?? plan;

  const cycleKey = billingCycle === 'YEARLY' ? 'priceYearly' : 'priceMonthly' as const;
  const currentAmount = toDecimal(currentPlan[cycleKey] as string);
  const nextAmount = toDecimal(plan[cycleKey] as string);
  const delta = nextAmount.minus(currentAmount);


  await db
    .update(subscriptions)
    .set({
      planId: plan.id,
      billingCycle,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, existing.id));


  if (delta.greaterThan(0)) {
    await db.insert(invoices).values({
      id: newId(),
      subscriptionId: existing.id,
      invoiceNumber: generateInvoiceNumber(),
      amount: delta.toFixed(4),
      currencyCode: plan.currencyCode,
      status: 'PENDING',
      dueAt: new Date(Date.now() + 3 * DAY_MS),
    });
  }

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, existing.id))
    .limit(1);
  return toMySubscriptionView(subRows[0], plan);
}

export async function cancelMySubscription(db: DB, userId: string): Promise<{ cancelled: boolean }> {
  const existing = await getMySubscription(db, userId);
  if (!existing) throw ApiError.notFound('Active subscription');


  await db
    .update(subscriptions)
    .set({
      status: 'CANCELLED',
      autoRenew: false,
      cancelledAt: new Date(),
      endsAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, existing.id));

  return { cancelled: true };
}

export async function listMyInvoices(db: DB, userId: string): Promise<InvoiceView[]> {
  const rows = await db
    .select()
    .from(invoices)
    .innerJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(invoices.createdAt));
  return rows.map((r) => toInvoiceView(r.invoices));
}

export interface RolloverResult {
  /** Subscriptions extended by this run. */
  renewed: number;
  /** Rows another concurrent run had already moved (optimistic-lock miss). */
  skipped: number;
  /** Subscription ids renewed in this run (for audit). */
  renewedIds: string[];
}

/**
 * Extends every ACTIVE auto-renewing subscription whose period has ended and
 * issues the next PENDING invoice.
 *
 * Safe to invoke repeatedly and from multiple instances: the extension is a
 * conditional update on the exact `endsAt` that was read, so only one worker
 * can advance a given row (the rest miss the optimistic lock and skip), which
 * also guarantees a single invoice per period.
 */
export async function rolloverDueSubscriptions(db: DB): Promise<RolloverResult> {
  const due = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.autoRenew, true),
        eq(subscriptions.status, 'ACTIVE'),
        sql`${subscriptions.endsAt} IS NOT NULL AND ${subscriptions.endsAt} < now()`,
      ),
    );

  let renewed = 0;
  let skipped = 0;
  const renewedIds: string[] = [];

  for (const sub of due) {
    const planRows = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, sub.planId))
      .limit(1);
    const plan = planRows[0];
    if (!plan) continue;

    const amount = sub.billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
    const periodStart = sub.endsAt ?? new Date();
    const periodEnd = new Date(periodStart.getTime() + (sub.billingCycle === 'YEARLY' ? 365 : 30) * DAY_MS);

    const advanced = await db
      .update(subscriptions)
      .set({ startsAt: periodStart, endsAt: periodEnd, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, 'ACTIVE'),
          eq(subscriptions.endsAt, periodStart),
        ),
      )
      .returning({ id: subscriptions.id });

    if (advanced.length === 0) {
      skipped += 1;
      continue;
    }

    await db.insert(invoices).values({
      id: newId(),
      subscriptionId: sub.id,
      invoiceNumber: generateInvoiceNumber(),
      amount,
      currencyCode: plan.currencyCode,
      status: 'PENDING',
      dueAt: new Date(Date.now() + 3 * DAY_MS),
    });
    renewed += 1;
    renewedIds.push(sub.id);
  }

  return { renewed, skipped, renewedIds };
}

export async function setPlanActive(db: DB, planId: string, isActive: boolean): Promise<SubscriptionPlanView>{
  const rows = await db
    .update(subscriptionPlans)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(subscriptionPlans.id, planId))
    .returning();
  if (rows.length === 0) throw ApiError.notFound('Plan');
  return toPlanView(rows[0]);
}

export async function adminListPlans(db: DB): Promise<SubscriptionPlanView[]> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .orderBy(desc(subscriptionPlans.createdAt));
  return rows.map(toPlanView);
}

export async function adminListSubscriptions(db: DB): Promise<Array<{ id: string; userId: string; planCode: string; status: string; billingCycle: string; createdAt: string }>> {
  const rows = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      planCode: subscriptionPlans.code,
      status: subscriptions.status,
      billingCycle: subscriptions.billingCycle,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .orderBy(desc(subscriptions.createdAt))
     .limit(100);
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    planCode: r.planCode,
    status: r.status,
    billingCycle: r.billingCycle,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function adminListInvoices(db: DB): Promise<Array<{ id: string; subscriptionId: string; invoiceNumber: string; amount: string; status: string; createdAt: string }>> {
  const rows = await db
    .select()
    .from(invoices)
    .orderBy(desc(invoices.createdAt))
     .limit(100);
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscriptionId,
    invoiceNumber: r.invoiceNumber,
    amount: r.amount.toString(),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
}

export { planTargetEnum, subscriptionStatusEnum };
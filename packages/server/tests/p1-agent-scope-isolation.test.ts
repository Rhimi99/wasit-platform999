import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { suppliers } from '../src/db/schema/trade.js';
import { orders } from '../src/db/schema/commerce.js';
import { threads, messages, threadParticipants } from '../src/db/schema/messaging.js';
import { createAgentTask, decideAgentTask, executeDueTasks, getTask } from '../src/modules/ai/runner.js';
import { routeEvents } from '../src/modules/ai/copilot.js';
import type { UserRole } from '@wasit/shared';

const AUDIT = { actorId: 'scope-test' };

async function insertUser(roleName: UserRole) {
  const id = randomUUID();
  const email = `scope-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('ScopePass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

function insertedAdvice(task: { result: unknown }): Record<string, unknown> {
  return JSON.parse(String((task.result as { advice: string }).advice)) as Record<string, unknown>;
}

describe('P1 — agent data isolation and least privilege', () => {
  it('refuses a platform-analytics task for an unauthorised merchant, no data returned', async () => {
    const merchant = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant.id, { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {} }, AUDIT),
    ).rejects.toThrow();
  });

  it('refuses a sensitive work agent for a merchant (capability gate)', async () => {
    const merchant = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant.id, { agentKey: 'risk-agent', taskType: 'risk.scan', input: {} }, AUDIT),
    ).rejects.toThrow(/not allowed/i);
  });

  it('scopes customer-intelligence to the caller: another tenant\'s buyers are never returned', async () => {
    // Two independent merchant tenants, each with its own buyer and order.
    const tenantA = await insertUser('MERCHANT');
    const tenantB = await insertUser('MERCHANT');
    const buyerA = (await insertUser('CUSTOMER')).id;
    const buyerB = (await insertUser('CUSTOMER')).id;
    const sellerA = randomUUID();
    const sellerB = randomUUID();
    await db.insert(suppliers).values({ id: sellerA, userId: tenantA.id, companyName: 'A Co', slug: `a-${randomUUID()}` });
    await db.insert(suppliers).values({ id: sellerB, userId: tenantB.id, companyName: 'B Co', slug: `b-${randomUUID()}` });

    await db.insert(orders).values({
      id: randomUUID(), orderNumber: `SCOPE-A-${randomUUID().slice(0, 16)}`, buyerId: buyerA, buyerType: 'CUSTOMER',
      sellerId: sellerA, sellerType: 'SUPPLIER', currencyCode: 'TND', itemsTotal: '100.0000',
      commission: '2.0000', buyerCommission: '2.0000', paymentFee: '0', grandTotal: '100.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });
    await db.insert(orders).values({
      id: randomUUID(), orderNumber: `SCOPE-B-${randomUUID().slice(0, 16)}`, buyerId: buyerB, buyerType: 'CUSTOMER',
      sellerId: sellerB, sellerType: 'SUPPLIER', currencyCode: 'TND', itemsTotal: '999.0000',
      commission: '2.0000', buyerCommission: '2.0000', paymentFee: '0', grandTotal: '999.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });

    const task = await createAgentTask(
      db, ['MERCHANT'], tenantA.id,
      { agentKey: 'customer-intelligence-agent', taskType: 'customer.segment', input: {} }, AUDIT,
    );
    const advice = insertedAdvice(task);
    expect(advice.scope).toBe('own');
    // A sees only its own single buyer/order, never B's 999 order.
    expect((advice.segments as { totalBuyers: number }).totalBuyers).toBe(1);
  });

  it('scopes sales-agent to the caller: a foreign order id in the input cannot widen the read', async () => {
    const tenantA = await insertUser('MERCHANT');
    const tenantB = await insertUser('MERCHANT');
    const sellerA = randomUUID();
    const sellerB = randomUUID();
    await db.insert(suppliers).values({ id: sellerA, userId: tenantA.id, companyName: 'A Co', slug: `a-${randomUUID()}` });
    await db.insert(suppliers).values({ id: sellerB, userId: tenantB.id, companyName: 'B Co', slug: `b-${randomUUID()}` });
    const foreignOrderId = randomUUID();
    await db.insert(orders).values({
      id: foreignOrderId, orderNumber: `SCOPE-F-${randomUUID().slice(0, 16)}`, buyerId: randomUUID(), buyerType: 'CUSTOMER',
      sellerId: sellerB, sellerType: 'SUPPLIER', currencyCode: 'TND', itemsTotal: '777.0000',
      commission: '2.0000', buyerCommission: '2.0000', paymentFee: '0', grandTotal: '777.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });

    // Attempt to read B's order by passing its id (and other injection attempts).
    // sales-agent is approval-gated: approve then execute, as the admin desk does.
    const created = await createAgentTask(
      db, ['MERCHANT'], tenantA.id,
      { agentKey: 'sales-agent', taskType: 'sales.qualify_lead', input: { orderId: foreignOrderId, sellerId: sellerB, userId: tenantB.id } },
      AUDIT,
    );
    expect(created.status).toBe('awaiting_approval');
    await decideAgentTask(db, created.id, tenantA.id, 'APPROVE', null, AUDIT);
    await executeDueTasks(db, 50);
    const task = await getTask(db, created.id);
    const advice = insertedAdvice(task);
    expect(advice.scope).toBe('own');
    const ids = (advice.recentOrders as { id: string }[]).map((o) => o.id);
    expect(ids).not.toContain(foreignOrderId);
  });

  it('scopes support-agent to the caller\'s own threads', async () => {
    const userA = await insertUser('CUSTOMER');
    const userB = await insertUser('CUSTOMER');
    const threadA = randomUUID();
    const threadB = randomUUID();
    await db.insert(threads).values({ id: threadA, participantIds: [userA.id] as never, isBlocked: false });
    await db.insert(threads).values({ id: threadB, participantIds: [userB.id] as never, isBlocked: false });
    await db.insert(threadParticipants).values({ id: randomUUID(), threadId: threadA, userId: userA.id });
    await db.insert(threadParticipants).values({ id: randomUUID(), threadId: threadB, userId: userB.id });
    const secret = `SECRET-${randomUUID()}`;
    await db.insert(messages).values({ id: randomUUID(), threadId: threadB, senderId: userB.id, body: secret, status: 'SENT' });

    const task = await createAgentTask(
      db, ['CUSTOMER'], userA.id,
      { agentKey: 'support-agent', taskType: 'support.triage_ticket', input: {} }, AUDIT,
    );
    const advice = insertedAdvice(task);
    expect(advice.scope).toBe('own');
    const bodies = (advice.snapshot as { recentUnread: { body: string }[] }).recentUnread.map((m) => m.body);
    expect(bodies.join(' ')).not.toContain(secret);
  });

  it('direct call and Copilot delegation enforce the same RBAC (merchant cannot reach a sensitive agent)', async () => {
    const merchant = await insertUser('MERCHANT');
    // Directly:
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant.id, { agentKey: 'payment-settlement-agent', taskType: 'payment.monitor_settlement', input: {} }, AUDIT),
    ).rejects.toThrow();
    // Through the Copilot coordinator (same real roles):
    const run = await routeEvents(db, [{ event: 'order.paid' }], merchant.id, ['MERCHANT'], AUDIT);
    expect(run.routed.map((r) => r.agentKey)).not.toContain('payment-settlement-agent');
    expect(run.skipped.some((s) => s.reason.length > 0)).toBe(true);
  });

  it('a queued task is blocked at execution if the requester lost the permission after creation', async () => {
    // Create a task directly in `queued` (as the scheduler would), then run it
    // as a requester who holds no platform-analytics permission.
    const merchant = await insertUser('MERCHANT');
    const other = await insertUser('MERCHANT');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'analytics-agent',
      taskType: 'analytics.report',
      requestedBy: merchant.id,
      input: {} as never,
      status: 'queued',
      scheduledFor: new Date(Date.now() - 1000),
    });
    const res = await executeDueTasks(db, 50);
    void res;
    void other;
    const after = await getTask(db, id);
    expect(after.status).toBe('blocked');
    expect(JSON.stringify(after.error)).toMatch(/permission/i);
  });

  it('does not leak another tenant\'s private rows through the market-research agent', async () => {
    const tenantB = await insertUser('MERCHANT');
    const requester = await insertUser('COMPANY');
    const secret = `Hidden Co ${randomUUID()}`;
    await db.insert(suppliers).values({ id: randomUUID(), userId: tenantB.id, companyName: secret, slug: `hidden-${randomUUID()}`, isActive: true });
    const task = await createAgentTask(
      db, ['COMPANY'], requester.id,
      { agentKey: 'market-research-agent', taskType: 'research.scan_market', input: {} }, AUDIT,
    );
    expect(task.status).not.toBe('blocked');
    expect(JSON.stringify(task.result)).not.toContain(secret);
  });
});

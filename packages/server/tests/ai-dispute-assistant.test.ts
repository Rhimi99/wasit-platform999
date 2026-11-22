import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import {
  disputes,
  disputeMessages,
  disputeEvidence,
  disputeEvents,
} from '../src/db/schema/disputes.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { createAgentTask, decideAgentTask, getTask } from '../src/modules/ai/agents.js';
import type { UserRole } from '@wasit/shared';

/**
 * `dispute-assistant` end to end against PostgreSQL.
 *
 * The gap this closes: the agent claimed to summarise a dispute while never
 * reading one — it listed every open dispute, mixed the last five messages from
 * unrelated disputes into one blob and returned a fixed sentence as advice.
 * These tests pin the replacement: a summary of exactly the requested dispute,
 * a triage view that carries no conversation at all, and a boundary that keeps
 * non-staff out.
 */

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDisputeIds: string[] = [];

const MARKER_A = 'MARKER-A-ONLY-IN-DISPUTE-A';
const MARKER_B = 'MARKER-B-ONLY-IN-DISPUTE-B';

let buyerId = '';
let sellerId = '';
let admin1 = '';
let admin2 = '';
let customerId = '';
let disputeA = '';
let disputeB = '';

async function insertUser(roleName: UserRole, tag: string) {
  const id = randomUUID();
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email: `dsp-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`,
    passwordHash: await argon2.hash('DisputeAssistantPass123!'),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return id;
}

async function insertOrder(buyer: string, seller: string, number: string) {
  const id = randomUUID();
  createdOrderIds.push(id);
  await db.insert(orders).values({
    id,
    orderNumber: number,
    buyerId: buyer,
    sellerId: seller,
    currencyCode: 'TND',
    itemsTotal: '250.0000',
    commission: '10.0000',
    buyerCommission: '5.0000',
    paymentFee: '5.0000',
    grandTotal: '255.0000',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
  });
  return id;
}

async function insertDispute(orderId: string, openedBy: string, number: string, description: string) {
  const id = randomUUID();
  createdDisputeIds.push(id);
  await db.insert(disputes).values({
    id,
    disputeNumber: number,
    orderId,
    openedById: openedBy,
    reasonCode: 'NOT_DELIVERED',
    description,
    status: 'OPEN',
  });
  await db.insert(disputeEvents).values({
    id: randomUUID(),
    disputeId: id,
    actorId: openedBy,
    eventType: 'CREATED',
  });
  return id;
}

async function runTask(input: Record<string, unknown>, requester = admin1) {
  const task = await createAgentTask(
    db,
    ['ADMIN'],
    requester,
    { agentKey: 'dispute-assistant', requestedBy: requester, input },
    { actorId: requester, ipAddress: null, userAgent: null },
  );
  return task;
}

async function storedInput(taskId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ input: agentTasks.input }).from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  return (row?.input ?? {}) as Record<string, unknown>;
}

async function runAndApprove(input: Record<string, unknown>) {
  const created = await runTask(input);
  const decided = await decideAgentTask(db, created.id, admin2, 'APPROVE', null, {
    actorId: admin2,
    ipAddress: null,
    userAgent: null,
  });
  return decided;
}

beforeAll(async () => {
  buyerId = await insertUser('CUSTOMER', 'buyer');
  sellerId = await insertUser('MERCHANT', 'seller');
  admin1 = await insertUser('ADMIN', 'admin1');
  admin2 = await insertUser('ADMIN', 'admin2');
  customerId = await insertUser('CUSTOMER', 'other');

  const orderA = await insertOrder(buyerId, sellerId, `DSPA-${Date.now()}`);
  const orderB = await insertOrder(buyerId, sellerId, `DSPB-${Date.now()}`);

  disputeA = await insertDispute(
    orderA,
    buyerId,
    `D-${Date.now()}-A`,
    'المنتج لم يصلني رغم أن الطلب مدفوع ومؤكد منذ أسبوعين كاملين ولم أستلم أي إشعار شحن.',
  );
  disputeB = await insertDispute(
    orderB,
    buyerId,
    `D-${Date.now()}-B`,
    'نزاع آخر مختلف تمامًا عن الأول يتعلق بمنتج آخر وطلب آخر تمامًا لاختبار العزل بين النزاعات.',
  );

  await db.insert(disputeMessages).values([
    {
      id: randomUUID(),
      disputeId: disputeA,
      senderId: buyerId,
      body: `${MARKER_A} لم يصل الطلب`,
      isEvidence: false,
    },
    {
      id: randomUUID(),
      disputeId: disputeA,
      senderId: sellerId,
      body: 'الطلب خرج من المستودع',
      isEvidence: false,
    },
    {
      id: randomUUID(),
      disputeId: disputeB,
      senderId: buyerId,
      body: `${MARKER_B} تفاصيل النزاع الثاني`,
      isEvidence: false,
    },
  ]);

  await db.insert(disputeEvidence).values({
    id: randomUUID(),
    disputeId: disputeA,
    uploadedById: buyerId,
    fileRef: 'evidence/a-receipt.pdf',
    description: 'إثبات الدفع',
    contentType: 'application/pdf',
  });
});

afterAll(async () => {
  const userIds = sql`${agentTasks.requestedBy} in (select id from users where email like 'dsp-%@wasit.tn')`;
  await db.delete(agentTasks).where(userIds);
  await db.delete(auditLogs).where(sql`${auditLogs.actorId} in (select id from users where email like 'dsp-%@wasit.tn')`);
  if (createdDisputeIds.length > 0) {
    await db.delete(disputeMessages).where(inArray(disputeMessages.disputeId, createdDisputeIds));
    await db.delete(disputeEvidence).where(inArray(disputeEvidence.disputeId, createdDisputeIds));
    await db.delete(disputeEvents).where(inArray(disputeEvents.disputeId, createdDisputeIds));
    await db.delete(disputes).where(inArray(disputes.id, createdDisputeIds));
  }
  if (createdOrderIds.length > 0) await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  for (const id of createdUserIds) {
    await db.delete(userRoles).where(eq(userRoles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeDb();
});

describe('summary of one dispute', () => {
  it('starts behind the approval gate and completes only after a different admin approves', async () => {
    const created = await runTask({ disputeId: disputeA });
    expect(created.status).toBe('awaiting_approval');
    expect(created.approvedBy).toBeNull();

    const approved = await decideAgentTask(db, created.id, admin2, 'APPROVE', null, {
      actorId: admin2,
      ipAddress: null,
      userAgent: null,
    });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(admin2);
  });

  it('summarises the requested dispute, with its evidence, timeline and amount', async () => {
    const task = await runAndApprove({ disputeId: disputeA });
    const payload = JSON.parse((task.result as { advice: string }).advice);

    expect(payload.mode).toBe('summary');
    expect(payload.dispute.id).toBe(disputeA);
    expect(payload.order.grandTotal).toBe(255);
    expect(payload.order.currencyCode).toBe('TND');
    expect(payload.evidence.count).toBe(1);
    expect(payload.timeline.map((t: { type: string }) => t.type)).toContain('CREATED');
    expect(payload.conversation.messages).toBe(2);
    expect(payload.decisionAuthority).toBe('HUMAN');
    expect(payload.readOnly).toBe(true);
    expect(typeof payload.recommendation.action).toBe('string');
    expect(payload.recommendation.confidence).toBeLessThanOrEqual(0.85);
  });

  it('never mixes another dispute into the summary', async () => {
    const task = await runAndApprove({ disputeId: disputeA });
    const payload = JSON.parse((task.result as { advice: string }).advice);
    const serialised = JSON.stringify(payload);
    expect(serialised).toContain(MARKER_A);
    expect(serialised).not.toContain(MARKER_B);
    expect(serialised).not.toContain(disputeB);
  });

  it('takes deadlines and money effects from the policy snapshot stored on the task', async () => {
    const created = await runTask({ disputeId: disputeA });
    const stored = (await storedInput(created.id)).__disputePolicy as {
      rules: Record<string, unknown>;
      source: string;
    };
    expect(stored.source).toBe('GLOBAL');
    expect(stored.rules.responseWindowDays).toBe(7);

    const approved = await decideAgentTask(db, created.id, admin2, 'APPROVE', null, {
      actorId: admin2,
      ipAddress: null,
      userAgent: null,
    });
    const payload = JSON.parse((approved.result as { advice: string }).advice);
    expect(payload.policy.rules.evidenceDeadlineDays).toBe(14);
    const split = payload.resolutionPaths.find((p: { decision: string }) => p.decision === 'SPLIT');
    expect(split.available).toBe(false);
    expect(split.financialEffect).toBeNull();
  });

  it('ignores a caller-supplied policy snapshot (the server value wins)', async () => {
    const created = await runTask({
      disputeId: disputeA,
      __disputePolicy: { rules: { responseWindowDays: 999 }, source: 'COUNTRY', countryCode: 'ZZ' },
    });
    const stored = (await storedInput(created.id)).__disputePolicy as {
      rules: Record<string, unknown>;
      source: string;
    };
    expect(stored.rules.responseWindowDays).toBe(7);
    expect(stored.source).toBe('GLOBAL');
  });

  it('writes no dispute data while summarising', async () => {
    const before = await Promise.all([
      db.select({ v: sql<number>`count(*)::int` }).from(disputes),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeMessages),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeEvidence),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeEvents),
    ]);
    await runAndApprove({ disputeId: disputeA });
    const after = await Promise.all([
      db.select({ v: sql<number>`count(*)::int` }).from(disputes),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeMessages),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeEvidence),
      db.select({ v: sql<number>`count(*)::int` }).from(disputeEvents),
    ]);
    expect(after.map((r) => r[0]!.v)).toEqual(before.map((r) => r[0]!.v));
  });

  it('fails honestly for an unknown dispute instead of inventing a summary', async () => {
    const task = await runAndApprove({ disputeId: randomUUID() });
    expect(task.status).toBe('failed');
    expect(JSON.stringify(task.error)).toContain('Dispute not found');
    expect(task.result).toBeNull();
  });

  it('records the completion in the audit trail', async () => {
    const task = await runAndApprove({ disputeId: disputeA });
    const rows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'AGENT_TASK'), eq(auditLogs.entityId, task.id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('AI.AGENT_TASK_CREATED');
    expect(actions).toContain('AI.AGENT_TASK_APPROVED');
    expect(actions).toContain('AI.AGENT_TASK_COMPLETED');
  });
});

describe('triage of the open queue', () => {
  it('returns counts without any conversation content', async () => {
    const task = await runAndApprove({});
    const payload = JSON.parse((task.result as { advice: string }).advice);
    const serialised = JSON.stringify(payload);

    expect(payload.mode).toBe('triage');
    expect(payload.counts.open).toBeGreaterThanOrEqual(2);
    expect(payload.openDisputes.map((d: { id: string }) => d.id)).toContain(disputeA);
    expect(serialised).not.toContain(MARKER_A);
    expect(serialised).not.toContain(MARKER_B);
    expect(serialised).not.toContain('excerpt');
    expect(payload.readOnly).toBe(true);
  });
});

describe('access boundary', () => {
  it('refuses a customer before any task row is written', async () => {
    await expect(
      createAgentTask(
        db,
        ['CUSTOMER'],
        customerId,
        { agentKey: 'dispute-assistant', requestedBy: customerId, input: { disputeId: disputeA } },
        { actorId: customerId, ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow(/platform administrators/i);

    const rows = await db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.requestedBy, customerId));
    expect(rows).toHaveLength(0);
  });

  it('refuses a support agent as well (the agent reads platform-wide dispute data)', async () => {
    const supportId = await insertUser('SUPPORT', 'support');
    await expect(
      createAgentTask(
        db,
        ['SUPPORT'],
        supportId,
        { agentKey: 'dispute-assistant', requestedBy: supportId, input: {} },
        { actorId: supportId, ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow(/platform administrators/i);
  });

  it('keeps the requester from approving their own request', async () => {
    const created = await runTask({ disputeId: disputeA });
    await expect(
      decideAgentTask(db, created.id, admin1, 'APPROVE', null, {
        actorId: admin1,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/cannot approve your own/i);
    const still = await getTask(db, created.id);
    expect(still.status).toBe('awaiting_approval');
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders } from '../src/db/schema/commerce.js';
import { disputes, disputeEvents } from '../src/db/schema/disputes.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { notifications } from '../src/db/schema/messaging.js';
import { createDispute, assignDispute, getDisputeDetail } from '../src/modules/disputes/service.js';
import {
  assignmentCycleOf,
  disputeAssistDedupeKey,
  readDisputeAssistant,
  requestDisputeAssistant,
} from '../src/modules/disputes/assistant.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-03 — automatic `dispute-assistant` task on reviewer assignment.
 *
 * The contract pinned here:
 *  - opening records a request and creates nothing (no reviewer, no invented owner);
 *  - a qualified reviewer gets exactly one task, owned by them, per assignment cycle;
 *  - duplicate requests, retries and concurrent callers never add a second task;
 *  - an unqualified reviewer (SUPPORT) gets nothing, and the reason is audited;
 *  - reassignment supersedes the old task, and a stale task cannot execute;
 *  - a failure never blocks the dispute, and every stage is audited.
 */

const app = createApp();
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDisputeIds: string[] = [];
const PREFIX = 'afc08';

let buyerId = '';
let sellerId = '';
let admin1 = '';
let admin2 = '';
let supportId = '';
let disputeStaffId = '';

async function insertUser(roleName: UserRole, tag: string) {
  const id = randomUUID();
  const email = `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Afc08Pass123!'),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
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
    itemsTotal: '300.0000',
    commission: '12.0000',
    buyerCommission: '6.0000',
    paymentFee: '6.0000',
    grandTotal: '306.0000',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
  });
  return id;
}

/** Opens a dispute through the real service, so the open-path hook runs. */
async function openDispute(tag: string): Promise<{ disputeId: string; orderId: string }> {
  const orderId = await insertOrder(buyerId, sellerId, `AFC08-${tag}-${Date.now()}`);
  const created = await createDispute(
    db,
    buyerId,
    {
      orderId,
      reasonCode: 'NOT_DELIVERED',
      description: `AFC-08 ${tag}: الطلب لم يصل رغم تأكيد الدفع، وأطلب مراجعة النزاع من الفريق المختص.`,
    },
    { ipAddress: null, userAgent: null },
  );
  createdDisputeIds.push(created.id);
  return { disputeId: created.id, orderId };
}

async function tasksFor(disputeId: string) {
  return db
    .select()
    .from(agentTasks)
    .where(
      sql`${agentTasks.agentKey} = 'dispute-assistant'
          and ${agentTasks.input}->>'__disputeId' = ${disputeId}`,
    );
}

async function auditActions(entityId: string, actions: string[]) {
  const rows = await db
    .select({ action: auditLogs.action, metadata: auditLogs.metadata, after: auditLogs.after, actorType: auditLogs.actorType })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'DISPUTE'), eq(auditLogs.entityId, entityId), inArray(auditLogs.action, actions)));
  return rows;
}

beforeAll(async () => {
  buyerId = await insertUser('CUSTOMER', 'buyer');
  sellerId = await insertUser('MERCHANT', 'seller');
  admin1 = await insertUser('ADMIN', 'admin1');
  admin2 = await insertUser('SUPER_ADMIN', 'admin2');
  supportId = await insertUser('SUPPORT', 'support');
  disputeStaffId = await insertUser('DISPUTE', 'reviewer');
});

afterEach(() => {
  setAiExecutionEnabled(null);
});

afterAll(async () => {
  await db.delete(agentTasks).where(sql`${agentTasks.requestedBy} in (select id from users where email like '${sql.raw(PREFIX)}-%@wasit.tn')`);
  await db.delete(auditLogs).where(sql`${auditLogs.entityType} = 'DISPUTE' and ${auditLogs.entityId} in (select id from disputes where opened_by_id in (select id from users where email like '${sql.raw(PREFIX)}-%@wasit.tn'))`);
  await db.delete(auditLogs).where(sql`${auditLogs.actorId} in (select id from users where email like '${sql.raw(PREFIX)}-%@wasit.tn')`);
  if (createdDisputeIds.length > 0) {
    await db.delete(disputeEvents).where(inArray(disputeEvents.disputeId, createdDisputeIds));
    await db.delete(notifications).where(sql`${notifications.userId} in (select id from users where email like '${sql.raw(PREFIX)}-%@wasit.tn')`);
    await db.delete(disputes).where(inArray(disputes.id, createdDisputeIds));
  }
  if (createdOrderIds.length > 0) await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  for (const id of createdUserIds) {
    await db.delete(userRoles).where(eq(userRoles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeDb();
});

describe('AI-03 dispute assistant automation', () => {
  it('records a request on open and creates no task while no reviewer is assigned', async () => {
    const { disputeId } = await openDispute('open');

    expect(await tasksFor(disputeId)).toHaveLength(0);

    const requested = await auditActions(disputeId, ['DISPUTE.AI_ASSIST_REQUESTED']);
    expect(requested).toHaveLength(1);
    expect((requested[0].metadata as Record<string, unknown>).state).toBe('PENDING_NO_REVIEWER');
    expect((requested[0].metadata as Record<string, unknown>).trigger).toBe('DISPUTE_OPENED');

    const view = await readDisputeAssistant(db, disputeId);
    expect(view.state).toBe('PENDING_NO_REVIEWER');
    expect(view.task).toBeNull();
    expect(view.reviewer).toBeNull();
  });

  it('creates exactly one task owned by the qualified reviewer on assignment', async () => {
    const { disputeId } = await openDispute('assign');
    const result = await assignDispute(db, disputeId, admin2, admin1, { ipAddress: null, userAgent: null });

    expect(result.aiAssistant.state).toBe('TASK_CREATED');
    expect(result.aiAssistant.taskId).toBeTruthy();

    const rows = await tasksFor(disputeId);
    expect(rows).toHaveLength(1);
    const task = rows[0];
    expect(task.id).toBe(result.aiAssistant.taskId);
    expect(task.requestedBy).toBe(admin1);
    expect(task.status).toBe('awaiting_approval');
    expect(task.requiresApproval).toBe(true);
    expect(task.triggeredBy).toBe('dispute-assignment');

    const input = task.input as Record<string, unknown>;
    expect(input.disputeId).toBe(disputeId);
    expect(input.__disputeId).toBe(disputeId);
    expect(input.__disputeSource).toBe('ASSIGNMENT');
    expect(typeof input.__disputeCycle).toBe('string');
    expect(task.dedupeKey).toBe(disputeAssistDedupeKey(disputeId, String(input.__disputeCycle)));

    const [row] = await db.select({ assignedAt: disputes.assignedAt }).from(disputes).where(eq(disputes.id, disputeId)).limit(1);
    expect(input.__disputeCycle).toBe(assignmentCycleOf(admin1, row.assignedAt));

    const created = await auditActions(disputeId, ['DISPUTE.AI_ASSIST_TASK_CREATED']);
    expect(created).toHaveLength(1);
    expect((created[0].after as Record<string, unknown>).reviewerUserId).toBe(admin1);
    expect((created[0].metadata as Record<string, unknown>).trigger).toBe('REVIEWER_ASSIGNED');
  });

  it('does not duplicate the task for repeated or concurrent requests in the same cycle', async () => {
    const { disputeId } = await openDispute('duplicate');
    await assignDispute(db, disputeId, admin2, admin1);

    const again = await requestDisputeAssistant(db, { disputeId, trigger: 'REVIEWER_ASSIGNED', actorId: admin2 });
    expect(again.state).toBe('TASK_EXISTS');

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => requestDisputeAssistant(db, { disputeId, trigger: 'MANUAL_RETRY', actorId: admin2 })),
    );
    expect(concurrent.every((r) => r.state === 'TASK_EXISTS' || r.state === 'TASK_CREATED')).toBe(true);

    const rows = await tasksFor(disputeId);
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'awaiting_approval')).toHaveLength(1);
  });

  it('creates nothing for a reviewer who cannot run the agent, and audits why', async () => {
    const { disputeId } = await openDispute('support');
    const result = await assignDispute(db, disputeId, admin2, supportId);

    expect(result.aiAssistant.state).toBe('PENDING_REVIEWER_NOT_QUALIFIED');
    expect(result.aiAssistant.reason).toBe('REVIEWER_NOT_PLATFORM_SCOPE');
    expect(await tasksFor(disputeId)).toHaveLength(0);

    const blocked = await auditActions(disputeId, ['DISPUTE.AI_ASSIST_BLOCKED']);
    expect(blocked).toHaveLength(1);
    expect((blocked[0].metadata as Record<string, unknown>).reviewerUserId).toBe(supportId);
  });

  it('keeps a dispute assignable when the assistant cannot be created, and creates it on retry', async () => {
    const { disputeId } = await openDispute('failure');

    setAiExecutionEnabled(false);
    const failed = await assignDispute(db, disputeId, admin2, admin1);
    expect(failed.id).toBe(disputeId);
    expect(failed.aiAssistant.state).toBe('TASK_FAILED');
    expect(await tasksFor(disputeId)).toHaveLength(0);

    const detail = await getDisputeDetail(db, admin2, disputeId);
    expect(detail.assignedToId).toBe(admin1);

    const failedAudit = await auditActions(disputeId, ['DISPUTE.AI_ASSIST_FAILED']);
    expect(failedAudit).toHaveLength(1);

    setAiExecutionEnabled(true);
    const retried = await requestDisputeAssistant(db, { disputeId, trigger: 'MANUAL_RETRY', actorId: admin2 });
    expect(retried.state).toBe('TASK_CREATED');
    expect(await tasksFor(disputeId)).toHaveLength(1);

    const noop = await requestDisputeAssistant(db, { disputeId, trigger: 'MANUAL_RETRY', actorId: admin2 });
    expect(noop.state).toBe('TASK_EXISTS');
    expect(await tasksFor(disputeId)).toHaveLength(1);
  });

  it('supersedes the previous cycle on reassignment and starts a new one', async () => {
    const { disputeId } = await openDispute('reassign');
    const first = await assignDispute(db, disputeId, admin2, admin1);
    expect(first.aiAssistant.state).toBe('TASK_CREATED');

    const second = await assignDispute(db, disputeId, admin2, admin2);
    expect(second.aiAssistant.state).toBe('TASK_CREATED');
    expect(second.aiAssistant.taskId).not.toBe(first.aiAssistant.taskId);

    const rows = await tasksFor(disputeId);
    expect(rows).toHaveLength(2);
    const oldTask = rows.find((r) => r.id === first.aiAssistant.taskId)!;
    const newTask = rows.find((r) => r.id === second.aiAssistant.taskId)!;
    expect(oldTask.status).toBe('rejected');
    expect(oldTask.rejectionReason).toContain('Superseded');
    expect(newTask.status).toBe('awaiting_approval');
    expect(newTask.requestedBy).toBe(admin2);

    const superseded = await auditActions(disputeId, ['DISPUTE.AI_ASSIST_SUPERSEDED']);
    expect(superseded).toHaveLength(1);
    expect((superseded[0].metadata as Record<string, unknown>).taskIds).toContain(first.aiAssistant.taskId);

    const view = await readDisputeAssistant(db, disputeId);
    expect(view.state).toBe('TASK_EXISTS');
    expect(view.task?.id).toBe(second.aiAssistant.taskId);
    expect(view.supersededTaskCount).toBe(1);
  });

  it('refuses to execute a task whose reviewer no longer holds the assignment', async () => {
    const { disputeId } = await openDispute('stale');
    const created = await assignDispute(db, disputeId, admin2, admin1);
    expect(created.aiAssistant.state).toBe('TASK_CREATED');

    // Reassignment that bypasses the service (as a concurrent writer would): the
    // old task stays awaiting_approval and must still refuse to run.
    await db
      .update(disputes)
      .set({ assignedToId: admin2, assignedAt: new Date(), updatedAt: new Date() })
      .where(eq(disputes.id, disputeId));

    const decided = await decideAgentTask(db, created.aiAssistant.taskId!, admin2, 'APPROVE', null, {
      actorId: admin2,
      ipAddress: null,
      userAgent: null,
    });
    expect(decided.status).toBe('failed');
    expect(JSON.stringify(decided.error)).toContain('no longer assigned');

    const rows = await tasksFor(disputeId);
    expect(rows.find((r) => r.id === created.aiAssistant.taskId)?.status).toBe('failed');
  });

  it('keeps two disputes isolated: one task each, one summary each', async () => {
    const a = await openDispute('iso-a');
    const b = await openDispute('iso-b');
    await assignDispute(db, a.disputeId, admin2, admin1);
    await assignDispute(db, b.disputeId, admin2, admin1);

    const rowsA = await tasksFor(a.disputeId);
    const rowsB = await tasksFor(b.disputeId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].id).not.toBe(rowsB[0].id);

    for (const taskId of [rowsA[0].id, rowsB[0].id]) {
      await decideAgentTask(db, taskId, admin2, 'APPROVE', null, { actorId: admin2, ipAddress: null, userAgent: null });
    }

    const viewA = await readDisputeAssistant(db, a.disputeId);
    const viewB = await readDisputeAssistant(db, b.disputeId);
    expect(viewA.task?.summary?.disputeNumber).toBeTruthy();
    expect(viewB.task?.summary?.disputeNumber).toBeTruthy();
    expect(viewA.task?.summary?.disputeNumber).not.toBe(viewB.task?.summary?.disputeNumber);
    expect(viewA.task?.summary?.recommendation?.action).toBeTruthy();
  });

  it('stops requesting assistance for a case that is already closed', async () => {
    const { disputeId } = await openDispute('closed');
    await db.update(disputes).set({ status: 'CLOSED', updatedAt: new Date() }).where(eq(disputes.id, disputeId));

    const result = await requestDisputeAssistant(db, { disputeId, trigger: 'MANUAL_RETRY', actorId: admin2 });
    expect(result.state).toBe('CLOSED_CASE');
    expect(await tasksFor(disputeId)).toHaveLength(0);

    const view = await readDisputeAssistant(db, disputeId);
    expect(view.state).toBe('CLOSED_CASE');
  });
});

describe('AI-03 boundary', () => {
  function client() {
    let cookie = '';
    return {
      async req(path: string, options: { method?: string; body?: unknown } = {}) {
        const headers: Record<string, string> = { Origin: 'http://localhost:5173' };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        const res = await app.request(path, {
          method: options.method ?? 'GET',
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie;
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        return { status: res.status, data: data as any };
      },
    };
  }

  async function login(email: string) {
    const c = client();
    const res = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'Afc08Pass123!', allowUnverifiedEmail: true } });
    expect(res.status, `login ${email}`).toBe(200);
    return c;
  }

  async function emailOf(userId: string) {
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row.email;
  }

  it('refuses the assistant view and retry to anyone who is not a platform administrator', async () => {
    const { disputeId } = await openDispute('rbac');
    const buyer = await login(await emailOf(buyerId));
    const support = await login(await emailOf(supportId));
    const reviewer = await login(await emailOf(disputeStaffId));

    for (const c of [buyer, support, reviewer]) {
      const read = await c.req(`/api/admin/disputes/${disputeId}/assistant`);
      expect(read.status).toBe(403);
      const retry = await c.req(`/api/admin/disputes/${disputeId}/assistant/retry`, { method: 'POST' });
      expect(retry.status).toBe(403);
    }

    const admin = await login(await emailOf(admin2));
    const ok = await admin.req(`/api/admin/disputes/${disputeId}/assistant`);
    expect(ok.status).toBe(200);
    expect(ok.data.data.state).toBe('PENDING_NO_REVIEWER');

    const retryNoReviewer = await admin.req(`/api/admin/disputes/${disputeId}/assistant/retry`, { method: 'POST' });
    expect(retryNoReviewer.status).toBe(200);
    expect(retryNoReviewer.data.data.state).toBe('PENDING_NO_REVIEWER');
    expect(await tasksFor(disputeId)).toHaveLength(0);
  });

  it('never takes the owner or the assignment link from the client', async () => {
    const admin = await login(await emailOf(admin1));
    const { disputeId } = await openDispute('forge');

    const res = await admin.req('/api/ai/agents/dispute-assistant/tasks', {
      method: 'POST',
      body: {
        input: {
          disputeId,
          requestedBy: admin2,
          __disputeSource: 'ASSIGNMENT',
          __disputeCycle: 'forged-cycle',
          __disputeId: 'forged-dispute',
        },
      },
    });
    expect(res.status).toBe(201);
    const taskId = res.data.data.id as string;

    const [row] = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
    expect(row.requestedBy).toBe(admin1);
    const input = row.input as Record<string, unknown>;
    expect(input.__disputeSource).toBeUndefined();
    expect(input.__disputeCycle).toBeUndefined();
    expect(input.__disputeId).toBeUndefined();
    expect(row.dedupeKey).toBeNull();
    expect(row.triggeredBy).toBe('user');
  });

  it('does not let a manual request satisfy the automation for another dispute', async () => {
    const admin = await login(await emailOf(admin1));
    const a = await openDispute('manual-a');
    const b = await openDispute('manual-b');

    const res = await admin.req('/api/ai/agents/dispute-assistant/tasks', {
      method: 'POST',
      body: { input: { disputeId: a.disputeId } },
    });
    expect(res.status).toBe(201);

    // The manual task carries no assignment link, so the automation for A still
    // has no task for A's cycle and creates its own when a reviewer is assigned.
    const assigned = await assignDispute(db, a.disputeId, admin2, admin1);
    expect(assigned.aiAssistant.state).toBe('TASK_CREATED');
    expect(assigned.aiAssistant.taskId).not.toBe(res.data.data.id);

    // Two rows mention dispute A (the manual request and the linked task), but
    // only the linked one is counted as the automation's task for A.
    const linked = await tasksFor(a.disputeId);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(assigned.aiAssistant.taskId);
    expect(await tasksFor(b.disputeId)).toHaveLength(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentSchedules } from '../src/db/schema/agents.js';
import { orders } from '../src/db/schema/commerce.js';
import {
  createAgentTask,
  executeDueTasks,
  getTask,
  runTask,
  setAgentStatus,
  syncAgentRegistry,
  SYSTEM_PRINCIPAL,
} from '../src/modules/ai/runner.js';
import { dispatchDueSchedules, ensureSchedules } from '../src/modules/ai/copilot.js';
import type { UserRole } from '@wasit/shared';

const AUDIT = { actorId: 'scheduler-fix-test' };

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];
const createdScheduleIds: string[] = [];

async function insertUser(roleName: UserRole) {
  const id = randomUUID();
  const email = `sched-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('SchedPass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

const adviceOf = (t: { result: unknown }) =>
  JSON.parse(String((t.result as { advice: string }).advice)) as Record<string, unknown>;

const track = (id: string) => { createdTaskIds.push(id); return id; };

beforeAll(async () => {
  // Registry rows must exist so the capability/scope checks can resolve agents.
  await syncAgentRegistry(db);
  await ensureSchedules(db);
});

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdScheduleIds.length) await db.delete(agentSchedules).where(inArray(agentSchedules.id, createdScheduleIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('Scheduler fix — trusted system analytics without weakening security', () => {
  it('runs the platform analytics report successfully for the authorised trusted schedule', async () => {
    const buyer = await insertUser('CUSTOMER');
    await db.insert(orders).values({
      id: randomUUID(), orderNumber: `SCHED-${randomUUID().slice(0, 16)}`, buyerId: buyer.id, buyerType: 'CUSTOMER',
      sellerId: randomUUID(), sellerType: 'SUPPLIER', currencyCode: 'TND', itemsTotal: '250.0000',
      commission: '2.0000', buyerCommission: '2.0000', paymentFee: '0', grandTotal: '250.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });

    const task = await createAgentTask(
      db, ['SUPER_ADMIN'], SYSTEM_PRINCIPAL,
      { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {}, triggeredBy: 'schedule:review-test' }, AUDIT,
    );
    track(task.id);
    await executeDueTasks(db, 50);
    const done = await getTask(db, task.id);

    expect(done.status).toBe('succeeded');
    const advice = adviceOf(done);
    expect(advice.scope).toBe('platform');
    expect((advice.snapshot as { orders: number }).orders).toBeGreaterThanOrEqual(1);
  });

  it('refuses a platform analytics task for CUSTOMER, MERCHANT, SUPPLIER and COMPANY', async () => {
    for (const roleName of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY'] as UserRole[]) {
      const u = await insertUser(roleName);
      await expect(
        createAgentTask(db, [roleName], u.id, { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {} }, AUDIT),
      ).rejects.toThrow();
    }
  });

  it('refuses a forged task that merely claims the system identity (no scheduler provenance)', async () => {
    // Inserted directly, bypassing createAgentTask, with the bare `system` id but
    // no `schedule:` provenance — exactly what a tampering actor would attempt.
    const forgedId = randomUUID();
    await db.insert(agentTasks).values({
      id: forgedId, agentKey: 'analytics-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'analytics.report', input: {} as never, status: 'queued', triggeredBy: 'user',
    });
    track(forgedId);

    await executeDueTasks(db, 50);
    const done = await getTask(db, forgedId);

    // Blocked by the execution-time permission/scope gate — never platform data.
    expect(done.status).toBe('blocked');
    expect(done.result).toBeNull();
  });

  it('the full scheduler cycle dispatches the trusted analytics schedule and it succeeds', async () => {
    await db.update(agentSchedules).set({ enabled: true, nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(agentSchedules.agentKey, 'analytics-agent'));

    const { dispatched } = await dispatchDueSchedules(db, AUDIT);
    expect(dispatched).toBeGreaterThanOrEqual(1);
    await executeDueTasks(db, 50);

    const scheduled = (await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, SYSTEM_PRINCIPAL)))
      .filter((t) => t.agentKey === 'analytics-agent' && t.triggeredBy.startsWith('schedule:'));
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
    const mostRecent = scheduled[scheduled.length - 1]!;
    track(mostRecent.id);
    expect(mostRecent.status).toBe('succeeded');
    expect(adviceOf(mostRecent).scope).toBe('platform');
  });

  it('does not record a refused result as success', async () => {
    // A scheduler-provenance task for an own-scope agent has no tenant to anchor
    // to, so the executor refuses (NO_SCOPE). The runner must persist that as a
    // failure with a clear reason — never as `succeeded`.
    const scheduleId = randomUUID();
    await db.insert(agentSchedules).values({
      id: scheduleId, agentKey: 'support-agent', taskType: 'support.triage_ticket',
      intervalSeconds: 86400, payload: {} as never, enabled: true, nextRunAt: new Date(),
    });
    createdScheduleIds.push(scheduleId);

    const task = await createAgentTask(
      db, ['SUPER_ADMIN'], SYSTEM_PRINCIPAL,
      { agentKey: 'support-agent', taskType: 'support.triage_ticket', input: {}, triggeredBy: `schedule:${scheduleId}` }, AUDIT,
    );
    track(task.id);
    await executeDueTasks(db, 50);
    const done = await getTask(db, task.id);

    expect(done.status).not.toBe('succeeded');
    expect(done.status).toBe('failed');
    const err = done.error as { code?: string; refused?: boolean } | null;
    expect(err?.refused).toBe(true);
    expect(err?.code).toBe('NO_SCOPE');
    // The refused payload is kept for forensics while the task itself is a failure.
    expect(adviceOf(done).status).toBe('refused');
  });

  it('keeps the kill switch effective: a paused agent blocks a trusted scheduled run', async () => {
    // Pause BEFORE enqueueing so the scheduler's own dispatch cannot run it.
    await setAgentStatus(db, 'analytics-agent', 'PAUSED', 'test kill switch', AUDIT);
    try {
      const task = await createAgentTask(
        db, ['SUPER_ADMIN'], SYSTEM_PRINCIPAL,
        { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {}, triggeredBy: 'schedule:kill-switch-test' }, AUDIT,
      );
      track(task.id);
      const done = await runTask(db, task.id, AUDIT);
      expect(done.status).toBe('blocked');
      expect(String((done.error as { message?: string })?.message ?? '')).toContain('paused');
    } finally {
      await setAgentStatus(db, 'analytics-agent', 'ACTIVE', 'test cleanup', AUDIT);
    }
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { agentSchedules } from '../src/db/schema/agent_schedules.js';
import { aiBudgets, aiRequests } from '../src/db/schema/ai.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import {
  createAgentSchedule,
  claimDueSchedule,
  runDueAgentSchedules,
  reclaimExpiredLeases,
  getAgentSchedule,
  MIN_SCHEDULE_INTERVAL_MINUTES,
} from '../src/modules/ai/scheduling.js';

/**
 * AI-01 — scheduled agent execution.
 *
 * These tests exercise the real subsystem against the real database: the atomic
 * lease claim (including a genuine two-worker race), budget refusal, the
 * approval-gate fail-closed rule, and SYSTEM audit attribution. Nothing is
 * mocked — the value of a scheduler is exactly in the behaviour that a mock
 * would hide.
 */

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

/** Inserts a user with a role and returns the id (no HTTP login needed). */
async function insertUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER'): Promise<string> {
  const id = randomUUID();
  const email = `ai01-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Ai01Pass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return id;
}

async function login(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `ai01-http-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Ai01Pass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const client = makeClient();
  const res = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'Ai01Pass123!', allowUnverifiedEmail: true },
  });
  expect(res.status).toBe(200);
  return { client, id };
}

const createdScheduleIds: string[] = [];
const createdUserIds: string[] = [];

async function makeSchedule(
  createdBy: string,
  agentKey: string,
  intervalMinutes = MIN_SCHEDULE_INTERVAL_MINUTES,
  input: Record<string, unknown> = { action: 'analyze' },
) {
  const row = await createAgentSchedule(db, createdBy, { agentKey, input, intervalMinutes, isActive: true }, {});
  createdScheduleIds.push(row.id);
  return row;
}

/** Forces a schedule due immediately, bypassing the normal next-run wait. */
async function makeDue(scheduleId: string): Promise<void> {
  await db.update(agentSchedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(agentSchedules.id, scheduleId));
}

afterAll(async () => {
  // Ownership-scoped teardown: removes the schedules, tasks and AI requests
  // caused by this spec's own users — including the request the scheduler
  // creates during an end-to-end run, which is not tracked by id. Rows owned by
  // other specs (or pre-existing data) are never touched.
  await cleanupOwnedRows(db, { userIds: createdUserIds, scheduleIds: createdScheduleIds });
});

describe('AI-01 — agent scheduling (real DB)', () => {
  it('creates a schedule with the next run one interval in the future and audits it', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const before = Date.now();
    const row = await makeSchedule(admin, 'marketing-agent', 30);
    expect(row.intervalMinutes).toBe(30);
    expect(row.isActive).toBe(true);
    expect(row.createdBy).toBe(admin);
    expect(row.nextRunAt.getTime()).toBeGreaterThan(before + 29 * 60_000);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_SCHEDULE_CREATED'), eq(auditLogs.entityId, row.id)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorType).toBe('USER');
    expect(audit[0].actorId).toBe(admin);
  });

  it('rejects an interval below the safe minimum (422)', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    await expect(
      createAgentSchedule(db, admin, { agentKey: 'marketing-agent', input: {}, intervalMinutes: 5, isActive: true }, {}),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses to schedule an approval-gated agent (fail-closed)', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    // sales-agent requires human approval.
    await expect(
      createAgentSchedule(db, admin, { agentKey: 'sales-agent', input: {}, intervalMinutes: 30, isActive: true }, {}),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a schedule whose agent permissions exceed the creator role', async () => {
    // A user with no role holds no permissions, so an agent requiring `ai:use`
    // must be refused (fail-closed). This is the same guard that stops a
    // lower-privileged role from scheduling a capability it does not have.
    const roleless = randomUUID();
    const email = `ai01-roleless-${Date.now()}@wasit.tn`;
    await db.insert(users).values({
      id: roleless,
      email,
      passwordHash: await argon2.hash('Ai01Pass123!'),
      firstName: 'NoRole',
      isActive: true,
      emailVerified: true,
    });
    createdUserIds.push(roleless);
    await expect(
      createAgentSchedule(db, roleless, { agentKey: 'marketing-agent', input: {}, intervalMinutes: 30, isActive: true }, {}),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('claims a due schedule atomically: exactly one of two concurrent workers wins', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);
    await makeDue(row.id);

    const [a, b] = await Promise.all([
      claimDueSchedule(db, 'worker-a', 60),
      claimDueSchedule(db, 'worker-b', 60),
    ]);
    const winners = [a, b].filter((r) => r?.id === row.id);
    expect(winners.length).toBe(1);
    const claimed = winners[0]!;
    expect(['worker-a', 'worker-b']).toContain(claimed.leaseOwner);
    expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not claim a schedule that is not yet due', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);
    // nextRunAt is in the future; nothing else is due for this id.
    const claimed = await claimDueSchedule(db, 'worker-x', 60);
    expect(claimed?.id).not.toBe(row.id);
  });

  it('advances nextRunAt on claim so a claimed schedule is not re-claimed immediately', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);
    await makeDue(row.id);
    const first = await claimDueSchedule(db, 'worker-1', 60);
    expect(first?.id).toBe(row.id);
    const second = await claimDueSchedule(db, 'worker-2', 60);
    expect(second?.id).not.toBe(row.id);
  });

  it('runs a due schedule end to end and records a SYSTEM-attributed audit trail', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES, { action: 'recommend_campaign' });
    await makeDue(row.id);

    const result = await runDueAgentSchedules(db, 'sweeper-test', { leaseSeconds: 60 });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.created).toBeGreaterThanOrEqual(1);

    const refreshed = await getAgentSchedule(db, row.id);
    expect(refreshed?.lastTaskId).toBeTruthy();
    // Lease released after the run.
    expect(refreshed?.leaseOwner).toBeNull();

    const task = await db.select().from(agentTasks).where(eq(agentTasks.id, refreshed!.lastTaskId!)).limit(1);
    expect(task.length).toBe(1);
    // Accountability: the task belongs to the human who created the schedule.
    expect(task[0].requestedBy).toBe(admin);
    expect(task[0].agentKey).toBe('marketing-agent');

    const scheduledAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_SCHEDULED'), eq(auditLogs.entityId, task[0].id)));
    expect(scheduledAudit.length).toBe(1);
    // The execution is attributed to SYSTEM, not to the creator's id.
    expect(scheduledAudit[0].actorType).toBe('SYSTEM');
    expect(scheduledAudit[0].actorId).toBeNull();
    expect((scheduledAudit[0].metadata as Record<string, unknown>).scheduleId).toBe(row.id);
  });

  it('blocks a run when the creator budget is exhausted and audits the refusal', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({
      id: budgetId,
      userId: admin,
      period: 'MONTHLY',
      maxRequests: 1,
      isActive: true,
      currencyCode: 'USD',
    });
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);
    await makeDue(row.id);

    // Exhaust the request budget with a real recorded request row.
    const requestId = randomUUID();
    await db.insert(aiRequests).values({
      id: requestId,
      userId: admin,
      requestType: 'CHAT',
      model: 'local-heuristic',
      tokensInput: 1,
      tokensOutput: 1,
      cost: '0',
      currencyCode: 'USD',
      status: 'SUCCESS',
    });

    const result = await runDueAgentSchedules(db, 'sweeper-budget', { leaseSeconds: 60 });
    expect(result.budgetBlocked).toBeGreaterThanOrEqual(1);

    const blocked = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_BUDGET_EXCEEDED'), eq(auditLogs.entityId, row.id)));
    expect(blocked.length).toBe(1);
    expect(blocked[0].actorType).toBe('SYSTEM');

    const refreshed = await getAgentSchedule(db, row.id);
    expect(refreshed?.lastTaskId).toBeNull();
    await db.delete(aiBudgets).where(eq(aiBudgets.id, budgetId));
  });

  it('an unexpired lease blocks a claim; an expired lease is reclaimable', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);

    // (1) A live lease (not yet expired) must block any other worker, even
    // though the schedule is due.
    await db
      .update(agentSchedules)
      .set({
        leaseOwner: 'busy-worker',
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
        nextRunAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(agentSchedules.id, row.id));
    const blocked = await claimDueSchedule(db, 'other-worker', 60);
    expect(blocked?.id).not.toBe(row.id);

    // (2) An expired lease (crashed worker) must be reclaimable.
    await db
      .update(agentSchedules)
      .set({ leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(agentSchedules.id, row.id));
    const reclaimed = await claimDueSchedule(db, 'alive-worker', 60);
    expect(reclaimed?.id).toBe(row.id);
    expect(reclaimed?.leaseOwner).toBe('alive-worker');
  });

  it('reclaimExpiredLeases frees schedules stranded by a crashed worker', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    createdUserIds.push(admin);
    const row = await makeSchedule(admin, 'marketing-agent', MIN_SCHEDULE_INTERVAL_MINUTES);
    await db
      .update(agentSchedules)
      .set({ leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(agentSchedules.id, row.id));

    const count = await reclaimExpiredLeases(db);
    expect(count).toBeGreaterThanOrEqual(1);
    const after = await getAgentSchedule(db, row.id);
    expect(after?.leaseOwner).toBeNull();
    expect(after?.leaseExpiresAt).toBeNull();
  });

  it('exposes the schedule lifecycle over the admin API with RBAC', async () => {
    const admin = await login('SUPER_ADMIN');
    createdUserIds.push(admin.id);

    const created = await admin.client.req('/api/admin/ai/agent-schedules', {
      method: 'POST',
      body: { agentKey: 'marketing-agent', intervalMinutes: 60, input: { action: 'recommend_campaign' } },
    });
    expect(created.status).toBe(201);
    const id = created.data.data.id as string;
    createdScheduleIds.push(id);

    const listed = await admin.client.req('/api/admin/ai/agent-schedules');
    expect(listed.status).toBe(200);
    expect((listed.data.data.items as Array<{ id: string }>).some((s) => s.id === id)).toBe(true);

    const patched = await admin.client.req(`/api/admin/ai/agent-schedules/${id}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.data.isActive).toBe(false);

    const deleted = await admin.client.req(`/api/admin/ai/agent-schedules/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await getAgentSchedule(db, id)).toBeNull();

    // A CUSTOMER cannot reach the admin schedule surface.
    const customer = await login('CUSTOMER');
    createdUserIds.push(customer.id);
    const forbidden = await customer.client.req('/api/admin/ai/agent-schedules', {
      method: 'POST',
      body: { agentKey: 'marketing-agent', intervalMinutes: 60 },
    });
    expect(forbidden.status).toBe(403);
  });
});

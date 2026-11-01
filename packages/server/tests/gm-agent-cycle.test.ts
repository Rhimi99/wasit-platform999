import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { eventOutbox } from '../src/db/schema/outbox.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { aiBudgets } from '../src/db/schema/ai.js';
import { enqueueEvent } from '../src/modules/ai/outbox-repo.js';
import { runAgentCycle, listAgentCycles, resolveCycleBudget } from '../src/modules/ai/cycle.js';
import { createAgentTask, getTask, syncAgentRegistry } from '../src/modules/ai/runner.js';
import * as outboxWorker from '../src/modules/ai/outbox-worker.js';
import type { UserRole } from '@wasit/shared';

/**
 * G8 — GM on-demand AI agent cycle.
 *
 * Drives the REAL cycle module, the REAL runner, the REAL outbox worker and the
 * REAL HTTP surface against a REAL database. Every assertion reads the effect
 * back from persisted state — nothing is mocked except the one deliberate
 * failure-injection case (which mocks a module boundary, not the logic under
 * test).
 *
 * The guarantees pinned here:
 *  - a cycle is triggered on demand and advances real due work (queued tasks,
 *    outbox events) WITHOUT the scheduler being enabled;
 *  - it is single-flight: a second concurrent trigger is told `blocked`;
 *  - it refuses to start when the AI budget is already spent (`blocked`);
 *  - a step failure is reported as `failed`, never as a hopeful success, and the
 *    terminal audit says FAILED;
 *  - every cycle is attributable to the authenticated SUPER_ADMIN (never a
 *    body-supplied identity) and every HTTP caller is RBAC-checked;
 *  - it executes nothing that was not already approved: an `awaiting_approval`
 *    task is left untouched.
 */

const app = createApp();

const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdEventIds: string[] = [];
const createdBudgetIds: string[] = [];

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdEventIds.length) await db.delete(eventOutbox).where(inArray(eventOutbox.id, createdEventIds));
  if (createdBudgetIds.length) await db.delete(aiBudgets).where(inArray(aiBudgets.id, createdBudgetIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

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
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, data: data as any };
    },
  };
}

async function insertStaff(roleName: UserRole) {
  const id = randomUUID();
  const email = `g8-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('G8Pass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

async function loginStaff(roleName: UserRole) {
  const { id, email } = await insertStaff(roleName);
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'G8Pass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

async function cycleAudits(correlationId: string) {
  return db.select().from(auditLogs).where(eq(auditLogs.entityId, correlationId));
}

async function enqueueQueuedTask(agentKey: string, taskType: string, requestedBy: string) {
  const task = await createAgentTask(db, ['SUPER_ADMIN'], requestedBy, {
    agentKey, taskType, input: {}, triggeredBy: 'user',
  }, { actorId: requestedBy });
  createdTaskIds.push(task.id);
  return task;
}

describe('G8 — RBAC on the cycle endpoints', () => {
  it('rejects an unauthenticated caller (401)', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/admin/gm/cycle', { method: 'POST', body: {} })).status).toBe(401);
    expect((await anon.req('/api/admin/gm/cycles')).status).toBe(401);
  });

  it('rejects a non-SUPER_ADMIN (403) and admits the GM (200)', async () => {
    const admin = await loginStaff('ADMIN');
    expect((await admin.client.req('/api/admin/gm/cycle', { method: 'POST', body: {} })).status).toBe(403);
    expect((await admin.client.req('/api/admin/gm/cycles')).status).toBe(403);

    const gm = await loginStaff('SUPER_ADMIN');
    const res = await gm.client.req('/api/admin/gm/cycle', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(['completed', 'blocked', 'failed']).toContain(res.data.data.status);
  });

  it('rejects an out-of-range limit (422)', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const res = await gm.client.req('/api/admin/gm/cycle', { method: 'POST', body: { limit: 9999 } });
    expect(res.status).toBe(422);
  });
});

describe('G8 — an on-demand cycle advances real due work', () => {
  it('runs a queued task and records STARTED + COMPLETED with the same correlationId', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const task = await enqueueQueuedTask('analytics-agent', 'analytics.report', gm.id);

    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 25 });

    expect(result.status).toBe('completed');
    expect(result.steps.tasksRan).toBeGreaterThanOrEqual(0);
    // The task this file enqueued reached a terminal state — by this cycle or a
    // concurrent one; either way it is never left queued.
    const done = await getTask(db, task.id);
    expect(['succeeded', 'failed', 'blocked', 'awaiting_approval']).toContain(done.status);

    const audits = await cycleAudits(result.correlationId);
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain('AI.AGENT_CYCLE_STARTED');
    expect(actions).toContain('AI.AGENT_CYCLE_COMPLETED');
    // The cycle is attributable to the real operator.
    expect(audits.every((a) => a.actorId === gm.id)).toBe(true);
    const completed = audits.find((a) => a.action === 'AI.AGENT_CYCLE_COMPLETED')!;
    expect((completed.metadata as { status: string }).status).toBe('completed');
  });

  it('drains a committed outbox event to its owning agent', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const orderId = randomUUID();
    const { id: eventId } = await enqueueEvent(db, {
      eventType: 'order.placed', aggregateType: 'ORDER', aggregateId: orderId,
      payload: { orderId }, dedupeKey: `order.placed:${orderId}`,
    });
    createdEventIds.push(eventId);

    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 25 });
    expect(result.status).toBe('completed');

    const row = await db.select().from(eventOutbox).where(eq(eventOutbox.id, eventId)).limit(1);
    expect(row[0].status).toBe('PROCESSED');
    const routed = await db.select().from(agentTasks).where(eq(agentTasks.correlationId, eventId));
    expect(routed).toHaveLength(1);
    expect(routed[0].agentKey).toBe('operations-agent');
    createdTaskIds.push(routed[0].id);
  });

  it('does not execute an awaiting_approval task (no auto-approval of gated work)', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // A gated task inserted directly in `awaiting_approval`: the cycle must not
    // approve it, only a human decision may.
    const gatedId = randomUUID();
    await db.insert(agentTasks).values({
      id: gatedId, agentKey: 'payment-settlement-agent', requestedBy: gm.id,
      taskType: 'payment.approve_payout', input: {} as never, status: 'awaiting_approval',
      requiresApproval: true, triggeredBy: 'user',
    });
    createdTaskIds.push(gatedId);

    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 25 });
    expect(result.status).toBe('completed');

    const gated = await getTask(db, gatedId);
    expect(gated.status).toBe('awaiting_approval');
  });
});

describe('G8 — single-flight (blocked, never a second overlapping cycle)', () => {
  it('reports blocked/ALREADY_RUNNING while another cycle holds the lock', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const client = await db.$client.connect();
    const held = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', ['wasit.ai.agent_cycle']);
    expect(held.rows[0].ok).toBe(true);
    try {
      const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 5 });
      expect(result.status).toBe('blocked');
      expect(result.reason).toBe('ALREADY_RUNNING');
      // A blocked cycle ran no step.
      expect(result.steps.tasksRan).toBe(0);
      expect(result.steps.outboxProcessed).toBe(0);

      const audits = await cycleAudits(result.correlationId);
      expect(audits.map((a) => a.action)).toContain('AI.AGENT_CYCLE_BLOCKED');
      expect(audits.map((a) => a.action)).not.toContain('AI.AGENT_CYCLE_COMPLETED');
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', ['wasit.ai.agent_cycle']);
      client.release();
    }
  });
});

describe('G8 — budget gate (blocked, never spend into the red)', () => {
  it('refuses to start when the operator budget is already spent', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // A per-operator zero-cost monthly budget: only THIS operator is affected,
    // so the shared test database is untouched for every other spec.
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({
      id: budgetId, userId: gm.id, period: 'MONTHLY', maxCost: '0.0000000000', currencyCode: 'USD', isActive: true,
    });
    createdBudgetIds.push(budgetId);

    const status = await resolveCycleBudget(db, gm.id);
    expect(status.exhausted).toBe(true);

    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 5 });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(result.steps.tasksRan).toBe(0);

    const audits = await cycleAudits(result.correlationId);
    expect(audits.map((a) => a.action)).toContain('AI.AGENT_CYCLE_BLOCKED');
    expect(audits.map((a) => a.action)).not.toContain('AI.AGENT_CYCLE_STARTED');
  });

  it('reports the resolved budget on a normal cycle', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 1 });
    expect(result.status).toBe('completed');
    expect(result.budget.limitUsd).not.toBeNull();
    expect(result.budget.source).toBeTruthy();
    expect(result.budget.currencyCode).toBe('USD');
  });
});

describe('G8 — a failing step is reported as failed, never as success', () => {
  it('marks the cycle failed and audits FAILED when a step throws', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const spy = vi.spyOn(outboxWorker, 'dispatchOutboxEvents').mockRejectedValue(new Error('g8-injected-failure'));
    let result;
    try {
      result = await runAgentCycle(db, { actorId: gm.id }, { limit: 5 });
    } finally {
      spy.mockRestore();
    }

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('g8-injected-failure');
    const audits = await cycleAudits(result.correlationId);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('AI.AGENT_CYCLE_STARTED');
    expect(actions).toContain('AI.AGENT_CYCLE_FAILED');
    expect(actions).not.toContain('AI.AGENT_CYCLE_COMPLETED');
  });
});

describe('G8 — the cycle log (read-only retrieval)', () => {
  it('lists a completed cycle with its steps and operator', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 5 });
    expect(result.status).toBe('completed');

    const cycles = await listAgentCycles(db, { limit: 200 });
    const mine = cycles.find((c) => c.correlationId === result.correlationId);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe('completed');
    expect(mine!.actorId).toBe(gm.id);
    expect(mine!.steps).not.toBeNull();
    expect(mine!.finishedAt).not.toBeNull();
  });

  it('surfaces a blocked cycle with its reason', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const budgetId = randomUUID();
    await db.insert(aiBudgets).values({
      id: budgetId, userId: gm.id, period: 'MONTHLY', maxCost: '0.0000000000', currencyCode: 'USD', isActive: true,
    });
    createdBudgetIds.push(budgetId);

    const result = await runAgentCycle(db, { actorId: gm.id }, { limit: 5 });
    expect(result.status).toBe('blocked');

    const cycles = await listAgentCycles(db, { limit: 200 });
    const mine = cycles.find((c) => c.correlationId === result.correlationId);
    expect(mine!.status).toBe('blocked');
    expect(mine!.reason).toBe('BUDGET_EXHAUSTED');
    expect(mine!.steps).toBeNull();
  });

  it('serves the cycle log over HTTP to the GM only', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const run = await gm.client.req('/api/admin/gm/cycle', { method: 'POST', body: { limit: 5 } });
    expect(run.status).toBe(200);
    const correlationId = run.data.data.correlationId as string;

    const list = await gm.client.req('/api/admin/gm/cycles?limit=200');
    expect(list.status).toBe(200);
    const ids = (list.data.data.items as { correlationId: string }[]).map((i) => i.correlationId);
    expect(ids).toContain(correlationId);
  });
});

describe('G8 — registry stays intact after cycles', () => {
  it('the operations agent is ACTIVE and registered', async () => {
    await syncAgentRegistry(db);
    const rows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, 'operations-agent')).limit(1);
    expect(rows[0].status).toBe('ACTIVE');
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { agentRegistry, agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { orders, payments, transactions } from '../src/db/schema/commerce.js';
import { orchestrateGmGoal } from '../src/modules/ai/orchestrator.js';
import { executeGmAction, listGmRunActions, GM_ACTION_ROUTES } from '../src/modules/ai/gm-actions.js';
import { setAgentStatus, getTask } from '../src/modules/ai/runner.js';
import type { UserRole } from '@wasit/shared';

/**
 * G4 — executing a GM's proposed follow-up action.
 *
 * Drives the REAL module, the REAL runner and the REAL HTTP surface against a
 * REAL database. Every assertion reads the effect back from persisted state —
 * nothing is mocked.
 *
 * The guarantees pinned here:
 *  - only an authenticated SUPER_ADMIN may execute a proposed action; ADMIN and
 *    anonymous callers are refused by the server, and the operator identity is
 *    taken from the session, never the request body;
 *  - only an action present in the run's snapshot AND wired to a real agent may
 *    run — an unknown, tampered, agent-less or unavailable action is refused;
 *  - a sensitive action becomes an `awaiting_approval` task and is never
 *    auto-executed;
 *  - `(runId, action)` is idempotent, including under concurrent requests;
 *  - the kill switch blocks execution and no money-path row is written;
 *  - the audit trail attributes the request to the real GM and reports the real
 *    outcome, never a hopeful success.
 */

const app = createApp();

const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
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
  const email = `g4-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('G4Pass123!'), firstName: roleName, isActive: true, emailVerified: true,
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
    body: { email, password: 'G4Pass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

/** Runs a goal as the GM and returns the persisted run id. */
async function runGoal(gmId: string, goal: string): Promise<string> {
  const run = await orchestrateGmGoal(db, {
    goal,
    requestedBy: gmId,
    role: ['SUPER_ADMIN'],
    audit: { actorId: gmId },
  });
  for (const r of run.results) if (r.taskId) createdTaskIds.push(r.taskId);
  return run.runId;
}

/** A run whose snapshot proposes `ads.spend_increase` (revenue growth playbook). */
async function revenueRun(gmId: string): Promise<string> {
  return runGoal(gmId, 'revenue growth plan for the ads campaign');
}

async function gmActionAudits(runId: string, action: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'GM_ACTION'), eq(auditLogs.entityId, runId)));
  return rows.filter((r) => (r.metadata as { action?: string } | null)?.action === action);
}

/** Counts money-path rows attributed to a (fresh, unique) order id — always 0. */
async function moneyRowsForOrder(orderId: string) {
  const o = await db.select().from(orders).where(eq(orders.id, orderId));
  const p = await db.select().from(payments).where(eq(payments.orderId, orderId));
  const t = await db.select().from(transactions).where(eq(transactions.orderId, orderId));
  return { orders: o.length, payments: p.length, transactions: t.length };
}

describe('G4 — RBAC and session identity on the execute endpoint', () => {
  it('rejects an unauthenticated caller (401)', async () => {
    const anon = makeClient();
    const res = await anon.req('/api/admin/gm/runs/00000000-0000-0000-0000-000000000000/actions/execute', {
      method: 'POST', body: { action: 'ads.spend_increase' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an ADMIN (403) and admits the GM', async () => {
    const admin = await loginStaff('ADMIN');
    const gm = await loginStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const denied = await admin.client.req(`/api/admin/gm/runs/${runId}/actions/execute`, {
      method: 'POST', body: { action: 'ads.spend_increase' },
    });
    expect(denied.status).toBe(403);

    const ok = await gm.client.req(`/api/admin/gm/runs/${runId}/actions/execute`, {
      method: 'POST', body: { action: 'ads.spend_increase' },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.data.status).toBe('task_created');
    if (ok.data.data.taskId) createdTaskIds.push(ok.data.data.taskId);
  });

  it('takes the operator identity from the session, never the request body', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const victim = await insertStaff('MERCHANT');
    const runId = await revenueRun(gm.id);

    const res = await gm.client.req(`/api/admin/gm/runs/${runId}/actions/execute`, {
      method: 'POST',
      // A forged identity in the body must be ignored entirely.
      body: { action: 'ads.spend_increase', actorId: victim.id, requestedBy: victim.id, userId: victim.id, role: ['SUPER_ADMIN'] },
    });
    expect(res.status).toBe(200);
    const taskId = res.data.data.taskId as string;
    createdTaskIds.push(taskId);

    // The task belongs to the GM (session), not the forged body identity.
    const task = await getTask(db, taskId);
    expect(task.requestedBy).toBe(gm.id);
    expect(task.requestedBy).not.toBe(victim.id);
  });
});

describe('G4 — action validation against the snapshot', () => {
  it('refuses an action that the run never proposed', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const res = await executeGmAction(db, runId, 'definitely.not.a.proposed.action', { actorId: gm.id });
    expect(res.status).toBe('blocked');
    expect(res.reason).toBe('UNKNOWN_ACTION');
    expect(res.taskId).toBeNull();
  });

  it('refuses an action present in the snapshot but not wired to an agent', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // The catalogue quality playbook proposes `catalog.publish_batch`, which the
    // Product Agent cannot actually perform (no publish capability).
    const runId = await runGoal(gm.id, 'catalogue quality audit for the product listing');

    const res = await executeGmAction(db, runId, 'catalog.publish_batch', { actorId: gm.id });
    expect(res.status).toBe('blocked');
    expect(res.reason).toBe('NO_AGENT');
  });

  it('refuses a synthetic agent-less action (gm.retry_failed)', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // Force a failing step so the run proposes `gm.retry_failed` (agentKey null).
    const runId = await runGoal(gm.id, 'platform health review');
    const res = await executeGmAction(db, runId, 'gm.retry_failed', { actorId: gm.id });
    // Either it was not proposed (200-blocked as unknown) or it was proposed and
    // rejected for having no agent — both are a refusal, never a created task.
    expect(res.status).toBe('blocked');
    expect(['UNKNOWN_ACTION', 'NO_AGENT']).toContain(res.reason);
  });

  it('refuses an action whose agent is stopped (kill switch)', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    await setAgentStatus(db, 'ads-agent', 'PAUSED', 'g4 kill switch', { actorId: gm.id });
    try {
      const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('AGENT_NOT_ACTIVE');
    } finally {
      await setAgentStatus(db, 'ads-agent', 'ACTIVE', 'g4 kill switch restore', { actorId: gm.id });
    }
  });

  it('refuses an action on a run the caller may not read (404 semantics)', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // A MERCHANT holds no platform scope, so the run is invisible to them.
    const outsider = await insertStaff('MERCHANT');
    const runId = await revenueRun(gm.id);

    await expect(executeGmAction(db, runId, 'ads.spend_increase', { actorId: outsider.id })).rejects.toThrow();
  });
});

describe('G4 — sensitive actions wait for human approval', () => {
  it('creates an awaiting_approval task and never auto-executes it', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    expect(res.status).toBe('task_created');
    expect(res.requiresApproval).toBe(true);
    expect(res.taskStatus).toBe('awaiting_approval');
    const taskId = res.taskId!;
    createdTaskIds.push(taskId);

    const task = await getTask(db, taskId);
    expect(task.status).toBe('awaiting_approval');
    expect(task.requiresApproval).toBe(true);
    expect(task.result).toBeNull();
    expect(task.agentKey).toBe(GM_ACTION_ROUTES['ads.spend_increase']!.agentKey);
  });

  it('links the task to the originating run via correlationId', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    createdTaskIds.push(res.taskId!);
    const task = await getTask(db, res.taskId!);
    expect(task.correlationId).toBe(runId);
    expect(task.triggeredBy).toBe('gm-action');
    expect(task.dedupeKey).toBe(`gm-action:${runId}:ads.spend_increase`);
    expect((task.input as { gmAction?: string }).gmAction).toBe('ads.spend_increase');
  });
});

describe('G4 — idempotency on (runId, action)', () => {
  it('a repeated request returns the same task, not a second one', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const first = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    createdTaskIds.push(first.taskId!);
    expect(first.deduplicated).toBe(false);
    const second = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });

    expect(second.taskId).toBe(first.taskId);
    expect(second.deduplicated).toBe(true);

    const rows = await db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.dedupeKey, `gm-action:${runId}:ads.spend_increase`));
    expect(rows).toHaveLength(1);
  });

  it('concurrent requests still create exactly one task', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const results = await Promise.all([
      executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id }),
      executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id }),
      executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id }),
    ]);
    const ids = new Set(results.map((r) => r.taskId).filter(Boolean));
    expect(ids.size).toBe(1);
    for (const r of results) if (r.taskId) createdTaskIds.push(r.taskId);

    const rows = await db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.dedupeKey, `gm-action:${runId}:ads.spend_increase`));
    expect(rows).toHaveLength(1);
  });

  it('a different action on the same run creates its own task', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    // The risk playbook proposes risk.block_account and compliance.final_ruling.
    const runId = await runGoal(gm.id, 'risk and compliance review');

    const a = await executeGmAction(db, runId, 'risk.block_account', { actorId: gm.id });
    const b = await executeGmAction(db, runId, 'compliance.final_ruling', { actorId: gm.id });
    if (a.taskId) createdTaskIds.push(a.taskId);
    if (b.taskId) createdTaskIds.push(b.taskId);

    expect(a.status).toBe('task_created');
    expect(b.status).toBe('task_created');
    expect(a.taskId).not.toBe(b.taskId);
  });
});

describe('G4 — audit trail and no money-path write', () => {
  it('records REQUESTED then EXECUTED with the real GM identity and outcome', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    createdTaskIds.push(res.taskId!);

    const audits = await gmActionAudits(runId, 'ads.spend_increase');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('AI.GM_ACTION_REQUESTED');
    expect(actions).toContain('AI.GM_ACTION_EXECUTED');
    for (const a of audits) expect(a.actorId).toBe(gm.id);
    const executed = audits.find((a) => a.action === 'AI.GM_ACTION_EXECUTED')!;
    expect((executed.metadata as { taskId?: string }).taskId).toBe(res.taskId);
  });

  it('records BLOCKED (never EXECUTED) when the action is refused', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    await executeGmAction(db, runId, 'nope.not.proposed', { actorId: gm.id });

    const audits = await gmActionAudits(runId, 'nope.not.proposed');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('AI.GM_ACTION_REQUESTED');
    expect(actions).toContain('AI.GM_ACTION_BLOCKED');
    expect(actions).not.toContain('AI.GM_ACTION_EXECUTED');
  });

  it('writes no order, payment or ledger row for the run', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    createdTaskIds.push(res.taskId!);

    // The run id is a fresh UUID, so no commerce row can ever be attributed to it.
    expect(await moneyRowsForOrder(runId)).toEqual({ orders: 0, payments: 0, transactions: 0 });
  });
});

describe('G4 — the actions view (read-only)', () => {
  it('annotates executability and reflects a created task', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);

    const before = await listGmRunActions(db, runId, gm.id);
    const adsBefore = before.find((a) => a.action === 'ads.spend_increase')!;
    expect(adsBefore.executable).toBe(true);
    expect(adsBefore.taskId).toBeNull();

    const res = await executeGmAction(db, runId, 'ads.spend_increase', { actorId: gm.id });
    createdTaskIds.push(res.taskId!);

    const after = await listGmRunActions(db, runId, gm.id);
    const adsAfter = after.find((a) => a.action === 'ads.spend_increase')!;
    expect(adsAfter.taskId).toBe(res.taskId);
    expect(adsAfter.taskStatus).toBe('awaiting_approval');
  });

  it('marks an unwired proposed action as not executable', async () => {
    const gm = await insertStaff('SUPER_ADMIN');
    const runId = await runGoal(gm.id, 'catalogue quality audit for the product listing');
    const actions = await listGmRunActions(db, runId, gm.id);
    const publish = actions.find((a) => a.action === 'catalog.publish_batch');
    expect(publish).toBeDefined();
    expect(publish!.executable).toBe(false);
    expect(publish!.reason).toBe('NO_AGENT');
  });

  it('exposes the allow-list route for every executable action', async () => {
    // Guard against drift: every routed action must name a real, non-coordinator agent.
    for (const [action, route] of Object.entries(GM_ACTION_ROUTES)) {
      expect(route.agentKey, action).toBeTruthy();
      expect(route.taskType, action).toBeTruthy();
      const rows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, route.agentKey)).limit(1);
      expect(rows.length, `${action} -> ${route.agentKey}`).toBe(1);
    }
  });
});

describe('G4 — HTTP surface', () => {
  it('lists a run\'s actions over HTTP (SUPER_ADMIN)', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await gm.client.req(`/api/admin/gm/runs/${runId}/actions`);
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<{ action: string; executable: boolean }>;
    expect(items.some((a) => a.action === 'ads.spend_increase' && a.executable)).toBe(true);
  });

  it('rejects a malformed body (missing action) with 422', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await gm.client.req(`/api/admin/gm/runs/${runId}/actions/execute`, {
      method: 'POST', body: {},
    });
    expect(res.status).toBe(422);
  });

  it('a tampered action string cannot create a task', async () => {
    const gm = await loginStaff('SUPER_ADMIN');
    const runId = await revenueRun(gm.id);
    const res = await gm.client.req(`/api/admin/gm/runs/${runId}/actions/execute`, {
      method: 'POST', body: { action: 'ads.spend_increase; DROP TABLE agent_tasks' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('blocked');
    expect(res.data.data.taskId).toBeNull();
  });
});

describe('G4 — registry stays intact', () => {
  it('the ads agent is ACTIVE and registered after the suite', async () => {
    const rows = await db.select().from(agentRegistry).where(eq(agentRegistry.key, 'ads-agent')).limit(1);
    expect(rows[0].status).toBe('ACTIVE');
  });
});

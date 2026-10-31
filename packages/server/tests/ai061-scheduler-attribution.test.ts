import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentMetrics, agentMemory, agentSchedules } from '../src/db/schema/agents.js';
import { orders } from '../src/db/schema/commerce.js';
import {
  createAgentTask,
  decideAgentTask,
  executeDueTasks,
  getTask,
  reapStaleTasks,
  setAgentStatus,
  syncAgentRegistry,
  SYSTEM_PRINCIPAL,
} from '../src/modules/ai/runner.js';
import { dispatchDueSchedules, ensureSchedules } from '../src/modules/ai/copilot.js';
import {
  deriveScope,
  derivePlatformScope,
  deriveSystemScope,
  assertValidScope,
  NoScopeError,
} from '../src/modules/ai/scope.js';
import { perAgentMetrics, aggregateMetrics, __internal as metricsInternal } from '../src/modules/ai/metrics-repo.js';
import { teamHealth, agentPerformance, recentActivity } from '../src/modules/ai/agent-monitor.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-06.1 — Scheduled-task attribution & agent result semantics.
 *
 * Drives the REAL scheduler/runner wiring against the REAL database and pins the
 * properties this fix exists to guarantee:
 *
 *   - M-1: a scheduler-created task writes an `agent_metrics` row AND an
 *     `agent_memory` note under a dedicated, explicit **system** identity, kept
 *     separate from every human owner (and never leaking into a tenant view).
 *   - M-2: a deliberate refusal is a first-class `refused` outcome — distinct from
 *     a technical failure — on both the executor-refusal and approval-REJECT
 *     paths, and the supervisor/GM views respect that distinction.
 *   - The trust anchors are unchanged: a forged `system` task, the kill switch,
 *     the per-run budget and RBAC all still hold.
 */

const AUDIT = { actorId: 'ai061-test' };

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];
const createdScheduleIds: string[] = [];

const track = (id: string) => { createdTaskIds.push(id); return id; };

async function insertUser(roleName: UserRole) {
  const id = randomUUID();
  const email = `ai061-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: await argon2.hash('Ai061Pass123!'), firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

async function metricRowsFor(owner: string, taskId: string) {
  return db.select().from(agentMetrics).where(and(eq(agentMetrics.scopeOwner, owner), eq(agentMetrics.taskId, taskId)));
}
async function memoryRowsFor(owner: string, taskId: string) {
  const all = await db.select().from(agentMemory).where(eq(agentMemory.scopeOwner, owner));
  return all.filter((r) => (r.content as Record<string, unknown>)?.taskId === taskId);
}

const render = (q: unknown): { sql: string; params: unknown[] } => new PgDialect().sqlToQuery(q as never);

beforeAll(async () => {
  await syncAgentRegistry(db);
  await ensureSchedules(db);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(agentMetrics).where(inArray(agentMetrics.scopeOwner, [...createdUserIds, SYSTEM_PRINCIPAL]));
    await db.delete(agentMemory).where(inArray(agentMemory.scopeOwner, [...createdUserIds, SYSTEM_PRINCIPAL]));
  }
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdScheduleIds.length) await db.delete(agentSchedules).where(inArray(agentSchedules.id, createdScheduleIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

// ---------------------------------------------------------------------------
// M-1 — the scheduler writes its own telemetry under a dedicated identity.
// ---------------------------------------------------------------------------

describe('AI-06.1 M-1 — scheduler attribution', () => {
  it('records a metric AND a memory note under the system bucket for a scheduled run', async () => {
    const buyer = await insertUser('CUSTOMER');
    await db.insert(orders).values({
      id: randomUUID(), orderNumber: `AI061-${randomUUID().slice(0, 16)}`, buyerId: buyer.id, buyerType: 'CUSTOMER',
      sellerId: randomUUID(), sellerType: 'SUPPLIER', currencyCode: 'TND', itemsTotal: '250.0000',
      commission: '2.0000', buyerCommission: '2.0000', paymentFee: '0', grandTotal: '250.0000',
      status: 'DELIVERED', paymentStatus: 'PAID',
    });

    const task = await createAgentTask(
      db, ['SUPER_ADMIN'], SYSTEM_PRINCIPAL,
      { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {}, triggeredBy: 'schedule:ai061-metric' }, AUDIT,
    );
    track(task.id);
    await executeDueTasks(db, 50);
    const done = await getTask(db, task.id);
    expect(done.status).toBe('succeeded');

    const metrics = await metricRowsFor(SYSTEM_PRINCIPAL, task.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].outcome).toBe('succeeded');
    expect(metrics[0].scopeOwner).toBe(SYSTEM_PRINCIPAL);

    const notes = await memoryRowsFor(SYSTEM_PRINCIPAL, task.id);
    expect(notes).toHaveLength(1);
    expect((notes[0].content as Record<string, unknown>).source).toBe('schedule');
  });

  it('never leaks a scheduled run into a tenant (owner) view', async () => {
    const owner = await insertUser('CUSTOMER');
    const scope = deriveScope({ userId: owner.id });
    const agg = await aggregateMetrics(db, scope);
    expect(agg.total).toBe(0);

    const perf = await agentPerformance(db, scope);
    expect(perf.find((r) => r.agentKey === 'analytics-agent')).toBeUndefined();
  });

  it('a system-scope read returns the row; the platform predicate excludes system', async () => {
    const sysRows = await perAgentMetrics(db, deriveSystemScope());
    expect(sysRows.some((r) => r.agentKey === 'analytics-agent')).toBe(true);
    // The platform predicate is `scope_owner <> 'system'` — verified at SQL level.
    const platform = render(metricsInternal.scopePredicate(
      derivePlatformScope({ userId: 'admin-1' }, { roles: ['SUPER_ADMIN'] }),
    ));
    expect(platform.sql).toContain('<>');
    expect(platform.params).toEqual([SYSTEM_PRINCIPAL]);
  });

  it('reports scheduler telemetry separately in the platform health view', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const platform = derivePlatformScope({ userId: admin.id }, { roles: ['SUPER_ADMIN'] });
    const health = await teamHealth(db, platform);
    expect(health.system).toBeDefined();
    expect(health.system!.succeeded24h).toBeGreaterThanOrEqual(1);
    // Human tasks and system tasks are counted separately, never merged.
    expect(typeof health.tasks.succeeded24h).toBe('number');

    const ownerHealth = await teamHealth(db, deriveScope({ userId: admin.id }));
    expect(ownerHealth.system).toBeUndefined();
  });

  it('a task that merely claims `system` is recorded in neither store', async () => {
    // Inserted directly, bypassing createAgentTask: bare `system` id, no
    // `schedule:` provenance. It is blocked at execution and leaves no telemetry.
    const forgedId = randomUUID();
    await db.insert(agentTasks).values({
      id: forgedId, agentKey: 'analytics-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'analytics.report', input: {} as never, status: 'queued', triggeredBy: 'user',
    });
    track(forgedId);
    await executeDueTasks(db, 50);
    const done = await getTask(db, forgedId);
    expect(done.status).toBe('blocked');
    expect(await metricRowsFor(SYSTEM_PRINCIPAL, forgedId)).toHaveLength(0);
    expect(await memoryRowsFor(SYSTEM_PRINCIPAL, forgedId)).toHaveLength(0);
  });

  it('the system scope is a distinct, non-platform, non-owner identity', () => {
    const sys = deriveSystemScope();
    expect(sys.owner).toBe(SYSTEM_PRINCIPAL);
    expect(sys.isSystem).toBe(true);
    expect(sys.isPlatform).toBe(false);
    expect(() => assertValidScope(sys)).not.toThrow();
    // A hand-built context claiming the system owner is rejected.
    expect(() => assertValidScope({ owner: SYSTEM_PRINCIPAL, isPlatform: false, isSystem: true } as never)).toThrow(NoScopeError);
  });

  it('the metrics scope predicate separates system from platform and owner', () => {
    const sys = render(metricsInternal.scopePredicate(deriveSystemScope()));
    expect(sys.params).toEqual([SYSTEM_PRINCIPAL]);
    const platform = render(metricsInternal.scopePredicate(derivePlatformScope({ userId: 'admin-1' }, { roles: ['SUPER_ADMIN'] })));
    expect(platform.sql).toContain('<>');
    const owner = render(metricsInternal.scopePredicate(deriveScope({ userId: 'user-A' })));
    expect(owner.params).toEqual(['user-A']);
  });
});

// ---------------------------------------------------------------------------
// M-2 — a refusal is a first-class outcome, distinct from a technical failure.
// ---------------------------------------------------------------------------

describe('AI-06.1 M-2 — refusal semantics', () => {
  it('counts an executor refusal as `refused` and records the `refused` outcome', async () => {
    // A scheduled own-scope agent has no tenant to anchor to → the executor
    // refuses (NO_SCOPE). Enqueued as `queued` (not auto-run) so the scheduler
    // path executes it and the refusal counter is exercised.
    const scheduleId = randomUUID();
    await db.insert(agentSchedules).values({
      id: scheduleId, agentKey: 'support-agent', taskType: 'support.triage_ticket',
      intervalSeconds: 86400, payload: {} as never, enabled: true, nextRunAt: new Date(),
    });
    createdScheduleIds.push(scheduleId);

    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId, agentKey: 'support-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'support.triage_ticket', input: {} as never, status: 'queued', triggeredBy: `schedule:${scheduleId}`,
    });
    track(taskId);

    const { refused } = await executeDueTasks(db, 50);
    expect(refused).toBeGreaterThanOrEqual(1);
    const done = await getTask(db, taskId);
    expect(done.status).toBe('failed');
    expect((done.error as { refused?: boolean })?.refused).toBe(true);

    const metrics = await metricRowsFor(SYSTEM_PRINCIPAL, taskId);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].outcome).toBe('refused');
    expect(metrics[0].errorCode).toBe('NO_SCOPE');
  });

  it('records an approval REJECT as a `refused` metric and a memory note', async () => {
    const admin = await insertUser('ADMIN');
    // sales-agent declares approval actions, so its tasks are approval-gated.
    const task = await createAgentTask(
      db, ['ADMIN'], admin.id,
      { agentKey: 'sales-agent', taskType: 'sales.qualify_lead', input: {} }, AUDIT,
    );
    track(task.id);
    const awaiting = await getTask(db, task.id);
    expect(awaiting.status).toBe('awaiting_approval');

    const decided = await decideAgentTask(db, task.id, admin.id, 'REJECT', 'not needed', AUDIT);
    expect(decided.status).toBe('rejected');

    const metrics = await metricRowsFor(admin.id, task.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].outcome).toBe('refused');
    expect(await memoryRowsFor(admin.id, task.id)).toHaveLength(1);
  });

  it('a watchdog-reaped run is recorded as a technical `failed` with a TIMEOUT code', async () => {
    const admin = await insertUser('ADMIN');
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId, agentKey: 'sales-agent', requestedBy: admin.id,
      taskType: 'sales.qualify_lead', input: {} as never, status: 'running',
      triggeredBy: 'user', startedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    track(taskId);
    const reaped = await reapStaleTasks(db, 60);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const done = await getTask(db, taskId);
    expect(done.status).toBe('failed');
    const metrics = await metricRowsFor(admin.id, taskId);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].outcome).toBe('failed');
    expect(metrics[0].errorCode).toBe('TIMEOUT');
  });

  it('the kill switch still blocks a trusted scheduled run', async () => {
    await setAgentStatus(db, 'analytics-agent', 'PAUSED', 'ai061 kill switch', AUDIT);
    try {
      const task = await createAgentTask(
        db, ['SUPER_ADMIN'], SYSTEM_PRINCIPAL,
        { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {}, triggeredBy: 'schedule:ai061-kill' }, AUDIT,
      );
      track(task.id);
      const done = await getTask(db, task.id);
      expect(done.status).toBe('blocked');
      const metrics = await metricRowsFor(SYSTEM_PRINCIPAL, task.id);
      expect(metrics).toHaveLength(1);
      expect(metrics[0].outcome).toBe('blocked');
    } finally {
      await setAgentStatus(db, 'analytics-agent', 'ACTIVE', 'ai061 cleanup', AUDIT);
    }
  });

  it('refuses a task for an agent the caller may not use (RBAC intact)', async () => {
    const merchant = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant.id, { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {} }, AUDIT),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The GM monitoring desk — RBAC + contract for the AI-06.1 system view.
// ---------------------------------------------------------------------------

describe('AI-06.1 — agent-ops desk (RBAC + contract)', () => {
  const app = createApp();

  async function loginCookie(roleName: UserRole) {
    const id = randomUUID();
    const email = `ai061-desk-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
    const password = 'DeskPass123!';
    await db.insert(users).values({ id, email, passwordHash: await argon2.hash(password), firstName: roleName, isActive: true, emailVerified: true });
    const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
    if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
    createdUserIds.push(id);
    const login = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, allowUnverifiedEmail: true }),
    });
    return login.headers.get('set-cookie') ?? '';
  }

  const get = (path: string, cookie?: string) =>
    app.request(path, { headers: cookie ? { Cookie: cookie } : {} });

  it('rejects unauthenticated access to every agent-ops surface', async () => {
    expect((await get('/api/admin/agent-ops/performance')).status).toBe(401);
    expect((await get('/api/admin/agent-ops/health')).status).toBe(401);
    expect((await get('/api/admin/agent-ops/activity')).status).toBe(401);
  });

  it('forbids a non-admin (CUSTOMER) from the agent-ops surface', async () => {
    const cookie = await loginCookie('CUSTOMER');
    expect((await get('/api/admin/agent-ops/health', cookie)).status).toBe(403);
  });

  it('serves the platform health view with the system block to an admin', async () => {
    const cookie = await loginCookie('SUPER_ADMIN');
    const res = await get('/api/admin/agent-ops/health', cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { scope: string; system?: unknown; tasks: { refused24h: number } } };
    expect(body.data.scope).toBe('platform');
    expect(body.data.system).toBeDefined();
    expect(typeof body.data.tasks.refused24h).toBe('number');
  });

  // --- RBAC: every unauthorised principal is refused on ALL three surfaces ---

  it('forbids a business user (MERCHANT) from every agent-ops surface', async () => {
    const cookie = await loginCookie('MERCHANT');
    expect((await get('/api/admin/agent-ops/performance', cookie)).status).toBe(403);
    expect((await get('/api/admin/agent-ops/health', cookie)).status).toBe(403);
    expect((await get('/api/admin/agent-ops/activity', cookie)).status).toBe(403);
  });

  it('forbids staff roles that lack the AI governance permission (RISK, SUPPORT)', async () => {
    for (const role of ['RISK', 'SUPPORT'] as const) {
      const cookie = await loginCookie(role);
      expect((await get('/api/admin/agent-ops/performance', cookie)).status).toBe(403);
      expect((await get('/api/admin/agent-ops/health', cookie)).status).toBe(403);
      expect((await get('/api/admin/agent-ops/activity', cookie)).status).toBe(403);
    }
  });

  it('allows ADMIN (AI_MANAGE) on all three surfaces, platform-scoped', async () => {
    const cookie = await loginCookie('ADMIN');
    const perf = await get('/api/admin/agent-ops/performance', cookie);
    const health = await get('/api/admin/agent-ops/health', cookie);
    const activity = await get('/api/admin/agent-ops/activity', cookie);
    expect(perf.status).toBe(200);
    expect(health.status).toBe(200);
    expect(activity.status).toBe(200);
    expect(((await perf.json()) as { data: { scope: string } }).data.scope).toBe('platform');
    expect(((await activity.json()) as { data: { scope?: unknown } }).data).toHaveProperty('items');
  });

  it('allows SUPER_ADMIN (ADMIN_AI) on all three surfaces, platform-scoped', async () => {
    const cookie = await loginCookie('SUPER_ADMIN');
    const perf = await get('/api/admin/agent-ops/performance', cookie);
    const activity = await get('/api/admin/agent-ops/activity', cookie);
    expect(perf.status).toBe(200);
    expect(activity.status).toBe(200);
    expect(((await perf.json()) as { data: { scope: string } }).data.scope).toBe('platform');
  });

  // --- Owner isolation: the platform view excludes the system bucket ---

  it('platform activity shows a human owner task but never the system bucket', async () => {
    const human = await insertUser('CUSTOMER');
    const humanTaskId = randomUUID();
    await db.insert(agentTasks).values({
      id: humanTaskId, agentKey: 'analytics-agent', requestedBy: human.id,
      taskType: 'analytics.report', input: {} as never, status: 'succeeded', triggeredBy: 'user', completedAt: new Date(),
    });
    track(humanTaskId);
    const sysTaskId = randomUUID();
    await db.insert(agentTasks).values({
      id: sysTaskId, agentKey: 'analytics-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'analytics.report', input: {} as never, status: 'succeeded', triggeredBy: 'schedule:ai061-iso', completedAt: new Date(),
    });
    track(sysTaskId);

    const cookie = await loginCookie('ADMIN');
    const res = await get('/api/admin/agent-ops/activity?limit=100', cookie);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { data: { items: Array<{ id: string; requestedBy: string }> } }).data.items;
    expect(items.some((r) => r.id === humanTaskId)).toBe(true);
    expect(items.some((r) => r.id === sysTaskId)).toBe(false);
    expect(items.every((r) => r.requestedBy !== SYSTEM_PRINCIPAL)).toBe(true);
  });

  it('an owner-scoped monitor read sees only that owner (never another owner or system)', async () => {
    const a = await insertUser('CUSTOMER');
    const b = await insertUser('CUSTOMER');
    const aTaskId = randomUUID();
    await db.insert(agentTasks).values({
      id: aTaskId, agentKey: 'analytics-agent', requestedBy: a.id,
      taskType: 'analytics.report', input: {} as never, status: 'succeeded', triggeredBy: 'user', completedAt: new Date(),
    });
    track(aTaskId);
    const bTaskId = randomUUID();
    await db.insert(agentTasks).values({
      id: bTaskId, agentKey: 'analytics-agent', requestedBy: b.id,
      taskType: 'analytics.report', input: {} as never, status: 'succeeded', triggeredBy: 'user', completedAt: new Date(),
    });
    track(bTaskId);

    const aActivity = await recentActivity(db, deriveScope({ userId: a.id }), 100);
    expect(aActivity.some((r) => r.id === aTaskId)).toBe(true);
    expect(aActivity.some((r) => r.id === bTaskId)).toBe(false);

    // And owner A never sees the system bucket either.
    const sysTaskId = randomUUID();
    await db.insert(agentTasks).values({
      id: sysTaskId, agentKey: 'analytics-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'analytics.report', input: {} as never, status: 'succeeded', triggeredBy: 'schedule:ai061-iso2', completedAt: new Date(),
    });
    track(sysTaskId);
    const aActivity2 = await recentActivity(db, deriveScope({ userId: a.id }), 100);
    expect(aActivity2.some((r) => r.id === sysTaskId)).toBe(false);
  });

  // --- Response shape ---

  it('performance returns the row shape the monitor page renders', async () => {
    const cookie = await loginCookie('ADMIN');
    const res = await get('/api/admin/agent-ops/performance', cookie);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { scope: string; items: Array<Record<string, unknown>> } }).data;
    expect(data.scope).toBe('platform');
    expect(Array.isArray(data.items)).toBe(true);
    for (const item of data.items) {
      for (const field of [
        'agentKey', 'total', 'succeeded', 'failed', 'blocked', 'refused',
        'successRate', 'failureRate', 'avgLatencyMs', 'awaitingApproval', 'running',
        'queued', 'overdue', 'costUsd', 'tokensInput', 'tokensOutput',
        'providerFailures', 'localRuns', 'toolCalls', 'toolFailures', 'lastActivityAt',
      ]) {
        expect(item).toHaveProperty(field);
      }
    }
  });

  it('health returns tasks/budget/alerts/attention items and the platform-only system block', async () => {
    const cookie = await loginCookie('ADMIN');
    const res = await get('/api/admin/agent-ops/health', cookie);
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: Record<string, never> }).data as unknown as {
      scope: string;
      generatedAt: string;
      agents: Record<string, unknown>;
      tasks: Record<string, unknown>;
      budget: Record<string, unknown>;
      alerts: unknown[];
      needsHumanAttention: unknown[];
      system: Record<string, unknown>;
    };
    expect(d.scope).toBe('platform');
    expect(typeof d.generatedAt).toBe('string');
    expect(d.agents).toHaveProperty('total');
    expect(d.agents).toHaveProperty('unhealthy');
    for (const f of ['queued', 'running', 'awaitingApproval', 'overdue', 'succeeded24h', 'failed24h', 'refused24h']) {
      expect(d.tasks).toHaveProperty(f);
    }
    expect(d.budget).toHaveProperty('spentUsd24h');
    expect(d.budget).toHaveProperty('runsOverCap24h');
    expect(Array.isArray(d.alerts)).toBe(true);
    expect(Array.isArray(d.needsHumanAttention)).toBe(true);
    // The system monitoring block is present for the platform view and complete.
    expect(d.system).toBeDefined();
    for (const f of ['succeeded24h', 'failed24h', 'refused24h', 'overdue']) {
      expect(d.system).toHaveProperty(f);
    }
  });

  it('activity returns rows with the fields the activity feed renders', async () => {
    const cookie = await loginCookie('ADMIN');
    const res = await get('/api/admin/agent-ops/activity?limit=5', cookie);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { data: { items: Array<Record<string, unknown>> } }).data.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);
    for (const row of items) {
      for (const field of ['id', 'agentKey', 'taskType', 'status', 'requestedBy', 'triggeredBy', 'latencyMs', 'cost', 'createdAt', 'completedAt']) {
        expect(row).toHaveProperty(field);
      }
    }
  });

  // --- Error / empty-data handling ---

  it('rejects an out-of-range limit with 422 (query validation)', async () => {
    const cookie = await loginCookie('ADMIN');
    expect((await get('/api/admin/agent-ops/activity?limit=0', cookie)).status).toBe(422);
    expect((await get('/api/admin/agent-ops/activity?limit=999', cookie)).status).toBe(422);
    expect((await get('/api/admin/agent-ops/performance?limit=-1', cookie)).status).toBe(422);
  });

  it('rejects a non-numeric limit and an out-of-range overdueSeconds with 422', async () => {
    const cookie = await loginCookie('ADMIN');
    expect((await get('/api/admin/agent-ops/activity?limit=abc', cookie)).status).toBe(422);
    expect((await get('/api/admin/agent-ops/health?overdueSeconds=0', cookie)).status).toBe(422);
    expect((await get('/api/admin/agent-ops/performance?overdueSeconds=999999', cookie)).status).toBe(422);
  });

  it('returns empty collections (not an error) for an owner with no data', async () => {
    const loner = await insertUser('CUSTOMER');
    const scope = deriveScope({ userId: loner.id });
    const perf = await agentPerformance(db, scope);
    const activity = await recentActivity(db, scope);
    const health = await teamHealth(db, scope);
    expect(perf).toEqual([]);
    expect(activity).toEqual([]);
    expect(health.scope).toBe('owner');
    expect(health.tasks.succeeded24h).toBe(0);
    expect(health.tasks.refused24h).toBe(0);
    // Owner scope never exposes the platform-only system block.
    expect(health.system).toBeUndefined();
  });
});

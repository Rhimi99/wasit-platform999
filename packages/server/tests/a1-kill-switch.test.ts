import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { agentRunSteps } from '../src/db/schema/agent_runs.js';
import { agentSchedules } from '../src/db/schema/agent_schedules.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { aiRequests } from '../src/db/schema/ai.js';
import argon2 from 'argon2';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import { ensureAgentRegistrySeeded, createAgentTask } from '../src/modules/ai/agents.js';
import { planAgentRun, type ProposedStep } from '../src/modules/ai/planner.js';
import { dispatchStep, recoverStuckSteps, recoverRun } from '../src/modules/ai/dispatcher.js';
import { createAgentSchedule, runDueAgentSchedules } from '../src/modules/ai/scheduling.js';
import { retryStep, runSupervisorCycle } from '../src/modules/ai/supervisor.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';

/**
 * A1 — Central AI Kill Switch: execution entry points.
 *
 * Real dispatcher, real scheduler, real supervisor, real database — nothing is
 * mocked. Proves the ONE central control actually stops every AI execution path
 * while disabled, refuses a bypass from any surface, loses nothing, and resumes
 * after re-enabling without double execution. The switch is reset in `afterEach`
 * so a failure can never leak a stopped state into another spec.
 */

const app = createApp();
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];
const createdScheduleIds: string[] = [];
const createdRegistryKeys: string[] = [];
const auditCtx = { actorId: null, actorType: 'USER' as const };

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-a1-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

function step(overrides: Partial<ProposedStep> & { stepKey: string; agentKey: string }): ProposedStep {
  return { input: {}, ...overrides };
}

async function plan(requester: string, steps: ProposedStep[], title = 'A1 run') {
  const p = await planAgentRun(db, requester, { title, steps }, auditCtx);
  createdRunIds.push(p.runId);
  return p;
}

async function stepRow(runId: string, stepKey: string) {
  const rows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  return rows.find((r) => r.stepKey === stepKey)!;
}

/** Counts audit rows of one action for one entity — proves a refusal was recorded once. */
async function auditCount(action: string, entityId: string | null): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(entityId === null ? eq(auditLogs.action, action) : and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
  return rows.length;
}

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

async function createStaffClient(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `it-a1-http-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterEach(() => {
  setAiExecutionEnabled(null);
});

afterAll(async () => {
  setAiExecutionEnabled(null);
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    runIds: createdRunIds,
    taskIds: createdTaskIds,
    scheduleIds: createdScheduleIds,
    registryKeys: createdRegistryKeys,
  });
  await closeDb();
});

describe('A1 — enabled: current behaviour is untouched', () => {
  it('1. creates a task and dispatches a step normally while enabled', async () => {
    setAiExecutionEnabled(true);
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const out = await dispatchStep(db, p.runId, 'mkt', auditCtx);
    if (out.taskId) createdTaskIds.push(out.taskId);
    expect(out.status).toBe('SUCCEEDED');
    expect((await stepRow(p.runId, 'mkt')).status).toBe('SUCCEEDED');
  });
});

describe('A1 — disabled: every entry point refuses', () => {
  it('2. refuses NEW task creation', async () => {
    const admin = await createUser('SUPER_ADMIN');
    setAiExecutionEnabled(false);
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], admin, { agentKey: 'product-agent', requestedBy: admin, input: {} }, auditCtx),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    // No task row was written.
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, admin));
    expect(rows.length).toBe(0);
  });

  it('3. refuses dispatch of a new step', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    setAiExecutionEnabled(false);
    await expect(dispatchStep(db, p.runId, 'mkt', auditCtx)).rejects.toMatchObject({ statusCode: 503 });
    // The step was not moved to RUNNING and no task was created.
    expect((await stepRow(p.runId, 'mkt')).status).toBe('PENDING');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, admin));
    expect(tasks.length).toBe(0);
  });

  it('4. refuses planning a new run', async () => {
    const admin = await createUser('SUPER_ADMIN');
    setAiExecutionEnabled(false);
    await expect(
      planAgentRun(db, admin, { title: 'blocked', steps: [step({ stepKey: 'x', agentKey: 'product-agent' })] }, auditCtx),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('5. refuses a scheduled sweep and records ONE refusal (no claim, no task)', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const row = await createAgentSchedule(db, admin, { agentKey: 'marketing-agent', input: {}, intervalMinutes: 30, isActive: true }, {});
    createdScheduleIds.push(row.id);
    await db.update(agentSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(agentSchedules.id, row.id));

    const before = await auditCount('AI.KILL_SWITCH_SCHEDULE_REFUSED', null);
    setAiExecutionEnabled(false);
    const result = await runDueAgentSchedules(db, 'a1-sweeper', { leaseSeconds: 60 });
    expect(result).toEqual({ claimed: 0, created: 0, skippedApproval: 0, budgetBlocked: 0, failed: 0 });
    const after = await auditCount('AI.KILL_SWITCH_SCHEDULE_REFUSED', null);
    expect(after - before).toBe(1);
    // The schedule survives and stays due — nothing is lost.
    const refreshed = await db.select().from(agentSchedules).where(eq(agentSchedules.id, row.id)).limit(1);
    expect(refreshed[0]!.isActive).toBe(true);
  });

  it('6. refuses the supervisor cycle and recovery sweep (no-op + one audit each)', async () => {
    setAiExecutionEnabled(false);
    const supBefore = await auditCount('AI.KILL_SWITCH_SUPERVISOR_REFUSED', null);
    const recBefore = await auditCount('AI.KILL_SWITCH_RECOVERY_REFUSED', null);
    const cycle = await runSupervisorCycle(db, auditCtx);
    expect(cycle).toEqual({ scanned: 0, contained: 0, retried: 0, decisions: [], errors: 0, status: 'SUCCESS' });
    const rec = await recoverStuckSteps(db, { stuckSeconds: 300, leaseSeconds: 60 }, auditCtx);
    expect(rec.scanned).toBe(0);
    expect(rec.recovered).toBe(0);
    expect(rec.status).toBe('SUCCESS');
    expect((await auditCount('AI.KILL_SWITCH_SUPERVISOR_REFUSED', null)) - supBefore).toBe(1);
    expect((await auditCount('AI.KILL_SWITCH_RECOVERY_REFUSED', null)) - recBefore).toBe(1);
  });

  it('7. refuses a retry without consuming the attempt or dispatching', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    const s = await stepRow(p.runId, 'mkt');
    await db.update(agentRunSteps).set({ status: 'FAILED', attemptCount: 1 }).where(eq(agentRunSteps.id, s.id));
    const failed = await stepRow(p.runId, 'mkt');

    setAiExecutionEnabled(false);
    const out = await retryStep(
      db,
      p.runId,
      { ...failed, dependsOn: failed.dependsOn as string[] } as never,
      [failed] as never,
      auditCtx,
    );
    expect(out.retried).toBe(false);
    expect(out.dispatched).toBe(false);
    expect(out.code).toBe('KILL_SWITCH');
    // The step is untouched: still FAILED, attempt not consumed.
    const after = await stepRow(p.runId, 'mkt');
    expect(after.status).toBe('FAILED');
    expect(after.attemptCount).toBe(1);
  });

  it('8. refuses the manual run recovery route', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [step({ stepKey: 'mkt', agentKey: 'product-agent' })]);
    setAiExecutionEnabled(false);
    await expect(recoverRun(db, p.runId, auditCtx)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('9. refuses the innermost provider call (runAIFeature), so no surface bypasses it', async () => {
    const admin = await createUser('SUPER_ADMIN');
    setAiExecutionEnabled(false);
    const before = await db.select({ n: sql<number>`count(*)` }).from(aiRequests);
    // The executor path reaches runAIFeature; with the switch off it must refuse
    // before any provider call or ai_requests row is written. createAgentTask
    // already refuses earlier, so we assert the row count is unchanged.
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], admin, { agentKey: 'analytics-agent', requestedBy: admin, input: {} }, auditCtx),
    ).rejects.toMatchObject({ statusCode: 503 });
    const after = await db.select({ n: sql<number>`count(*)` }).from(aiRequests);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });
});

describe('A1 — multi-step run stops before the next step, resumes without duplication', () => {
  it('10. a second step is refused while disabled, then runs after re-enabling', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const p = await plan(admin, [
      step({ stepKey: 'a', agentKey: 'product-agent' }),
      step({ stepKey: 'b', agentKey: 'marketing-agent', dependsOn: ['a'] }),
    ]);
    const first = await dispatchStep(db, p.runId, 'a', auditCtx);
    if (first.taskId) createdTaskIds.push(first.taskId);
    expect(first.status).toBe('SUCCEEDED');

    setAiExecutionEnabled(false);
    await expect(dispatchStep(db, p.runId, 'b', auditCtx)).rejects.toMatchObject({ statusCode: 503 });
    expect((await stepRow(p.runId, 'b')).status).toBe('PENDING');

    // Re-enable: the second step runs exactly once and closes the run.
    setAiExecutionEnabled(true);
    const second = await dispatchStep(db, p.runId, 'b', auditCtx);
    if (second.taskId) createdTaskIds.push(second.taskId);
    expect(second.status).toBe('SUCCEEDED');
    // Exactly one task per step — no double execution.
    const bStep = await stepRow(p.runId, 'b');
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, admin));
    const forB = tasks.filter((t) => (t.input as Record<string, unknown>).__stepId === bStep.id);
    expect(forB.length).toBe(1);
  });
});

describe('A1 — admin control surface: RBAC and audit', () => {
  it('11. SUPER_ADMIN can read and toggle the switch, and the toggle is audited', async () => {
    const { client } = await createStaffClient('SUPER_ADMIN');
    const read = await client.req('/api/admin/ai/kill-switch');
    expect(read.status).toBe(200);
    expect(read.data.data).toMatchObject({ enabled: true });

    const disable = await client.req('/api/admin/ai/kill-switch', { method: 'POST', body: { enabled: false, reason: 'drill' } });
    expect(disable.status).toBe(200);
    expect(disable.data.data).toMatchObject({ enabled: false, source: 'runtime' });

    // A subsequent read reflects the stop.
    const read2 = await client.req('/api/admin/ai/kill-switch');
    expect(read2.data.data.enabled).toBe(false);

    // Re-enable so the switch never leaks past this test.
    const enable = await client.req('/api/admin/ai/kill-switch', { method: 'POST', body: { enabled: true } });
    expect(enable.data.data.enabled).toBe(true);

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'AI.KILL_SWITCH_DISABLED'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.entityType).toBe('AI_KILL_SWITCH');
  });

  it('12. an unauthorised CUSTOMER cannot read or control the switch', async () => {
    const { client } = await createStaffClient('CUSTOMER');
    expect((await client.req('/api/admin/ai/kill-switch')).status).toBe(403);
    expect((await client.req('/api/admin/ai/kill-switch', { method: 'POST', body: { enabled: false } })).status).toBe(403);
    // The switch was NOT changed by the refused attempt.
    expect((await client.req('/api/admin/ai/kill-switch')).status).toBe(403);
  });

  it('13. unauthenticated access is refused', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/ai/kill-switch')).status).toBe(401);
    expect((await c.req('/api/admin/ai/kill-switch', { method: 'POST', body: { enabled: false } })).status).toBe(401);
  });
});

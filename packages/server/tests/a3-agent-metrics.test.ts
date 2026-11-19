import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { aiRequests } from '../src/db/schema/ai.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';

/**
 * A3 — Agent Metrics & Outcome Tracking (DB-backed integration).
 *
 * Exercises the REAL admin endpoint `/api/admin/ai/company-metrics` end to end
 * against Postgres: real auth, real RBAC, real SQL over `agent_tasks`,
 * `ai_requests` and `audit_logs`. It seeds a UNIQUE agent key so the assertions
 * are isolated from any other data, and cleans up exactly what it created.
 */

const app = createApp();
const AGENT_KEY = `a3-it-agent-${randomUUID().slice(0, 8)}`;
const created = { userIds: [] as string[], taskIds: [] as string[], auditIds: [] as string[] };

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
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createUser(roleName: 'ADMIN' | 'MERCHANT') {
  const id = randomUUID();
  const email = `a3-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('StaffPass123!'),
    firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  created.userIds.push(id);
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST', body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

async function seedTask(agentKey: string, owner: string, status: string, opts: { result?: unknown; latencyMs?: number } = {}) {
  const id = randomUUID();
  await db.insert(agentTasks).values({
    id, agentKey, requestedBy: owner,
    input: { note: 'a3-it' } as never,
    status,
    result: opts.result === undefined ? null : (opts.result as never),
    latencyMs: opts.latencyMs ?? 0,
    completedAt: status === 'succeeded' || status === 'failed' || status === 'approved' ? new Date() : null,
    startedAt: new Date(),
  });
  created.taskIds.push(id);
  return id;
}

async function seedLedger(taskId: string, agentKey: string, owner: string, cost: string, model = 'gpt-4o-mini') {
  await db.insert(aiRequests).values({
    id: randomUUID(), userId: owner, requestType: `AGENT:${agentKey}`, model,
    tokensInput: 100, tokensOutput: 20, cost, status: 'SUCCESS',
    metadata: { taskId, agentKey, __agentTaskId: taskId } as never,
  });
}

afterAll(async () => {
  if (created.taskIds.length) {
    await db.delete(aiRequests).where(inArray(aiRequests.userId, created.userIds));
    await db.delete(agentTasks).where(inArray(agentTasks.id, created.taskIds));
  }
  if (created.auditIds.length) await db.delete(auditLogs).where(inArray(auditLogs.id, created.auditIds));
  await db.delete(agentRegistry).where(eq(agentRegistry.key, AGENT_KEY));
  if (created.userIds.length) {
    await db.delete(userRoles).where(inArray(userRoles.userId, created.userIds));
    await db.delete(users).where(inArray(users.id, created.userIds));
  }
});

describe('A3 — /api/admin/ai/company-metrics (RBAC + real metrics)', () => {
  it('refuses an unauthenticated caller', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/ai/company-metrics')).status).toBe(401);
  });

  it('refuses a non-admin (MERCHANT) — no cross-owner exposure', async () => {
    const { client } = await createUser('MERCHANT');
    expect((await client.req('/api/admin/ai/company-metrics')).status).toBe(403);
  });

  it('returns honest, real per-agent metrics to an admin', async () => {
    const { client: admin } = await createUser('ADMIN');
    const { id: owner } = await createUser('MERCHANT');

    await db.insert(agentRegistry).values({
      id: randomUUID(), key: AGENT_KEY, name: 'A3 IT Agent', category: 'general',
      capabilities: [] as never, allowedTools: [] as never, approvalActions: [] as never,
      limits: {} as never, taskTypes: [] as never, permissionsRequired: [] as never,
      isActive: true,
    });

    const t1 = await seedTask(AGENT_KEY, owner, 'succeeded', { result: { advice: 'ok' }, latencyMs: 120 });
    const t2 = await seedTask(AGENT_KEY, owner, 'succeeded', { result: { advice: 'ok' }, latencyMs: 180 });
    const t3 = await seedTask(AGENT_KEY, owner, 'failed', { latencyMs: 90 });
    await seedTask(AGENT_KEY, owner, 'queued');

    await seedLedger(t1, AGENT_KEY, owner, '0.0025000000');
    await seedLedger(t2, AGENT_KEY, owner, '0.0015000000');

    const recoveryId = randomUUID();
    await db.insert(auditLogs).values({
      id: recoveryId, action: 'AI.AGENT_TASK_COST_RECOVERED', entityType: 'AGENT_TASK', entityId: t3,
    });
    created.auditIds.push(recoveryId);

    const res = await admin.req(`/api/admin/ai/company-metrics?agentKey=${AGENT_KEY}`);
    expect(res.status).toBe(200);
    const data = res.data.data;

    // Only the filtered agent is returned.
    expect(data.agents).toHaveLength(1);
    const a = data.agents[0];
    expect(a.agentKey).toBe(AGENT_KEY);

    // Execution: 4 runs, 2 completed, 1 failed, 1 pending, 50% success.
    expect(a.execution.totalRuns).toBe(4);
    expect(a.execution.completed).toBe(2);
    expect(a.execution.failed).toBe(1);
    expect(a.execution.pending).toBe(1);
    expect(a.execution.successRate).toBeCloseTo(2 / 3, 5);

    // Performance: durations from the recorded latencies.
    expect(a.performance.measuredRuns).toBe(3);
    expect(a.performance.medianDurationMs).toBe(120);
    expect(a.performance.recoveredRuns).toBe(1);

    // Cost: ACTUAL ledger spend (0.0025 + 0.0015), never an estimate.
    expect(a.cost.available).toBe(true);
    expect(a.cost.actualProviderCostUsd).toBe('0.0040000000');
    expect(a.cost.requests).toBe(2);

    // Outcomes: stored results counted; no fabricated business outcome.
    expect(a.outcomes.tasksWithStoredResult).toBe(2);
    expect(a.outcomes.businessOutcomesAchieved).toBe(0);

    // Health derived from the settled success rate (2/3 ≥ 0.5) with failures present.
    expect(a.health).toBe('degraded');
    expect(data.attention.some((x: { agentKey: string }) => x.agentKey === AGENT_KEY)).toBe(true);
    expect(data.generatedAt).toBeTruthy();
  });
});

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { agentTasks, agentRegistry } from '../src/db/schema/agents.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-ARCH-ALIGN-01 — the Copilot's dispatch boundary, over real HTTP.
 *
 * The Copilot is the coordination layer (plan → permission check → dependency
 * order → dispatch → monitor → aggregate). These tests pin the boundaries the
 * architecture brief makes non-negotiable:
 *  - it cannot route work to an agent that has no executor;
 *  - it cannot route work to itself or to the Supervisor;
 *  - it never widens permissions (the run is created for the caller and the
 *    caller must already hold every permission the target agent needs);
 *  - planning writes a plan and NOTHING else — no task, no execution;
 *  - a planned step keeps its agent (no re-pointing to a substitute agent).
 */

const app = createApp();
const TEST_PREFIX = 'arch-align-';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

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

async function makeUser(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'CUSTOMER' | 'MERCHANT') {
  const client = makeClient();
  const id = randomUUID();
  const email = `it-${TEST_PREFIX}${uniq(roleName.toLowerCase())}@wasit.tn`;
  const password = 'StrongPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: roleName,
    lastName: 'Tester',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status).toBe(200);
  createdUserIds.push(id);
  return { client, id };
}

function planBody(steps: Array<Record<string, unknown>>, title = 'Arch alignment plan') {
  return { title, steps };
}

async function planAs(client: ReturnType<typeof makeClient>, steps: Array<Record<string, unknown>>) {
  const r = await client.req('/api/admin/ai/agent-runs', { method: 'POST', body: planBody(steps) });
  if (r.status === 201) createdRunIds.push(r.data.data.runId);
  return r;
}

async function countTasksFor(runId: string): Promise<number> {
  const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  if (steps.length === 0) return 0;
  const rows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(inArray(agentTasks.id, steps.map((s) => s.id)));
  return rows.length;
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterEach(() => {
  // The kill switch is global state: always restore it after a test flips it.
  setAiExecutionEnabled(true);
});

afterAll(async () => {
  await cleanupOwnedRows(db, { userIds: createdUserIds, runIds: createdRunIds });
  await closeDb();
});

describe('AI-ARCH-ALIGN-01 — Copilot planning is reachable and side-effect free', () => {
  it('creates a PLANNING run with ordered steps and dispatches nothing', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [
      { stepKey: 'analyse', agentKey: 'analytics-agent', input: {} },
      { stepKey: 'advise', agentKey: 'product-agent', input: {}, dependsOn: ['analyse'] },
    ]);

    expect(r.status).toBe(201);
    const plan = r.data.data;
    expect(plan.runId).toBeTruthy();
    expect(plan.status).toBe('PLANNING');
    expect(plan.steps.map((s: { stepKey: string }) => s.stepKey)).toEqual(['analyse', 'advise']);

    const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, plan.runId)))[0];
    expect(run.status).toBe('PLANNING');
    // Planning is not execution: no agent task exists for any step.
    expect(await countTasksFor(plan.runId)).toBe(0);

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, plan.runId));
    expect(audit.map((a) => a.action)).toContain('AI.AGENT_RUN_PLANNED');
  });

  it('marks approval-gated steps as requiring approval without approving them', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [{ stepKey: 'ads', agentKey: 'ads-agent', input: {} }]);
    expect(r.status).toBe(201);
    const step = r.data.data.steps[0];
    expect(step.requiresApproval).toBe(true);
    expect(step.status).toBe('PENDING');
    expect(await countTasksFor(r.data.data.runId)).toBe(0);
  });
});

describe('AI-ARCH-ALIGN-01 — the Copilot cannot route to an agent that cannot run', () => {
  it('refuses the Marketing Video Agent (declared, no executor)', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [
      { stepKey: 'video', agentKey: 'marketing-video-agent', input: {} },
    ]);
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
    expect(r.data.error.fieldErrors[0].code).toBe('AGENT_NOT_EXECUTABLE');
  });

  it('refuses the Agent Supervisor', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [
      { stepKey: 'sup', agentKey: 'agent-supervisor', input: {} },
    ]);
    expect(r.status).toBe(422);
    expect(r.data.error.fieldErrors[0].code).toBe('SUPERVISOR_NOT_RUNNABLE');
  });

  it('refuses the Copilot itself', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [{ stepKey: 'self', agentKey: 'wasit-copilot', input: {} }]);
    expect(r.status).toBe(422);
    expect(r.data.error.fieldErrors[0].code).toBe('UNKNOWN_AGENT');
  });

  it('refuses an unknown agent', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [{ stepKey: 'x', agentKey: 'not-an-agent', input: {} }]);
    expect(r.status).toBe(422);
    expect(r.data.error.fieldErrors[0].code).toBe('UNKNOWN_AGENT');
  });

  it('writes no run row when a step is refused', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const before = await db.select({ id: agentRuns.id }).from(agentRuns);
    const r = await planAs(admin.client, [
      { stepKey: 'ok', agentKey: 'product-agent', input: {} },
      { stepKey: 'bad', agentKey: 'marketing-video-agent', input: {} },
    ]);
    expect(r.status).toBe(422);
    const after = await db.select({ id: agentRuns.id }).from(agentRuns);
    expect(after.length).toBe(before.length);
  });
});

describe('AI-ARCH-ALIGN-01 — governance boundaries around the Copilot', () => {
  it('refuses a non-admin requester: AI_MANAGE is required', async () => {
    const customer = await makeUser('CUSTOMER');
    const r = await customer.client.req('/api/admin/ai/agent-runs', {
      method: 'POST',
      body: planBody([{ stepKey: 'a', agentKey: 'product-agent', input: {} }]),
    });
    expect(r.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/admin/ai/agent-runs', {
      method: 'POST',
      body: planBody([{ stepKey: 'a', agentKey: 'product-agent', input: {} }]),
    });
    expect(r.status).toBe(401);
  });

  it('respects the central AI kill switch', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    setAiExecutionEnabled(false);
    const r = await planAs(admin.client, [{ stepKey: 'a', agentKey: 'product-agent', input: {} }]);
    expect(r.status).toBe(503);
  });

  it('keeps a planned step bound to its agent (no re-pointing at dispatch time)', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const r = await planAs(admin.client, [
      { stepKey: 'fix', agentKey: 'development-agent', input: {} },
    ]);
    expect(r.status).toBe(201);
    const runId = r.data.data.runId;

    const before = (await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId)))[0];
    expect(before.agentKey).toBe('development-agent');

    // Dispatching the step (it is approval-gated) must not swap the agent.
    const dispatch = await admin.client.req(`/api/admin/ai/agent-runs/${runId}/steps/fix/dispatch`, {
      method: 'POST',
    });
    expect([200, 202, 409]).toContain(dispatch.status);

    const after = (await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId)))[0];
    expect(after.agentKey).toBe('development-agent');
    expect(after.agentKey).toBe(before.agentKey);

    if (dispatch.data?.data?.taskId) {
      const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, dispatch.data.data.taskId)))[0];
      expect(task.agentKey).toBe('development-agent');
    }
  });

  it('exposes the official structure with tiers on the admin agent list', async () => {
    const admin = await makeUser('ADMIN');
    const r = await admin.client.req('/api/admin/ai/agents');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<{ key: string; tier?: string }>;
    expect(items.find((a) => a.key === 'marketing-video-agent')?.tier).toBe('CORE_SPECIALIST');
    expect(items.find((a) => a.key === 'finance-agent')?.tier).toBe('SUPPORTING');
    expect(items.find((a) => a.key === 'agent-supervisor')?.tier).toBe('GOVERNANCE');
    expect(r.data.data.copilot.tier).toBe('GOVERNANCE');
  });
});

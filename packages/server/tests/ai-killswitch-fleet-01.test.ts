import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema/index.js';
import { createApp } from '../src/app.js';
import { db, closeDb, type DB } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';
import { ensureAgentRegistrySeeded, createAgentTask, AGENT_CATALOGUE } from '../src/modules/ai/agents.js';
import { createCopilotRequest, advanceCopilotRun } from '../src/modules/ai/copilot/service.js';
import { recoverRun, recoverStuckSteps } from '../src/modules/ai/dispatcher.js';
import { runSupervisorCycle } from '../src/modules/ai/supervisor.js';
import { runDueAgentSchedules } from '../src/modules/ai/scheduling.js';
import { scanEscalations } from '../src/modules/ai/escalations.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { PLATFORM_METRICS } from '../src/lib/ai/tool-registry.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { aiExecutionSwitches } from '../src/db/schema/ai-execution-switch.js';
import {
  readExecutionSwitchState,
  lockAndAssertExecutionAllowed,
  AI_AGENT_PAUSED_MESSAGE,
  AI_CONTROL_UNAVAILABLE_MESSAGE,
} from '../src/lib/ai/execution-switch.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import argon2 from 'argon2';

/**
 * WASIT-AI-KILLSWITCH-FLEET-01 — one central AI switch for every instance.
 *
 * Real database, real services, real HTTP. Two independent surfaces are used:
 *   - `appA` / `appB`: two Hono instances, each resolving everything from the
 *     database;
 *   - `dbB` / `dbC`: SEPARATE pools (separate connections), standing in for
 *     other server processes. Every decision is read from PostgreSQL inside the
 *     operation, so a second instance cannot keep a stale "enabled".
 *
 * Nothing here mocks the switch, the agents or the database.
 */

const appA = createApp();
const appB = createApp();
const AUDIT = { actorId: null, actorType: 'USER' as const };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdRunIds: string[] = [];

const poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
const dbB = drizzle(poolB, { schema }) as unknown as DB;
const poolC = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
const dbC = drizzle(poolC, { schema }) as unknown as DB;

const GLOBAL_PATH = '/api/admin/ai/execution-switch/global';
const SWITCH_PATH = '/api/admin/ai/execution-switch';
const agentPath = (key: string) => `/api/admin/ai/execution-switch/agents/${key}`;

async function createUser(
  roleName: string,
): Promise<{ id: string; email: string; client: ReturnType<typeof makeClient> }> {
  const id = randomUUID();
  const email = `it-killfleet-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('FleetPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  const client = makeClient(appA);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'FleetPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { id, email, client };
}

async function loginOn(app: ReturnType<typeof createApp>, email: string) {
  const client = makeClient(app);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'FleetPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return client;
}

function makeClient(app: ReturnType<typeof createApp>) {
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

async function auditCount(action: string): Promise<number> {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return rows.length;
}

/** The newest switch audit row for a specific actor — deterministic ordering. */
async function latestAuditFor(action: string, actorId: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.actorId, actorId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const [last] = rows;
  expect(last).toBeDefined();
  return last!;
}

async function insertQueuedTask(ownerId: string, agentKey: string): Promise<string> {
  const id = randomUUID();
  await db.insert(agentTasks).values({
    id,
    agentKey,
    requestedBy: ownerId,
    input: {} as never,
    status: 'queued',
    requiresApproval: false,
    model: 'local-heuristic',
  });
  createdTaskIds.push(id);
  return id;
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterEach(async () => {
  // No spec may leak a stop into another one: the global row and every agent
  // row are reopened, and the env belt is restored.
  env.AI_AGENT_EXECUTION_ENABLED = true;
  await db.delete(aiExecutionSwitches).where(eq(aiExecutionSwitches.scope, 'AGENT'));
  await setAiExecutionEnabled(db, true);
});

afterAll(async () => {
  env.AI_AGENT_EXECUTION_ENABLED = true;
  await setAiExecutionEnabled(db, true);
  await poolB.end();
  await poolC.end();
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    runIds: createdRunIds,
    taskIds: createdTaskIds,
    scheduleIds: [],
    registryKeys: [],
  });
  await closeDb();
});

describe('FLEET-01 — one instance stops an agent, another instance refuses it', () => {
  it('is enforced across pools, and only for the stopped agent', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');

    const stop = await admin.client.req(agentPath('analytics-agent'), {
      method: 'POST',
      body: { stopped: true, reason: 'drill: analytics paused' },
    });
    expect(stop.status).toBe(200);
    expect(stop.data.data.stopped).toBe(true);
    expect(stop.data.data.state.source).toBe('database');

    // Instance B: a different pool, a different request object, same database.
    const stateB = await readExecutionSwitchState(dbB);
    expect(stateB.stoppedAgents).toContain('analytics-agent');
    await expect(
      createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'analytics-agent', requestedBy: owner.id, input: {} }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503, message: AI_AGENT_PAUSED_MESSAGE });

    // The agent that was NOT stopped keeps working on that same instance.
    const other = await createAgentTask(
      dbB,
      ['SUPER_ADMIN'],
      owner.id,
      { agentKey: 'support-agent', requestedBy: owner.id, input: {} },
      AUDIT,
    );
    expect(other.id).toBeTruthy();
    createdTaskIds.push(other.id);

    // Instance B reads the SAME decision through its own HTTP surface.
    const adminOnB = await loginOn(appB, admin.email);
    const readB = await adminOnB.req(SWITCH_PATH);
    expect(readB.status).toBe(200);
    expect(readB.data.data.stoppedAgents).toEqual(['analytics-agent']);

    // And B can stop an agent that A then refuses: control is symmetric.
    expect(
      (await adminOnB.req(agentPath('support-agent'), { method: 'POST', body: { stopped: true, reason: 'from B' } }))
        .status,
    ).toBe(200);
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503, message: AI_AGENT_PAUSED_MESSAGE });
  });
});

describe('FLEET-01 — the global stop covers every execution path', () => {
  it('refuses all agents, Copilot, Supervisor, the scheduler, recovery and tools', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');

    // A run that exists BEFORE the stop: advancing it must not dispatch.
    const beforeStop = await createCopilotRequest(
      db,
      owner.id,
      { request: 'مراجعة أداء المبيعات وتذاكر الدعم المفتوحة' },
      AUDIT,
    );
    const runId = beforeStop.report!.runId;
    createdRunIds.push(runId);

    const stop = await admin.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: true, reason: 'platform drill' },
    });
    expect(stop.status).toBe(200);
    expect(stop.data.data.state).toMatchObject({ enabled: false, source: 'database', globalStopped: true });

    // 1) every catalogue agent is refused on another instance
    for (const agent of AGENT_CATALOGUE) {
      await expect(
        createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: agent.key, requestedBy: owner.id, input: {} }, AUDIT),
      ).rejects.toMatchObject({ statusCode: 503 });
    }

    // 2) Copilot cannot plan or advance
    await expect(
      createCopilotRequest(db, owner.id, { request: 'خطة جديدة أثناء الإيقاف الشامل' }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(advanceCopilotRun(db, runId, AUDIT)).rejects.toMatchObject({ statusCode: 503 });

    // 3) Supervisor cycle is a no-op with ONE refusal audit (it drives retries)
    const supervisorBefore = await auditCount('AI.KILL_SWITCH_SUPERVISOR_REFUSED');
    const cycle = await runSupervisorCycle(dbB, AUDIT);
    expect(cycle).toMatchObject({ scanned: 0, contained: 0, retried: 0, errors: 0 });
    expect(await auditCount('AI.KILL_SWITCH_SUPERVISOR_REFUSED')).toBe(supervisorBefore + 1);

    // 4) Scheduled sweep claims nothing and creates nothing
    const scheduleBefore = await auditCount('AI.KILL_SWITCH_SCHEDULE_REFUSED');
    const sweep = await runDueAgentSchedules(dbB, 'worker-fleet-1');
    expect(sweep).toMatchObject({ claimed: 0, created: 0 });
    expect(await auditCount('AI.KILL_SWITCH_SCHEDULE_REFUSED')).toBe(scheduleBefore + 1);

    // 5) Recovery sweeps do not re-drive anything
    const recoveryBefore = await auditCount('AI.KILL_SWITCH_RECOVERY_REFUSED');
    const recovered = await recoverStuckSteps(dbB, { stuckSeconds: 1 }, AUDIT);
    expect(recovered).toMatchObject({ scanned: 0, recovered: 0, reconciledRuns: 0 });
    expect(await auditCount('AI.KILL_SWITCH_RECOVERY_REFUSED')).toBe(recoveryBefore + 1);
    await expect(recoverRun(db, runId, AUDIT)).rejects.toMatchObject({ statusCode: 503 });

    // 6) Escalation scanning is skipped
    const escalation = await scanEscalations(dbB, AUDIT, { now: new Date() });
    expect(escalation.skipped).toBe('KILL_SWITCH');

    // 7) The tool gateway is refused before any identity/data work
    const toolRefusal = await withAgentRunContext(
      {
        taskId: 'task-fleet-1',
        agentKey: 'analytics-agent',
        requestedBy: owner.id,
        requesterRoles: ['SUPER_ADMIN'],
        authorizedActions: [],
        allowedTools: [PLATFORM_METRICS],
      } as never,
      () => invokeTool(dbB, PLATFORM_METRICS, {}),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(toolRefusal).toBeInstanceOf(ToolGatewayError);
    expect((toolRefusal as ToolGatewayError).code).toBe('AI_EXECUTION_DISABLED');
  });
});

describe('FLEET-01 — nothing new starts after the stop is acknowledged', () => {
  it('cancels queued work instead of re-queuing it, and refuses new tasks', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');
    const queuedId = await insertQueuedTask(owner.id, 'analytics-agent');

    const stop = await admin.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: true, reason: 'drain queued work' },
    });
    expect(stop.status).toBe(200);
    expect(stop.data.data.cancelledQueued).toBeGreaterThanOrEqual(1);

    const [cancelled] = await db.select().from(agentTasks).where(eq(agentTasks.id, queuedId));
    expect(cancelled.status).toBe('cancelled');
    expect((cancelled.error as { code?: string }).code).toBe('AI_EXECUTION_DISABLED');

    // After the acknowledgement, no creation may succeed.
    for (let i = 0; i < 3; i += 1) {
      await expect(
        createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
      ).rejects.toMatchObject({ statusCode: 503 });
    }

    // An ADMIN may stop but may not lift: the stop needs one authority, lifting
    // it needs an independent (higher) one.
    const adminResume = await admin.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: false, reason: 'drill over' },
    });
    expect(adminResume.status).toBe(403);

    // Resuming does NOT resurrect the cancelled work (no silent replay).
    const superAdmin = await createUser('SUPER_ADMIN');
    const resume = await superAdmin.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: false, reason: 'drill over' },
    });
    expect(resume.status).toBe(200);
    const [stillCancelled] = await db.select().from(agentTasks).where(eq(agentTasks.id, queuedId));
    expect(stillCancelled.status).toBe('cancelled');
  });
});

describe('FLEET-01 — the control store failing means refuse, never allow', () => {
  it('fails closed over HTTP and in the service when the table cannot be read', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');

    await db.execute('ALTER TABLE ai_execution_switches RENAME TO ai_execution_switches_unreadable');
    try {
      const state = await readExecutionSwitchState(dbB);
      expect(state).toMatchObject({ enabled: false, source: 'unavailable', failClosed: true });

      const read = await admin.client.req(SWITCH_PATH);
      expect(read.status).toBe(200);
      expect(read.data.data).toMatchObject({ enabled: false, source: 'unavailable', failClosed: true });

      await expect(
        createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
      ).rejects.toMatchObject({ statusCode: 503, message: AI_CONTROL_UNAVAILABLE_MESSAGE });
    } finally {
      await db.execute('ALTER TABLE ai_execution_switches_unreadable RENAME TO ai_execution_switches');
    }
    const restored = await readExecutionSwitchState(dbB);
    expect(restored.source).toBe('database');
  });
});

describe('FLEET-01 — an individual resume cannot bypass the global stop', () => {
  it('keeps the agent stopped with a 409 while the platform is stopped', async () => {
    const admin = await createUser('ADMIN');
    await admin.client.req(agentPath('sales-agent'), { method: 'POST', body: { stopped: true, reason: 'x' } });
    await admin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true, reason: 'global' } });

    const attempt = await admin.client.req(agentPath('sales-agent'), {
      method: 'POST',
      body: { stopped: false, reason: 'try to sneak back' },
    });
    expect(attempt.status).toBe(409);

    const state = await readExecutionSwitchState(dbB);
    expect(state.stoppedAgents).toContain('sales-agent');
    expect(state.globalStopped).toBe(true);
  });
});

describe('FLEET-01 — the decision survives a restart (no process memory)', () => {
  it('is read from the database by a fresh pool and a fresh app', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');
    await admin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true, reason: 'restart drill' } });

    // Fresh connections: nothing of the writing instance is reused.
    const freshPool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    const freshDb = drizzle(freshPool, { schema }) as unknown as DB;
    try {
      const state = await readExecutionSwitchState(freshDb);
      expect(state).toMatchObject({ enabled: false, source: 'database', globalStopped: true });
      expect(state.global?.reason).toBe('restart drill');
      await expect(
        createAgentTask(freshDb, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
      ).rejects.toMatchObject({ statusCode: 503 });
      const freshApp = createApp();
      const read = await makeClient(freshApp).req(SWITCH_PATH);
      expect(read.status).toBe(401);
    } finally {
      await freshPool.end();
    }
  });
});

describe('FLEET-01 — audit records who/what/why/version, and stays silent on no-ops', () => {
  it('records the stop, skips an unchanged stop, and flags a non-independent resume', async () => {
    const first = await createUser('SUPER_ADMIN');
    const second = await createUser('SUPER_ADMIN');

    const before = await auditCount('AI.EXECUTION_STOPPED');
    const stop = await first.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: true, reason: 'audit drill' },
    });
    expect(stop.status).toBe(200);
    expect(await auditCount('AI.EXECUTION_STOPPED')).toBe(before + 1);

    const entry = await latestAuditFor('AI.EXECUTION_STOPPED', first.id);
    expect(entry.actorId).toBe(first.id);
    expect(entry.entityType).toBe('AI_EXECUTION_SWITCH');
    expect(entry.metadata).toMatchObject({ scope: 'GLOBAL', targetKey: '*', reason: 'audit drill' });

    // Same state again: nothing is written.
    const again = await first.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: true, reason: 'duplicate' },
    });
    expect(again.status).toBe(200);
    expect(again.data.data.changed).toBe(false);
    expect(await auditCount('AI.EXECUTION_STOPPED')).toBe(before + 1);

    // A different SUPER_ADMIN resumes: recorded as an independent resume.
    const resume = await second.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: false, reason: 'reviewed' },
    });
    expect(resume.status).toBe(200);
    expect(resume.data.data.independentResume).toBe(true);
    const resumed = await latestAuditFor('AI.EXECUTION_RESUMED', second.id);
    expect(resumed.actorId).toBe(second.id);
    expect(resumed.metadata).toMatchObject({ reason: 'reviewed', independentResume: true });

    // The same operator who stops may lift it — allowed, but NOT independent.
    await first.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true, reason: 'self test' } });
    const selfResume = await first.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: false, reason: 'self lift' },
    });
    expect(selfResume.status).toBe(200);
    expect(selfResume.data.data.independentResume).toBe(false);
    const selfEntry = await latestAuditFor('AI.EXECUTION_RESUMED', first.id);
    expect(selfEntry.metadata).toMatchObject({ independentResume: false });
  });
});

describe('FLEET-01 — RBAC on the control surface', () => {
  it('refuses anonymous, customer and support callers; ADMIN cannot lift a global stop', async () => {
    const anonymous = await makeClient(appA).req(GLOBAL_PATH, { method: 'POST', body: { stopped: true } });
    expect(anonymous.status).toBe(401);

    const customer = await createUser('CUSTOMER');
    expect((await customer.client.req(SWITCH_PATH)).status).toBe(403);
    expect((await customer.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true } })).status).toBe(403);

    const support = await createUser('SUPPORT');
    expect((await support.client.req(SWITCH_PATH)).status).toBe(403);

    const admin = await createUser('ADMIN');
    expect((await admin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true } })).status).toBe(200);
    const lift = await admin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: false } });
    expect(lift.status).toBe(403);

    const superAdmin = await createUser('SUPER_ADMIN');
    expect((await superAdmin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: false } })).status).toBe(200);
  });

  it('accepts only known agent keys', async () => {
    const admin = await createUser('ADMIN');
    const unknown = await admin.client.req(agentPath('not-a-real-agent'), {
      method: 'POST',
      body: { stopped: true },
    });
    expect(unknown.status).toBe(404);
  });
});

describe('FLEET-01 — concurrency: a stop racing task creation', () => {
  it('leaves no queued task and no successful creation after the stop commits', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');
    const queuedId = await insertQueuedTask(owner.id, 'support-agent');

    const creations = Array.from({ length: 20 }, () =>
      createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT).then(
        (task) => ({ ok: true as const, task }),
        (error: { statusCode?: number }) => ({ ok: false as const, status: error.statusCode }),
      ),
    );
    const stop = admin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true, reason: 'race drill' } });

    const [stopResult, ...creationResults] = await Promise.all([stop, ...creations]);
    expect(stopResult.status).toBe(200);

    // Invariant 1: nothing is left waiting to be picked up.
    const queued = await db.select().from(agentTasks).where(eq(agentTasks.status, 'queued'));
    expect(queued).toHaveLength(0);
    const [drained] = await db.select().from(agentTasks).where(eq(agentTasks.id, queuedId));
    expect(drained.status).toBe('cancelled');

    // Invariant 2: every creation either succeeded BEFORE the stop (and was
    // drained) or was refused with the switch's 503 — never an unhandled path.
    for (const result of creationResults) {
      if (result.ok) {
        createdTaskIds.push(result.task.id);
        const [row] = await db.select().from(agentTasks).where(eq(agentTasks.id, result.task.id));
        expect(['cancelled', 'failed', 'approved', 'succeeded']).toContain(row.status);
      } else {
        expect(result.status).toBe(503);
      }
    }
    // A creation issued after the acknowledgement is always refused.
    await expect(
      createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('FLEET-01 — an agent stop belongs to that agent only, under lock', () => {
  /** Two stopped agents and one open one: a "first AGENT row" lookup answers wrong. */
  async function seedAgentRows(): Promise<void> {
    await db.insert(aiExecutionSwitches).values([
      { id: randomUUID(), scope: 'AGENT', targetKey: 'analytics-agent', stopped: true, reason: 'regression', actorId: null, version: 1 },
      { id: randomUUID(), scope: 'AGENT', targetKey: 'product-agent', stopped: true, reason: 'regression', actorId: null, version: 1 },
      { id: randomUUID(), scope: 'AGENT', targetKey: 'support-agent', stopped: false, reason: null, actorId: null, version: 1 },
    ]);
  }

  it('refuses every stopped agent and never blocks the open one', async () => {
    const owner = await createUser('SUPER_ADMIN');
    await seedAgentRows();

    for (const agentKey of ['analytics-agent', 'product-agent']) {
      await expect(
        createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey, requestedBy: owner.id, input: {} }, AUDIT),
      ).rejects.toMatchObject({ statusCode: 503, message: AI_AGENT_PAUSED_MESSAGE });
    }

    const allowed = await createAgentTask(
      dbB,
      ['SUPER_ADMIN'],
      owner.id,
      { agentKey: 'support-agent', requestedBy: owner.id, input: {} },
      AUDIT,
    );
    createdTaskIds.push(allowed.id);
    expect(allowed.agentKey).toBe('support-agent');
  });

  it('the in-transaction check reads the caller own AGENT row', async () => {
    await seedAgentRows();

    for (const agentKey of ['analytics-agent', 'product-agent']) {
      await expect(
        db.transaction((tx) => lockAndAssertExecutionAllowed(tx, agentKey)),
      ).rejects.toMatchObject({ statusCode: 503, message: AI_AGENT_PAUSED_MESSAGE });
    }
    await expect(db.transaction((tx) => lockAndAssertExecutionAllowed(tx, 'support-agent'))).resolves.toBeUndefined();
    // No agent key: only the GLOBAL row decides.
    await expect(db.transaction((tx) => lockAndAssertExecutionAllowed(tx, null))).resolves.toBeUndefined();
  });

  it('a stop waits for the in-flight creation and then refuses the next one', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('SUPER_ADMIN');

    // Hold the same share lock `createAgentTask` takes, standing in for a
    // creation that has already passed its check but has not committed yet.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inTransaction = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = dbC.transaction(async (tx) => {
      await lockAndAssertExecutionAllowed(tx, 'sales-agent');
      entered();
      await gate;
    });
    await inTransaction;

    const stop = admin.client.req(agentPath('sales-agent'), {
      method: 'POST',
      body: { stopped: true, reason: 'race drill: one agent' },
    });
    const first = await Promise.race([
      stop.then(() => 'stopped' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 400)),
    ]);
    // The stop cannot commit while a creation holds the share lock.
    expect(first).toBe('waiting');

    release();
    await holder;
    expect((await stop).status).toBe(200);

    // Once the stop is committed, the next creation for that agent is refused.
    await expect(
      createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'sales-agent', requestedBy: owner.id, input: {} }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503, message: AI_AGENT_PAUSED_MESSAGE });
    // ...and only that agent: an open one still runs.
    const open = await createAgentTask(
      dbB,
      ['SUPER_ADMIN'],
      owner.id,
      { agentKey: 'support-agent', requestedBy: owner.id, input: {} },
      AUDIT,
    );
    createdTaskIds.push(open.id);
  });
});

describe('FLEET-01 — a refused control attempt is recorded, and nothing else is', () => {
  it('records an ADMIN trying to lift the global stop, and the env-belt conflict', async () => {
    const admin = await createUser('ADMIN');
    const superAdmin = await createUser('SUPER_ADMIN');
    await superAdmin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: true, reason: 'drill' } });

    const before = await auditCount('AI.EXECUTION_CONTROL_REFUSED');
    const refused = await admin.client.req(GLOBAL_PATH, {
      method: 'POST',
      body: { stopped: false, reason: 'let me lift it' },
    });
    expect(refused.status).toBe(403);
    expect(await auditCount('AI.EXECUTION_CONTROL_REFUSED')).toBe(before + 1);
    const entry = await latestAuditFor('AI.EXECUTION_CONTROL_REFUSED', admin.id);
    expect(entry.entityType).toBe('AI_EXECUTION_SWITCH');
    expect(entry.metadata).toMatchObject({ scope: 'GLOBAL', requested: 'RESUME', status: 403 });
    // The refusal changes nothing.
    expect((await superAdmin.client.req(SWITCH_PATH)).data.data.globalStopped).toBe(true);

    // The environment belt refuses a database resume with 409 — also recorded.
    env.AI_AGENT_EXECUTION_ENABLED = false;
    const conflicted = await superAdmin.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: false } });
    expect(conflicted.status).toBe(409);
    const envEntry = await latestAuditFor('AI.EXECUTION_CONTROL_REFUSED', superAdmin.id);
    expect(envEntry.metadata).toMatchObject({ scope: 'GLOBAL', requested: 'RESUME', status: 409 });
  });

  it('does not record ordinary failures such as an unknown agent key', async () => {
    const admin = await createUser('ADMIN');
    const before = await auditCount('AI.EXECUTION_CONTROL_REFUSED');
    expect((await admin.client.req(agentPath('not-a-real-agent'), { method: 'POST', body: { stopped: true } })).status).toBe(404);
    expect(await auditCount('AI.EXECUTION_CONTROL_REFUSED')).toBe(before);
  });
});

describe('FLEET-01 — the pre-fleet kill-switch endpoint keeps its contract', () => {
  it('returns the whole state, including the stopped agents, not just enabled/source', async () => {
    // Lifting the global stop is a SUPER_ADMIN act on every surface, the legacy
    // one included (the pre-fleet route maps `enabled:true` to a resume).
    const admin = await createUser('SUPER_ADMIN');
    expect(
      (await admin.client.req(agentPath('analytics-agent'), { method: 'POST', body: { stopped: true, reason: 'legacy drill' } }))
        .status,
    ).toBe(200);

    const legacy = await admin.client.req('/api/admin/ai/kill-switch', {
      method: 'POST',
      body: { enabled: true, reason: 'legacy resume of the global row' },
    });
    expect(legacy.status).toBe(200);
    const data = legacy.data.data;
    // The pre-fleet fields a client could read before the fleet release.
    expect(data.enabled).toBe(true);
    expect(data.source).toBe('database');
    expect(data.stoppedAgents).toEqual(['analytics-agent']);
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.failClosed).toBe(false);
    // ...and the fleet fields are still there.
    expect(data.scope).toBe('GLOBAL');
    expect(data.targetKey).toBe('*');
    expect(data.state.globalStopped).toBe(false);
  });
});

describe('FLEET-01 — the environment belt can stop but never re-open', () => {
  it('keeps execution stopped while the env flag is off, and refuses a database resume', async () => {
    const owner = await createUser('SUPER_ADMIN');
    env.AI_AGENT_EXECUTION_ENABLED = false;

    const state = await readExecutionSwitchState(dbB);
    expect(state).toMatchObject({ enabled: false, source: 'env', envStopped: true });

    // Even the authority that may lift the database stop cannot lift the belt.
    const resume = await owner.client.req(GLOBAL_PATH, { method: 'POST', body: { stopped: false } });
    expect(resume.status).toBe(409);

    await expect(
      createAgentTask(dbB, ['SUPER_ADMIN'], owner.id, { agentKey: 'support-agent', requestedBy: owner.id, input: {} }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 503 });

    env.AI_AGENT_EXECUTION_ENABLED = true;
    const open = await readExecutionSwitchState(dbB);
    expect(open.enabled).toBe(true);
  });
});

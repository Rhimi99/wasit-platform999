import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE, COPILOT_KEY } from '../src/modules/ai/catalogue.js';
import { createAgentTask, getTask, syncAgentRegistry } from '../src/modules/ai/runner.js';
import { executeAgentTask } from '../src/modules/ai/executors.js';
import { routeEvents, planRouteEvents, EVENT_ROUTING } from '../src/modules/ai/copilot.js';
import { invokeTool } from '../src/lib/ai/tool-gateway.js';

const AUDIT = { actorId: 'test' };

async function insertStaff(
  roleName: 'ADMIN' | 'SUPER_ADMIN' | 'RISK' | 'DISPUTE' | 'MERCHANT' | 'CUSTOMER' = 'ADMIN',
) {
  const id = randomUUID();
  const email = `ai03-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Ai03Pass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

async function countCopilotTasks(): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(eq(agentTasks.agentKey, COPILOT_KEY));
  return rows[0]?.v ?? 0;
}

describe('AI-03.2 — the Copilot cannot be created as an agent task (L-1)', () => {
  let admin: { id: string; email: string };

  beforeEach(async () => {
    admin = await insertStaff('SUPER_ADMIN');
    await syncAgentRegistry(db);
  });

  it('refuses to create a task for the Copilot, even for a SUPER_ADMIN', async () => {
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], admin.id, {
        agentKey: COPILOT_KEY,
        requestedBy: admin.id,
        input: {},
        taskType: 'copilot.route_event',
      }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not persist any task row when the creation is refused', async () => {
    const before = await countCopilotTasks();
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], admin.id, {
        agentKey: COPILOT_KEY,
        requestedBy: admin.id,
        input: {},
      }, AUDIT),
    ).rejects.toThrow();
    expect(await countCopilotTasks()).toBe(before);
  });

  it('still creates and runs a task for an allowed specialised agent', async () => {
    const created = await createAgentTask(db, ['SUPER_ADMIN'], admin.id, {
      agentKey: 'product-agent',
      requestedBy: admin.id,
      input: {},
    }, AUDIT);
    expect(created.agentKey).toBe('product-agent');
    expect(created.status).toBe('succeeded');
    const fetched = await getTask(db, created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('keeps Copilot preview and routing working (specialised agents only)', async () => {
    const preview = await planRouteEvents(db, ['dispute.opened'], ['SUPER_ADMIN']);
    expect(preview).toHaveLength(1);
    expect(preview[0].agentKey).toBe(EVENT_ROUTING['dispute.opened'].agentKey);
    expect(preview[0].agentKey).not.toBe(COPILOT_KEY);
    expect(preview[0].runnable).toBe(true);

    const result = await routeEvents(db, [{ event: 'dispute.opened', payload: {} }], admin.id, ['SUPER_ADMIN'], AUDIT);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0].agentKey).not.toBe(COPILOT_KEY);
    expect(result.routed[0].agentKey).toBe(EVENT_ROUTING['dispute.opened'].agentKey);
  });

  it('blocks a legacy Copilot task from reaching a specialised executor (defence in depth)', async () => {
    // Simulate a row that predates the creation-time guard by inserting it
    // directly, then driving the execution boundary with the Copilot definition.
    await expect(executeAgentTask(db, COPILOT_CATALOGUE, {})).rejects.toThrow(/coordinator/i);
  });

  it('fails a legacy Copilot task through the runner without running an executor', async () => {
    // A pre-guard row cannot be created via the API any more; insert it directly
    // to prove the runner's execution boundary still contains it.
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: COPILOT_KEY,
      requestedBy: admin.id,
      taskType: 'copilot.route_event',
      input: {} as never,
      status: 'queued',
      requiresApproval: false,
      correlationId: randomUUID(),
      triggeredBy: 'user',
      maxAttempts: 1,
      model: 'local-heuristic',
    });
    const { runTask } = await import('../src/modules/ai/runner.js');
    const after = await runTask(db, taskId, AUDIT);
    expect(after.status).toBe('failed');
    expect(JSON.stringify(after.error ?? {})).toMatch(/coordinator/i);
  });

  it('no catalogue route targets the Copilot key as an executable agent', () => {
    expect(COPILOT_CATALOGUE.isCopilot).toBe(true);
    for (const route of Object.values(EVENT_ROUTING)) {
      expect(route.agentKey).not.toBe(COPILOT_KEY);
    }
    // The specialised catalogue never contains the coordinator.
    expect(AGENT_CATALOGUE.some((a) => a.key === COPILOT_KEY)).toBe(false);
  });

  it('does not change the permission or approval behaviour of other agents', async () => {
    // A gated, sensitive agent still lands in awaiting_approval and writes a row.
    const gated = await createAgentTask(db, ['SUPER_ADMIN'], admin.id, {
      agentKey: 'finance-agent',
      requestedBy: admin.id,
      input: {},
    }, AUDIT);
    expect(gated.status).toBe('awaiting_approval');
    expect(gated.approvalAction).toBeTruthy();

    // The gateway still refuses an ungranted tool (RBAC/scope untouched).
    await expect(invokeTool(db, 'platform.metrics', {})).rejects.toBeTruthy();
  });
});

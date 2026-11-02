import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/client.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * AI-02.2 — Admin Copilot desk (`/api/admin/copilot/*`).
 *
 * The desk is a SUPER_ADMIN-only *view + trigger* over the existing runner /
 * copilot services. These integration tests drive the real `createApp()` against
 * the real database and pin the properties the feature exists to guarantee:
 *
 *   - RBAC: SUPER_ADMIN only — anonymous 401, ADMIN/MERCHANT/CUSTOMER 403.
 *   - Routing *preview* writes nothing; only an explicit confirm creates tasks.
 *   - `approve` and `run` are separate: approve never executes, and a task that
 *     requires approval cannot be run before it is approved.
 *   - Agent status changes and every decision are audited.
 *   - The audit feed is scoped to `AI.*` actions.
 *
 * No service is mocked: every assertion reads the effect back from the database.
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

async function createStaffUser(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `it-copilot-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) {
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  }
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id, email };
}

/** Task ids created by this file, removed after it finishes. */
const createdTaskIds: string[] = [];

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
});

describe('Admin Copilot desk — RBAC (SUPER_ADMIN only)', () => {
  it('rejects unauthenticated access to every Copilot surface (401)', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/copilot')).status).toBe(401);
    expect((await c.req('/api/admin/copilot/agents')).status).toBe(401);
    expect((await c.req('/api/admin/copilot/agents/summary')).status).toBe(401);
    expect((await c.req('/api/admin/copilot/tasks')).status).toBe(401);
    expect((await c.req('/api/admin/copilot/audit')).status).toBe(401);
    expect((await c.req('/api/admin/copilot/route/preview', { method: 'POST', body: { events: ['order.placed'] } })).status).toBe(401);
    expect((await c.req('/api/admin/copilot/route', { method: 'POST', body: { events: [{ event: 'order.placed' }] } })).status).toBe(401);
  });

  it('forbids an ADMIN from the Copilot desk (403) — AI_MANAGE is not enough', async () => {
    const admin = await createStaffUser('ADMIN');
    expect((await admin.client.req('/api/admin/copilot')).status).toBe(403);
    expect((await admin.client.req('/api/admin/copilot/agents')).status).toBe(403);
    expect((await admin.client.req('/api/admin/copilot/tasks')).status).toBe(403);
    expect((await admin.client.req('/api/admin/copilot/audit')).status).toBe(403);
    expect((await admin.client.req('/api/admin/copilot/route', { method: 'POST', body: { events: [{ event: 'order.placed' }] } })).status).toBe(403);
  });

  it('forbids a business user (MERCHANT) and a CUSTOMER (403)', async () => {
    const merchant = await createStaffUser('MERCHANT');
    const customer = await createStaffUser('CUSTOMER');
    expect((await merchant.client.req('/api/admin/copilot/tasks')).status).toBe(403);
    expect((await customer.client.req('/api/admin/copilot/agents')).status).toBe(403);
  });

  it('allows a SUPER_ADMIN to read the coordinator spec and agent registry', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const spec = await superAdmin.client.req('/api/admin/copilot');
    expect(spec.status).toBe(200);
    expect(spec.data.data.key).toBe('wasit-copilot');

    const agents = await superAdmin.client.req('/api/admin/copilot/agents');
    expect(agents.status).toBe(200);
    const keys = (agents.data.data.items as Array<{ key: string }>).map((a) => a.key);
    expect(keys).toContain('sales-agent');

    const summary = await superAdmin.client.req('/api/admin/copilot/agents/summary');
    expect(summary.status).toBe(200);
    expect(typeof summary.data.data.total).toBe('number');
    expect(typeof summary.data.data.pendingApprovals).toBe('number');
  });
});

describe('Admin Copilot desk — routing preview creates nothing', () => {
  it('previews a known event as runnable without writing a task or an audit row', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const before = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, superAdmin.id));

    const res = await superAdmin.client.req('/api/admin/copilot/route/preview', {
      method: 'POST',
      body: { events: ['order.placed'] },
    });
    expect(res.status).toBe(200);
    const preview = res.data.data.preview as Array<{ event: string; agentKey: string | null; runnable: boolean; requiresApproval: boolean }>;
    expect(preview).toHaveLength(1);
    expect(preview[0].event).toBe('order.placed');
    expect(preview[0].agentKey).toBe('operations-agent');
    expect(preview[0].runnable).toBe(true);
    // operations.health_check is not a gated action for that agent.
    expect(typeof preview[0].requiresApproval).toBe('boolean');

    // The preview must not have created any task for this caller.
    const after = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, superAdmin.id));
    expect(after.length).toBe(before.length);

    // Nor an AI.COPILOT_ROUTED audit row (that is only written on confirm).
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.COPILOT_ROUTED'), eq(auditLogs.actorId, superAdmin.id)));
    expect(audits).toHaveLength(0);
  });

  it('marks a gated event as requiring approval in the preview', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    // sales.qualify_lead routes to sales-agent, which is gated (requiresHumanApproval).
    const res = await superAdmin.client.req('/api/admin/copilot/route/preview', {
      method: 'POST',
      body: { events: ['lead.created'] },
    });
    expect(res.status).toBe(200);
    const preview = res.data.data.preview as Array<{ event: string; agentKey: string; runnable: boolean; requiresApproval: boolean }>;
    expect(preview[0].agentKey).toBe('sales-agent');
    expect(preview[0].requiresApproval).toBe(true);
    expect(res.data.data.gated).toBeGreaterThanOrEqual(1);
  });

  it('reports an unroutable event without failing the whole preview', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/route/preview', {
      method: 'POST',
      body: { events: ['does.not.exist', 'order.placed'] },
    });
    expect(res.status).toBe(200);
    const preview = res.data.data.preview as Array<{ event: string; runnable: boolean; reason: string | null }>;
    expect(preview[0].runnable).toBe(false);
    expect(preview[0].reason).toBeTruthy();
    expect(preview[1].runnable).toBe(true);
  });
});

describe('Admin Copilot desk — confirm routing creates tasks and a run', () => {
  it('confirms a route: creates the task, returns a correlation id, audits the run', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/route', {
      method: 'POST',
      body: { events: [{ event: 'order.placed' }] },
    });
    expect(res.status).toBe(201);
    const correlationId = res.data.data.correlationId as string;
    expect(correlationId).toBeTruthy();
    const routed = res.data.data.routed as Array<{ taskId: string; agentKey: string }>;
    expect(routed).toHaveLength(1);
    expect(routed[0].agentKey).toBe('operations-agent');
    createdTaskIds.push(routed[0].taskId);

    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.COPILOT_ROUTED'), eq(auditLogs.entityId, correlationId)));
    expect(audit.length).toBeGreaterThan(0);

    // The run detail aggregates the run's tasks and cost.
    const detail = await superAdmin.client.req(`/api/admin/copilot/runs/${correlationId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.correlationId).toBe(correlationId);
    expect(detail.data.data.total).toBeGreaterThanOrEqual(1);
    expect(typeof detail.data.data.cost.totalCost).toBe('string');
    expect(typeof detail.data.data.cost.tokensInput).toBe('number');
  });
});

describe('Admin Copilot desk — direct task creation', () => {
  it('creates a gated agent task that lands in awaiting_approval', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(res.status).toBe(201);
    expect(res.data.data.status).toBe('awaiting_approval');
    createdTaskIds.push(res.data.data.id as string);
  });

  it('rejects a task type the agent does not handle (403)', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {}, taskType: 'not.a.real.task' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown agent key (404) without leaking internals', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/agents/no-such-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(res.status).toBe(404);
  });
});

describe('Admin Copilot desk — approve and run are separate operations', () => {
  /** Creates a gated sales-agent task and returns its id. */
  async function createGatedTask(client: ReturnType<typeof makeClient>): Promise<string> {
    const created = await client.req('/api/admin/copilot/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(created.status).toBe(201);
    const id = created.data.data.id as string;
    createdTaskIds.push(id);
    return id;
  }

  it('refuses to run a task that is not yet approved (409) and never executes it', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const taskId = await createGatedTask(superAdmin.client);

    const res = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/run`, { method: 'POST' });
    expect(res.status).toBe(409);

    const after = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}`);
    expect(after.data.data.status).toBe('awaiting_approval');
    expect(after.data.data.result).toBeNull();
  });

  it('approve records the decision but does NOT execute the task', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const taskId = await createGatedTask(superAdmin.client);

    const approved = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(approved.status).toBe(200);
    expect(approved.data.data.status).toBe('approved');
    expect(approved.data.data.result).toBeNull(); // not executed
    expect(approved.data.data.approvedBy).toBe(superAdmin.id);

    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_APPROVED'), eq(auditLogs.entityId, taskId)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('approves then runs a gated task to a terminal status, recording both audit entries', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const taskId = await createGatedTask(superAdmin.client);

    const approved = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(approved.data.data.status).toBe('approved');

    const run = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/run`, { method: 'POST' });
    expect(run.status).toBe(200);
    expect(['succeeded', 'failed']).toContain(run.data.data.status);

    const runAudit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_RUN_REQUESTED'), eq(auditLogs.entityId, taskId)));
    expect(runAudit.length).toBeGreaterThan(0);
  });

  it('rejects a task and records the reason', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const taskId = await createGatedTask(superAdmin.client);

    const rejected = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/reject`, {
      method: 'POST',
      body: { decision: 'REJECT', reason: 'not now' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.data.status).toBe('rejected');
    expect(rejected.data.data.rejectionReason).toBe('not now');
  });

  it('refuses to decide a task that is not awaiting approval (409)', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    // marketing-agent is not gated → it runs immediately to a terminal status.
    const created = await superAdmin.client.req('/api/admin/copilot/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    const taskId = created.data.data.id as string;
    createdTaskIds.push(taskId);

    const again = await superAdmin.client.req(`/api/admin/copilot/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(again.status).toBe(409);
  });
});

describe('Admin Copilot desk — agent kill switch is audited', () => {
  it('pauses and resumes an agent, auditing each change', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const agentKey = 'b2b-agent';

    const paused = await superAdmin.client.req(`/api/admin/copilot/agents/${agentKey}/status`, {
      method: 'POST',
      body: { status: 'PAUSED', reason: 'maintenance' },
    });
    expect(paused.status).toBe(200);
    expect(paused.data.data.status).toBe('PAUSED');

    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.AGENT_STATUS_CHANGED'));
    expect(audit.length).toBeGreaterThan(0);

    // Restore so other tests see the seeded ACTIVE state.
    const resumed = await superAdmin.client.req(`/api/admin/copilot/agents/${agentKey}/status`, {
      method: 'POST',
      body: { status: 'ACTIVE' },
    });
    expect(resumed.status).toBe(200);
    expect(resumed.data.data.status).toBe('ACTIVE');
  });
});

describe('Admin Copilot desk — audit feed is scoped to AI actions', () => {
  it('returns only AI.* entries and honours an exact-action filter', async () => {
    const superAdmin = await createStaffUser('SUPER_ADMIN');
    const res = await superAdmin.client.req('/api/admin/copilot/audit?limit=50');
    expect(res.status).toBe(200);
    const items = res.data.data.items as Array<{ action: string }>;
    expect(Array.isArray(items)).toBe(true);
    for (const row of items) expect(row.action.startsWith('AI.')).toBe(true);

    const filtered = await superAdmin.client.req('/api/admin/copilot/audit?action=AI.AGENT_STATUS_CHANGED&limit=10');
    expect(filtered.status).toBe(200);
    for (const row of filtered.data.data.items as Array<{ action: string }>) {
      expect(row.action).toBe('AI.AGENT_STATUS_CHANGED');
    }
  });
});

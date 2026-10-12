import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/client.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { aiBudgets, aiModels } from '../src/db/schema/ai.js';

/**
 * Admin AI governance — contract + RBAC for the surfaces the new `/admin/ai`
 * desk consumes. The page adds no new backend; these tests pin the exact
 * shapes the UI reads so a silent contract drift fails here first.
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

async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `it-adminai-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
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

describe('Admin AI governance desk (contract + RBAC)', () => {
  it('rejects unauthenticated access to every admin AI surface', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/ai/usage')).status).toBe(401);
    expect((await c.req('/api/admin/ai/requests')).status).toBe(401);
    expect((await c.req('/api/admin/ai/budgets')).status).toBe(401);
    expect((await c.req('/api/admin/ai/models')).status).toBe(401);
    expect((await c.req('/api/admin/ai/agents')).status).toBe(401);
    expect((await c.req('/api/admin/ai/tasks')).status).toBe(401);
  });

  it('forbids a non-admin (CUSTOMER) from the AI governance surface', async () => {
    const { client } = await createStaffUser('CUSTOMER');
    expect((await client.req('/api/admin/ai/usage')).status).toBe(403);
    expect((await client.req('/api/admin/ai/models')).status).toBe(403);
    expect((await client.req('/api/admin/ai/tasks')).status).toBe(403);
  });

  it('forbids a business user (MERCHANT) from the AI governance surface', async () => {
    const { client } = await createStaffUser('MERCHANT');
    expect((await client.req('/api/admin/ai/usage')).status).toBe(403);
  });

  it('returns the usage shape the Overview tab renders', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/usage');
    expect(r.status).toBe(200);
    const d = r.data.data;
    expect(typeof d.window.start).toBe('string');
    expect(typeof d.window.end).toBe('string');
    expect(typeof d.totals.requests).toBe('number');
    expect(typeof d.totals.tokensInput).toBe('number');
    expect(typeof d.totals.tokensOutput).toBe('number');
    expect(typeof d.totals.cost).toBe('string');
    expect(typeof d.totals.distinctUsers).toBe('number');
    expect(Array.isArray(d.budgets)).toBe(true);
  });

  it('returns the model catalogue rows the Models tab renders', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/models');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    const local = items.find((m) => m.key === 'local-heuristic');
    expect(local).toBeTruthy();
    for (const field of ['id', 'key', 'displayName', 'provider', 'inputPer1k', 'outputPer1k', 'currencyCode', 'isActive']) {
      expect(local).toHaveProperty(field);
    }
  });

  it('returns the agent registry rows the Agents tab renders (with the approval gate flag)', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/agents');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<{ key: string; requiresHumanApproval: boolean }>;
    const sales = items.find((a) => a.key === 'sales-agent');
    const marketing = items.find((a) => a.key === 'marketing-agent');
    expect(sales?.requiresHumanApproval).toBe(true);
    expect(marketing?.requiresHumanApproval).toBe(false);
  });

  it('seeds and returns the full catalogue even when no user has invoked an agent', async () => {
    // Regression: the registry read must not depend on a prior user-facing
    // /api/ai/agents call to populate it.
    //
    // The registry is a single shared table, and vitest runs test *files* in
    // parallel against one database. Emptying it with an unqualified
    // `delete(agentRegistry)` makes the table globally empty for a few
    // milliseconds, which a parallel file (e.g. phase19) can observe as a
    // missing agent — a cross-file race. Instead, empty and re-read the table
    // inside a transaction that always rolls back: the emptied state is visible
    // only to this transaction, so no other file can observe it.
    const { agentRegistry } = await import('../src/db/schema/agents.js');
    const { listRegistryAgents } = await import('../src/modules/ai/runner.js');
    class RollbackAfterAssert extends Error {}
    await db
      .transaction(async (tx) => {
        await tx.delete(agentRegistry);
        // `listRegistryAgents` is exactly what GET /api/admin/ai/agents reads;
        // it must lazily (re)seed the full catalogue from an empty table.
        const items = await listRegistryAgents(tx as unknown as typeof db);
        expect(items.length).toBeGreaterThanOrEqual(11);
        expect(items.map((a) => a.key)).toContain('sales-agent');
        throw new RollbackAfterAssert('rollback-after-assert');
      })
      .catch((err) => {
        if (!(err instanceof RollbackAfterAssert)) throw err;
      });
  });

  it('returns the requests feed and the tasks feed as { items: [] } collections', async () => {
    const { client } = await createStaffUser('ADMIN');
    const reqs = await client.req('/api/admin/ai/requests?limit=10');
    expect(reqs.status).toBe(200);
    expect(Array.isArray(reqs.data.data.items)).toBe(true);

    const tasks = await client.req('/api/admin/ai/tasks');
    expect(tasks.status).toBe(200);
    expect(Array.isArray(tasks.data.data.items)).toBe(true);
  });

  it('filters the admin task feed by status and agentKey', async () => {
    const { client } = await createStaffUser('ADMIN');
    const filtered = await client.req('/api/admin/ai/tasks?status=awaiting_approval&agentKey=sales-agent&limit=5');
    expect(filtered.status).toBe(200);
    const items = filtered.data.data.items as Array<{ status: string; agentKey: string }>;
    for (const t of items) {
      expect(t.status).toBe('awaiting_approval');
      expect(t.agentKey).toBe('sales-agent');
    }
  });

  it('creates/updates a budget through the desk contract, then lists it with audit', async () => {
    const admin = await createStaffUser('ADMIN');

    const upsert = await admin.client.req('/api/admin/ai/budgets', {
      method: 'POST',
      body: {
        roleTarget: 'MERCHANT',
        period: 'MONTHLY',
        maxRequests: 42,
        maxCost: '9.5000000000',
        currencyCode: 'USD',
        isActive: true,
      },
    });
    expect([200, 201]).toContain(upsert.status);
    const budgetId = upsert.data.data.id as string;
    expect(upsert.data.data.roleTarget).toBe('MERCHANT');
    expect(upsert.data.data.maxRequests).toBe(42);
    expect(upsert.data.data.maxCost).toBe('9.5000000000');

    const list = await admin.client.req('/api/admin/ai/budgets');
    expect(list.status).toBe(200);
    const found = (list.data.data.items as Array<{ id: string }>).find((b) => b.id === budgetId);
    expect(found).toBeTruthy();

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.BUDGET_UPSERTED'), eq(auditLogs.entityId, budgetId)));
    expect(audit.length).toBeGreaterThan(0);

    // Cleanup the row this test created so the suite stays idempotent.
    await db.delete(aiBudgets).where(eq(aiBudgets.id, budgetId));
  });

  it('rejects a budget with neither userId nor roleTarget (422)', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/budgets', {
      method: 'POST',
      body: { period: 'MONTHLY', isActive: true },
    });
    expect(r.status).toBe(422);
  });

  it('rejects a budget targeting both userId and roleTarget (422)', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/budgets', {
      method: 'POST',
      body: { userId: randomUUID(), roleTarget: 'MERCHANT', period: 'MONTHLY' },
    });
    expect(r.status).toBe(422);
  });

  it('upserts a model through the desk contract (insert then update by key)', async () => {
    const admin = await createStaffUser('ADMIN');
    const key = `e2e-model-${Date.now()}`;

    const created = await admin.client.req('/api/admin/ai/models', {
      method: 'POST',
      body: {
        key,
        displayName: 'Smoke Model',
        provider: 'local',
        contextWindow: 8000,
        maxOutputTokens: 1024,
        inputPer1k: '0.5000000000',
        outputPer1k: '1.5000000000',
        currencyCode: 'USD',
        isActive: true,
      },
    });
    expect(created.status).toBe(201);
    const modelId = created.data.data.id as string;
    expect(created.data.data.key).toBe(key);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.MODEL_UPSERTED'), eq(auditLogs.entityId, modelId)));
    expect(audit.length).toBeGreaterThan(0);

    // The same key must update in place, never insert a second row.
    const updated = await admin.client.req('/api/admin/ai/models', {
      method: 'POST',
      body: { key, displayName: 'Smoke Model v2', provider: 'local', isActive: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.data.id).toBe(modelId);
    expect(updated.data.data.displayName).toBe('Smoke Model v2');
    expect(updated.data.data.isActive).toBe(false);

    const list = await admin.client.req('/api/admin/ai/models');
    const rows = (list.data.data.items as Array<{ id: string }>).filter((m) => m.id === modelId);
    expect(rows.length).toBe(1);

    // Cleanup so the shared catalogue stays as seeded for other tests.
    await db.delete(aiModels).where(eq(aiModels.id, modelId));
  });

  it('runs an approval-gated agent task end-to-end from the desk (approve → completed)', async () => {
    const requester = await createStaffUser('ADMIN');
    const approver = await createStaffUser('ADMIN');

    // sales-agent is gated → lands in awaiting_approval.
    const created = await requester.client.req('/api/ai/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(created.status).toBe(201);
    const taskId = created.data.data.id as string;
    expect(created.data.data.status).toBe('awaiting_approval');

    // It appears in the admin queue the Tasks tab reads.
    const queue = await approver.client.req('/api/admin/ai/tasks?status=awaiting_approval');
    expect(queue.status).toBe(200);
    expect((queue.data.data.items as Array<{ id: string }>).some((t) => t.id === taskId)).toBe(true);

    const approved = await approver.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(approved.status).toBe(200);
    expect(approved.data.data.status).toBe('approved');
    expect(approved.data.data.approvedBy).toBe(approver.id);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_APPROVED'), eq(auditLogs.entityId, taskId)));
    expect(audit.length).toBeGreaterThan(0);

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });

  it('rejects a gated task and records the decision', async () => {
    const requester = await createStaffUser('ADMIN');
    const approver = await createStaffUser('ADMIN');

    const created = await requester.client.req('/api/ai/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    const taskId = created.data.data.id as string;

    const rejected = await approver.client.req(`/api/ai/tasks/${taskId}/reject`, {
      method: 'POST',
      body: { decision: 'REJECT', reason: 'not now' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.data.status).toBe('rejected');
    expect(rejected.data.data.rejectionReason).toBe('not now');

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });

  it('refuses to decide a task that is not awaiting approval (409)', async () => {
    const admin = await createStaffUser('ADMIN');
    const created = await admin.client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    // marketing-agent is not gated → it runs immediately to a terminal status.
    const taskId = created.data.data.id as string;
    expect(['succeeded', 'failed']).toContain(created.data.data.status);

    const again = await admin.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(again.status).toBe(409);

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });
});

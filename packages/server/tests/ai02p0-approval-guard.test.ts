import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-02.P0 — separation of duties on agent-task approval.
 *
 * A task's requester must never be able to approve it, whatever their role
 * (SUPER_ADMIN included). The rule lives in the backend service
 * (`decideAgentTask`), not the UI, so every approval surface inherits it. These
 * tests pin the behaviour against the real HTTP stack and the real database.
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

const createdUserIds: string[] = [];

async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN') {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `it-ai02p0-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
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

/** Creates a gated task (sales-agent) as `requester` and returns its id. */
async function createGatedTask(requester: { client: ReturnType<typeof makeClient> }): Promise<string> {
  const created = await requester.client.req('/api/ai/agents/sales-agent/tasks', {
    method: 'POST',
    body: { input: { action: 'identify_leads' } },
  });
  expect(created.status).toBe(201);
  expect(created.data.data.status).toBe('awaiting_approval');
  return created.data.data.id as string;
}

async function taskRow(taskId: string) {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  return rows[0];
}

describe('AI-02.P0 — separation of duties on agent-task approval', () => {
  it('refuses a requester approving their own task (403) and does not run it', async () => {
    const requester = await createStaffUser('ADMIN');
    const taskId = await createGatedTask(requester);

    const self = await requester.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(self.status).toBe(403);

    // The refusal must not have advanced or executed the task.
    const row = await taskRow(taskId);
    expect(row.status).toBe('awaiting_approval');
    expect(row.result).toBeNull();
    expect(row.approvedBy).toBeNull();

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });

  it('refuses a SUPER_ADMIN approving their own task (privilege does not exempt)', async () => {
    const requester = await createStaffUser('SUPER_ADMIN');
    const taskId = await createGatedTask(requester);

    const self = await requester.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(self.status).toBe(403);

    const row = await taskRow(taskId);
    expect(row.status).toBe('awaiting_approval');

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });

  it('allows a different authorised approver to approve and run the task', async () => {
    const requester = await createStaffUser('ADMIN');
    const approver = await createStaffUser('ADMIN');
    const taskId = await createGatedTask(requester);

    const approved = await approver.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE', reason: 'ok' },
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

  it('a rejected task is never executed and the decision is audited', async () => {
    const requester = await createStaffUser('ADMIN');
    const approver = await createStaffUser('ADMIN');
    const taskId = await createGatedTask(requester);

    const rejected = await approver.client.req(`/api/ai/tasks/${taskId}/reject`, {
      method: 'POST',
      body: { decision: 'REJECT', reason: 'not now' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.data.status).toBe('rejected');
    expect(rejected.data.data.rejectionReason).toBe('not now');

    // No execution artefacts: no result, and no COMPLETED audit for this task.
    const row = await taskRow(taskId);
    expect(row.result).toBeNull();
    expect(row.status).toBe('rejected');

    const completed = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_COMPLETED'), eq(auditLogs.entityId, taskId)));
    expect(completed.length).toBe(0);

    const rejectedAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_TASK_REJECTED'), eq(auditLogs.entityId, taskId)));
    expect(rejectedAudit.length).toBeGreaterThan(0);

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });

  it('permits a requester to withdraw (reject) their own task', async () => {
    // Rejecting one's own request is not a conflict of interest: it removes work
    // rather than authorising a sensitive action, so it stays allowed.
    const requester = await createStaffUser('ADMIN');
    const taskId = await createGatedTask(requester);

    const rejected = await requester.client.req(`/api/ai/tasks/${taskId}/reject`, {
      method: 'POST',
      body: { decision: 'REJECT', reason: 'withdrawn by requester' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.data.status).toBe('rejected');

    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
  });
});

afterAll(async () => {
  // Remove the gated tasks and the staff users this spec created (plus their
  // user_roles). No unqualified DELETE, so other specs' rows are never touched.
  await cleanupOwnedRows(db, { userIds: createdUserIds });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { planAgentRun } from '../src/modules/ai/planner.js';

/**
 * AI-02.S1 — Supervisor admin surface: RBAC + containment contract.
 *
 * Pins the authorisation boundary of `/api/admin/ai/supervisor/*` and the
 * manual-containment behaviour (it walks a run to FAILED, audits it, and never
 * approves a sensitive step).
 */

const app = createApp();
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  await cleanupOwnedRows(db, { userIds: createdUserIds, runIds: createdRunIds });
  await closeDb();
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

async function createStaffUser(roleName: string) {
  const id = randomUUID();
  const email = `it-ai024r-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
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
  return { client, id, email };
}

async function makeRun(requester: string, stepKeys: string[] = ['a', 'b']) {
  const p = await planAgentRun(
    db,
    requester,
    { title: 'RBAC run', steps: stepKeys.map((k) => ({ stepKey: k, agentKey: 'marketing-agent', input: {} })) },
    { actorId: null, actorType: 'USER' as const },
  );
  createdRunIds.push(p.runId);
  return p;
}

describe('AI-02.S1 — supervisor admin RBAC', () => {
  it('rejects unauthenticated access to the supervisor surface', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/ai/supervisor/overview')).status).toBe(401);
    expect(
      (await c.req('/api/admin/ai/supervisor/runs/x/contain', { method: 'POST', body: { reason: 'stop' } })).status,
    ).toBe(401);
  });

  it('forbids CUSTOMER, MERCHANT and SUPPLIER from the supervisor surface', async () => {
    for (const roleName of ['CUSTOMER', 'MERCHANT', 'SUPPLIER']) {
      const { client } = await createStaffUser(roleName);
      expect((await client.req('/api/admin/ai/supervisor/overview')).status).toBe(403);
    }
  });

  it('allows ADMIN (holds AI_MANAGE) to read the overview', async () => {
    const { client } = await createStaffUser('ADMIN');
    const r = await client.req('/api/admin/ai/supervisor/overview');
    expect(r.status).toBe(200);
    const d = r.data.data;
    expect(typeof d.activeRuns).toBe('number');
    expect(typeof d.stuckRuns).toBe('number');
    expect(typeof d.failedSteps).toBe('number');
    expect(typeof d.awaitingRetrySteps).toBe('number');
    expect(typeof d.containedRuns).toBe('number');
    expect(typeof d.budgetExceededRuns).toBe('number');
    expect(Array.isArray(d.recentInterventions)).toBe(true);
    expect(d.limits.maxAttempts).toBeGreaterThan(0);
  });

  it('allows SUPER_ADMIN to read the overview', async () => {
    const { client } = await createStaffUser('SUPER_ADMIN');
    expect((await client.req('/api/admin/ai/supervisor/overview')).status).toBe(200);
  });

  it('validates the containment body (reason is required)', async () => {
    const { client, id } = await createStaffUser('SUPER_ADMIN');
    const p = await makeRun(id);
    const r = await client.req(`/api/admin/ai/supervisor/runs/${p.runId}/contain`, { method: 'POST', body: {} });
    expect(r.status).toBe(422);
  });
});

describe('AI-02.S1 — manual containment via the API', () => {
  it('contains a run, audits it, and never approves a sensitive step', async () => {
    const { client, id } = await createStaffUser('SUPER_ADMIN');
    const p = await makeRun(id, ['a', 'b']);

    const r = await client.req(`/api/admin/ai/supervisor/runs/${p.runId}/contain`, {
      method: 'POST',
      body: { reason: 'operator stop' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data.contained).toBe(true);

    const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, p.runId)).limit(1))[0];
    expect(run.status).toBe('FAILED');
    expect((run.error as { contained?: boolean }).contained).toBe(true);

    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, p.runId));
    for (const s of steps) {
      expect(s.status).toBe('CANCELLED');
      // Containment is not an approval: no step is marked approved.
      expect(s.approvedBy).toBeNull();
    }

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, p.runId), eq(auditLogs.action, 'AI.AGENT_RUN_CONTAINED')));
    expect(audits.length).toBe(1);
    expect((audits[0].metadata as { reason?: string }).reason).toBe('operator stop');
    // The manual action is attributed to the acting administrator.
    expect(audits[0].actorId).toBe(id);
  });

  it('refuses to contain an already-finished run', async () => {
    const { client, id } = await createStaffUser('SUPER_ADMIN');
    const p = await makeRun(id);
    const first = await client.req(`/api/admin/ai/supervisor/runs/${p.runId}/contain`, { method: 'POST', body: { reason: 'first' } });
    expect(first.status).toBe(200);
    const second = await client.req(`/api/admin/ai/supervisor/runs/${p.runId}/contain`, { method: 'POST', body: { reason: 'second' } });
    expect(second.status).toBe(409);
  });
});

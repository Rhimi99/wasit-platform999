import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { AGENT_CATALOGUE, listAgents } from '../src/modules/ai/agents.js';
import { declaredOnlyAgents } from '../src/modules/ai/catalogue.js';

/**
 * AI-REG-01 — the API exposes the real agent layer and refuses to run an agent
 * that has no executor.
 *
 * Real HTTP through `createApp`, real PostgreSQL. The refusal must happen
 * before a task row exists, and it must be audited.
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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function registerCustomer() {
  const client = makeClient();
  const email = `it-reg01-${uniq('c')}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Reg', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, email };
}

async function createStaff(roleName: 'ADMIN' | 'SUPER_ADMIN') {
  const client = makeClient();
  const id = randomUUID();
  const email = `it-reg01-${uniq(roleName.toLowerCase())}@wasit.tn`;
  const password = 'StaffPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status).toBe(200);
  return { client, email, id };
}

async function taskCount(agentKey: string): Promise<number> {
  const rows = await db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.agentKey, agentKey));
  return rows.length;
}

async function refusalAudits(agentKey: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'AI.AGENT_RUN_REFUSED'), eq(auditLogs.entityId, agentKey)));
}

describe('AI-REG-01 — agent layer API and execution gate', () => {
  it('lists the agents with their real executability and the Copilot apart', async () => {
    const { client } = await registerCustomer();
    const r = await client.req('/api/ai/agents');
    expect(r.status).toBe(200);

    const agents = r.data.data.agents as Array<{ key: string; executable?: boolean; isSupervisor?: boolean }>;
    expect(agents).toHaveLength(21);
    expect(new Set(agents.map((a) => a.key)).size).toBe(21);
    expect(agents.filter((a) => a.executable === true)).toHaveLength(11);
    expect(agents.filter((a) => a.executable !== true)).toHaveLength(10);
    expect(agents.filter((a) => a.isSupervisor === true).map((a) => a.key)).toEqual(['agent-supervisor']);

    expect(r.data.data.counts).toEqual({
      total: 21,
      specialised: 20,
      supervisor: 1,
      executable: 11,
      declared: 9,
      copilot: 1,
    });
    expect(r.data.data.copilot.key).toBe('wasit-copilot');
    expect(agents.some((a) => a.key === 'wasit-copilot')).toBe(false);
  });

  it('refuses every declared-only agent, writes no task and audits the refusal', async () => {
    const { client } = await registerCustomer();
    for (const spec of declaredOnlyAgents()) {
      const before = await taskCount(spec.key);
      const r = await client.req(`/api/ai/agents/${spec.key}/tasks`, {
        method: 'POST',
        body: { input: {} },
      });
      expect(r.status).toBe(409);
      expect(r.data.error.code).toBe('CONFLICT');
      expect(String(r.data.error.message)).toContain(spec.key);
      expect(await taskCount(spec.key)).toBe(before);

      const audits = await refusalAudits(spec.key);
      expect(audits.length).toBeGreaterThan(0);
      const metadata = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect(metadata.code).toBe('AGENT_NOT_EXECUTABLE');
    }
  });

  it('refuses the supervisor and the Copilot by their own codes', async () => {
    const { client } = await registerCustomer();

    const supervisor = await client.req('/api/ai/agents/agent-supervisor/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(supervisor.status).toBe(409);
    expect(await taskCount('agent-supervisor')).toBe(0);
    const supervisorAudit = (await refusalAudits('agent-supervisor')).at(-1);
    expect((supervisorAudit?.metadata as Record<string, unknown>).code).toBe('SUPERVISOR_NOT_RUNNABLE');

    const copilot = await client.req('/api/ai/agents/wasit-copilot/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(copilot.status).toBe(409);
    const copilotAudit = (await refusalAudits('wasit-copilot')).at(-1);
    expect((copilotAudit?.metadata as Record<string, unknown>).code).toBe('COPILOT_NOT_RUNNABLE');
  });

  it('keeps unknown keys a 404', async () => {
    const { client } = await registerCustomer();
    const r = await client.req('/api/ai/agents/not-a-real-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(r.status).toBe(404);
  });

  it('still runs executable agents (auto and approval-gated)', async () => {
    const { client } = await registerCustomer();

    const auto = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(auto.status).toBe(201);
    expect(['succeeded', 'running', 'queued']).toContain(auto.data.data.status);

    const gated = await client.req('/api/ai/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(gated.status).toBe(201);
    expect(gated.data.data.status).toBe('awaiting_approval');
  });

  it('gives the admin desk the same layer, and only to staff', async () => {
    const customer = await registerCustomer();
    const forbidden = await customer.client.req('/api/admin/ai/agents');
    expect(forbidden.status).toBe(403);

    const admin = await createStaff('SUPER_ADMIN');
    const r = await admin.client.req('/api/admin/ai/agents');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<{ key: string; executable?: boolean }>;
    expect(items).toHaveLength(21);
    expect(items.filter((i) => i.executable === true)).toHaveLength(AGENT_CATALOGUE.length);
    expect(r.data.data.counts.declared).toBe(9);
    expect(r.data.data.copilot.key).toBe('wasit-copilot');
  });

  it('keeps listAgents in step with the executable catalogue', async () => {
    const agents = await listAgents(db);
    expect(agents).toHaveLength(21);
    expect(agents.filter((a) => a.executable === true).map((a) => a.key).sort()).toEqual(
      AGENT_CATALOGUE.map((a) => a.key).sort(),
    );
  });
});

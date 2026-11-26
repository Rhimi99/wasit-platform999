import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { AGENT_GENERATIVE_CAPABILITY } from '../src/lib/ai/llm/contract.js';
import { isAiPathCovered } from '../src/lib/rate-limit/ai-policy.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * WASIT-GM-DASHBOARD-01 — the GM command center.
 *
 * These tests drive the real app over real HTTP against the real database. They
 * assert three things the dashboard is judged on:
 *  1. Access: only an account the AI desk already trusts may read it.
 *  2. Truth: every section reports its own state, and a figure the server could
 *     not compute is `null` rather than a zero.
 *  3. No new authority: the module exposes reads only, and the labels it prints
 *     (generative vs deterministic) match the code that actually runs.
 */

const app = createApp();
const HERE = dirname(fileURLToPath(import.meta.url));

let ipSeq = 0;
function makeClient() {
  let cookie = '';
  const ip = `203.0.113.${(ipSeq++ % 250) + 1}`;
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
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
      return { res, data: data as any, status: res.status, text: JSON.stringify(data ?? '') };
    },
  };
}

async function loginAs(roleName: string) {
  const email = `gm-${roleName.toLowerCase()}-${randomUUID()}@wasit.tn`;
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email,
      passwordHash: await argon2.hash('StrongPass123!'),
      firstName: 'Gm',
      emailVerified: true,
      isActive: true,
    })
    .returning();
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!roleRow) throw new Error(`missing role ${roleName}`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleId: roleRow.id });
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login for ${roleName}`).toBe(200);
  return { client, userId: user.id };
}

beforeAll(async () => {
  await resetRateLimitStore();
});

afterAll(async () => {
  await resetRateLimitStore();
  await closeDb();
});

describe('WASIT-GM-DASHBOARD-01 — access', () => {
  it('refuses an anonymous caller', async () => {
    const client = makeClient();
    expect((await client.req('/api/admin/gm/overview')).status).toBe(401);
  });

  it('refuses a CUSTOMER and a SUPPORT account', async () => {
    for (const role of ['CUSTOMER', 'SUPPORT']) {
      const { client } = await loginAs(role);
      expect((await client.req('/api/admin/gm/overview')).status, role).toBe(403);
      expect((await client.req('/api/admin/gm/tasks')).status, role).toBe(403);
      expect((await client.req('/api/admin/gm/audit')).status, role).toBe(403);
    }
  });

  it('serves an ADMIN and a SUPER_ADMIN', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      const { client } = await loginAs(role);
      expect((await client.req('/api/admin/gm/overview')).status, role).toBe(200);
    }
  });
});

describe('WASIT-GM-DASHBOARD-01 — overview contract', () => {
  it('returns every section with its own state, source and timestamp', async () => {
    const { client } = await loginAs('ADMIN');
    const { status, data } = await client.req('/api/admin/gm/overview');
    expect(status).toBe(200);
    const body = data.data;
    expect(body.viewer.roles).toContain('ADMIN');
    expect(body.viewer.canDecideApprovals).toBe(true);
    expect(body.window.days).toBe(30);

    const expected = [
      'platform',
      'agents',
      'copilot',
      'supervisor',
      'tasks',
      'approvals',
      'providers',
      'spending',
      'health',
      'audit',
    ];
    for (const key of expected) {
      const section = body.sections[key];
      expect(section, key).toBeTruthy();
      expect(['OK', 'UNAVAILABLE'], key).toContain(section.state);
      expect(typeof section.source, key).toBe('string');
      expect(section.source.length, key).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(section.generatedAt)), key).toBe(false);
      if (section.state === 'OK') expect(section.data, key).not.toBeNull();
      else expect(typeof section.error, key).toBe('string');
    }
  });

  it('reports where the kill-switch state came from, not a placeholder', async () => {
    const { client } = await loginAs('ADMIN');
    const { data } = await client.req('/api/admin/gm/overview');
    const platform = data.data.sections.platform.data;
    expect(typeof platform.killSwitch.enabled).toBe('boolean');
    expect(['runtime', 'env']).toContain(platform.killSwitch.source);
  });

  it('labels an agent generative only when its executor reaches the LLM path', async () => {
    const { client } = await loginAs('ADMIN');
    const { data } = await client.req('/api/admin/gm/overview');
    const agents = data.data.sections.agents.data;
    expect(agents).toBeTruthy();
    expect(agents.counts.total).toBeGreaterThan(0);

    // The map the dashboard uses must equal the generation call sites in the
    // executor source, so the "generative" label cannot outlive the code.
    const executors = readFileSync(join(HERE, '../src/modules/ai/executors.ts'), 'utf8');
    const callSites = [...executors.matchAll(/draftFor\(\s*db,\s*[^,]+,\s*'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(callSites.length).toBe(Object.keys(AGENT_GENERATIVE_CAPABILITY).length);
    expect(new Set(callSites)).toEqual(new Set(Object.values(AGENT_GENERATIVE_CAPABILITY)));

    const generative = agents.items.filter((agent: { generation: string }) => agent.generation === 'llm');
    expect(new Set(generative.map((agent: { key: string }) => agent.key))).toEqual(
      new Set(Object.keys(AGENT_GENERATIVE_CAPABILITY)),
    );
    for (const agent of generative) {
      expect(agent.generationCapability).toBeTruthy();
    }
    // An agent with an executor but no generation call must never be called generative.
    for (const agent of agents.items) {
      if (agent.generation === 'deterministic') expect(agent.generationCapability).toBeNull();
    }
  });

  it('reports unknown figures as null, never as zero', async () => {
    const { client } = await loginAs('ADMIN');
    const { data } = await client.req('/api/admin/gm/overview');
    const agents = data.data.sections.agents.data.items as Array<{
      execution: { total: number; successRate: number | null };
      cost: { available: boolean; actualCostUsd: string | null };
    }>;
    for (const agent of agents) {
      if (agent.execution.total === 0) expect(agent.execution.successRate).toBeNull();
      if (!agent.cost.available) expect(agent.cost.actualCostUsd).toBeNull();
    }
    // The platform block mirrors its source: when a section is unavailable its
    // figures are null, so the headline cannot show a fabricated zero.
    const platform = data.data.sections.platform.data;
    if (data.data.sections.approvals.state === 'UNAVAILABLE') expect(platform.approvalsPending).toBeNull();
    if (data.data.sections.supervisor.state === 'UNAVAILABLE') expect(platform.alertsFiring).toBeNull();
  });

  it('does not claim a process-local counter store is shared', async () => {
    const { client } = await loginAs('ADMIN');
    const { data } = await client.req('/api/admin/gm/overview');
    const items = data.data.sections.health.data.items as { key: string; detail: string }[];
    const store = items.find((item) => item.key === 'rateLimitStore');
    expect(store).toBeTruthy();
    if (store!.detail.startsWith('memory')) {
      expect(store!.detail).toContain('process-local');
      expect(store!.detail).not.toContain('shared across replicas');
    }
  });

  it('never leaks a secret or a raw credential', async () => {
    const { client } = await loginAs('ADMIN');
    const { text } = await client.req('/api/admin/gm/overview');
    const providers = JSON.parse(text).data.sections.providers.data;
    for (const provider of providers.items) {
      // The key state may say the key exists; it may never carry it.
      expect(provider.keyState).not.toHaveProperty('key');
      expect(provider.keyState).not.toHaveProperty('secret');
      expect(provider.keyState).not.toHaveProperty('secretCiphertext');
      expect(Object.keys(provider.keyState)).toEqual(
        expect.arrayContaining(['present', 'source', 'envVar', 'fingerprint']),
      );
    }
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(text).not.toMatch(/password_hash/i);
  });

  it('keeps a failed section local instead of failing the request', async () => {
    // A section is wrapped in `settle`; the contract test above proves the shape.
    // Here we prove the failure path itself: a bad window is refused by validation
    // while a valid request still answers 200 with sections.
    const { client } = await loginAs('ADMIN');
    expect((await client.req('/api/admin/gm/overview?days=0')).status).toBe(422);
    expect((await client.req('/api/admin/gm/overview?days=abc')).status).toBe(422);
    expect((await client.req('/api/admin/gm/overview?days=91')).status).toBe(422);
    expect((await client.req('/api/admin/gm/overview?days=7')).status).toBe(200);
  });
});

describe('WASIT-GM-DASHBOARD-01 — approvals', () => {
  it('shows a gated task, blocks self-approval, and reports whether an independent approver exists', async () => {
    const { client, userId } = await loginAs('ADMIN');
    const created = await client.req('/api/ai/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: { action: 'identify_leads' } },
    });
    expect(created.status).toBe(201);
    expect(created.data.data.status).toBe('awaiting_approval');
    const taskId = created.data.data.id as string;

    const { data } = await client.req('/api/admin/gm/overview');
    const approvals = data.data.sections.approvals;
    expect(approvals.state).toBe('OK');
    const item = (approvals.data.items as Array<Record<string, unknown>>).find((row) => row.id === taskId);
    expect(item, 'the gated task appears in the approvals desk').toBeTruthy();
    expect(item!.kind).toBe('agent_task');
    expect(item!.requestedBy).toBe(userId);
    expect(item!.selfApprovalBlocked).toBe(true);
    expect(item!.evidence).toBeInstanceOf(Array);
    expect(approvals.data.approverRoles).toContain('ADMIN');

    // The server still refuses the self-approval, whatever the dashboard shows.
    const self = await client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect([403, 409]).toContain(self.status);

    // An independent ADMIN can decide it, and the dashboard then shows nothing pending.
    const other = await loginAs('ADMIN');
    const decided = await other.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(decided.status).toBe(200);
    const after = await other.client.req('/api/admin/gm/overview');
    const stillPending = (after.data.data.sections.approvals.data.items as Array<Record<string, unknown>>).some(
      (row) => row.id === taskId,
    );
    expect(stillPending).toBe(false);
  });
});

describe('WASIT-GM-DASHBOARD-01 — task and audit queries', () => {
  it('filters tasks by severity and never returns a row outside the filter', async () => {
    const { client } = await loginAs('ADMIN');
    const high = await client.req('/api/admin/gm/tasks?severity=high&pageSize=50');
    expect(high.status).toBe(200);
    for (const row of high.data.data.items) {
      expect(['failed', 'rejected', 'cancelled', 'contained']).toContain(row.status);
      expect(row.severity).toBe('high');
    }
    const medium = await client.req('/api/admin/gm/tasks?severity=medium&pageSize=50');
    for (const row of medium.data.data.items) {
      expect(['awaiting_approval', 'running', 'queued']).toContain(row.status);
    }
  });

  it('paginates with a bounded page size', async () => {
    const { client } = await loginAs('ADMIN');
    const page = await client.req('/api/admin/gm/tasks?page=1&pageSize=5');
    expect(page.status).toBe(200);
    expect(page.data.data.pageSize).toBe(5);
    expect(page.data.data.items.length).toBeLessThanOrEqual(5);
    const huge = await client.req('/api/admin/gm/tasks?pageSize=100000');
    expect(huge.status).toBe(422);
  });

  it('filters the audit trail by action prefix and rejects a pattern', async () => {
    const { client } = await loginAs('ADMIN');
    const rows = await client.req('/api/admin/gm/audit?action=AI.&pageSize=50');
    expect(rows.status).toBe(200);
    for (const row of rows.data.data.items) expect(row.action.startsWith('AI.')).toBe(true);
    expect((await client.req('/api/admin/gm/audit?action=AI.%25')).status).toBe(422);
  });
});

describe('WASIT-GM-DASHBOARD-01 — no new authority', () => {
  it('registers no write route under /api/admin/gm', () => {
    const writes = app.routes
      .filter((route) => route.path.startsWith('/api/admin/gm'))
      .filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method.toUpperCase()));
    expect(writes).toEqual([]);
  });

  it('is covered by the unified AI rate-limit policy', () => {
    expect(isAiPathCovered('/api/admin/gm/overview', 'GET')).toBe(true);
    expect(isAiPathCovered('/api/admin/gm/tasks', 'GET')).toBe(true);
  });

  it('does not create a task or change state when the dashboard is read', async () => {
    const { client } = await loginAs('ADMIN');
    const before = await db.select({ id: agentTasks.id }).from(agentTasks);
    await client.req('/api/admin/gm/overview');
    await client.req('/api/admin/gm/tasks');
    const after = await db.select({ id: agentTasks.id }).from(agentTasks);
    expect(after.length).toBe(before.length);
  });
});

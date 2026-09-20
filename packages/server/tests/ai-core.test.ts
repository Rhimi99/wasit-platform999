import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { aiRequests } from '../src/db/schema/ai.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';

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

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'AI', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function setupUser(role = 'CUSTOMER', prefix = 'ai') {
  const client = makeClient();
  const email = `it-ai-${uniq(prefix)}@wasit.tn`;
  await register(client, email, role);
  return { client, email };
}

/** Creates a staff/internal user directly (roles not allowed via public register). */
async function createStaffUser(roleName: 'ADMIN' | 'AI_ADMIN' | 'SUPPORT') {
  const id = randomUUID();
  const email = `it-ai-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
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

describe('AI Core Runtime + Model Provider/Routing', () => {
  it('rejects unauthenticated access to AI endpoints', async () => {
    const c = makeClient();
    expect((await c.req('/api/ai/models')).status).toBe(401);
    expect((await c.req('/api/ai/budgets/me')).status).toBe(401);
    expect(
      (await c.req('/api/ai/run', { method: 'POST', body: { requestType: 'X', user: 'x' } })).status,
    ).toBe(401);
  });

  it('exposes the model catalogue with the seeded models (local + openai + anthropic)', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/models');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<{ key: string; isActive: boolean }>;
    const keys = items.map((i) => i.key);
    expect(keys).toContain('local-heuristic');
    expect(keys).toContain('openai-gpt-4o-mini');
    expect(keys).toContain('anthropic-claude-sonnet-4');
  });

  it('exposes own budget/usage starting at zero', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/budgets/me');
    expect(r.status).toBe(200);
    expect(r.data.data.period).toBe('MONTHLY');
    expect(r.data.data.usage.requests).toBe(0);
  });

  it('runs a feature with the local-heuristic fallback and records usage + audit', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'MARKET_ANALYSIS', user: 'Analyze the current market snapshot.' },
    });
    expect(r.status).toBe(200);
    const data = r.data.data;
    expect(data.requestId).toBeTruthy();
    expect(data.kind).toBe('MARKET_ANALYSIS');
    // No provider configured in tests → deterministic local engine.
    expect(data.model).toBe('local-heuristic');
    // Local model is free; the cost string may expose Decimal precision.
    expect(['0', '0.0000000000']).toContain(data.cost);

    // Request persisted.
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiRequests)
      .where(eq(aiRequests.requestType, 'MARKET_ANALYSIS'));
    expect(rows[0].count).toBe(1);

    // Audit entry persisted.
    const audits = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.FEATURE_RUN'));
    expect(audits[0].count).toBeGreaterThan(0);
  });

  it('runs the smart features end-to-end against live data', async () => {
    const { client } = await setupUser('CUSTOMER');
    const market = await client.req('/api/ai/market-analysis', { method: 'POST' });
    expect(market.status).toBe(200);
    expect(market.data.data.kind).toBe('MARKET_ANALYSIS');
    expect(market.data.data.data.products).toBeGreaterThanOrEqual(0);

    const rec = await client.req('/api/ai/recommendations', { method: 'POST', body: { limit: 5 } });
    expect(rec.status).toBe(200);
    expect(rec.data.data.kind).toBe('RECOMMENDATIONS');

    const smart = await client.req('/api/ai/smart-search', { method: 'POST', body: { q: 'oil' } });
    expect(smart.status).toBe(200);
    expect(smart.data.data.kind).toBe('SMART_SEARCH');

    const sup = await client.req('/api/ai/supplier-recommendations', { method: 'POST', body: { limit: 3 } });
    expect(sup.status).toBe(200);
    expect(sup.data.data.kind).toBe('SUPPLIER_RECOMMENDATIONS');
  });

  it('enforces RBAC: CUSTOMER cannot read global AI activity (AI_MANAGE/ADMIN_AI)', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/recent');
    expect(r.status).toBe(403);
  });

  it('keeps tenant isolation: each user sees only their own AI activity', async () => {
    const a = await setupUser('CUSTOMER', 'aiso');
    const b = await setupUser('CUSTOMER', 'aiso');

    await a.client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'SMART_SEARCH', user: 'query A' },
    });
    await b.client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'SMART_SEARCH', user: 'query B' },
    });

    const actA = await a.client.req('/api/ai/activity');
    expect(actA.status).toBe(200);
    const itemsA = actA.data.data.items as Array<{ requestType: string }>;
    const actB = await b.client.req('/api/ai/activity');
    const itemsB = actB.data.data.items as Array<{ requestType: string }>;
    expect(itemsA.length).toBe(1);
    expect(itemsB.length).toBe(1);
  });

  it('records usage cost across multiple calls via /budgets/me', async () => {
    const { client } = await setupUser('CUSTOMER');
    for (let i = 0; i < 3; i += 1) {
      await client.req('/api/ai/run', {
        method: 'POST',
        body: { requestType: 'MARKET_ANALYSIS', user: `call ${i}` },
      });
    }
    const r = await client.req('/api/ai/budgets/me');
    expect(r.status).toBe(200);
    expect(r.data.data.usage.requests).toBe(3);
  });

  it('lists agents from the persistent registry (auto-seeded)', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/agents');
    expect(r.status).toBe(200);
    const agents = r.data.data.agents as Array<{ key: string; requiresHumanApproval: boolean }>;
    expect(agents.length).toBeGreaterThanOrEqual(11);
    expect(agents.some((a) => a.key === 'sales-agent')).toBe(true);
    expect(agents.some((a) => a.key === 'product-agent')).toBe(true);
  });

  it('runs a non-gated agent task to success (marketing-agent)', async () => {
    const { client } = await setupUser('CUSTOMER');
    const r = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: { action: 'recommend_campaign', goal: 'increase reach' } },
    });
    expect(r.status).toBe(201);
    expect(r.data.data.status).toBe('succeeded');
    expect(r.data.data.agentKey).toBe('marketing-agent');
  });

  it('gates human-approval agents until an AI_MANAGE actor approves', async () => {
    const { client } = await setupUser('CUSTOMER');
    const created = await client.req('/api/ai/agents/sales-agent/tasks', {
      method: 'POST',
      body: { input: { action: 'identify_leads' } },
    });
    expect(created.status).toBe(201);
    expect(created.data.data.status).toBe('awaiting_approval');
    const taskId = created.data.data.id as string;

    // CUSTOMER cannot approve.
    const denied = await client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    expect(denied.status).toBe(403);

    // Admin (AI_MANAGE) can approve.
    const admin = await createStaffUser('ADMIN');
    const approved = await admin.client.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE', reason: 'ok' },
    });
    expect(approved.status).toBe(200);
    expect(approved.data.data.status).toBe('approved');
  });

  it('enforces AI request budgets (429 on exhaustion)', async () => {
    const { client } = await setupUser('CUSTOMER');

    // Raise a budget: 1 request max for this user via admin.
    const admin = await createStaffUser('ADMIN');
    const self = await client.req('/api/auth/me');
    const userId = self.data.data.id as string;
    const bs = await admin.client.req('/api/admin/ai/budgets', {
      method: 'POST',
      body: {
        userId,
        period: 'MONTHLY',
        maxRequests: 1,
        currencyCode: 'USD',
        isActive: true,
      },
    });
    expect(bs.status).toBe(201);

    const first = await client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'MARKET_ANALYSIS', user: 'one' },
    });
    expect(first.status).toBe(200);

    const second = await client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'MARKET_ANALYSIS', user: 'two' },
    });
    expect(second.status).toBe(429);
  });

  it('exposes /api/health/ai with a live catalog heartbeat (public)', async () => {
    const r = await app.request('/api/health/ai');
    const body = (await r.json()) as { success: boolean; data: { ok: boolean; models: number } };
    expect(r.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.models).toBeGreaterThanOrEqual(3);
  });
});
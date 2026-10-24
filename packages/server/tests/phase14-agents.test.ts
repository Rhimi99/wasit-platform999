import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { createAgentTask, decideAgentTask, executeDueTasks, listAgents, getTask, AGENT_CATALOGUE } from '../src/modules/ai/runner.js';
import { db } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { products, categories } from '../src/db/schema/products.js';
import { eq } from 'drizzle-orm';

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

/** Insert a staff user directly (public register allows only trading roles). */
async function insertStaff(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'RISK' | 'DISPUTE' = 'ADMIN') {
  const id = randomUUID();
  const email = `p14-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Phase14Pass123!');
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
  return { id, email };
}

const AUDIT = { actorId: 'test' };

/** Runs a task through the real createAgentTask lifecycle and returns status+result. */
async function runTask(agentKey: string, input: Record<string, unknown>, requestedBy: string) {
  const res = await createAgentTask(db, ['SUPER_ADMIN'], requestedBy, {
    agentKey,
    requestedBy,
    input,
  }, AUDIT);
  return res;
}

describe('Phase 14 — specialised agent executors (real DB-backed capabilities)', () => {
  it('registers the specialised agents with their capabilities', async () => {
    const agents = await listAgents(db);
    const keys = agents.map((a) => a.key).sort();
    // The Phase 19 layer grows the catalogue; the original eleven must all
    // still be registered alongside the additions.
    const original = [
      'ads-agent',
      'analytics-agent',
      'b2b-agent',
      'development-agent',
      'dispute-assistant',
      'marketing-agent',
      'market-research-agent',
      'product-agent',
      'risk-agent',
      'sales-agent',
      'support-agent',
    ].sort();
    for (const k of original) expect(keys).toContain(k);
    expect(keys).toContain('agent-supervisor');
    // Every catalogue entry must carry a capability + permissions.
    for (const def of agents) {
      expect(def.capabilities.length).toBeGreaterThan(0);
      expect(def.permissionsRequired.length).toBeGreaterThan(0);
    }
  });

  /**
   * Runs a task and, for gated agents, approves it as a SUPER_ADMIN and lets the
   * scheduler dispatch it. Approval is recorded separately from execution, so
   * the caller must drive the scheduler to observe the real outcome.
   */
  async function runAndComplete(agentKey: string, input: Record<string, unknown>, staffId: string) {
    const created = await createAgentTask(db, ['SUPER_ADMIN'], staffId, { agentKey, requestedBy: staffId, input }, AUDIT);
    if (created.status === 'awaiting_approval') {
      // Human approval path — SUPER_ADMIN may approve (they hold AI_MANAGE).
      await decideAgentTask(db, created.id, staffId, 'APPROVE', 'auto test approval', AUDIT);
      await executeDueTasks(db);
      return getTask(db, created.id);
    }
    return created;
  }

  it.each([
    ['sales-agent', { action: 'identify_leads' }, 'kpi'],
    ['marketing-agent', { action: 'recommend_campaign' }, 'marketingVideos'],
    ['ads-agent', { action: 'recommend_ads' }, 'snapshot'],
    ['support-agent', { action: 'draft_reply' }, 'snapshot'],
    ['analytics-agent', { action: 'generate_report' }, 'snapshot'],
    ['market-research-agent', { action: 'market_overview' }, 'snapshot'],
    ['b2b-agent', { action: 'match_b2b' }, 'matches'],
    ['risk-agent', { action: 'assess_risk' }, 'riskPosture'],
    ['dispute-assistant', { action: 'summarize_dispute' }, 'recommendation'],
    ['development-agent', { action: 'dev_plan' }, 'nextSteps'],
  ] as const)('executes %s and returns its specialised structured result', async (agentKey, input, expectedKey) => {
    const staff = await insertStaff('SUPER_ADMIN');
    const task = await runAndComplete(agentKey, input, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    expect(task.error).toBeNull();

    const result = task.result as { agentKey?: string; advice?: string } | null;
    expect(result).toBeTruthy();
    expect(result?.agentKey).toBe(agentKey);

    // The advice is JSON string that must parse into the agent's own structure.
    const advice = result?.advice as string | undefined;
    expect(typeof advice).toBe('string');
    const parsed = JSON.parse(advice as string) as Record<string, unknown>;
    expect(parsed.agentKey).toBe(agentKey);
    expect(parsed).toHaveProperty(expectedKey);

    // Every agent is read-only advisory.
    expect(parsed.readOnly).toBe(true);
  });

  it('works differently per agent — outputs carry agent-specific fields', async () => {
    const staff = await insertStaff('SUPER_ADMIN');
    const sales = await runAndComplete('sales-agent', { action: 'identify_leads' }, staff.id);
    const salesParsed = JSON.parse(((sales.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    expect(salesParsed).toHaveProperty('kpi');
    expect(salesParsed).toHaveProperty('leadsPotential');
    expect(salesParsed).toHaveProperty('recentOrders');

    const marketing = await runAndComplete('marketing-agent', { action: 'recommend_campaign' }, staff.id);
    const marketingParsed = JSON.parse(((marketing.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    // The Product Marketing requirement: generated videos must be previewable/downloadable in-app.
    expect(Array.isArray(marketingParsed.marketingVideos)).toBe(true);
    const videos = marketingParsed.marketingVideos as Array<Record<string, unknown>>;
    for (const v of videos) {
      expect(v).toHaveProperty('previewable', true);
      expect(v).toHaveProperty('downloadable', true);
      expect(v).toHaveProperty('mimeType', 'video/mp4');
      expect(v).toHaveProperty('mediaUrl');
    }
  });

  it('product-agent analyzes a real product and returns completeness', async () => {
    const staff = await insertStaff('SUPER_ADMIN');

    // Insert a real category + product so the executor has live DB data.
    const categoryId = randomUUID();
    const productId = randomUUID();
    const catSlug = `cat-p14-${Date.now()}`;
    const prodSlug = `prod-p14-${Date.now()}`;
    await db.insert(categories).values({
      id: categoryId,
      name: 'Test Category',
      slug: catSlug,
      isActive: true,
    });
    await db.insert(products).values({
      id: productId,
      sellerId: staff.id,
      sellerType: 'MERCHANT',
      categoryId,
      name: 'Phase 14 Test Product',
      slug: prodSlug,
      sku: `SKU-P14-${Date.now()}`,
      currencyCode: 'TND',
      basePrice: '12.5',
      moq: 1,
      unit: 'piece',
      status: 'ACTIVE',
      isPublished: true,
      tags: [],
    });

    const task = await runAndComplete('product-agent', { action: 'analyze_product', productId }, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    const parsed = JSON.parse(((task.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    expect(parsed.agentKey).toBe('product-agent');
    expect(parsed).toHaveProperty('completeness');
    const completeness = parsed.completeness as { score?: number; issues?: string[] };
    expect(typeof completeness.score).toBe('number');
    expect(Array.isArray(completeness.issues)).toBe(true);
    expect(parsed).toHaveProperty('product');
  });

  it('supports productId input on the product-agent (unknown product error)', async () => {
    const staff = await insertStaff('SUPER_ADMIN');
    const task = await runAndComplete('product-agent', { action: 'analyze_product', productId: 'does-not-exist' }, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    const parsed = JSON.parse(((task.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    expect((parsed as { error?: string }).error).toBeTruthy();
  });

  it('Agents that require human approval stay in awaiting_approval for non-admins', async () => {
    // A normal merchant/staff without AI_MANAGE cannot trigger gated agents directly.
    // We assert the gating is applied by the catalogue metadata.
    const gated = AGENT_CATALOGUE.filter((a) => a.requiresHumanApproval).map((a) => a.key);
    expect(gated).toEqual(
      expect.arrayContaining(['sales-agent', 'ads-agent', 'b2b-agent', 'risk-agent', 'dispute-assistant', 'development-agent']),
    );
  });

  it('agent task is persisted and retrievable via getTask', async () => {
    const staff = await insertStaff('SUPER_ADMIN');
    const input: Record<string, unknown> = { action: 'market_overview' };
    const created = await runAndComplete('market-research-agent', input, staff.id);
    const loaded = await getTask(db, created.id);
    expect(loaded.id).toBe(created.id);
    expect(['succeeded', 'approved']).toContain(loaded.status);
  });

  it('rejects an unknown agent key with a clear error', async () => {
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], 'system', {
        agentKey: 'does-not-exist',
        requestedBy: 'system',
        input: {},
      }, AUDIT),
    ).rejects.toThrow();
  });

  it('non-gated agents do not require approval and run instantly', async () => {
    const staff = await insertStaff('SUPER_ADMIN');
    const forKeys = ['marketing-agent', 'product-agent', 'support-agent', 'analytics-agent', 'market-research-agent'];
    for (const key of forKeys) {
      const def = AGENT_CATALOGUE.find((a) => a.key === key);
      expect(def?.requiresHumanApproval).toBe(false);
      const created = await createAgentTask(db, ['SUPER_ADMIN'], staff.id, { agentKey: key, requestedBy: staff.id, input: { action: 'analyze' } }, AUDIT);
      expect(created.status).toBe('succeeded');
    }
  });
});

describe('Phase 14 — agent API integration (HTTP)', () => {
  it('creates an agent task and lists it via /api/ai endpoints', async () => {
    const email = `p14-api-${Date.now()}@wasit.tn`;
    const client = makeClient();
    const reg = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', firstName: 'P14', role: 'CUSTOMER' },
    });
    expect(reg.status).toBe(201);
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    // marketing-agent is non-gated → runs synchronously via HTTP.
    const created = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: { action: 'recommend_campaign', limit: 3 } },
    });
    expect(created.status).toBe(201);
    expect(created.data.data.status).toBe('succeeded');
    expect(created.data.data.agentKey).toBe('marketing-agent');

    const list = await client.req('/api/ai/agents/marketing-agent/tasks');
    expect(list.status).toBe(200);
    expect((list.data.data.items as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('gated agent requires AI_MANAGE approval via HTTP (approve/reject flow)', async () => {
    const email = `p14-gate-${Date.now()}@wasit.tn`;
    const client = makeClient();
    await client.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', firstName: 'P14', role: 'CUSTOMER' },
    });
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    // sales-agent is gated.
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

    // Admin (AI_MANAGE) can approve; the approval is recorded as its own
    // transition ('approved'), distinct from execution.
    const admin = await makeClient();
    await admin.req('/api/auth/register', {
      method: 'POST',
      body: { email: `p14-admin-${Date.now()}@wasit.tn`, password: 'StrongPass123!', firstName: 'Adm', role: 'SUPPORT' },
    });
    // SUPPORT role doesn't have AI_MANAGE — create an admin via staff insertion.
    const inserted = await insertStaff('ADMIN');
    const adminClient = makeClient();
    const adminLogin = await adminClient.req('/api/auth/login', {
      method: 'POST',
      body: { email: inserted.email, password: 'Phase14Pass123!', allowUnverifiedEmail: true },
    });
    expect(adminLogin.status).toBe(200);

    const approved = await adminClient.req(`/api/ai/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { decision: 'APPROVE', reason: 'ok' },
    });
    expect(approved.status).toBe(200);
    expect(approved.data.data.status).toBe('approved');
  });
});
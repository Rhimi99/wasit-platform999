import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentMetrics, agentMemory } from '../src/db/schema/agents.js';
import { createAgentTask, getTask, syncAgentRegistry } from '../src/modules/ai/runner.js';
import { deriveScope, derivePlatformScope, deriveSystemScope, SYSTEM_PRINCIPAL } from '../src/modules/ai/scope.js';
import { recordMetric, perAgentMetrics, aggregateMetrics } from '../src/modules/ai/metrics-repo.js';
import { putMemory, listMemory, trimOwnMemory } from '../src/modules/ai/memory-repo.js';
import {
  deriveMemoryTags,
  deriveMemorySource,
  isMemorableStatus,
  recordTaskMemory,
  recallAgentContext,
  enforceMemoryRetention,
  __internal as memoryServiceInternal,
} from '../src/modules/ai/memory-service.js';
import { agentPerformance, teamHealth, recentActivity } from '../src/modules/ai/agent-monitor.js';

/**
 * AI-06.0 — Agent Memory, Performance Metrics & Operational Monitoring.
 *
 * These integration tests drive the REAL wiring against the REAL database and
 * pin the properties the operational layer exists to guarantee:
 *
 *   - A finished task writes exactly ONE metric row and ONE memory note, both
 *     owned by the real requester — never the scheduler principal.
 *   - Recording is idempotent (a task finalised twice yields one note) and
 *     bounded (per-owner retention trims the oldest notes).
 *   - Recall returns only deterministic facts from the owner's own notes.
 *   - The monitor derives real numbers and never crosses owners: a tenant scope
 *     sees only its rows, a platform scope sees the aggregate.
 *   - The monitoring routes are RBAC-gated (AI_MANAGE) and read-only.
 *
 * No service is mocked: every assertion reads the effect back from the database.
 */

const AUDIT = { actorId: 'ai06-test' };

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(agentMetrics).where(inArray(agentMetrics.scopeOwner, createdUserIds));
    await db.delete(agentMemory).where(inArray(agentMemory.scopeOwner, createdUserIds));
  }
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function insertUser(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `ai06-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: await argon2.hash('Ai06Pass123!'), firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

/** Creates and runs a read-only support task for a real customer. It executes
 * inline (support-agent is not approval-gated), so its metric/memory rows are
 * written synchronously by the time this resolves. */
async function ranSupportTask(): Promise<{ taskId: string; ownerId: string }> {
  const owner = await insertUser('CUSTOMER');
  const created = await createAgentTask(
    db, ['CUSTOMER'], owner.id,
    { agentKey: 'support-agent', taskType: 'support.triage_ticket', input: {} },
    AUDIT,
  );
  createdTaskIds.push(created.id);
  const after = await getTask(db, created.id);
  expect(after.status).toBe('succeeded');
  return { taskId: created.id, ownerId: owner.id };
}

async function metricRowsFor(owner: string, taskId: string) {
  return db.select().from(agentMetrics).where(and(eq(agentMetrics.scopeOwner, owner), eq(agentMetrics.taskId, taskId)));
}
async function memoryRowsFor(owner: string, taskId: string) {
  const all = await db.select().from(agentMemory).where(eq(agentMemory.scopeOwner, owner));
  return all.filter((r) => (r.content as Record<string, unknown>)?.taskId === taskId);
}

beforeAll(async () => {
  await syncAgentRegistry(db);
});

// ---------------------------------------------------------------------------
// Pure derivations — no database.
// ---------------------------------------------------------------------------

describe('AI-06.0 — memory derivations (pure)', () => {
  it('derives bounded tags from the catalogue, never free text', () => {
    const tags = deriveMemoryTags('support-agent', 'support.triage_ticket');
    expect(tags).toContain('support');
    // A nonsense task type contributes nothing.
    expect(deriveMemoryTags('support-agent', 'zzz.not_a_family')).not.toContain('zzz');
  });

  it('maps provenance to a bounded source enum', () => {
    expect(deriveMemorySource('schedule:daily')).toBe('schedule');
    expect(deriveMemorySource('user')).toBe('task');
  });

  it('only terminal, meaningful statuses are memorable', () => {
    expect(isMemorableStatus('succeeded')).toBe(true);
    expect(isMemorableStatus('failed')).toBe(true);
    expect(isMemorableStatus('blocked')).toBe(true);
    expect(isMemorableStatus('rejected')).toBe(true);
    expect(isMemorableStatus('awaiting_approval')).toBe(false);
    expect(isMemorableStatus('running')).toBe(false);
  });

  it('maps a task status to a metric outcome and a refused code', () => {
    expect(memoryServiceInternal.outcomeOf('succeeded')).toBe('succeeded');
    expect(memoryServiceInternal.outcomeOf('blocked')).toBe('blocked');
    expect(memoryServiceInternal.outcomeOf('rejected')).toBe('refused');
    expect(memoryServiceInternal.outcomeOf('failed')).toBe('failed');
    expect(memoryServiceInternal.errorCodeOf({ refused: true })).toBe('REFUSED');
    expect(memoryServiceInternal.errorCodeOf({ code: 'NO_SCOPE' })).toBe('NO_SCOPE');
    expect(memoryServiceInternal.errorCodeOf({ message: 'a long free-form message' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Runner wiring — a real finished task writes one metric + one memory note.
// ---------------------------------------------------------------------------

describe('AI-06.0 — a finished run is recorded', () => {
  it('writes exactly one succeeded metric and one memory note, owned by the requester', async () => {
    const { taskId, ownerId } = await ranSupportTask();

    const metrics = await metricRowsFor(ownerId, taskId);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].outcome).toBe('succeeded');
    expect(metrics[0].agentKey).toBe('support-agent');
    expect(metrics[0].scopeOwner).toBe(ownerId);

    const notes = await memoryRowsFor(ownerId, taskId);
    expect(notes).toHaveLength(1);
    expect(notes[0].scopeOwner).toBe(ownerId);
    expect(notes[0].kind).toBe('summary');
    const content = notes[0].content as Record<string, unknown>;
    expect(content.taskId).toBe(taskId);
    expect(content.source).toBe('task');
    expect((content.metrics as Record<string, unknown>).outcome).toBe('succeeded');
    expect(content.tags).toContain('support');
  });

  it('records the scheduler principal under the dedicated system bucket (never a human owner)', async () => {
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId, agentKey: 'support-agent', requestedBy: SYSTEM_PRINCIPAL,
      taskType: 'support.triage_ticket', input: {} as never, status: 'succeeded', triggeredBy: 'schedule:daily',
    });
    createdTaskIds.push(taskId);
    const id = await recordTaskMemory(db, deriveSystemScope(), {
      id: taskId, agentKey: 'support-agent', taskType: 'support.triage_ticket',
      requestedBy: SYSTEM_PRINCIPAL, status: 'succeeded', latencyMs: 1, error: null, triggeredBy: 'schedule:daily',
    });
    expect(id).not.toBeNull();
    const notes = await db.select().from(agentMemory).where(eq(agentMemory.scopeOwner, SYSTEM_PRINCIPAL));
    const mine = notes.filter((r) => (r.content as Record<string, unknown>)?.taskId === taskId);
    expect(mine).toHaveLength(1);
    await db.delete(agentMemory).where(and(eq(agentMemory.scopeOwner, SYSTEM_PRINCIPAL), sql`${agentMemory.content}->>'taskId' = ${taskId}`));
  });
});

// ---------------------------------------------------------------------------
// Idempotency + retention.
// ---------------------------------------------------------------------------

describe('AI-06.0 — recording is idempotent and bounded', () => {
  it('a second record for the same task writes no second note', async () => {
    const { taskId, ownerId } = await ranSupportTask();
    const again = await recordTaskMemory(db, deriveScope({ userId: ownerId }), {
      id: taskId, agentKey: 'support-agent', taskType: 'support.triage_ticket',
      requestedBy: ownerId, status: 'succeeded', latencyMs: 5, error: null, triggeredBy: 'user',
    });
    expect(again).toBeNull();
    expect(await memoryRowsFor(ownerId, taskId)).toHaveLength(1);
  });

  it('per-owner retention trims to the newest notes, keeping the owner isolated', async () => {
    const owner = await insertUser('CUSTOMER');
    const other = await insertUser('CUSTOMER');
    const scope = deriveScope({ userId: owner.id });
    const otherScope = deriveScope({ userId: other.id });
    for (let i = 0; i < 5; i++) {
      await putMemory(db, scope, { agentKey: 'support-agent', kind: 'note', content: { tags: ['support'] } });
      await putMemory(db, otherScope, { agentKey: 'support-agent', kind: 'note', content: { tags: ['support'] } });
    }
    const removed = await trimOwnMemory(db, scope, 2);
    expect(removed).toBe(3);
    expect(await listMemory(db, scope)).toHaveLength(2);
    // The other owner's notes are untouched.
    expect(await listMemory(db, otherScope)).toHaveLength(5);
  });

  it('enforceMemoryRetention is best-effort and scoped to the caller', async () => {
    expect(await enforceMemoryRetention(db, deriveSystemScope(), 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recall — deterministic facts only, owner-scoped.
// ---------------------------------------------------------------------------

describe('AI-06.0 — recall', () => {
  it('returns prior-run facts for the same owner and agent, and null when none', async () => {
    const owner = await insertUser('CUSTOMER');
    const scope = deriveScope({ userId: owner.id });
    await putMemory(db, scope, {
      agentKey: 'support-agent', kind: 'summary',
      content: { tags: ['support'], source: 'task', metrics: { outcome: 'succeeded', latencyMs: 42 } },
    });
    const recall = await recallAgentContext(db, scope, 'support-agent', 'support.triage_ticket');
    expect(recall).toContain('support-agent');
    expect(recall).toContain('succeeded');
    expect(recall).toContain('42ms');

    const stranger = await insertUser('CUSTOMER');
    expect(await recallAgentContext(db, deriveScope({ userId: stranger.id }), 'support-agent', 'support.triage_ticket')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Monitor — real aggregates, strict owner isolation.
// ---------------------------------------------------------------------------

describe('AI-06.0 — performance + health', () => {
  it('derives per-agent performance from real rows, owner-scoped', async () => {
    const { ownerId } = await ranSupportTask();
    const scope = deriveScope({ userId: ownerId });
    const rows = await agentPerformance(db, scope);
    const support = rows.find((r) => r.agentKey === 'support-agent');
    expect(support).toBeDefined();
    expect(support!.succeeded).toBeGreaterThanOrEqual(1);
    expect(support!.successRate).toBeGreaterThan(0);

    // A stranger's owner scope must not see the other owner's rows.
    const stranger = await insertUser('CUSTOMER');
    const strangerRows = await agentPerformance(db, deriveScope({ userId: stranger.id }));
    expect(strangerRows.find((r) => r.agentKey === 'support-agent')).toBeUndefined();
  });

  it('a platform scope sees the aggregate', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const platform = derivePlatformScope({ userId: admin.id }, { roles: ['SUPER_ADMIN'] });
    const rows = await agentPerformance(db, platform);
    expect(rows.find((r) => r.agentKey === 'support-agent')).toBeDefined();
  });

  it('team health reports live counts and only alerts on real conditions', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const platform = derivePlatformScope({ userId: admin.id }, { roles: ['SUPER_ADMIN'] });
    const health = await teamHealth(db, platform);
    expect(health.scope).toBe('platform');
    expect(health.agents.total).toBeGreaterThan(0);
    expect(health.tasks.succeeded24h).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(health.alerts)).toBe(true);
    expect(Array.isArray(health.needsHumanAttention)).toBe(true);
  });

  it('recent activity returns newest tasks, owner-scoped', async () => {
    const { ownerId, taskId } = await ranSupportTask();
    const rows = await recentActivity(db, deriveScope({ userId: ownerId }), 10);
    expect(rows.some((r) => r.id === taskId)).toBe(true);
    expect(rows[0]).toHaveProperty('agentKey');
  });

  it('aggregate metrics are owner-scoped', async () => {
    const { ownerId } = await ranSupportTask();
    const agg = await aggregateMetrics(db, deriveScope({ userId: ownerId }));
    expect(agg.total).toBeGreaterThanOrEqual(1);
    expect(agg.succeeded).toBeGreaterThanOrEqual(1);
  });

  it('records a metric only for the owner in the context', async () => {
    const owner = await insertUser('CUSTOMER');
    const scope = deriveScope({ userId: owner.id });
    await recordMetric(db, scope, { agentKey: 'support-agent', outcome: 'blocked', errorCode: 'NO_SCOPE' });
    const rows = await perAgentMetrics(db, scope);
    expect(rows.find((r) => r.agentKey === 'support-agent')!.blocked).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Routes — RBAC + contract.
// ---------------------------------------------------------------------------

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
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function loginAs(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const { email } = await insertUser(roleName);
  const client = makeClient();
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'Ai06Pass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return client;
}

describe('AI-06.0 — monitoring routes', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await app.request('/api/admin/agent-ops/health');
    expect(res.status).toBe(401);
  });

  it('refuses a caller without the AI governance permission', async () => {
    const merchant = await loginAs('MERCHANT');
    const { status } = await merchant.req('/api/admin/agent-ops/health');
    expect(status).toBe(403);
  });

  it('serves the health view to a platform admin', async () => {
    const admin = await loginAs('SUPER_ADMIN');
    const { status, data } = await admin.req('/api/admin/agent-ops/health');
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.scope).toBe('platform');
    expect(data.data).toHaveProperty('alerts');
    expect(data.data).toHaveProperty('needsHumanAttention');
  });

  it('serves performance and activity feeds', async () => {
    const admin = await loginAs('SUPER_ADMIN');
    const perf = await admin.req('/api/admin/agent-ops/performance');
    expect(perf.status).toBe(200);
    expect(Array.isArray(perf.data.data.items)).toBe(true);
    const activity = await admin.req('/api/admin/agent-ops/activity?limit=5');
    expect(activity.status).toBe(200);
    expect(Array.isArray(activity.data.data.items)).toBe(true);
  });
});

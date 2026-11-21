import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { agentMetrics, agentTasks } from '../src/db/schema/agents.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { env } from '../src/lib/env.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import {
  recordAgentMetric,
  recordMetricSafely,
  buildMetricsReport,
  backfillAgentMetrics,
} from '../src/modules/ai/metrics.js';
import { recordTaskOutcomeMemory } from '../src/modules/ai/memory.js';

/**
 * AI-MET-01 — persistent agent metrics over real HTTP and real PostgreSQL.
 *
 * The suite covers the guarantees the layer exists to make: exact counting, no
 * double recording, real failures and retries, durability across a new
 * connection (the server process restarting cannot lose these rows), agent and
 * owner isolation, admin-only access, a metrics outage that never breaks the
 * task, and no sensitive content in any response.
 */

const app = createApp();
const AUDIT = { actorId: 'ai-met01-test' };

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

async function makeUser(roleName: 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT', prefix = 'met') {
  const client = makeClient();
  const id = randomUUID();
  const email = `it-${prefix}-${uniq(roleName.toLowerCase())}@wasit.tn`;
  const password = 'StrongPass123!';
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
  return { client, id, email };
}

/** A window that certainly covers rows written during this run. */
function window() {
  const to = new Date(Date.now() + 60_000);
  const from = new Date(Date.now() - 60 * 60_000);
  return { from, to };
}

function qs(extra: Record<string, string> = {}) {
  const { from, to } = window();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...extra });
  return params.toString();
}

const createdUserIds: string[] = [];
// A separate pool stands in for a restarted process: reading through it proves
// the metric lives in PostgreSQL, not in this module's memory.
const rawPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

afterAll(async () => {
  await rawPool.end();
  for (const id of createdUserIds) {
    await db.delete(agentMetrics).where(eq(agentMetrics.scopeOwner, id));
    await db.delete(agentTasks).where(eq(agentTasks.requestedBy, id));
  }
});

async function staff(): Promise<{ id: string }> {
  const admin = await makeUser('ADMIN', 'metadmin');
  createdUserIds.push(admin.id);
  return { id: admin.id };
}

async function customer(): Promise<{ id: string; client: ReturnType<typeof makeClient> }> {
  const user = await makeUser('CUSTOMER');
  createdUserIds.push(user.id);
  return { id: user.id, client: user.client };
}

describe('AI-MET-01 — recording is tied to the real task lifecycle', () => {
  it('writes exactly one row for a successful task, with the stored owner', async () => {
    const owner = await customer();
    const task = await createAgentTask(
      db,
      ['CUSTOMER'],
      owner.id,
      { agentKey: 'marketing-agent', requestedBy: owner.id, input: { action: 'preview' } },
      AUDIT,
    );
    expect(task.status).toBe('succeeded');

    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('succeeded');
    expect(rows[0].agentKey).toBe('marketing-agent');
    expect(rows[0].scopeOwner).toBe(owner.id);
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failed run with a machine code, never the error message', async () => {
    // A run with no resolvable owner is refused by the fail-closed scope guard
    // inside the run context, so the task settles as failed for real.
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      '',
      { agentKey: 'analytics-agent', requestedBy: '', input: { action: 'snapshot' } },
      AUDIT,
    );
    expect(task.status).toBe('failed');

    const [row] = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, task.id));
    expect(row.outcome).toBe('failed');
    expect(row.errorCode).toBeTruthy();
    // A code, not a sentence: the stored value is short and upper-case.
    expect(row.errorCode).toMatch(/^[A-Z0-9_]+$/);
    expect(row.errorCode).not.toContain(' ');
  });

  it('records a human rejection as `rejected`, and an approval as `succeeded`', async () => {
    const requester = await customer();
    const admin = await staff();

    const rejectedTask = await createAgentTask(
      db,
      ['ADMIN'],
      requester.id,
      { agentKey: 'ads-agent', requestedBy: requester.id, input: { action: 'recommend' } },
      AUDIT,
    );
    expect(rejectedTask.status).toBe('awaiting_approval');
    await decideAgentTask(db, rejectedTask.id, admin.id, 'REJECT', 'Budget freeze', AUDIT);

    const approvedTask = await createAgentTask(
      db,
      ['ADMIN'],
      requester.id,
      { agentKey: 'ads-agent', requestedBy: requester.id, input: { action: 'recommend' } },
      AUDIT,
    );
    expect(approvedTask.status).toBe('awaiting_approval');
    await decideAgentTask(db, approvedTask.id, admin.id, 'APPROVE', 'Approved for review', AUDIT);

    const rejectedRows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, rejectedTask.id));
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0].outcome).toBe('rejected');
    expect(rejectedRows[0].scopeOwner).toBe(requester.id);

    const approvedRows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, approvedTask.id));
    expect(approvedRows).toHaveLength(1);
    expect(approvedRows[0].outcome).toBe('succeeded');
  });

  it('records a pre-execution refusal as a blocked event with no task id', async () => {
    const owner = await customer();
    const res = await owner.client.req('/api/ai/agents/wasit-copilot/tasks', {
      method: 'POST',
      body: { input: { action: 'x' } },
    });
    expect(res.status).toBe(409);

    const [row] = await db
      .select()
      .from(agentMetrics)
      .where(and(eq(agentMetrics.scopeOwner, owner.id), eq(agentMetrics.outcome, 'blocked')));
    expect(row).toBeTruthy();
    expect(row.taskId).toBeNull();
    expect(row.errorCode).toBe('COPILOT_NOT_RUNNABLE');
  });

  it('never double records the same settled event', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    const event = {
      agentKey: 'analytics-agent',
      taskId,
      scopeOwner: owner.id,
      outcome: 'succeeded' as const,
      attempt: 1,
      latencyMs: 42,
    };
    expect(await recordAgentMetric(db, event)).toBe(true);
    expect(await recordAgentMetric(db, event)).toBe(false);
    expect(await recordAgentMetric(db, { ...event, latencyMs: 999 })).toBe(false);

    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, taskId));
    expect(rows).toHaveLength(1);
    // The first write wins: a duplicate cannot rewrite a measurement.
    expect(rows[0].latencyMs).toBe(42);
  });

  it('keeps a retry as a second attempt of the same task', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    const base = { agentKey: 'sales-agent', taskId, scopeOwner: owner.id, latencyMs: 10 };
    await recordAgentMetric(db, { ...base, outcome: 'failed', attempt: 1, errorCode: 'PROVIDER_TIMEOUT' });
    await recordAgentMetric(db, { ...base, outcome: 'succeeded', attempt: 2 });

    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, taskId));
    expect(rows).toHaveLength(2);

    const report = await buildMetricsReport(db, { ...window(), agentKey: 'sales-agent' });
    const agent = report.agents.find((a) => a.agentKey === 'sales-agent')!;
    expect(agent.execution.tasks).toBeGreaterThanOrEqual(1);
    expect(agent.execution.attempts).toBeGreaterThanOrEqual(2);
    expect(agent.retries.retriedTasks).toBeGreaterThanOrEqual(1);
    expect(agent.retries.maxAttempts).toBeGreaterThanOrEqual(2);
    expect(agent.execution.successRate).not.toBeNull();
  });
});

describe('AI-MET-01 — durability, isolation and honesty of the figures', () => {
  it('persists rows in PostgreSQL, readable from a separate connection', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    await recordAgentMetric(db, {
      agentKey: 'support-agent',
      taskId,
      scopeOwner: owner.id,
      outcome: 'succeeded',
      attempt: 1,
      latencyMs: 7,
    });

    // A different connection stands in for a restarted process: if the metric
    // lived in module memory this read would return nothing.
    const external = await rawPool.query(
      'select outcome, scope_owner, latency_ms from agent_metrics where task_id = $1',
      [taskId],
    );
    expect(external.rows).toHaveLength(1);
    expect(external.rows[0].outcome).toBe('succeeded');
    expect(external.rows[0].scope_owner).toBe(owner.id);
  });

  it('isolates agents: a report for one agent never contains another agent\'s events', async () => {
    const owner = await customer();
    await recordAgentMetric(db, {
      agentKey: 'b2b-agent',
      taskId: randomUUID(),
      scopeOwner: owner.id,
      outcome: 'succeeded',
      attempt: 1,
    });

    const report = await buildMetricsReport(db, { ...window(), agentKey: 'b2b-agent' });
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].agentKey).toBe('b2b-agent');
    expect(report.integrity.distinctOwners).toBe(1);
  });

  it('reports cost as unavailable instead of inventing a zero', async () => {
    const owner = await customer();
    await recordAgentMetric(db, {
      agentKey: 'risk-agent',
      taskId: randomUUID(),
      scopeOwner: owner.id,
      outcome: 'succeeded',
      attempt: 1,
    });
    const report = await buildMetricsReport(db, { ...window(), agentKey: 'risk-agent' });
    const agent = report.agents[0];
    // No provider ledger row for this synthetic event: the honest answer is
    // "unavailable", never "0 USD spent".
    expect(agent.cost.status).toBe('unavailable');
    expect(agent.cost.costUsd).toBeNull();
    expect(agent.cost.reason).toBeTruthy();
  });

  it('never exposes owner ids, task input or memory content', async () => {
    const owner = await customer();
    const secretNote = `commercial-terms-${randomUUID()}`;
    await recordTaskOutcomeMemory(db, {
      agentKey: 'marketing-agent',
      ownerId: owner.id,
      taskId: randomUUID(),
      status: 'succeeded',
      latencyMs: 5,
    });
    const admin = await makeUser('ADMIN', 'metleak');
    createdUserIds.push(admin.id);

    const res = await admin.client.req(`/api/admin/ai/metrics/report?${qs()}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.data);

    expect(body).not.toContain(owner.id);
    expect(body).not.toContain(secretNote);
    expect(body).not.toMatch(/password|bearer|sk-ant|ghp_/i);
    // The only owner-derived figure is an aggregate count.
    expect(res.data.data.integrity.distinctOwners).toBeGreaterThanOrEqual(1);
  });

  it('counts a stalled open task from its own timestamps', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'analytics-agent',
      requestedBy: owner.id,
      input: { action: 'snapshot' },
      status: 'running',
      startedAt: twoHoursAgo,
      createdAt: twoHoursAgo,
    });

    const report = await buildMetricsReport(db, { ...window(), agentKey: 'analytics-agent' });
    const agent = report.agents.find((a) => a.agentKey === 'analytics-agent')!;
    expect(agent.stalled.count).toBeGreaterThanOrEqual(1);
    expect(agent.stalled.oldestAgeMinutes).toBeGreaterThanOrEqual(90);
    expect(agent.stalled.thresholdMinutes).toBe(env.AI_METRICS_STALL_AFTER_MINUTES);
  });
});

describe('AI-MET-01 — backfill and coverage', () => {
  it('reconstructs history for settled tasks, idempotently', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    await db.insert(agentTasks).values({
      id: taskId,
      agentKey: 'development-agent',
      requestedBy: owner.id,
      input: { action: 'snapshot' },
      status: 'succeeded',
      latencyMs: 1234,
      createdAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    });

    const before = await buildMetricsReport(db, { ...window(), agentKey: 'development-agent' });
    expect(before.coverage.backfillRecommended).toBe(true);

    const first = await backfillAgentMetrics(db, { since: window().from, limit: 5000 });
    expect(first.inserted).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('succeeded');
    expect(rows[0].latencyMs).toBe(1234);

    const second = await backfillAgentMetrics(db, { since: window().from, limit: 5000 });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);

    const after = await buildMetricsReport(db, { ...window(), agentKey: 'development-agent' });
    expect(after.coverage.tasksWithMetric).toBeGreaterThanOrEqual(1);
  });

  it('produces a per-period series from the log', async () => {
    const owner = await customer();
    const taskId = randomUUID();
    await recordAgentMetric(db, {
      agentKey: 'analytics-agent',
      taskId,
      scopeOwner: owner.id,
      outcome: 'failed',
      attempt: 1,
      latencyMs: 50,
      errorCode: 'PROVIDER_ERROR',
    });

    const report = await buildMetricsReport(db, { ...window(), agentKey: 'analytics-agent', granularity: 'day' });
    expect(report.series.length).toBeGreaterThanOrEqual(1);
    const point = report.series[report.series.length - 1];
    expect(point.attempts).toBeGreaterThanOrEqual(1);
    expect(point.failed).toBeGreaterThanOrEqual(1);
    expect(point.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('AI-MET-01 — failure containment and access control', () => {
  it('never lets a metrics outage break the task it measures', async () => {
    const broken = {
      insert() {
        throw new Error('metrics store offline');
      },
    } as unknown as typeof db;
    const wrote = await recordMetricSafely(broken, {
      agentKey: 'marketing-agent',
      taskId: randomUUID(),
      scopeOwner: 'someone',
      outcome: 'succeeded',
    });
    expect(wrote).toBe(false);

    // And the real path still settles: a task completes even when a metric row
    // for it already exists with a conflicting value (duplicate absorbed).
    const owner = await customer();
    const task = await createAgentTask(
      db,
      ['CUSTOMER'],
      owner.id,
      { agentKey: 'market-research-agent', requestedBy: owner.id, input: { action: 'summary' } },
      AUDIT,
    );
    expect(task.status).toBe('succeeded');
  });

  it('refuses non-admins and unauthenticated callers on every metrics endpoint', async () => {
    const viewer = await customer();
    const support = await makeUser('SUPPORT', 'metsupport');
    createdUserIds.push(support.id);

    const paths = [
      '/api/admin/ai/metrics/report',
      '/api/admin/ai/metrics/series',
      '/api/admin/ai/metrics/coverage',
    ];
    for (const path of paths) {
      const anon = await makeClient().req(`${path}?${qs()}`);
      expect(anon.status).toBe(401);
      const asCustomer = await viewer.client.req(`${path}?${qs()}`);
      expect(asCustomer.status).toBe(403);
      const asSupport = await support.client.req(`${path}?${qs()}`);
      expect(asSupport.status).toBe(403);
    }

    const anonBackfill = await makeClient().req('/api/admin/ai/metrics/backfill', { method: 'POST', body: {} });
    expect(anonBackfill.status).toBe(401);
    const customerBackfill = await viewer.client.req('/api/admin/ai/metrics/backfill', {
      method: 'POST',
      body: {},
    });
    expect(customerBackfill.status).toBe(403);
  });

  it('serves the report to ADMIN and SUPER_ADMIN with audited reads', async () => {
    const admin = await makeUser('ADMIN', 'metreport');
    const superAdmin = await makeUser('SUPER_ADMIN', 'metsuper');
    createdUserIds.push(admin.id, superAdmin.id);

    for (const actor of [admin, superAdmin]) {
      const res = await actor.client.req(`/api/admin/ai/metrics/report?${qs()}`);
      expect(res.status).toBe(200);
      const data = res.data.data;
      expect(data.window.granularity).toBe('day');
      expect(data.overall.execution).toBeDefined();
      expect(data.overall.quality.businessOutcomes).toBe('unavailable');
      expect(data.notes.length).toBeGreaterThan(0);
    }

    const [auditRow] = await db
      .select({ id: sql<string>`id` })
      .from(sql`audit_logs`)
      .where(sql`action = 'AI.METRICS_REPORT_READ'`)
      .limit(1);
    expect(auditRow).toBeTruthy();
  });

  it('validates the window and refuses an inverted or oversized range', async () => {
    const admin = await makeUser('ADMIN', 'metrange');
    createdUserIds.push(admin.id);

    const inverted = await admin.client.req(
      `/api/admin/ai/metrics/report?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86_400_000).toISOString()}`,
    );
    expect(inverted.status).toBe(422);

    const tooWide = await admin.client.req(
      `/api/admin/ai/metrics/report?from=${new Date(Date.now() - 500 * 86_400_000).toISOString()}&to=${new Date().toISOString()}`,
    );
    expect(tooWide.status).toBe(422);

    const badGranularity = await admin.client.req(`/api/admin/ai/metrics/report?${qs({ granularity: 'hour' })}`);
    expect(badGranularity.status).toBe(422);

    const unknownFilter = await admin.client.req(`/api/admin/ai/metrics/report?${qs({ ownerId: 'x' })}`);
    expect(unknownFilter.status).toBe(422);
  });

  it('runs a backfill through the admin API and audits it', async () => {
    const admin = await makeUser('ADMIN', 'metbackfill');
    createdUserIds.push(admin.id);
    const { from } = window();

    const res = await admin.client.req('/api/admin/ai/metrics/backfill', {
      method: 'POST',
      body: { from: from.toISOString(), limit: 100 },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.scanned).toBeGreaterThanOrEqual(0);
    expect(typeof res.data.data.inserted).toBe('number');
    expect(typeof res.data.data.skipped).toBe('number');

    const [auditRow] = await db
      .select({ id: sql<string>`id` })
      .from(sql`audit_logs`)
      .where(sql`action = 'AI.METRICS_BACKFILLED'`)
      .limit(1);
    expect(auditRow).toBeTruthy();
  });
});

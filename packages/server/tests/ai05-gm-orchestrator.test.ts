import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentRegistry, agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { aiBudgets } from '../src/db/schema/ai.js';
import { orders } from '../src/db/schema/commerce.js';
import {
  GM_PLAYBOOKS,
  buildReport,
  classifyGoal,
  listGmPlaybooks,
  orchestrateGmGoal,
  planWaves,
  reviewResults,
  type GmStepResult,
} from '../src/modules/ai/orchestrator.js';

/**
 * AI-05.0 — GM Orchestrator (central command & coordination layer).
 *
 * These integration tests drive the REAL orchestrator against the REAL database
 * and pin the properties the layer exists to guarantee:
 *
 *   - Planning is deterministic (keyword classification + dependency waves) and
 *     never starts a step whose prerequisite did not run.
 *   - Every delegated step goes through `createAgentTask`, so the caller's REAL
 *     roles apply — the orchestrator never fabricates a `SUPER_ADMIN`.
 *   - The kill switch, the platform-scope gate and the human-approval gate are
 *     honoured per step; a gated step is *not* executed by the orchestrator.
 *   - The layer performs no financial/commercial mutation.
 *   - A completed run is audited (`AI.GM_ORCHESTRATED`).
 *
 * No service is mocked: every assertion reads the effect back from the database.
 */

const AUDIT = { actorId: 'test-gm' };

/** Task ids created by this file, removed after it finishes. */
const createdTaskIds: string[] = [];

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
});

async function insertStaff(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `ai05-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Ai05Pass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

/** Orders attributed to the requester — must never change during an orchestration. */
async function commerceRowsFor(userId: string): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.buyerId, userId));
  return rows[0]?.v ?? 0;
}

/** Records the task ids an orchestration created so the file can clean them up. */
function remember(run: { results: { taskId: string | null }[] }): void {
  for (const r of run.results) if (r.taskId) createdTaskIds.push(r.taskId);
}

// ---------------------------------------------------------------------------
// Pure planning logic — no database, no clock.
// ---------------------------------------------------------------------------

describe('AI-05.0 — deterministic planning (pure)', () => {
  it('classifies a goal by keyword and falls back deterministically', () => {
    expect(classifyGoal('Platform health check please').playbook.id).toBe('platform.health_review');
    expect(classifyGoal('نمو الإيرادات والمبيعات').playbook.id).toBe('revenue.growth');
    // An unrelated goal falls back to the first (default) playbook, never random.
    expect(classifyGoal('zzz unknown zzz').playbook.id).toBe('platform.health_review');
  });

  it('orders dependent steps into waves (prerequisites first)', () => {
    const pb = GM_PLAYBOOKS.find((p) => p.id === 'revenue.growth')!;
    const { waves, dropped } = planWaves(pb.steps);
    expect(dropped).toEqual([]);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([['research'], ['marketing'], ['ads']]);
  });

  it('drops steps with a missing dependency instead of running them out of order', () => {
    const { waves, dropped } = planWaves([
      { id: 'a', agentKey: 'x', taskType: 't', intent: '', intentAr: '', dependsOn: ['missing'] },
      { id: 'b', agentKey: 'x', taskType: 't', intent: '', intentAr: '', dependsOn: [] },
    ]);
    expect(dropped).toContain('a');
    expect(waves.flat().map((s) => s.id)).toEqual(['b']);
  });

  it('drops a dependency cycle rather than looping', () => {
    const { waves, dropped } = planWaves([
      { id: 'a', agentKey: 'x', taskType: 't', intent: '', intentAr: '', dependsOn: ['b'] },
      { id: 'b', agentKey: 'x', taskType: 't', intent: '', intentAr: '', dependsOn: ['a'] },
    ]);
    expect(waves.flat()).toEqual([]);
    expect(dropped.sort()).toEqual(['a', 'b']);
  });

  it('treats a succeeded step with no substantive evidence as insufficient (a proposal is not proof)', () => {
    const results: GmStepResult[] = [
      { stepId: 'with', agentKey: 'a', taskType: 't', intent: '', intentAr: '', outcome: 'succeeded', taskId: '1', requiresApproval: false, approvalAction: null, evidenceKeys: ['orders'], evidence: { orders: '3' }, error: null, skippedReason: null },
      { stepId: 'without', agentKey: 'b', taskType: 't', intent: '', intentAr: '', outcome: 'succeeded', taskId: '2', requiresApproval: false, approvalAction: null, evidenceKeys: [], evidence: {}, error: null, skippedReason: null },
    ];
    const review = reviewResults(results);
    expect(review.insufficientEvidence).toEqual(['without']);
    expect(review.hasBlockingIssues).toBe(true);
  });

  it('flags a cross-agent conflict on the same evidence key', () => {
    const base = (stepId: string, value: string): GmStepResult => ({
      stepId, agentKey: 'a', taskType: 't', intent: '', intentAr: '', outcome: 'succeeded', taskId: stepId, requiresApproval: false, approvalAction: null, evidenceKeys: ['orders'], evidence: { orders: value }, error: null, skippedReason: null,
    });
    const review = reviewResults([base('s1', '10'), base('s2', '12')]);
    expect(review.conflicts.map((c) => c.key)).toEqual(['orders']);
    expect(review.hasBlockingIssues).toBe(true);
  });

  it('produces an Arabic management report with risks and priorities', () => {
    const pb = GM_PLAYBOOKS[0]!;
    const results: GmStepResult[] = [
      { stepId: 'ops', agentKey: 'operations-agent', taskType: 'operations.health_check', intent: '', intentAr: '', outcome: 'failed', taskId: '1', requiresApproval: false, approvalAction: null, evidenceKeys: [], evidence: {}, error: 'boom', skippedReason: null },
    ];
    const review = reviewResults(results);
    const report = buildReport({ goal: 'health', playbook: pb, matched: ['health'], results, review });
    expect(report.summaryAr).toMatch(/المهمة/);
    expect(report.risks.join(' ')).toMatch(/فشلت/);
    expect(report.priorities.length).toBeGreaterThan(0);
  });

  it('lists playbooks with their agents', () => {
    const books = listGmPlaybooks();
    expect(books.length).toBe(GM_PLAYBOOKS.length);
    expect(books.find((b) => b.id === 'platform.health_review')!.agents).toEqual(
      expect.arrayContaining(['operations-agent', 'analytics-agent']),
    );
  });
});

// ---------------------------------------------------------------------------
// Orchestration against the real database.
// ---------------------------------------------------------------------------

describe('AI-05.0 — orchestration (integration)', () => {
  let superAdmin: { id: string };

  beforeEach(async () => {
    superAdmin = await insertStaff('SUPER_ADMIN');
  });

  it('coordinates a health review, aggregates real evidence and audits the run', async () => {
    const run = await orchestrateGmGoal(db, {
      goal: 'platform health review',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);

    expect(run.playbookId).toBe('platform.health_review');
    const succeeded = run.results.filter((r) => r.outcome === 'succeeded');
    expect(succeeded.map((r) => r.stepId).sort()).toEqual(['analytics', 'ops']);
    // Real, live-data evidence — not an empty proposal.
    for (const s of succeeded) expect(s.evidenceKeys.length).toBeGreaterThan(0);
    expect(run.review.evidenceCount).toBeGreaterThan(0);
    expect(run.report.summaryAr).toContain('المهمة');
    expect(run.report.steps.length).toBe(run.results.length);

    // Every delegated task is correlated to this run.
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.correlationId, run.runId));
    expect(tasks.length).toBe(succeeded.length);
    expect(tasks.every((t) => t.triggeredBy === `gm:${run.runId}`)).toBe(true);

    // The run is audited.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.GM_ORCHESTRATED'), eq(auditLogs.entityId, run.runId)));
    expect(audit.length).toBe(1);
  });

  it('never mutates commercial data', async () => {
    const before = await commerceRowsFor(superAdmin.id);
    const run = await orchestrateGmGoal(db, {
      goal: 'platform health review',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);
    expect(await commerceRowsFor(superAdmin.id)).toBe(before);
  });

  it('never fabricates a SUPER_ADMIN: a MERCHANT cannot reach platform-scoped agents', async () => {
    const merchant = await insertStaff('MERCHANT');
    const run = await orchestrateGmGoal(db, {
      goal: 'platform health review',
      requestedBy: merchant.id,
      role: ['MERCHANT'],
      audit: AUDIT,
    });
    remember(run);

    // Both steps are platform-scoped; a merchant must be refused, not escalated.
    expect(run.results.every((r) => r.outcome === 'skipped')).toBe(true);
    expect(run.results.some((r) => r.outcome === 'succeeded')).toBe(false);
    expect(run.results.map((r) => r.skippedReason).join(' ')).toMatch(/admin role/i);
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.correlationId, run.runId));
    expect(tasks.length).toBe(0);
  });

  it('honours the kill switch: a DISABLED agent is skipped, not run', async () => {
    await db.update(agentRegistry).set({ status: 'DISABLED' }).where(eq(agentRegistry.key, 'operations-agent'));
    try {
      const run = await orchestrateGmGoal(db, {
        goal: 'platform health review',
        requestedBy: superAdmin.id,
        role: ['SUPER_ADMIN'],
        audit: AUDIT,
      });
      remember(run);
      const ops = run.results.find((r) => r.stepId === 'ops')!;
      expect(ops.outcome).toBe('skipped');
      expect(ops.skippedReason).toMatch(/DISABLED/);
      // The other step still ran — one stopped agent does not abort the run.
      expect(run.results.find((r) => r.stepId === 'analytics')!.outcome).toBe('succeeded');
    } finally {
      await db.update(agentRegistry).set({ status: 'ACTIVE' }).where(eq(agentRegistry.key, 'operations-agent'));
    }
  });

  it('gates a sensitive agent behind human approval without executing it', async () => {
    const run = await orchestrateGmGoal(db, {
      goal: 'revenue growth plan',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);

    expect(run.playbookId).toBe('revenue.growth');
    const ads = run.results.find((r) => r.stepId === 'ads')!;
    expect(ads.outcome).toBe('awaiting_approval');
    expect(ads.requiresApproval).toBe(true);
    expect(ads.evidenceKeys).toEqual([]);
    expect(run.review.pendingApproval).toContain('ads');

    // The gated task exists in `awaiting_approval` and produced no result.
    const gated = await db.select().from(agentTasks).where(eq(agentTasks.id, ads.taskId!));
    expect(gated[0]!.status).toBe('awaiting_approval');
    expect(gated[0]!.result).toBeNull();

    // The proposed spend increase is advisory only — never auto-executed.
    const spend = run.proposedActions.find((a) => a.action === 'ads.spend_increase')!;
    expect(spend.requiresApproval).toBe(true);
    expect(spend.executed).toBe(false);
  });

  it('caps the number of steps it will run in one orchestration', async () => {
    const run = await orchestrateGmGoal(db, {
      goal: 'revenue growth plan',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
      options: { maxSteps: 1 },
    });
    remember(run);
    // Only the first declared step may run; the rest are reported as skipped.
    const ran = run.results.filter((r) => r.outcome !== 'skipped');
    expect(ran.map((r) => r.stepId)).toEqual(['research']);
    expect(run.results.filter((r) => r.outcome === 'skipped').map((r) => r.stepId).sort()).toEqual(['ads', 'marketing']);
  });

  it('executes dependent steps after their prerequisite (real ordering, not just planning)', async () => {
    const run = await orchestrateGmGoal(db, {
      goal: 'revenue growth plan',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);

    const research = run.results.find((r) => r.stepId === 'research')!;
    const marketing = run.results.find((r) => r.stepId === 'marketing')!;
    expect(research.taskId).toBeTruthy();
    expect(marketing.taskId).toBeTruthy();

    // The marketing task was created only after the research task it depends on.
    const rows = await db
      .select({ id: agentTasks.id, createdAt: agentTasks.createdAt })
      .from(agentTasks)
      .where(inArray(agentTasks.id, [research.taskId!, marketing.taskId!]));
    const byId = new Map(rows.map((r) => [r.id, r.createdAt]));
    expect(byId.get(marketing.taskId!)!.getTime()).toBeGreaterThanOrEqual(byId.get(research.taskId!)!.getTime());
  });

  it('does not bypass the budget guard: an exhausted budget fails a step closed (never a success)', async () => {
    // A zero-request monthly budget makes the reasoning call throw 429 — the
    // delegated task must fail closed, and the orchestrator must report it as
    // `not_run` (never as a success on an unbudgeted call). This uses the
    // request-count limit, so it is independent of the configured provider.
    await db.insert(aiBudgets).values({
      id: randomUUID(),
      userId: superAdmin.id,
      period: 'MONTHLY',
      maxRequests: 0,
      currencyCode: 'USD',
      isActive: true,
    });
    const run = await orchestrateGmGoal(db, {
      goal: 'platform health review',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);

    expect(run.results.some((r) => r.outcome === 'succeeded')).toBe(false);
    const ops = run.results.find((r) => r.stepId === 'ops')!;
    expect(['not_run', 'failed']).toContain(ops.outcome);
    expect(run.review.hasBlockingIssues).toBe(true);
  });

  it('falls back to a default playbook and still returns a report for an unroutable goal', async () => {
    const run = await orchestrateGmGoal(db, {
      goal: 'zzz totally unrelated zzz',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: AUDIT,
    });
    remember(run);
    expect(run.playbookId).toBe('platform.health_review');
    expect(run.matchedKeywords).toEqual([]);
    expect(run.report.summaryAr).toContain('المهمة');
    expect(run.results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface — `/api/admin/gm/*` (SUPER_ADMIN only).
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
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, data: data as any };
    },
  };
}

async function loginStaff(roleName: 'SUPER_ADMIN' | 'ADMIN') {
  const { id, email } = await insertStaff(roleName);
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'Ai05Pass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

describe('AI-05.0 — GM desk routes (SUPER_ADMIN only)', () => {
  it('rejects unauthenticated access (401)', async () => {
    const c = makeClient();
    expect((await c.req('/api/admin/gm/playbooks')).status).toBe(401);
    expect((await c.req('/api/admin/gm/orchestrate', { method: 'POST', body: { goal: 'platform health review' } })).status).toBe(401);
  });

  it('rejects ADMIN (403) — the GM desk is SUPER_ADMIN only', async () => {
    const { client } = await loginStaff('ADMIN');
    expect((await client.req('/api/admin/gm/playbooks')).status).toBe(403);
    expect((await client.req('/api/admin/gm/orchestrate', { method: 'POST', body: { goal: 'platform health review' } })).status).toBe(403);
  });

  it('lets a SUPER_ADMIN list playbooks and run an orchestration', async () => {
    const { client } = await loginStaff('SUPER_ADMIN');
    const books = await client.req('/api/admin/gm/playbooks');
    expect(books.status).toBe(200);
    expect(books.data.data.items.length).toBe(GM_PLAYBOOKS.length);

    const run = await client.req('/api/admin/gm/orchestrate', {
      method: 'POST',
      body: { goal: 'platform health review' },
    });
    expect(run.status).toBe(201);
    expect(run.data.data.playbookId).toBe('platform.health_review');
    for (const r of run.data.data.results as { taskId: string | null }[]) {
      if (r.taskId) createdTaskIds.push(r.taskId);
    }
  });
});

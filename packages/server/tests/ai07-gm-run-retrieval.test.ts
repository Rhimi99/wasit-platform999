import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  GM_SNAPSHOT_VERSION,
  getGmRun,
  orchestrateGmGoal,
} from '../src/modules/ai/orchestrator.js';

/**
 * AI-07.0 / AI-07.0a — GM Run Retrieval (snapshot + read surface).
 *
 * These integration tests drive the REAL orchestrator and the REAL HTTP surface
 * against the REAL database. They pin the properties the retrieval feature must
 * guarantee:
 *
 *   - A completed run persists a full, versioned snapshot in `audit_logs.after`.
 *   - `getGmRun` replays it VERBATIM — the review/report/proposedActions are the
 *     originals, never recomputed from current agent/task state, so a later
 *     status change cannot rewrite history.
 *   - Skipped / failed / awaiting_approval steps and their reasons are captured.
 *   - Retrieval is read-only: it creates and mutates nothing.
 *   - Access control is enforced server-side (401 / 403 / 404) and a non-owner,
 *     non-platform caller cannot read — or even detect — another owner's run.
 *   - Legacy runs (no snapshot) fail closed with 404 rather than being
 *     reconstructed from live rows.
 *
 * No service is mocked: every assertion reads the effect back from the database.
 */

const AUDIT = { actorId: 'test-gm' };
const app = createApp();

/** Task ids created by this file, removed after it finishes. */
const createdTaskIds: string[] = [];
/** User ids created by this file. */
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function insertStaff(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `ai07-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Ai07Pass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

/** Records the task ids an orchestration created so the file can clean them up. */
function remember(run: { results: { taskId: string | null }[] }): void {
  for (const r of run.results) if (r.taskId) createdTaskIds.push(r.taskId);
}

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
    body: { email, password: 'Ai07Pass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, id };
}

/** Runs one orchestration as a super-admin and returns the in-memory result. */
async function runAs(requestedBy: string, goal: string) {
  const run = await orchestrateGmGoal(db, {
    goal,
    requestedBy,
    role: ['SUPER_ADMIN'],
    audit: { actorId: requestedBy },
  });
  remember(run);
  return run;
}

/** Runs one orchestration under an explicit (non-admin) role set. */
async function runAsRole(requestedBy: string, role: ('SUPER_ADMIN' | 'MERCHANT')[], goal: string) {
  const run = await orchestrateGmGoal(db, {
    goal,
    requestedBy,
    role,
    audit: { actorId: requestedBy },
  });
  remember(run);
  return run;
}

/** The exact `after` JSON persisted for a run's audit row. */
async function storedSnapshot(runId: string) {
  const rows = await db
    .select({ after: auditLogs.after })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'AI.GM_ORCHESTRATED'), eq(auditLogs.entityId, runId)))
    .limit(1);
  return rows[0]?.after ?? null;
}

// ---------------------------------------------------------------------------
// Snapshot persistence (AI-07.0a).
// ---------------------------------------------------------------------------

describe('AI-07.0a — the run is persisted as a versioned snapshot', () => {
  it('writes a versioned snapshot carrying the full result into audit_logs.after', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    const run = await runAs(superAdmin.id, 'platform health review');

    const after = (await storedSnapshot(run.runId)) as Record<string, unknown> | null;
    expect(after).toBeTruthy();
    expect(after!.version).toBe(GM_SNAPSHOT_VERSION);
    expect(after!.goal).toBe('platform health review');
    expect(after!.requestedBy).toBe(superAdmin.id);
    expect(after!.role).toEqual(['SUPER_ADMIN']);
    expect(after!.playbookId).toBe('platform.health_review');
    // The whole result — not just counts.
    expect(Array.isArray(after!.results)).toBe(true);
    expect((after!.results as unknown[]).length).toBe(run.results.length);
    expect(after!.review).toEqual(run.review);
    expect(after!.report).toEqual(run.report);
    expect(after!.proposedActions).toEqual(run.proposedActions);
    expect(typeof after!.capturedAt).toBe('string');
  });

  it('captures skipped, failed/not_run and awaiting_approval steps with their reasons', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');

    // 1) skipped: under a non-admin role, a platform-scoped agent is skipped
    // (never run) and the reason is captured. `risk-agent` is not toggled by any
    // other suite, so this assertion is not racing a shared registry row.
    const merchant = await insertStaff('MERCHANT');
    const skippedRun = await runAsRole(merchant.id, ['MERCHANT'], 'risk and compliance review');
    const skippedSnap = (await storedSnapshot(skippedRun.runId)) as {
      results: { stepId: string; outcome: string; skippedReason: string | null }[];
    };
    const riskStep = skippedSnap.results.find((r) => r.stepId === 'risk')!;
    expect(riskStep.outcome).toBe('skipped');
    expect(riskStep.skippedReason).toBeTruthy();
    expect(riskStep.skippedReason).toMatch(/risk-agent|admin role/i);

    // 2) awaiting_approval: the ads step is gated, not executed.
    const growthRun = await runAs(superAdmin.id, 'revenue growth plan');
    const growthSnap = (await storedSnapshot(growthRun.runId)) as { results: { stepId: string; outcome: string; requiresApproval: boolean }[] };
    const adsStep = growthSnap.results.find((r) => r.stepId === 'ads')!;
    expect(adsStep.outcome).toBe('awaiting_approval');
    expect(adsStep.requiresApproval).toBe(true);

    // 3) failed/not_run: an exhausted request budget fails a step closed. The
    // snapshot must carry that outcome (never as a success). `catalog.quality`
    // runs a single step on `product-agent` (not toggled by other suites).
    const { aiBudgets } = await import('../src/db/schema/ai.js');
    await db.insert(aiBudgets).values({
      id: randomUUID(),
      userId: superAdmin.id,
      period: 'MONTHLY',
      maxRequests: 0,
      currencyCode: 'USD',
      isActive: true,
    });
    const budgetRun = await runAs(superAdmin.id, 'catalogue quality audit');
    const budgetSnap = (await storedSnapshot(budgetRun.runId)) as { results: { stepId: string; outcome: string }[] };
    const budgetStep = budgetSnap.results.find((r) => r.stepId === 'product')!;
    expect(['not_run', 'failed']).toContain(budgetStep.outcome);
    // Clean up so the budget does not leak into other runs in this file.
    await db.delete(aiBudgets).where(eq(aiBudgets.userId, superAdmin.id));
  });

  it('does not store request metadata or secrets in the snapshot', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    const run = await orchestrateGmGoal(db, {
      goal: 'platform health review',
      requestedBy: superAdmin.id,
      role: ['SUPER_ADMIN'],
      audit: { actorId: superAdmin.id, ipAddress: '203.0.113.7', userAgent: 'vitest-agent/1.0' },
    });
    remember(run);

    const after = (await storedSnapshot(run.runId)) as Record<string, unknown>;
    const serialized = JSON.stringify(after);
    // The snapshot keeps the requester id but never the request's IP/User-Agent.
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('vitest-agent/1.0');
    expect(after.requestedBy).toBe(superAdmin.id);
  });
});

// ---------------------------------------------------------------------------
// Deterministic replay (AI-07.0).
// ---------------------------------------------------------------------------

describe('AI-07.0 — getGmRun replays the original result verbatim', () => {
  it('returns exactly the run the orchestrator produced', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    const run = await runAs(superAdmin.id, 'platform health review');

    const fetched = await getGmRun(db, run.runId, superAdmin.id);
    expect(fetched.runId).toBe(run.runId);
    expect(fetched.correlationId).toBe(run.runId);
    expect(fetched.playbookId).toBe(run.playbookId);
    expect(fetched.matchedKeywords).toEqual(run.matchedKeywords);
    expect(fetched.plan).toEqual(run.plan);
    expect(fetched.results).toEqual(run.results);
    expect(fetched.review).toEqual(run.review);
    expect(fetched.report).toEqual(run.report);
    expect(fetched.proposedActions).toEqual(run.proposedActions);
  });

  it('does not recompute from current state: a later status change cannot rewrite history', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    // The ads step is gated at run time.
    const run = await runAs(superAdmin.id, 'revenue growth plan');
    const adsStep = run.results.find((r) => r.stepId === 'ads')!;
    expect(adsStep.outcome).toBe('awaiting_approval');
    const adsTaskId = adsStep.taskId!;

    // Mutate live state AFTER the run: approve the gated task. A recompute from
    // live rows would map the new status to `not_run`; the snapshot must not.
    await db.update(agentTasks).set({ status: 'approved' }).where(eq(agentTasks.id, adsTaskId));
    const liveTask = await db.select().from(agentTasks).where(eq(agentTasks.id, adsTaskId)).limit(1);
    expect(liveTask[0]!.status).toBe('approved');

    const fetched = await getGmRun(db, run.runId, superAdmin.id);
    const fetchedAds = fetched.results.find((r) => r.stepId === 'ads')!;
    // The retrieved report still shows what happened at execution time.
    expect(fetchedAds.outcome).toBe('awaiting_approval');
    expect(fetched.review).toEqual(run.review);
    expect(fetched.review.pendingApproval).toContain('ads');
  });

  it('retrieval creates and mutates nothing', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    const run = await runAs(superAdmin.id, 'revenue growth plan');

    const countTasks = async () =>
      (await db.select({ v: sql<number>`count(*)::int` }).from(agentTasks))[0]?.v ?? 0;
    const countAudit = async () =>
      (await db.select({ v: sql<number>`count(*)::int` }).from(auditLogs))[0]?.v ?? 0;

    const tasksBefore = await countTasks();
    const auditBefore = await countAudit();
    const snapshotBefore = await storedSnapshot(run.runId);

    await getGmRun(db, run.runId, superAdmin.id);
    await getGmRun(db, run.runId, superAdmin.id);

    expect(await countTasks()).toBe(tasksBefore);
    expect(await countAudit()).toBe(auditBefore);
    expect(await storedSnapshot(run.runId)).toEqual(snapshotBefore);
  });

  it('fails closed with 404 for an unknown run and for a legacy run with no snapshot', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    await expect(getGmRun(db, randomUUID(), superAdmin.id)).rejects.toMatchObject({ statusCode: 404 });

    // A legacy run: an audit row exists but carries no snapshot (pre-AI-07.0a).
    const legacyId = randomUUID();
    await db.insert(auditLogs).values({
      id: randomUUID(),
      actorId: superAdmin.id,
      action: 'AI.GM_ORCHESTRATED',
      entityType: 'AI_ORCHESTRATION',
      entityId: legacyId,
      metadata: { playbookId: 'platform.health_review' },
    });
    await expect(getGmRun(db, legacyId, superAdmin.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('fails closed for a snapshot version this build cannot read', async () => {
    const superAdmin = await insertStaff('SUPER_ADMIN');
    const futureId = randomUUID();
    await db.insert(auditLogs).values({
      id: randomUUID(),
      actorId: superAdmin.id,
      action: 'AI.GM_ORCHESTRATED',
      entityType: 'AI_ORCHESTRATION',
      entityId: futureId,
      after: { version: 999, requestedBy: superAdmin.id, results: [] } as never,
    });
    await expect(getGmRun(db, futureId, superAdmin.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Access control & owner isolation (HTTP surface).
// ---------------------------------------------------------------------------

describe('AI-07.0 — HTTP surface /api/admin/gm/runs/:correlationId', () => {
  it('rejects unauthenticated access (401)', async () => {
    const c = makeClient();
    expect((await c.req(`/api/admin/gm/runs/${randomUUID()}`)).status).toBe(401);
  });

  it('rejects ADMIN (403) — the GM desk is SUPER_ADMIN only', async () => {
    const { client } = await loginStaff('ADMIN');
    expect((await client.req(`/api/admin/gm/runs/${randomUUID()}`)).status).toBe(403);
  });

  it('lets a SUPER_ADMIN run a goal and read it back', async () => {
    const { client, id } = await loginStaff('SUPER_ADMIN');
    const run = await client.req('/api/admin/gm/orchestrate', {
      method: 'POST',
      body: { goal: 'platform health review' },
    });
    expect(run.status).toBe(201);
    const runId = run.data.data.runId as string;
    for (const r of run.data.data.results as { taskId: string | null }[]) {
      if (r.taskId) createdTaskIds.push(r.taskId);
    }

    const fetched = await client.req(`/api/admin/gm/runs/${runId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.data.data.runId).toBe(runId);
    expect(fetched.data.data.report).toEqual(run.data.data.report);
    expect(fetched.data.data.review).toEqual(run.data.data.review);
    expect(fetched.data.data.proposedActions).toEqual(run.data.data.proposedActions);
    expect(fetched.data.data.requestedBy).toBe(id);
  });

  it('answers 404 for an unknown run id', async () => {
    const { client } = await loginStaff('SUPER_ADMIN');
    expect((await client.req(`/api/admin/gm/runs/${randomUUID()}`)).status).toBe(404);
  });

  it('does not leak another owner’s run to a non-platform caller', async () => {
    // Owner: a super-admin who ran the goal.
    const owner = await insertStaff('SUPER_ADMIN');
    const run = await runAs(owner.id, 'platform health review');

    // A non-platform caller (MERCHANT) who knows the run id must get 404 — the
    // same answer as a missing run, so existence is not disclosed.
    const merchant = await insertStaff('MERCHANT');
    await expect(getGmRun(db, run.runId, merchant.id)).rejects.toMatchObject({ statusCode: 404 });

    // The owner and any platform-scope holder can read it.
    const asOwner = await getGmRun(db, run.runId, owner.id);
    expect(asOwner.runId).toBe(run.runId);
    const otherAdmin = await insertStaff('ADMIN');
    const asAdmin = await getGmRun(db, run.runId, otherAdmin.id);
    expect(asAdmin.runId).toBe(run.runId);
  });
});

// ---------------------------------------------------------------------------
// Run log / list surface (AI-07.1 desk).
// ---------------------------------------------------------------------------

describe('AI-07.1 — the GM run log lists runs read-only', () => {
  it('lists a run from its audit metadata with hasSnapshot=true', async () => {
    const { client, id } = await loginStaff('SUPER_ADMIN');
    const run = await runAs(id, 'revenue growth plan');

    const res = await client.req('/api/admin/gm/runs?limit=200');
    expect(res.status).toBe(200);
    const items = res.data.data.items as { runId: string; playbookId: string | null; hasSnapshot: boolean; goal: string | null }[];
    const row = items.find((r) => r.runId === run.runId);
    expect(row).toBeTruthy();
    expect(row!.playbookId).toBe('revenue.growth');
    expect(row!.hasSnapshot).toBe(true);
    expect(row!.goal).toBe('revenue growth plan');
  });

  it('does not write anything when listing', async () => {
    const { client, id } = await loginStaff('SUPER_ADMIN');
    await runAs(id, 'revenue growth plan');

    const first = await client.req('/api/admin/gm/runs?limit=200');
    const second = await client.req('/api/admin/gm/runs?limit=200');
    // Identical listing twice: no run was appended by reading.
    expect((second.data.data.items as unknown[]).length).toBe((first.data.data.items as unknown[]).length);
  });

  it('refuses an ADMIN-only caller', async () => {
    const { client } = await loginStaff('ADMIN');
    expect((await client.req('/api/admin/gm/runs')).status).toBe(403);
  });
});

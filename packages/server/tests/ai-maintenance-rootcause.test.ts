import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { createAgentTask } from '../src/modules/ai/agents.js';
import { createApp } from '../src/app.js';

/**
 * Platform Maintenance & Repair — the diagnosis end to end.
 *
 * Real lifecycle (`createAgentTask` → executor → PostgreSQL) over failures this
 * file plants with distinct causes, then the same agent reached over HTTP to
 * check the RBAC boundary. Nothing is mocked, and the read-only claim is checked
 * by comparing the planted rows before and after the run.
 */

const app = createApp();
const AUDIT = { actorId: 'it-maintenance', ipAddress: null, userAgent: null };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];

async function insertUser(roleName: string) {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `mnt-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('MaintenancePass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

async function plantFailure(agentKey: string, message: string) {
  const id = randomUUID();
  createdTaskIds.push(id);
  await db.insert(agentTasks).values({
    id,
    agentKey,
    requestedBy: 'it-maintenance-seed',
    taskType: 'diagnostic_fixture',
    input: { seeded: true } as never,
    status: 'failed',
    error: { message } as never,
    requiresApproval: false,
    triggeredBy: 'test',
  });
  return id;
}

function adviceOf(task: { result: unknown }): Record<string, unknown> {
  const advice = (task.result as { advice?: string } | null)?.advice;
  expect(typeof advice).toBe('string');
  return JSON.parse(advice as string) as Record<string, unknown>;
}

let adminId = '';

beforeAll(async () => {
  const admin = await insertUser('SUPER_ADMIN');
  adminId = admin.id;

  // Three failures with the same cause (different ids, so only the signature
  // normalization can group them) and one with a different cause.
  await plantFailure('sales-agent', 'Insufficient stock for product 550e8400-e29b-41d4-a716-446655440000');
  await plantFailure('product-agent', 'Insufficient stock for product 123e4567-e89b-12d3-a456-426614174000');
  await plantFailure('analytics-agent', 'Insufficient stock for product 9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f');
  await plantFailure('ads-agent', 'Upstream timed out after 30s');
});

afterAll(async () => {
  await db.delete(agentTasks).where(sql`${agentTasks.requestedBy} = 'it-maintenance-seed'`);
  for (const id of createdTaskIds) await db.delete(agentTasks).where(eq(agentTasks.id, id));
  for (const id of createdUserIds) {
    await db.delete(userRoles).where(eq(userRoles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeDb();
});

describe('maintenance agent — computed root cause', () => {
  it('groups the planted failures and names the dominant cause', async () => {
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      adminId,
      { agentKey: 'development-agent', requestedBy: adminId, input: { windowDays: 7 } },
      AUDIT,
    );
    expect(task.status).toBe('succeeded');

    const advice = adviceOf(task);
    expect(advice.readOnly).toBe(true);

    const analysis = advice.rootCauseAnalysis as {
      sampleSize: number;
      dominant: { family: string; occurrences: number; confidence: string; agents: string[] };
      unknownSamples: number;
    };
    expect(analysis.sampleSize).toBeGreaterThanOrEqual(4);
    expect(analysis.dominant.family).toBe('INSUFFICIENT_STOCK');
    expect(analysis.dominant.occurrences).toBeGreaterThanOrEqual(3);
    expect(analysis.dominant.confidence).toBe('high');
    expect(analysis.dominant.agents).toEqual(
      expect.arrayContaining(['sales-agent', 'product-agent', 'analytics-agent']),
    );
  });

  it('turns the cause into a patch proposal that waits for the GM', async () => {
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      adminId,
      { agentKey: 'development-agent', requestedBy: adminId, input: { windowDays: 7 } },
      AUDIT,
    );
    const advice = adviceOf(task);

    const proposals = advice.patchProposals as Array<{
      family: string;
      likelyFiles: string[];
      requiresGmApproval: boolean;
      status: string;
      testsToAdd: string[];
      rollback: string;
    }>;
    expect(proposals.length).toBeGreaterThan(0);

    const stock = proposals.find((p) => p.family === 'INSUFFICIENT_STOCK')!;
    expect(stock).toBeDefined();
    expect(stock.likelyFiles).toContain('src/lib/inventory-engine.ts');
    expect(stock.requiresGmApproval).toBe(true);
    expect(stock.status).toBe('PROPOSED');
    expect(stock.testsToAdd.length).toBeGreaterThan(0);
    expect(stock.rollback.length).toBeGreaterThan(0);
  });

  it('packages the dominant cause as an independent branch + PR, with no diff and no recorded approval', async () => {
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      adminId,
      { agentKey: 'development-agent', requestedBy: adminId, input: { windowDays: 7 } },
      AUDIT,
    );
    const advice = adviceOf(task);
    const pkg = advice.repairPackage as {
      branch: string;
      baseBranch: string;
      prTitle: string;
      prBody: string;
      approvalStatus: string;
      approvalsRequired: string[];
      rollback: string;
      blocked: Array<{ step: string }>;
    } | null;

    expect(pkg).toBeTruthy();
    expect(pkg!.baseBranch).toBe('master');
    expect(pkg!.branch).toMatch(/^ai-repair\/[a-z-]+$/);
    expect(pkg!.prTitle).toContain('INSUFFICIENT_STOCK');
    expect(pkg!.prBody).toContain('Rollback');
    expect(pkg!.prBody).toContain('Approval');
    // Nothing is applied and nothing is approved by the agent itself.
    expect(pkg!.prBody).not.toContain('```diff');
    expect(pkg!.approvalStatus).toBe('NOT_RECORDED');
    expect(pkg!.approvalsRequired).toEqual(['code.apply_patch', 'code.merge']);
    expect(pkg!.blocked.map((b) => b.step).sort()).toEqual(['apply_patch', 'isolated_tests']);
  });

  it('reports every step of the repair chain, including what it cannot do', async () => {
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      adminId,
      { agentKey: 'development-agent', requestedBy: adminId, input: { windowDays: 7 } },
      AUDIT,
    );
    const advice = adviceOf(task);

    const report = advice.reviewReport as {
      summary: string;
      checklist: Array<{ step: string; state: string; detail: string }>;
      approvalsRequired: string[];
      appliesChanges: boolean;
    };
    const state = (step: string) => report.checklist.find((s) => s.step === step)?.state;

    expect(state('diagnose')).toBe('done');
    expect(state('root_cause')).toBe('done');
    expect(state('patch_proposal')).toBe('done');
    expect(state('isolated_tests')).toBe('blocked');
    expect(state('apply_patch')).toBe('pending_approval');
    expect(report.appliesChanges).toBe(false);
    expect(report.approvalsRequired).toEqual(['code.apply_patch', 'code.merge']);

    const protocol = advice.repairProtocol as { blocked: Array<{ step: string }>; appliesChanges: boolean };
    expect(protocol.appliesChanges).toBe(false);
    expect(protocol.blocked.map((b) => b.step)).toEqual(
      expect.arrayContaining(['isolated_tests', 'apply_patch']),
    );
  });

  it('changes nothing it diagnoses', async () => {
    const before = await db
      .select({ id: agentTasks.id, status: agentTasks.status, error: agentTasks.error })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, 'it-maintenance-seed'))
      .orderBy(agentTasks.id);

    await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      adminId,
      { agentKey: 'development-agent', requestedBy: adminId, input: { windowDays: 7 } },
      AUDIT,
    );

    const after = await db
      .select({ id: agentTasks.id, status: agentTasks.status, error: agentTasks.error })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, 'it-maintenance-seed'))
      .orderBy(agentTasks.id);

    expect(after).toEqual(before);
  });
});

describe('maintenance agent — HTTP boundary', () => {
  async function loginAs(roleName: string) {
    const user = await insertUser(roleName);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'MaintenancePass123!', allowUnverifiedEmail: true }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie') ?? '';
  }

  it('refuses a customer at the platform boundary and lets an admin run the diagnosis', async () => {
    const customerCookie = await loginAs('CUSTOMER');
    const denied = await app.request('/api/ai/agents/development-agent/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: customerCookie },
      body: JSON.stringify({ input: { windowDays: 7 } }),
    });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string; message: string } };
    expect(deniedBody.error.message).toContain('platform-wide');

    const adminCookie = await loginAs('SUPER_ADMIN');
    const allowed = await app.request('/api/ai/agents/development-agent/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ input: { windowDays: 7 } }),
    });
    expect(allowed.status).toBe(201);
    const payload = (await allowed.json()) as { data: { result: { advice: string } } };
    const advice = JSON.parse(payload.data.result.advice) as Record<string, unknown>;
    expect(advice.rootCauseAnalysis).toBeTruthy();
    expect(advice.patchProposals).toBeTruthy();
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentRuns, agentRunSteps } from '../src/db/schema/agent_runs.js';
import { agentRegistry, agentTasks } from '../src/db/schema/agents.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE, agentRunRefusal } from '../src/modules/ai/catalogue.js';
import { validatePlan } from '../src/modules/ai/planner.js';
import { runSupervisorCycle } from '../src/modules/ai/supervisor.js';
import { createCopilotRequest, advanceCopilotRun, buildCopilotReport } from '../src/modules/ai/copilot/service.js';
import { parseIntent } from '../src/modules/ai/copilot/intent.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import { setLlmProviderOverride } from '../src/lib/ai/llm/provider-seam.js';
import { spendGuardState } from '../src/lib/ai/spend-guard.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import type { AIProvider, AIProviderCallOptions, AIProviderCallResult } from '../src/lib/ai/types.js';
import type { UserRole } from '@wasit/shared';

/**
 * WASIT-COPILOT-01 — the coordinator, end to end.
 *
 * No vendor key exists in this environment and none may be used, so the model
 * path is exercised through the same scripted-transport seam AI-LLM-01 uses: the
 * provider composes its answer from the FACTS block it received (the live agent
 * catalogue). The deterministic planner and every guard stay in place, and the
 * default run in this suite is the no-provider one — exactly what a deployment
 * without a vendor does.
 */

const app = createApp();
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const AUDIT = { actorId: 'copilot-01-test' };
const savedAdminControlMax = env.AI_RATE_LIMIT_ADMIN_CONTROL_MAX;
const savedAdminMultiplier = env.AI_RATE_LIMIT_ADMIN_MULTIPLIER;

function makeClient(ip = '10.61.0.1') {
  let cookie = '';
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
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createUser(roleName: UserRole, tag: string) {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `copilot01-${tag}-${randomUUID()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('CopilotPass123!'),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const client = makeClient(`10.61.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'CopilotPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login ${roleName}`).toBe(200);
  return { id, email, client };
}

/** A provider that answers a plan built from the catalogue facts it received. */
class PlanProvider implements AIProvider {
  readonly calls: AIProviderCallOptions[] = [];
  constructor(
    readonly id: string,
    private readonly build: (agents: string[]) => Record<string, unknown>,
  ) {}
  isAvailable(): boolean {
    return true;
  }
  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    this.calls.push(opts);
    const agents: string[] = [];
    for (const line of opts.user.split('\n')) {
      const m = /^agent:([a-z0-9-]+) = /i.exec(line.trim());
      if (m) agents.push(m[1]);
    }
    const content = JSON.stringify(this.build(agents));
    return {
      content,
      model: 'scripted-plan',
      tokensInput: Math.max(1, Math.ceil(opts.user.length / 4)),
      tokensOutput: Math.max(1, Math.ceil(content.length / 4)),
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

function planBody(agents: string[]) {
  return {
    goal: 'Weekly review of sales and support',
    constraints: ['no price changes'],
    expectedOutputs: ['report'],
    needsClarification: false,
    clarificationQuestion: null,
    steps: agents.map((agentKey) => ({
      stepKey: agentKey.replace('-agent', ''),
      agentKey,
      reason: `covers ${agentKey}`,
      dependsOn: [],
    })),
    injectionSuspected: false,
  };
}

async function tasksForRun(runId: string) {
  const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  const ids = steps
    .map((s) => (s.result as { taskId?: string } | null)?.taskId)
    .filter((v): v is string => typeof v === 'string');
  if (ids.length === 0) return [];
  return db.select().from(agentTasks).where(inArray(agentTasks.id, ids));
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

beforeEach(async () => {
  await resetRateLimitStore();
  setLlmProviderOverride(null);
  setAiExecutionEnabled(null);
});

afterEach(() => {
  setLlmProviderOverride(null);
  setAiExecutionEnabled(null);
  env.AI_RATE_LIMIT_ADMIN_CONTROL_MAX = savedAdminControlMax;
  env.AI_RATE_LIMIT_ADMIN_MULTIPLIER = savedAdminMultiplier;
});

afterAll(async () => {
  setLlmProviderOverride(null);
  setAiExecutionEnabled(null);
  env.AI_RATE_LIMIT_ADMIN_CONTROL_MAX = savedAdminControlMax;
  if (createdRunIds.length > 0) {
    await db.delete(agentRunSteps).where(inArray(agentRunSteps.runId, createdRunIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(agentTasks).where(inArray(agentTasks.requestedBy, createdUserIds));
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('WASIT-COPILOT-01 — the coordinator', () => {
  it('splits one request across several agents, each one owning its domain', async () => {
    const gm = await createUser('SUPER_ADMIN', 'fanout');
    const res = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'أريد خطة تسويق وتذاكر الدعم المفتوحة هذا الأسبوع' },
    });
    expect(res.status).toBe(201);
    const report = res.data.data.report;
    createdRunIds.push(report.runId);
    expect(report.steps.length).toBe(2);
    const agents = report.steps.map((s: { agentKey: string }) => s.agentKey);
    expect(agents).toContain('marketing-agent');
    expect(agents).toContain('support-agent');
    // The coordinator did not drag in an unrelated specialist.
    expect(agents).not.toContain('ads-agent');
    expect(agents).not.toContain('product-agent');

    // Every step really ran: a task row exists for each, owned by the requester.
    const tasks = await tasksForRun(report.runId);
    expect(tasks.length).toBe(report.steps.length);
    expect(new Set(tasks.map((t) => t.requestedBy))).toEqual(new Set([gm.id]));
    expect(report.progress.succeeded).toBe(report.steps.length);
  });

  it('understands Arabic, French and English requests deterministically', () => {
    const ar = parseIntent('أريد تقريراً عن المبيعات هذا الشهر بدون تغيير الأسعار');
    expect(ar.locale).toBe('ar');
    expect(ar.signals).toContain('sales');
    expect(ar.constraints.join(' ')).toContain('بدون');
    expect(ar.needsClarification).toBe(false);

    const fr = parseIntent("Fais-moi un rapport sur les ventes et le support de ce mois");
    expect(fr.locale).toBe('fr');
    expect(fr.signals).toEqual(expect.arrayContaining(['sales', 'support']));

    const en = parseIntent('Summarise support tickets and sales performance for last week');
    expect(en.locale).toBe('en');
    expect(en.signals).toEqual(expect.arrayContaining(['support', 'sales']));
    expect(en.expectedOutputs.length).toBeGreaterThan(0);
  });

  it('asks for clarification only when nothing actionable was recognised', async () => {
    const gm = await createUser('SUPER_ADMIN', 'clarify');
    const vague = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'ساعدني في هذا الأمر' },
    });
    expect(vague.status).toBe(200);
    expect(vague.data.data.needsClarification).toBe(true);
    expect(vague.data.data.clarificationQuestion).toBeTruthy();
    expect(vague.data.data.report).toBeNull();

    // Nothing was written for an unactionable request.
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.requestedBy, gm.id));
    expect(runs).toHaveLength(0);

    // A recognisable request is never blocked on a missing detail.
    const actionable = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'حالة المخاطر' },
    });
    expect(actionable.status).toBe(201);
    createdRunIds.push(actionable.data.data.report.runId);
    expect(actionable.data.data.report.steps[0].agentKey).toBe('risk-agent');
  });

  it('refuses a delegation the requester is not authorised to make', async () => {
    const merchant = await createUser('MERCHANT', 'rbac');
    // The HTTP surface is admin-gated; the service is the authority that must
    // refuse. A merchant lacks order:read, so payment-settlement-agent is out.
    await expect(
      createCopilotRequest(
        db,
        merchant.id,
        { request: 'تسوية المدفوعات والشكاوى المالية للأسبوع الماضي' },
        AUDIT,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.requestedBy, merchant.id));
    expect(runs).toHaveLength(0);
    const tasks = await db.select().from(agentTasks).where(eq(agentTasks.requestedBy, merchant.id));
    expect(tasks).toHaveLength(0);
  });

  it('refuses to route work to the Copilot itself, the supervisor, or an unknown agent', async () => {
    const gm = await createUser('SUPER_ADMIN', 'notdispatchable');
    for (const agentKey of ['wasit-copilot', 'agent-supervisor', 'made-up-agent']) {
      await expect(
        validatePlan(db, gm.id, [{ stepKey: 'x', agentKey, input: {} }]),
      ).rejects.toBeTruthy();
    }
    expect(agentRunRefusal(COPILOT_CATALOGUE)?.code).toBe('COPILOT_NOT_RUNNABLE');
    // And the coordinator's own identity is still outside the 20.
    expect(AGENT_CATALOGUE.filter((a) => a.key === 'wasit-copilot')).toHaveLength(0);
  });

  it('does not create a second run or second tasks when the same request is retried', async () => {
    const gm = await createUser('SUPER_ADMIN', 'idempotent');
    const requestId = `copilot-test-${randomUUID()}`;
    const body = { request: 'مبيعات الشهر', requestId };

    const first = await gm.client.req('/api/admin/ai/copilot/requests', { method: 'POST', body });
    expect(first.status).toBe(201);
    const runId = first.data.data.report.runId;
    createdRunIds.push(runId);
    const firstTasks = await tasksForRun(runId);

    const second = await gm.client.req('/api/admin/ai/copilot/requests', { method: 'POST', body });
    expect(second.status).toBe(201);
    expect(second.data.data.report.runId).toBe(runId);

    const advance = await gm.client.req(`/api/admin/ai/copilot/requests/${runId}/advance`, { method: 'POST' });
    expect(advance.status).toBe(200);

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.runKey, `copilot:${requestId}`));
    expect(runs).toHaveLength(1);
    const tasksAfter = await tasksForRun(runId);
    expect(tasksAfter).toHaveLength(firstTasks.length);
    expect(tasksAfter.map((t) => t.id).sort()).toEqual(firstTasks.map((t) => t.id).sort());
  });

  it('follows several concurrent requests without mixing their steps', async () => {
    const gm = await createUser('SUPER_ADMIN', 'concurrent');
    const [a, b] = await Promise.all([
      gm.client.req('/api/admin/ai/copilot/requests', {
        method: 'POST',
        body: { request: 'مبيعات هذا الشهر', requestId: `conc-a-${randomUUID()}` },
      }),
      gm.client.req('/api/admin/ai/copilot/requests', {
        method: 'POST',
        body: { request: 'تذاكر الدعم المفتوحة', requestId: `conc-b-${randomUUID()}` },
      }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const runA = a.data.data.report;
    const runB = b.data.data.report;
    createdRunIds.push(runA.runId, runB.runId);

    expect(runA.runId).not.toBe(runB.runId);
    expect(runA.steps.map((s: { agentKey: string }) => s.agentKey)).toEqual(['sales-agent']);
    expect(runB.steps.map((s: { agentKey: string }) => s.agentKey)).toEqual(['support-agent']);

    // Each report is scoped to its own run.
    const fetchedA = await gm.client.req(`/api/admin/ai/copilot/requests/${runA.runId}`);
    expect(fetchedA.data.data.steps.map((s: { agentKey: string }) => s.agentKey)).toEqual(['sales-agent']);
    const fetchedB = await gm.client.req(`/api/admin/ai/copilot/requests/${runB.runId}`);
    expect(fetchedB.data.data.steps.map((s: { agentKey: string }) => s.agentKey)).toEqual(['support-agent']);
  });

  it('reports success and failure in one report without hiding either', async () => {
    const support = await createUser('SUPPORT', 'mixed');
    // analytics-agent is platform-scoped: a SUPPORT requester may plan it (the
    // permission check passes) but the agent layer refuses to run it for a
    // non-platform role. The coordinator must record that, not hide it.
    const created = await createCopilotRequest(
      db,
      support.id,
      { request: 'حالة السوق وتذاكر الدعم المفتوحة' },
      AUDIT,
    );
    const runId = created.report!.runId;
    createdRunIds.push(runId);

    const report = await buildCopilotReport(db, runId, support.id);
    const failed = report.steps.filter((s) => s.status === 'FAILED');
    const succeeded = report.steps.filter((s) => s.status === 'SUCCEEDED');
    expect(failed).toHaveLength(1);
    expect(failed[0].agentKey).toBe('market-research-agent');
    expect(failed[0].error).toContain('platform');
    expect(succeeded.map((s) => s.agentKey)).toEqual(['support-agent']);
    expect(report.status).toBe('PARTIALLY_COMPLETED');
    expect(report.outcomes.stalled).toContain('market');
    expect(report.outcomes.completed).toContain('support');
    expect(report.escalations.some((e) => e.kind === 'failure')).toBe(true);
    // The refusal is never routed to another agent behind the manager's back.
    expect(report.steps.filter((s) => s.agentKey === 'market-research-agent')).toHaveLength(1);
  });

  it('escalates a gated agent to a human and never approves it itself', async () => {
    const gm = await createUser('SUPER_ADMIN', 'escalate');
    const res = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'راجع ميزانية الإعلانات' },
    });
    expect(res.status).toBe(201);
    const report = res.data.data.report;
    createdRunIds.push(report.runId);

    const step = report.steps.find((s: { agentKey: string }) => s.agentKey === 'ads-agent');
    expect(step).toBeDefined();
    expect(step.requiresApproval).toBe(true);
    expect(step.approvedBy).toBeNull();
    expect(report.governance.approvalsRequired).toBeGreaterThanOrEqual(1);
    expect(report.governance.selfApproval).toBe(false);
    expect(report.escalations.some((e: { kind: string }) => e.kind === 'approval')).toBe(true);

    // A second advance changes nothing: the coordinator cannot approve.
    const again = await gm.client.req(`/api/admin/ai/copilot/requests/${report.runId}/advance`, { method: 'POST' });
    expect(again.status).toBe(200);
    const after = again.data.data.report.steps.find((s: { agentKey: string }) => s.agentKey === 'ads-agent');
    expect(after.approvedBy).toBeNull();
    expect(after.status).not.toBe('SUCCEEDED');
  });

  it('plans and executes with no provider at all (local heuristic)', async () => {
    const gm = await createUser('SUPER_ADMIN', 'heuristic');
    const res = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'تقرير عن أداء المنصة والعمليات' },
    });
    expect(res.status).toBe(201);
    const report = res.data.data.report;
    createdRunIds.push(report.runId);
    expect(report.plan.source).toBe('heuristic');
    expect(report.plan.fallbackReason).toBe('no_generative_provider');
    expect(report.progress.succeeded).toBeGreaterThanOrEqual(1);
  });

  it('uses a valid model plan, and refuses one that invents an agent', async () => {
    const gm = await createUser('SUPER_ADMIN', 'llmplan');
    setLlmProviderOverride(
      new PlanProvider('local-heuristic', () => planBody(['market-research-agent', 'marketing-agent'])),
    );
    const good = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'دراسة السوق ثم خطة تسويق' },
    });
    expect(good.status).toBe(201);
    createdRunIds.push(good.data.data.report.runId);
    expect(good.data.data.report.plan.source).toBe('llm');
    expect(good.data.data.report.steps.map((s: { agentKey: string }) => s.agentKey)).toEqual([
      'market-research-agent',
      'marketing-agent',
    ]);

    // The model proposes a department that does not exist: the plan is refused
    // and the deterministic planner takes over — nothing invented is executed.
    setLlmProviderOverride(
      new PlanProvider('local-heuristic', () => planBody(['market-research-agent', 'growth-hacking-agent'])),
    );
    const bad = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'دراسة السوق مع فريق النمو' },
    });
    expect(bad.status).toBe(201);
    const report = bad.data.data.report;
    createdRunIds.push(report.runId);
    expect(report.plan.source).toBe('heuristic');
    expect(report.plan.fallbackReason).toBe('ungrounded_output');
    expect(report.steps.every((s: { agentKey: string }) => s.agentKey !== 'growth-hacking-agent')).toBe(true);
  });

  it('cannot spend past the global guard when a paid provider is configured without caps', async () => {
    const gm = await createUser('SUPER_ADMIN', 'spend');
    const provider = new PlanProvider('openai', () => planBody(['sales-agent']));
    setLlmProviderOverride(provider);
    // The guard state belongs to the deployment, not to this file: another suite
    // may have installed GLOBAL caps in the shared database. Read the live state
    // and assert the invariant that holds either way — a paid provider is called
    // only when both caps are active.
    const guard = await spendGuardState(db, env.AI_CONFIG_ENVIRONMENT ?? 'test');

    const res = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'تقرير مبيعات الشهر' },
    });
    expect(res.status).toBe(201);
    const report = res.data.data.report;
    createdRunIds.push(report.runId);

    if (guard.ready) {
      expect(report.plan.source).toBe('llm');
      expect(provider.calls).toHaveLength(1);
    } else {
      // No caps: the guard refuses before the call, and the coordinator degrades
      // to the deterministic plan instead of spending.
      expect(report.plan.fallbackReason).toBe('spend_guard');
      expect(provider.calls).toHaveLength(0);
      expect(report.plan.source).toBe('heuristic');
    }
  });

  it('respects the AI rate limit on the coordination surface', async () => {
    const gm = await createUser('SUPER_ADMIN', 'ratelimit');
    env.AI_RATE_LIMIT_ADMIN_CONTROL_MAX = 2;
    env.AI_RATE_LIMIT_ADMIN_MULTIPLIER = 1;
    await resetRateLimitStore();

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await gm.client.req('/api/admin/ai/copilot/requests', {
        method: 'POST',
        body: { request: 'حالة المبيعات', requestId: `rl-${i}-${randomUUID()}` },
      });
      statuses.push(res.status);
      if (res.status === 201) createdRunIds.push(res.data.data.report.runId);
    }
    expect(statuses.slice(0, 2)).toEqual([201, 201]);
    expect(statuses[2]).toBe(429);
  });

  it('respects the kill switch and the supervisor', async () => {
    const gm = await createUser('SUPER_ADMIN', 'governance');

    setAiExecutionEnabled(false);
    const blocked = await gm.client.req('/api/admin/ai/copilot/requests', {
      method: 'POST',
      body: { request: 'تقرير مبيعات الشهر' },
    });
    expect(blocked.status).toBe(503);
    const none = await db.select().from(agentRuns).where(eq(agentRuns.requestedBy, gm.id));
    expect(none).toHaveLength(0);

    setAiExecutionEnabled(null);
    const created = await createCopilotRequest(
      db,
      gm.id,
      { request: 'خطة تسويق الشهر', autoAdvance: false },
      AUDIT,
    );
    const runId = created.report!.runId;
    createdRunIds.push(runId);

    // A run left open with a stalled step is the supervisor's business, not the
    // coordinator's: the Copilot never force-closes a run it did not finish.
    await db
      .update(agentRunSteps)
      .set({ status: 'RUNNING', startedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(agentRunSteps.runId, runId));
    await db
      .update(agentRuns)
      .set({ status: 'RUNNING', startedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(agentRuns.id, runId));
    const cycle = await runSupervisorCycle(db, AUDIT, {
      runIds: [runId],
      now: () => new Date(Date.now() + 7 * 86_400_000),
    });
    expect(cycle.scanned).toBe(1);
    expect(cycle.contained).toBe(1);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.status).toBe('FAILED');
    // The report reflects the supervisor's decision, never a stale success.
    const report = await buildCopilotReport(db, runId, gm.id);
    expect(report.status).toBe('FAILED');
    expect(report.governance.dispatchable).toBe(false);

    // And the coordinator cannot resurrect a contained run.
    const after = await advanceCopilotRun(db, runId, AUDIT);
    expect(after.dispatched).toEqual([]);
    expect(after.status).toBe('FAILED');
  });

  it('keeps the 20 agents, their identities and their isolation intact', async () => {
    // 20 specialised agents + the governance supervisor; the Copilot is outside.
    const specialists = AGENT_CATALOGUE.filter((a) => !a.isSupervisor);
    expect(specialists).toHaveLength(20);
    expect(AGENT_CATALOGUE.filter((a) => a.isSupervisor)).toHaveLength(1);
    expect(new Set(AGENT_CATALOGUE.map((a) => a.key)).size).toBe(21);
    expect(AGENT_CATALOGUE.some((a) => a.isCopilot === true)).toBe(false);

    const rows = await db.select({ key: agentRegistry.key, isCopilot: agentRegistry.isCopilot }).from(agentRegistry);
    // The Copilot is a coordination layer, so it has no runnable registry row.
    expect(rows.map((r) => r.key)).not.toContain('wasit-copilot');
    expect(rows.filter((r) => r.isCopilot)).toHaveLength(0);
    const specialistRows = rows.filter((r) => !r.isCopilot && r.key !== 'agent-supervisor');
    expect(specialistRows).toHaveLength(20);

    // The coordinator never wrote a task for itself or for the supervisor.
    const coordinatorTasks = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(and(inArray(agentTasks.agentKey, ['wasit-copilot', 'agent-supervisor']), sql`${agentTasks.requestedBy} <> 'seed'`));
    expect(coordinatorTasks).toHaveLength(0);
  });
});

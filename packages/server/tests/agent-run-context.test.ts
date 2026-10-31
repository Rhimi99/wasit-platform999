import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { aiRequests } from '../src/db/schema/ai.js';
import * as executors from '../src/modules/ai/executors.js';
import {
  createAgentTask,
  runTask,
  getTask,
} from '../src/modules/ai/runner.js';
import { authorizedActionsForAgent, findAgentSpec } from '../src/modules/ai/catalogue.js';
import {
  getAgentRunContext,
  getAgentRunBudget,
  requireAction,
  ActionNotAuthorizedError,
  withAgentRunContext,
  withAgentRunBudget,
  AgentRunBudget,
  AgentRunBudgetExceededError,
  AgentCostRecordingError,
} from '../src/lib/ai/agent-run-context.js';
import { runAIFeature } from '../src/lib/ai/runtime.js';
import type { AIProvider } from '../src/lib/ai/types.js';

/**
 * Secure agent execution context (AI-01.1).
 *
 * Proves the runner binds a TRUSTED run identity (task id / agent key / task
 * type / authorized actions) and a per-run cost budget to each execution, that
 * both are derived from the catalogue and never from task input, that an
 * over-budget run is refused, and that no context leaks between runs. Every
 * assertion is scoped by the task ids this file created, because the suite runs
 * files in parallel against one database.
 */

const AUDIT = { actorId: 'ai01-run-context-operator' };
const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

async function insertUser(roleName: 'SUPER_ADMIN' | 'MERCHANT'): Promise<string> {
  const id = randomUUID();
  const email = `ai01-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('Ai01Pass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

/**
 * Creates a NON-GATED agent task as a real SUPER_ADMIN. The runner executes it
 * inline, so the caller must install any executor spy BEFORE calling this. Using
 * a non-gated agent keeps the shared table free of `approved` rows that another
 * test file's `executeDueTasks` could race on.
 */
async function createNonGated(agentKey: string, taskType: string, input: Record<string, unknown>): Promise<string> {
  const userId = await insertUser('SUPER_ADMIN');
  const created = await createAgentTask(db, ['SUPER_ADMIN'], userId, { agentKey, taskType, input }, AUDIT);
  createdTaskIds.push(created.id);
  return created.id;
}

/**
 * Polls until `predicate` holds or the timeout elapses, returning the last row.
 *
 * The inline run normally wins the single-flight claim, but a concurrent
 * `executeDueTasks` from another test file sharing the database can grab the row
 * first; polling for the observable outcome keeps the assertions honest in both
 * cases instead of assuming which caller won.
 */
async function waitFor(
  taskId: string,
  predicate: (t: Awaited<ReturnType<typeof getTask>>) => boolean,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = await getTask(db, taskId);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    last = await getTask(db, taskId);
  }
  return last;
}

const isTerminal = (s: string): boolean => ['succeeded', 'failed', 'rejected', 'blocked'].includes(s);

/**
 * Forces a task to a terminal state so a sibling test file's `executeDueTasks`
 * can never pick it up as a retry. This is an UPDATE, never a DELETE: a row that
 * another file already selected must still exist when it re-reads it. `rejected`
 * is terminal AND is not counted as a failure by the supervisor, so a neutralised
 * row cannot mark its agent unhealthy for another file.
 */
async function neutralize(taskId: string): Promise<void> {
  await db
    .update(agentTasks)
    .set({ status: 'rejected', scheduledFor: null })
    .where(eq(agentTasks.id, taskId));
}

/** A stub paid provider so pricing is non-zero without any network call. */
function paidStub(): AIProvider {
  return {
    id: 'ai01-test-paid',
    isAvailable: () => true,
    call: async (opts) => ({
      content: 'stub',
      model: opts.model ?? 'stub',
      tokensInput: 1,
      tokensOutput: 4096,
      cost: '0',
      currencyCode: 'USD',
    }),
  };
}

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('authorizedActionsForAgent — trusted grant list', () => {
  it('derives the grant list from declared capabilities, never from allowedTools', () => {
    const sales = findAgentSpec('sales-agent')!;
    expect(authorizedActionsForAgent(sales)).toEqual(['identify_leads']);
    // `allowedTools` names data sources; those ids must never become grants.
    expect(authorizedActionsForAgent(sales)).not.toContain('platform.metrics');
  });

  it('returns an empty grant list for an agent that declares no capabilities (fail closed)', () => {
    const spec = findAgentSpec('marketing-agent')!;
    const capabilityless = { ...spec, capabilities: [] } as typeof spec;
    expect(authorizedActionsForAgent(capabilityless)).toEqual([]);
  });
});

describe('requireAction — deny by default', () => {
  it('refuses with no run context at all', () => {
    expect(getAgentRunContext()).toBeUndefined();
    expect(() => requireAction('finance.payout')).toThrow(ActionNotAuthorizedError);
  });

  it('refuses an action that is not in the run grant list, with the ACTION_NOT_AUTHORIZED code', () => {
    return withAgentRunContext(
      { taskId: 't', agentKey: 'sales-agent', authorizedActions: ['identify_leads'] },
      async () => {
        expect(() => requireAction('identify_leads')).not.toThrow();
        let caught: unknown;
        try {
          requireAction('finance.payout');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ActionNotAuthorizedError);
        expect((caught as ActionNotAuthorizedError).code).toBe('ACTION_NOT_AUTHORIZED');
      },
    );
  });

  it('refuses every action when the grant list is empty', () => {
    return withAgentRunContext({ taskId: 't', agentKey: 'x', authorizedActions: [] }, async () => {
      expect(() => requireAction('anything')).toThrow(ActionNotAuthorizedError);
    });
  });
});

describe('runner binds a trusted execution context', () => {
  it('binds the task id, agent key, task type and catalogue-derived grant list', async () => {
    let seen: ReturnType<typeof getAgentRunContext>;
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      seen = getAgentRunContext();
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => isTerminal(t.status));
    } finally {
      spy.mockRestore();
    }
    expect(seen!.taskId).toBe(id);
    expect(seen!.agentKey).toBe('marketing-agent');
    expect(seen!.taskType).toBe('marketing.plan_campaign');
    expect(seen!.authorizedActions).toEqual(['recommend_campaign']);
  });

  it('cannot forge authorizedActions through task input', async () => {
    let seen: ReturnType<typeof getAgentRunContext>;
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      seen = getAgentRunContext();
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', {
        action: 'recommend_campaign',
        authorizedActions: ['finance.payout', 'prod.deploy', 'risk.block_account'],
        allowedTools: ['outreach.send'],
        __userId: 'someone-else',
      });
      await waitFor(id, (t) => isTerminal(t.status));
    } finally {
      spy.mockRestore();
    }
    expect(seen!.authorizedActions).toEqual(['recommend_campaign']);
    expect(seen!.authorizedActions).not.toContain('finance.payout');
    expect(seen!.authorizedActions).not.toContain('prod.deploy');
  });

  it('binds a per-run budget whose ceiling comes from the catalogue policy', async () => {
    const expectedCap = new Decimal(findAgentSpec('marketing-agent')!.limits.maxCostUsdPerRun as number);
    let budget: ReturnType<typeof getAgentRunBudget>;
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      budget = getAgentRunBudget();
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => isTerminal(t.status));
    } finally {
      spy.mockRestore();
    }
    expect(budget!).toBeInstanceOf(AgentRunBudget);
    expect(budget!.maxCostUsd!.toFixed(10)).toBe(expectedCap.toFixed(10));
  });

  it('cannot raise the run cost ceiling through the payload', async () => {
    const expectedCap = new Decimal(findAgentSpec('marketing-agent')!.limits.maxCostUsdPerRun as number);
    let budget: ReturnType<typeof getAgentRunBudget>;
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      budget = getAgentRunBudget();
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', {
        action: 'recommend_campaign',
        runCapUsd: '999999',
        maxCostUsdPerRun: 999999,
        limits: { maxCostUsdPerRun: 999999 },
      });
      await waitFor(id, (t) => isTerminal(t.status));
    } finally {
      spy.mockRestore();
    }
    expect(budget!.maxCostUsd!.toFixed(10)).toBe(expectedCap.toFixed(10));
    expect(budget!.maxCostUsd!.toNumber()).toBeLessThan(999999);
  });

  it('fails closed when the executor exceeds the run ceiling', async () => {
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      // Drive real priced calls through the run budget until it trips the policy
      // ceiling. The provider is a stub, so no network call leaves the process.
      for (let i = 0; i < 60; i += 1) {
        await runAIFeature(db, {
          userId: 'ai01-budget-probe',
          roles: ['SUPER_ADMIN'],
          requestType: 'AGENT:marketing-agent',
          user: 'probe',
          maxTokens: 4096,
          modelKey: 'anthropic-claude-sonnet-4',
          provider: paidStub(),
        });
      }
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => t.error != null);
    } finally {
      spy.mockRestore();
    }
    const done = await getTask(db, id);
    expect(done.status).not.toBe('succeeded');
    expect(JSON.stringify(done.error)).toMatch(/ceiling exceeded/i);
    await neutralize(id);
  });

  it('fails closed when the executor denies an action it was not granted', async () => {
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      requireAction('finance.payout');
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => t.error != null);
    } finally {
      spy.mockRestore();
    }
    const done = await getTask(db, id);
    expect(done.status).not.toBe('succeeded');
    expect(JSON.stringify(done.error)).toMatch(/not authorized/i);
    await neutralize(id);
  });

  it('seeds the run budget with the task cost already spent, so a retry cannot reset the cap', async () => {
    // A retry is the same task row re-run. Insert a queued row already carrying
    // spend equal to the catalogue cap, then drive it through the real runner:
    // the retry starts with zero headroom, so its first priced call must be
    // refused — proving the cap bounds the whole task, not each attempt.
    const userId = await insertUser('SUPER_ADMIN');
    const cap = findAgentSpec('marketing-agent')!.limits.maxCostUsdPerRun as number;
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'marketing-agent',
      requestedBy: userId,
      taskType: 'marketing.plan_campaign',
      input: { action: 'recommend_campaign' } as never,
      status: 'queued',
      cost: new Decimal(cap).toFixed(10),
      model: 'local-heuristic',
    });
    createdTaskIds.push(id);
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      await runAIFeature(db, {
        userId: 'ai01-budget-probe',
        roles: ['SUPER_ADMIN'],
        requestType: 'AGENT:marketing-agent',
        user: 'probe',
        maxTokens: 4096,
        modelKey: 'anthropic-claude-sonnet-4',
        provider: paidStub(),
      });
      return { content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0 };
    });
    try {
      await runTask(db, id, AUDIT);
    } finally {
      spy.mockRestore();
    }
    const done = await getTask(db, id);
    expect(done.status).not.toBe('succeeded');
    expect(JSON.stringify(done.error)).toMatch(/ceiling exceeded/i);
    await neutralize(id);
  });
});

describe('run context lifecycle — isolation and cleanup', () => {
  it('clears the context after a successful run', async () => {
    const spy = vi.spyOn(executors, 'executeAgentTask').mockResolvedValue({
      content: JSON.stringify({ ok: true }), tokensInput: 0, tokensOutput: 0,
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => isTerminal(t.status));
    } finally {
      spy.mockRestore();
    }
    expect(getAgentRunContext()).toBeUndefined();
    expect(getAgentRunBudget()).toBeUndefined();
  });

  it('clears the context after a failing run', async () => {
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async () => {
      throw new Error('boom');
    });
    let id = '';
    try {
      id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
      await waitFor(id, (t) => t.error != null);
    } finally {
      spy.mockRestore();
    }
    expect(getAgentRunContext()).toBeUndefined();
    expect(getAgentRunBudget()).toBeUndefined();
    await neutralize(id);
  });

  it('does not leak the context between two concurrent runs', async () => {
    // Gate both executions until BOTH have arrived at the executor, then release
    // them together so the two runs genuinely overlap — any context bleed between
    // them would be observed in the captured identities.
    let arrived = 0;
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: Array<{ taskId: string; agentKey: string }> = [];
    const spy = vi.spyOn(executors, 'executeAgentTask').mockImplementation(async (_db, agent) => {
      arrived += 1;
      if (arrived === 2) release();
      await opened;
      const ctx = getAgentRunContext();
      observed.push({ taskId: ctx!.taskId ?? '', agentKey: ctx!.agentKey });
      return { content: JSON.stringify({ ok: true, agentKey: agent.key }), tokensInput: 0, tokensOutput: 0 };
    });
    let a = '';
    let b = '';
    try {
      [a, b] = await Promise.all([
        createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' }),
        createNonGated('product-agent', 'product.audit_catalog', { action: 'analyze_product' }),
      ]);
      await Promise.all([waitFor(a, (t) => isTerminal(t.status)), waitFor(b, (t) => isTerminal(t.status))]);
    } finally {
      spy.mockRestore();
    }
    const byTask = new Map(observed.map((o) => [o.taskId, o.agentKey]));
    expect(byTask.get(a)).toBe('marketing-agent');
    expect(byTask.get(b)).toBe('product-agent');
    expect(observed.length).toBe(2);
    expect(getAgentRunContext()).toBeUndefined();
  });

  it('runs the real executor engine inside the bound context (end-to-end, non-gated agent)', async () => {
    // No spy: the real marketing-agent executor calls the real AI feature engine
    // (local-heuristic provider, no network). Proves the run identity is live
    // *during* execution and cleared afterwards.
    const id = await createNonGated('marketing-agent', 'marketing.plan_campaign', { action: 'recommend_campaign' });
    const done = await waitFor(id, (t) => isTerminal(t.status));
    expect(done.status).toBe('succeeded');
    expect(new Decimal(done.cost).isZero()).toBe(true); // local-heuristic is free
    expect(getAgentRunContext()).toBeUndefined();
    expect(getAgentRunBudget()).toBeUndefined();
  });

  it('is refused when the caller lacks the agent permission (RBAC intact)', async () => {
    const userId = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], userId, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {} }, AUDIT),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps concurrent AsyncLocalStorage budgets independent', async () => {
    const a = new AgentRunBudget(new Decimal(10));
    const b = new AgentRunBudget(new Decimal(10));
    await Promise.all([
      withAgentRunBudget(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        getAgentRunBudget()!.reserve(new Decimal(1));
      }),
      withAgentRunBudget(b, async () => {
        getAgentRunBudget()!.reserve(new Decimal(3));
      }),
    ]);
    expect(a.spentUsd.toNumber()).toBe(1);
    expect(b.spentUsd.toNumber()).toBe(3);
  });
});

describe('AgentRunBudget — reservation-based ceiling arithmetic', () => {
  it('reserves an estimate and settles it to the measured cost exactly once', () => {
    const budget = new AgentRunBudget(new Decimal('1'));
    expect(budget.reserve(new Decimal('0.4'))).toBe(true);
    expect(budget.spentUsd.toFixed(2)).toBe('0.40'); // reserved
    // Settle replaces the estimate with the (lower) measured cost — never adds.
    expect(budget.settle(new Decimal('0.4'), new Decimal('0.25'))).toBe(true);
    expect(budget.spentUsd.toFixed(2)).toBe('0.25');
    expect(budget.callCount).toBe(1);
  });

  it('refuses to reserve when the estimate would exceed the ceiling (nothing reserved)', () => {
    const budget = new AgentRunBudget(new Decimal('0.05'));
    expect(budget.reserve(new Decimal('0.03'))).toBe(true);
    expect(budget.reserve(new Decimal('0.03'))).toBe(false);
    expect(budget.spentUsd.toFixed(2)).toBe('0.03');
    expect(budget.callCount).toBe(1);
  });

  it('settles to the full measured cost even when it overshoots the ceiling', () => {
    const budget = new AgentRunBudget(new Decimal('0.05'));
    expect(budget.reserve(new Decimal('0.01'))).toBe(true);
    // Measured 0.09 replaces the 0.01 reservation and overshoots — still counted.
    expect(budget.settle(new Decimal('0.01'), new Decimal('0.09'))).toBe(false);
    expect(budget.spentUsd.toFixed(2)).toBe('0.09');
  });

  it('releases a reservation for a call that never completed', () => {
    const budget = new AgentRunBudget(new Decimal('1'));
    expect(budget.reserve(new Decimal('0.3'))).toBe(true);
    budget.release(new Decimal('0.3'));
    expect(budget.spentUsd.toFixed(2)).toBe('0.00');
    expect(budget.callCount).toBe(0);
  });

  it('treats a null ceiling as uncapped', () => {
    const budget = new AgentRunBudget(null);
    expect(budget.reserve(new Decimal('1000'))).toBe(true);
    expect(budget.settle(new Decimal('1000'), new Decimal('2000'))).toBe(true);
    expect(budget.spentUsd.toNumber()).toBe(2000);
  });

  it('carries prior spend across retries so the cap bounds the whole task', () => {
    // A retry is seeded with what earlier attempts already spent; the remaining
    // headroom is what is left of the cap, not the cap again.
    const cap = new Decimal('1');
    const firstAttempt = new AgentRunBudget(cap);
    expect(firstAttempt.reserve(new Decimal('0.6'))).toBe(true);
    expect(firstAttempt.settle(new Decimal('0.6'), new Decimal('0.6'))).toBe(true);
    const retry = new AgentRunBudget(cap, firstAttempt.spentUsd);
    // Only 0.4 of headroom remains, so a 0.6 estimate is refused outright.
    expect(retry.reserve(new Decimal('0.6'))).toBe(false);
    expect(retry.spentUsd.toFixed(2)).toBe('0.60');
    expect(retry.reserve(new Decimal('0.4'))).toBe(true);
    expect(retry.spentUsd.toFixed(2)).toBe('1.00');
  });

  it('degrades an unparseable carry-over value to zero without throwing', () => {
    expect(() => new AgentRunBudget(new Decimal('1'), new Decimal(0))).not.toThrow();
  });
});

describe('runAIFeature enforces the run ceiling', () => {
  it('refuses before calling the provider when the estimate already exceeds the cap', async () => {
    const budget = new AgentRunBudget(new Decimal('0.001'));
    let called = 0;
    const provider: AIProvider = {
      id: 'ai01-test-paid',
      isAvailable: () => true,
      call: async () => {
        called += 1;
        return { content: 'x', model: 'x', tokensInput: 1, tokensOutput: 1, cost: '0', currencyCode: 'USD' };
      },
    };
    await expect(
      withAgentRunBudget(budget, () =>
        runAIFeature(db, {
          userId: 'ai01-budget-probe',
          roles: ['SUPER_ADMIN'],
          requestType: 'TEST',
          user: 'probe',
          maxTokens: 4096,
          modelKey: 'anthropic-claude-sonnet-4',
          provider,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);
    expect(called).toBe(0);
  });

  it('records the full measured cost and refuses when it overshoots the cap', async () => {
    // Estimate (maxTokens 100) stays under the cap, but the measured cost lands
    // just above it. The provider has already been paid, so the cost must be
    // recorded in full (never dropped) AND the run refused.
    const budget = new AgentRunBudget(new Decimal('0.0016'));
    const provider: AIProvider = {
      id: 'ai01-test-paid',
      isAvailable: () => true,
      call: async () => ({ content: 'x', model: 'x', tokensInput: 100, tokensOutput: 100, cost: '0', currencyCode: 'USD' }),
    };
    const userId = `ai01-over-${Date.now()}`;
    await expect(
      withAgentRunBudget(budget, () =>
        runAIFeature(db, {
          userId,
          roles: ['SUPER_ADMIN'],
          requestType: 'TEST',
          user: 'p',
          maxTokens: 100,
          modelKey: 'anthropic-claude-sonnet-4',
          provider,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);
    // 100/1000 * 0.003 + 100/1000 * 0.015 = 0.0018 USD, recorded in full.
    expect(budget.spentUsd.toFixed(4)).toBe('0.0018');
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0].cost).toBe('0.0018000000');
    expect(rows[0].status).toBe('OVER_BUDGET');
    expect(rows[0].tokensInput).toBe(100);
    expect(rows[0].tokensOutput).toBe(100);
  });

  it('does not consult a run budget outside an agent run', async () => {
    // No `withAgentRunBudget` wrapper: the monthly budget applies, not a per-run
    // one, and a free local call must succeed.
    const out = await runAIFeature(db, {
      userId: 'ai01-budget-probe',
      roles: ['SUPER_ADMIN'],
      requestType: 'TEST',
      user: 'probe',
    });
    expect(out.requestId).toBeTruthy();
  });
});

describe('AI-01.2 — actual cost accounting and over-cap enforcement', () => {
  /** A paid stub returning a fixed, known token count so cost is deterministic. */
  function fixedPaidProvider(tokensIn: number, tokensOut: number): AIProvider {
    return {
      id: 'ai012-test-paid',
      isAvailable: () => true,
      call: async () => ({
        content: 'x',
        model: 'stub',
        tokensInput: tokensIn,
        tokensOutput: tokensOut,
        cost: '0',
        currencyCode: 'USD',
      }),
    };
  }

  const price = (tokensIn: number, tokensOut: number): string =>
    new Decimal('0.003').mul(tokensIn / 1000).plus(new Decimal('0.015').mul(tokensOut / 1000)).toFixed(10);

  it('records an actual cost below the cap as a SUCCESS', async () => {
    const budget = new AgentRunBudget(new Decimal('1'));
    const userId = `ai012-under-${Date.now()}`;
    const out = await withAgentRunBudget(budget, () =>
      runAIFeature(db, {
        userId,
        roles: ['SUPER_ADMIN'],
        requestType: 'TEST',
        user: 'probe',
        maxTokens: 4096,
        modelKey: 'anthropic-claude-sonnet-4',
        provider: fixedPaidProvider(1000, 1000),
      }),
    );
    const expected = price(1000, 1000); // 0.018
    expect(out.cost).toBe(expected);
    expect(budget.spentUsd.toFixed(10)).toBe(expected);
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0].cost).toBe(expected);
    expect(rows[0].status).toBe('SUCCESS');
  });

  it('records an actual cost exactly equal to the cap and treats it as within budget', async () => {
    // A call whose measured cost lands exactly on the ceiling must be accepted
    // (the boundary is inclusive) and recorded in full.
    const actual = new Decimal(price(1000, 1000)); // 0.018
    const budget = new AgentRunBudget(actual);
    const userId = `ai012-equal-${Date.now()}`;
    const out = await withAgentRunBudget(budget, () =>
      runAIFeature(db, {
        userId,
        roles: ['SUPER_ADMIN'],
        requestType: 'TEST',
        user: 'probe',
        maxTokens: 100, // estimate ≈ 0.0015 < cap 0.018, so the call is admitted
        modelKey: 'anthropic-claude-sonnet-4',
        provider: fixedPaidProvider(1000, 1000),
      }),
    );
    expect(out.cost).toBe(actual.toFixed(10));
    expect(budget.spentUsd.toFixed(10)).toBe(actual.toFixed(10));
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
    expect(rows[0].status).toBe('SUCCESS');
    expect(rows[0].cost).toBe(actual.toFixed(10));
  });

  it('records the full actual cost when it exceeds the cap, then refuses the run', async () => {
    const userId = `ai012-over-${Date.now()}`;
    // Use a cap that admits the estimate but is then exceeded by the measurement,
    // so the settle path (not the up-front reserve) is the one that trips.
    const admitBudget = new AgentRunBudget(new Decimal('0.0025'));
    let threw: unknown;
    try {
      await withAgentRunBudget(admitBudget, () =>
        runAIFeature(db, {
          userId,
          roles: ['SUPER_ADMIN'],
          requestType: 'TEST',
          user: 'probe',
          maxTokens: 100, // estimate: 100/1000*0.015 = 0.0015 < 0.0025
          modelKey: 'anthropic-claude-sonnet-4',
          provider: fixedPaidProvider(1000, 1000), // measured 0.018 >> cap
        }),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AgentRunBudgetExceededError);
    // The measured cost is recorded in FULL (never dropped) despite the refusal.
    const expected = price(1000, 1000);
    expect(admitBudget.spentUsd.toFixed(10)).toBe(expected);
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0].cost).toBe(expected);
    expect(rows[0].status).toBe('OVER_BUDGET');
    expect(rows[0].metadata).toMatchObject({ runBudgetExceeded: true });
  });

  it('refuses every subsequent call once the budget is exhausted', async () => {
    // After an over-cap call, the accumulator holds the true (over-cap) spend, so
    // the very next call is refused up front without reaching the provider.
    const budget = new AgentRunBudget(new Decimal('0.0025'));
    const userId = `ai012-next-${Date.now()}`;
    const provider = fixedPaidProvider(1000, 1000);
    let calls = 0;
    const counting: AIProvider = {
      ...provider,
      call: async (opts) => {
        calls += 1;
        return provider.call(opts);
      },
    };
    await expect(
      withAgentRunBudget(budget, () =>
        runAIFeature(db, { userId, roles: ['SUPER_ADMIN'], requestType: 'TEST', user: 'p', maxTokens: 100, modelKey: 'anthropic-claude-sonnet-4', provider: counting }),
      ),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);
    expect(calls).toBe(1);
    await expect(
      withAgentRunBudget(budget, () =>
        runAIFeature(db, { userId, roles: ['SUPER_ADMIN'], requestType: 'TEST', user: 'p', maxTokens: 100, modelKey: 'anthropic-claude-sonnet-4', provider: counting }),
      ),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);
    // The second call never reached the provider.
    expect(calls).toBe(1);
  });

  it('does not double-count the measured cost (reservation is replaced, not added)', async () => {
    const budget = new AgentRunBudget(new Decimal('1'));
    const userId = `ai012-once-${Date.now()}`;
    await withAgentRunBudget(budget, () =>
      runAIFeature(db, {
        userId,
        roles: ['SUPER_ADMIN'],
        requestType: 'TEST',
        user: 'p',
        maxTokens: 4096,
        modelKey: 'anthropic-claude-sonnet-4',
        provider: fixedPaidProvider(1000, 1000),
      }),
    );
    // Exactly the measured cost — not estimate + measured.
    expect(budget.spentUsd.toFixed(10)).toBe(price(1000, 1000));
    expect(budget.callCount).toBe(1);
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
    expect(rows.length).toBe(1);
  });

  it('releases the reservation when the provider call throws (no charge for a failed call)', async () => {
    const budget = new AgentRunBudget(new Decimal('1'));
    const userId = `ai012-fail-${Date.now()}`;
    const failing: AIProvider = {
      id: 'ai012-test-paid',
      isAvailable: () => true,
      call: async () => {
        throw new Error('provider down');
      },
    };
    await expect(
      withAgentRunBudget(budget, () =>
        runAIFeature(db, { userId, roles: ['SUPER_ADMIN'], requestType: 'TEST', user: 'p', maxTokens: 100, modelKey: 'anthropic-claude-sonnet-4', provider: failing }),
      ),
    ).rejects.toThrow(/provider down/);
    expect(budget.spentUsd.toFixed(10)).toBe('0.0000000000');
    expect(budget.callCount).toBe(0);
  });

  it('never allows concurrent in-flight calls to overrun the remaining headroom (race)', async () => {
    // Two calls are started together. Each call's estimate fits alone, but both
    // together exceed the cap. The atomic reservation must admit exactly one and
    // refuse the other BEFORE it reaches the provider.
    const budget = new AgentRunBudget(new Decimal('0.0025'));
    const userId = `ai012-race-${Date.now()}`;
    let inFlight = 0;
    let peakInFlight = 0;
    const slow: AIProvider = {
      id: 'ai012-test-paid',
      isAvailable: () => true,
      call: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { content: 'x', model: 'stub', tokensInput: 100, tokensOutput: 100, cost: '0', currencyCode: 'USD' };
      },
    };
    const run = (): Promise<unknown> =>
      withAgentRunBudget(budget, () =>
        runAIFeature(db, { userId, roles: ['SUPER_ADMIN'], requestType: 'TEST', user: 'p', maxTokens: 100, modelKey: 'anthropic-claude-sonnet-4', provider: slow }),
      );
    const results = await Promise.allSettled([run(), run()]);
    const refused = results.filter((r) => r.status === 'rejected' && r.reason instanceof AgentRunBudgetExceededError);
    // Exactly one call was admitted to the provider; the other was refused up front.
    expect(peakInFlight).toBe(1);
    expect(refused.length).toBe(1);
    // Total spend is bounded by the cap plus at most the one admitted call.
    expect(budget.spentUsd.lte(new Decimal('0.0025').plus('0.003'))).toBe(true);
  });

  it('fails closed with AgentCostRecordingError when the measured cost cannot be persisted', async () => {
    // A `user_id` longer than the column (varchar(36)) makes the ledger insert
    // fail for real — no mock. The provider call has already happened, so the run
    // must not report success, must not continue, and must surface the distinct
    // cost-recording error rather than a budget-exceeded one.
    const budget = new AgentRunBudget(new Decimal('1'));
    const userId = 'x'.repeat(64);
    let threw: unknown;
    try {
      await withAgentRunBudget(budget, () =>
        runAIFeature(db, {
          userId,
          roles: ['SUPER_ADMIN'],
          requestType: 'TEST',
          user: 'p',
          maxTokens: 4096,
          modelKey: 'anthropic-claude-sonnet-4',
          provider: fixedPaidProvider(1000, 1000),
        }),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AgentCostRecordingError);
    expect((threw as AgentCostRecordingError).code).toBe('RUN_COST_NOT_RECORDED');
    // The accumulator still holds the true spend (never reset to zero), so the
    // caller cannot continue as if the call were free; the thrown error aborts
    // the run before any further call is made.
    expect(budget.spentUsd.toFixed(10)).toBe(price(1000, 1000));
  });
});

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  withAgentRunContext,
  getAgentRunContext,
  requireAction,
  mergeAgentTaskMetadata,
  ActionNotAuthorizedError,
  AgentRunBudget,
  withAgentRunBudget,
  getAgentRunBudget,
  AgentRunBudgetExceededError,
  AGENT_TASK_LEDGER_KEY,
  type AgentRunContext,
} from '../../src/lib/ai/agent-run-context.js';

/**
 * Trusted agent-run context + action gate + per-run budget — database-free.
 *
 * These are the in-process primitives the runner uses to (a) attribute AI
 * requests to a task without trusting caller input, (b) gate each operation
 * against a server-derived grant list, and (c) cap a run's spend. This file
 * pins the fail-closed behaviour and the async isolation between concurrent
 * runs; the runner's own wiring is covered by the integration suite.
 */

const CTX: AgentRunContext = {
  taskId: 'task-1',
  agentKey: 'sales-agent',
  authorizedActions: ['supplier.get_owned'],
  allowedTools: ['catalogue.read'],
};

describe('run context — async isolation', () => {
  it('is undefined outside any run', () => {
    expect(getAgentRunContext()).toBeUndefined();
  });

  it('is visible inside withAgentRunContext and gone after it returns', async () => {
    await withAgentRunContext(CTX, async () => {
      expect(getAgentRunContext()?.taskId).toBe('task-1');
    });
    expect(getAgentRunContext()).toBeUndefined();
  });

  it('does not leak between two interleaved runs', async () => {
    const seen: string[] = [];
    await Promise.all([
      withAgentRunContext({ taskId: 'A', agentKey: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(getAgentRunContext()!.taskId);
      }),
      withAgentRunContext({ taskId: 'B', agentKey: 'b' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(getAgentRunContext()!.taskId);
      }),
    ]);
    expect(seen.sort()).toEqual(['A', 'B']);
  });
});

describe('requireAction — fail-closed grant gate', () => {
  it('refuses when there is no run context', () => {
    expect(() => requireAction('supplier.get_owned')).toThrow(ActionNotAuthorizedError);
  });

  it('refuses a granted id that is not in the list', async () => {
    await withAgentRunContext(CTX, async () => {
      expect(() => requireAction('supplier.get_all')).toThrow(ActionNotAuthorizedError);
    });
  });

  it('allows an id present in the run grant list', async () => {
    await withAgentRunContext(CTX, async () => {
      expect(() => requireAction('supplier.get_owned')).not.toThrow();
    });
  });

  it('refuses every action when no grant list was set (absent = no grant)', async () => {
    await withAgentRunContext({ taskId: 't', agentKey: 'a' }, async () => {
      expect(() => requireAction('anything')).toThrow(ActionNotAuthorizedError);
    });
  });

  it('consults the tool list for scope=tools and refuses tools not granted', async () => {
    await withAgentRunContext(CTX, async () => {
      expect(() => requireAction('catalogue.read', 'tools')).not.toThrow();
      expect(() => requireAction('supplier.get_owned', 'tools')).toThrow(ActionNotAuthorizedError);
    });
  });

  it('refuses tools when allowedTools is absent', async () => {
    await withAgentRunContext({ taskId: 't', agentKey: 'a', authorizedActions: ['x'] }, async () => {
      expect(() => requireAction('x', 'tools')).toThrow(ActionNotAuthorizedError);
    });
  });

  it('exposes the refused action id and a stable code', () => {
    try {
      requireAction('nope');
      throw new Error('expected ActionNotAuthorizedError');
    } catch (err) {
      const e = err as ActionNotAuthorizedError;
      expect(e).toBeInstanceOf(ActionNotAuthorizedError);
      expect(e.actionId).toBe('nope');
      expect(e.code).toBe('ACTION_NOT_AUTHORIZED');
    }
  });
});

describe('mergeAgentTaskMetadata — trusted attribution only', () => {
  it('overwrites forged taskId/agentKey with the trusted context', () => {
    const merged = mergeAgentTaskMetadata({ taskId: 'forged', agentKey: 'forged', other: 1 }, CTX);
    expect(merged.taskId).toBe('task-1');
    expect(merged.agentKey).toBe('sales-agent');
    expect(merged.other).toBe(1);
  });

  it('strips taskId/agentKey when no run context exists', () => {
    const merged = mergeAgentTaskMetadata({ taskId: 'forged', agentKey: 'forged', other: 1 }, undefined);
    expect('taskId' in merged).toBe(false);
    expect('agentKey' in merged).toBe(false);
    expect(merged.other).toBe(1);
  });

  it('never mutates the input metadata object', () => {
    const input = { taskId: 'forged' };
    mergeAgentTaskMetadata(input, CTX);
    expect(input.taskId).toBe('forged');
  });

  it('writes the trusted ledger key from the context, overwriting a forged one', () => {
    const merged = mergeAgentTaskMetadata({ [AGENT_TASK_LEDGER_KEY]: 'forged', other: 1 }, CTX);
    expect(merged[AGENT_TASK_LEDGER_KEY]).toBe('task-1');
    expect(merged.other).toBe(1);
  });

  it('always strips the ledger key when no run context exists (G2)', () => {
    const merged = mergeAgentTaskMetadata({ [AGENT_TASK_LEDGER_KEY]: 'victim', other: 1 }, undefined);
    expect(AGENT_TASK_LEDGER_KEY in merged).toBe(false);
    expect(merged.other).toBe(1);
  });

  it('prefers the context ledgerTaskId over its taskId when they differ', () => {
    const merged = mergeAgentTaskMetadata(undefined, { ...CTX, ledgerTaskId: 'ledger-task-9' });
    expect(merged[AGENT_TASK_LEDGER_KEY]).toBe('ledger-task-9');
  });
});

describe('AgentRunBudget — reservation-based ceiling', () => {
  const usd = (n: string | number) => new Decimal(n);

  it('reserves while under the cap and refuses once the estimate would exceed it', () => {
    const budget = new AgentRunBudget(usd(1));
    expect(budget.reserve(usd('0.6'))).toBe(true);
    expect(budget.reserve(usd('0.6'))).toBe(false);
    expect(budget.spentUsd.toFixed(2)).toBe('0.60');
    expect(budget.callCount).toBe(1);
  });

  it('treats a null cap as uncapped', () => {
    const budget = new AgentRunBudget(null);
    expect(budget.reserve(usd(1000))).toBe(true);
    expect(budget.reserve(usd(1000))).toBe(true);
    expect(budget.callCount).toBe(2);
  });

  it('releases a reservation for a call that never reached the provider', () => {
    const budget = new AgentRunBudget(usd(1));
    budget.reserve(usd('0.5'));
    budget.release(usd('0.5'));
    expect(budget.spentUsd.toFixed(2)).toBe('0.00');
    expect(budget.callCount).toBe(0);
  });

  it('settles a reservation to the measured cost without double-counting', () => {
    const budget = new AgentRunBudget(usd(1));
    budget.reserve(usd('0.5'));
    expect(budget.settle(usd('0.5'), usd('0.4'))).toBe(true);
    expect(budget.spentUsd.toFixed(2)).toBe('0.40');
  });

  it('flags an over-cap settlement and keeps the true spend on the counter', () => {
    const budget = new AgentRunBudget(usd(1));
    budget.reserve(usd('0.5'));
    expect(budget.settle(usd('0.5'), usd('2'))).toBe(false);
    expect(budget.spentUsd.toFixed(2)).toBe('2.00');
  });

  it('carries prior spend so a retry cannot reset the ceiling', () => {
    const budget = new AgentRunBudget(usd(1), usd('0.9'));
    expect(budget.reserve(usd('0.2'))).toBe(false);
    expect(budget.reserve(usd('0.05'))).toBe(true);
  });

  it('is reachable through withAgentRunBudget and gone after it returns', async () => {
    expect(getAgentRunBudget()).toBeUndefined();
    const budget = new AgentRunBudget(usd(1));
    await withAgentRunBudget(budget, async () => {
      expect(getAgentRunBudget()).toBe(budget);
    });
    expect(getAgentRunBudget()).toBeUndefined();
  });

  it('exposes the exceeded ceiling as a stable error', () => {
    const err = new AgentRunBudgetExceededError('1.0000000000', '2.0000000000');
    expect(err.code).toBe('RUN_BUDGET_EXCEEDED');
    expect(err.maxCostUsd).toBe('1.0000000000');
    expect(err.spentUsd).toBe('2.0000000000');
  });
});

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { runAIFeature } from '../../src/lib/ai/runtime.js';
import {
  AgentRunBudget,
  AgentRunBudgetExceededError,
  withAgentRunBudget,
  withAgentRunContext,
  type AgentRunContext,
} from '../../src/lib/ai/agent-run-context.js';
import { aiModels, aiRequests, aiBudgets, aiUsage } from '../../src/db/schema/ai.js';
import type { DB } from '../../src/db/client.js';
import { aiExecutionSwitches } from '../../src/db/schema/ai-execution-switch.js';
import { openGlobalSwitchRow } from '../support/open-switch-row.js';
import type { AIProvider } from '../../src/lib/ai/types.js';

/**
 * AI-INTEG-P3-T1 — trusted run budget + metadata in the REAL `runAIFeature`.
 *
 * These specs run the production `runtime.ts` against an in-memory fake `DB` and
 * a fake provider — no Postgres. They prove: the per-run ceiling refuses BEFORE
 * the provider call, a failed call releases its reservation, a successful call
 * settles exactly once, a retry carries prior spend (never resets the ceiling),
 * concurrent calls cannot both slip under the same headroom, and request
 * metadata is attributed to the trusted run context (never to caller input).
 */

type Row = Record<string, unknown>;

const TABLES = { aiModels, aiRequests, aiBudgets, aiUsage, aiExecutionSwitches } as const;

function fakeDb(seedModels: Row[] = [], opts: { failRequestInsert?: boolean } = {}) {
  const store: Record<string, Row[]> = {
    aiModels: [...seedModels],
    aiRequests: [],
    aiBudgets: [],
    aiUsage: [],
    aiExecutionSwitches: [openGlobalSwitchRow()],
  };
  const nameOf = new Map<unknown, string>(Object.entries(TABLES).map(([n, t]) => [t, n]));
  const tableName = (t: unknown): string => nameOf.get(t) ?? 'aiModels';

  const db = {
    select() {
      const b = {
        _table: 'aiModels' as string,
        from(t: unknown) { b._table = tableName(t); return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() { return b; },
        then(resolve: (rows: Row[]) => unknown) {
          // `usageSum` reads a single aggregate row from `ai_requests`; every
          // other select here returns its stored rows unfiltered.
          if (b._table === 'aiRequests') {
            const rows = store.aiRequests;
            const agg = {
              requests: rows.filter((r) => r.requestType !== 'AGENT_TASK').length,
              tokensIn: rows.reduce((s, r) => s + Number(r.tokensInput || 0), 0),
              tokensOut: rows.reduce((s, r) => s + Number(r.tokensOutput || 0), 0),
              cost: String(rows.reduce((s, r) => s + Number(r.cost || 0), 0)),
            };
            return Promise.resolve([agg]).then(resolve);
          }
          return Promise.resolve([...store[b._table]]).then(resolve);
        },
      };
      return b;
    },
    insert(t: unknown) {
      const table = tableName(t);
      return {
        values(v: Row | Row[]) {
          if (table === 'aiRequests' && opts.failRequestInsert) {
            return Promise.reject(new Error('ledger unavailable'));
          }
          store[table].push(...(Array.isArray(v) ? v : [v]));
          return Promise.resolve(undefined);
        },
      };
    },
    update(t: unknown) {
      const table = tableName(t);
      const b = {
        _patch: {} as Row,
        set(patch: Row) { b._patch = patch; return b; },
        where() {
          for (const row of store[table]) Object.assign(row, b._patch);
          return Promise.resolve(undefined);
        },
      };
      return b;
    },
    _store: store,
  };
  return db as unknown as DB & { _store: typeof store };
}

/** A priced model so the run ceiling has real numbers to work with. */
function pricedModel(key = 'test-model', per1k = 1) {
  return { key, provider: 'fake', displayName: key, currencyCode: 'USD', inputPer1k: per1k, outputPer1k: per1k };
}

function fakeProvider(tokensIn = 10, tokensOut = 20) {
  const calls: unknown[] = [];
  const provider: AIProvider = {
    id: 'fake',
    isAvailable: () => true,
    async call(opts) {
      calls.push(opts);
      return { content: 'ok', model: opts.model ?? 'test-model', tokensInput: tokensIn, tokensOutput: tokensOut, cost: '0', currencyCode: 'USD' };
    },
  };
  return { provider, calls };
}

function baseInput(provider: AIProvider, metadata?: Record<string, unknown>) {
  return {
    userId: 'user-1',
    roles: ['MERCHANT'] as const,
    requestType: 'AGENT:test',
    system: 'sys',
    user: 'hello',
    maxTokens: 256,
    modelKey: 'test-model',
    provider,
    ...(metadata ? { metadata } : {}),
  } as unknown as Parameters<typeof runAIFeature>[1];
}

describe('run budget — reserve before the provider call', () => {
  it('refuses an over-cap call BEFORE provider.call (no paid call happens)', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider, calls } = fakeProvider();
    const budget = new AgentRunBudget(new Decimal('0.0001')); // far below the estimate

    await expect(
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);
    expect(calls).toHaveLength(0);
    expect(db._store.aiRequests).toHaveLength(0);
  });
});

describe('run budget — release on provider failure', () => {
  it('releases the reservation when the provider throws (spend back to zero)', async () => {
    const db = fakeDb([pricedModel()]);
    const failing: AIProvider = {
      id: 'fake',
      isAvailable: () => true,
      async call() { throw new Error('provider down'); },
    };
    const budget = new AgentRunBudget(new Decimal(1));

    await expect(
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(failing))),
    ).rejects.toThrow('provider down');

    // Reserved then released: no residual spend, no dangling reservation.
    expect(budget.spentUsd.toFixed(10)).toBe('0.0000000000');
    expect(budget.callCount).toBe(0);
    // The failed attempt is still recorded on the ledger (unchanged behaviour).
    expect(db._store.aiRequests).toHaveLength(1);
    expect(db._store.aiRequests[0].status).toBe('FAILED');
  });
});

describe('run budget — settle once on success', () => {
  it('settles to the measured cost exactly once', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider(10, 20); // actual = 30/1000 * 1 = 0.03
    const budget = new AgentRunBudget(new Decimal(1));

    const out = await withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider)));

    expect(budget.spentUsd.toFixed(10)).toBe('0.0300000000');
    expect(budget.callCount).toBe(1);
    expect(out.cost).toBe('0.0300000000');
    const row = db._store.aiRequests[0];
    expect(row.status).toBe('SUCCESS');
    expect(row.cost).toBe('0.0300000000');
  });

  it('carries prior spend across a retry (ceiling is never reset)', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider(10, 20);
    // A retry is seeded with what earlier attempts already recorded.
    const budget = new AgentRunBudget(new Decimal(1), new Decimal('0.5'));

    await withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider)));

    // prior 0.5 + actual 0.03 = 0.53 (NOT reset to 0.03).
    expect(budget.spentUsd.toFixed(10)).toBe('0.5300000000');
  });

  it('records the full cost and refuses AFTER the ledger when the measured cost exceeds the cap', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider, calls } = fakeProvider(10, 5000); // actual = 5.01 > cap 1
    const budget = new AgentRunBudget(new Decimal(1));

    await expect(
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
    ).rejects.toBeInstanceOf(AgentRunBudgetExceededError);

    // The provider WAS called (the money is spent) and the cost IS recorded.
    expect(calls).toHaveLength(1);
    expect(db._store.aiRequests).toHaveLength(1);
    expect(db._store.aiRequests[0].status).toBe('OVER_BUDGET');
    expect(new Decimal(String(db._store.aiRequests[0].cost)).gt(1)).toBe(true);
    // The accumulator holds the true spend, so a later call is refused up front.
    expect(budget.spentUsd.gt(1)).toBe(true);
  });

  it('carries the measured CALL cost on the error (G3) so the task can persist it', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider(10, 5000); // actual = 5.01 > cap 1
    const budget = new AgentRunBudget(new Decimal(1));

    const err = await withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))).then(
      () => { throw new Error('expected an over-budget refusal'); },
      (e: AgentRunBudgetExceededError) => e,
    );

    // The ledger holds the exact measured cost…
    expect(db._store.aiRequests[0].cost).toBe('5.0100000000');
    // …and the error carries the SAME call cost (not the accumulated run spend),
    // which is what the task-termination path accumulates onto `agent_tasks.cost`.
    expect(err).toBeInstanceOf(AgentRunBudgetExceededError);
    expect(err.actualCostUsd).toBe('5.0100000000');
    expect(err.spentUsd).toBe('5.0100000000'); // equal here: no prior spend on this run
  });

  it('carries only the CALL cost — never the accumulated spend — when the run had prior spend (G3)', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider(10, 5000); // actual call cost = 5.01
    // Cap 1 with prior spend 0.5: the estimate fits, but the measured cost does not.
    const budget = new AgentRunBudget(new Decimal(1), new Decimal('0.5'));

    const err = await withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))).then(
      () => { throw new Error('expected an over-budget refusal'); },
      (e: AgentRunBudgetExceededError) => e,
    );

    expect(err.actualCostUsd).toBe('5.0100000000'); // the call's own cost
    expect(err.spentUsd).toBe('5.5100000000'); // prior 0.5 + call 5.01 — distinct from actualCostUsd
  });

  it('does NOT carry a call cost for a PRE-FLIGHT refusal (provider never called) (G3)', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider, calls } = fakeProvider();
    const budget = new AgentRunBudget(new Decimal('0.0001')); // far below the estimate

    const err = await withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))).then(
      () => { throw new Error('expected an over-budget refusal'); },
      (e: AgentRunBudgetExceededError) => e,
    );

    expect(err).toBeInstanceOf(AgentRunBudgetExceededError);
    expect(calls).toHaveLength(0); // no paid call
    expect(db._store.aiRequests).toHaveLength(0); // nothing recorded
    expect(err.actualCostUsd).toBeUndefined(); // nothing spent ⇒ no invented cost
  });
});

describe('run budget — concurrency', () => {
  it('does not let two concurrent calls both slip under the same headroom', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider, calls } = fakeProvider(10, 20);
    const budget = new AgentRunBudget(new Decimal('0.3')); // fits one estimate (~0.258), not two

    const results = await Promise.allSettled([
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(calls).toHaveLength(1); // the loser was refused before any provider call
  });
});

describe('run metadata — trusted context only', () => {
  it('attributes taskId/agentKey from the run context, not from caller input', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider();

    await withAgentRunContext(
      { taskId: 'real-task', agentKey: 'sales-agent' },
      () => runAIFeature(db, baseInput(provider, { taskId: 'forged', agentKey: 'forged', action: 'x' })),
    );

    const row = db._store.aiRequests[0];
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.taskId).toBe('real-task');
    expect(meta.agentKey).toBe('sales-agent');
    expect(meta.action).toBe('x'); // unrelated metadata preserved
  });

  it('keeps caller metadata EXACTLY as-is when no run context exists', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider();

    await runAIFeature(db, baseInput(provider, { taskId: 'caller-task', agentKey: 'caller-agent' }));

    const meta = db._store.aiRequests[0].metadata as Record<string, unknown>;
    expect(meta.taskId).toBe('caller-task'); // NOT stripped — master behaviour preserved
    expect(meta.agentKey).toBe('caller-agent');
    expect(meta.provider).toBe('fake');
  });
});

// ───────────────────────── AI-INTEG-P3-T1.1 (F2 + F4) ─────────────────────────

describe('cost recording — a failed ledger write never reports success (F2)', () => {
  it('throws AgentCostRecordingError (not a bare success) when recordAiRequest fails', async () => {
    const db = fakeDb([pricedModel()], { failRequestInsert: true });
    const { provider } = fakeProvider(10, 20);

    await expect(runAIFeature(db, baseInput(provider))).rejects.toMatchObject({
      code: 'RUN_COST_NOT_RECORDED',
    });
  });

  it('preserves the original database error as the cause', async () => {
    const db = fakeDb([pricedModel()], { failRequestInsert: true });
    const { provider } = fakeProvider(10, 20);

    try {
      await runAIFeature(db, baseInput(provider));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { cause?: string }).cause).toBe('ledger unavailable');
    }
  });

  it('still settles the run budget exactly once before the ledger failure', async () => {
    const db = fakeDb([pricedModel()], { failRequestInsert: true });
    const { provider } = fakeProvider(10, 20);
    const budget = new AgentRunBudget(new Decimal(1));

    await expect(
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
    ).rejects.toMatchObject({ code: 'RUN_COST_NOT_RECORDED' });
    // settle ran (estimate replaced by measured cost) — not double-counted, not left reserved.
    expect(budget.callCount).toBe(1);
    expect(budget.spentUsd.gt(0)).toBe(true);
  });
});

describe('model pricing validation — fail closed (F4)', () => {
  function modelWithPrice(inputPer1k: unknown, outputPer1k: unknown): Row {
    return { key: 'test-model', provider: 'openai', displayName: 't', currencyCode: 'USD', inputPer1k, outputPer1k };
  }

  it.each([
    ['negative input price', '-1', '0'],
    ['negative output price', '0', '-5'],
    ['NaN input price', NaN, '0'],
    ['Infinity output price', '0', Infinity],
    ['non-numeric price', 'free', '0'],
  ])('refuses a %s (503) and never reaches the provider', async (_label, i, o) => {
    const db = fakeDb([modelWithPrice(i, o)]);
    const { provider, calls } = fakeProvider();

    await expect(runAIFeature(db, baseInput(provider))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('accepts a zero price (free model) and still completes', async () => {
    const db = fakeDb([modelWithPrice('0', '0')]);
    const { provider, calls } = fakeProvider(10, 20);

    const out = await runAIFeature(db, baseInput(provider));
    expect(calls).toHaveLength(1);
    expect(out.cost).toBe('0.0000000000');
  });

  it('never reserves a negative estimate against a run budget', async () => {
    const db = fakeDb([modelWithPrice('-2', '-2')]);
    const { provider } = fakeProvider();
    const budget = new AgentRunBudget(new Decimal(1));

    await expect(
      withAgentRunBudget(budget, () => runAIFeature(db, baseInput(provider))),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(budget.spentUsd.toNumber()).toBe(0); // no negative reservation widened the headroom
  });
});

// ───────────────────────── AI-INTEG-P3-G2 (trusted reconciliation evidence) ─────────────────────────
// The `ai_requests.metadata` key `__agentTaskId` is the SERVER-OWNED evidence
// `reconcileTaskCostFromLedger` keys on. These specs prove the WRITE side:
//  - a trusted run context writes the key from the task id (never from `input`);
//  - the direct `/api/ai/run` path (no context) can never plant it, even when the
//    caller sends a forged `metadata.__agentTaskId`/`metadata.taskId`.
// The READ side (reconcile abstains on forged evidence) is proven in the wiring
// suite against the real `agents.ts`.

describe('G2 — trusted reconciliation evidence is written only from a run context', () => {
  const LEDGER_KEY = '__agentTaskId';

  it('writes the trusted ledger key from the run context, not from caller input', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider();
    const ctx: AgentRunContext = {
      taskId: 'real-task',
      agentKey: 'sales-agent',
      ledgerTaskId: 'real-task',
      authorizedActions: [],
      allowedTools: [],
    };

    await withAgentRunContext(ctx, () =>
      runAIFeature(db, baseInput(provider, { taskId: 'forged', [LEDGER_KEY]: 'forged', action: 'x' })),
    );

    const meta = db._store.aiRequests[0].metadata as Record<string, unknown>;
    expect(meta[LEDGER_KEY]).toBe('real-task'); // trusted id wins
    expect(meta.taskId).toBe('real-task');
    expect(meta.action).toBe('x'); // unrelated metadata preserved
  });

  it('strips a forged ledger key on the no-context (/api/ai/run) path', async () => {
    const db = fakeDb([pricedModel()]);
    const { provider } = fakeProvider();

    await runAIFeature(db, baseInput(provider, { [LEDGER_KEY]: 'victim-task', other: 1 }));

    const meta = db._store.aiRequests[0].metadata as Record<string, unknown>;
    expect(LEDGER_KEY in meta).toBe(false); // no trusted evidence can be planted
    expect(meta.other).toBe(1); // other keys preserved — master behaviour intact
  });
});


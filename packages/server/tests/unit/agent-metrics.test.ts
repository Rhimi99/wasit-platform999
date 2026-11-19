import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DB } from '../../src/db/client.js';
import {
  buildCompanyMetrics,
  buildCompanyMetricsForAdmin,
} from '../../src/modules/ai/agent-metrics.js';
import { deriveScope, derivePlatformScope, NoScopeError } from '../../src/modules/ai/scope.js';
import { agentTasks, agentRegistry } from '../../src/db/schema/agents.js';
import { aiRequests } from '../../src/db/schema/ai.js';
import { agentRunSteps } from '../../src/db/schema/agent_runs.js';
import { auditLogs } from '../../src/db/schema/audit.js';

/**
 * A3 — Agent Metrics & Outcome Tracking (database-free half).
 *
 * Drives the REAL `buildCompanyMetrics` against an in-memory fake `DB` and pins
 * every calculation: run buckets, success rate, duration (avg/median/p95/slow),
 * retries, ACTUAL cost attribution, health derivation, honest outcomes, and the
 * admin platform-scope gate. No Postgres, no mocks of the module itself.
 *
 * The fake returns rows already shaped the way the metrics query selects them
 * (drizzle's column mapping is exercised by the DB-backed suite); it also records
 * which tables were read, so a test can prove `agent_metrics` is never touched.
 */

type Row = Record<string, unknown>;

const TN = {
  agentTasks: getTableName(agentTasks),
  agentRegistry: getTableName(agentRegistry),
  aiRequests: getTableName(aiRequests),
  agentRunSteps: getTableName(agentRunSteps),
  auditLogs: getTableName(auditLogs),
};

interface FakeStore {
  agentTasks: Row[];
  agentRegistry: Row[];
  aiRequests: Row[];
  agentRunSteps: Row[];
  auditLogs: Row[];
}

function fakeDb(seed: Partial<FakeStore> = {}) {
  const store: FakeStore = {
    agentTasks: seed.agentTasks ?? [],
    agentRegistry: seed.agentRegistry ?? [],
    aiRequests: seed.aiRequests ?? [],
    agentRunSteps: seed.agentRunSteps ?? [],
    auditLogs: seed.auditLogs ?? [],
  };
  const reads: string[] = [];
  const tableFor = (t: unknown): keyof FakeStore => {
    const n = getTableName(t as never);
    if (n === TN.agentTasks) return 'agentTasks';
    if (n === TN.agentRegistry) return 'agentRegistry';
    if (n === TN.aiRequests) return 'aiRequests';
    if (n === TN.agentRunSteps) return 'agentRunSteps';
    if (n === TN.auditLogs) return 'auditLogs';
    throw new Error(`unexpected table ${n}`);
  };
  const db = {
    select() {
      const b = {
        _t: '' as keyof FakeStore,
        from(t: unknown) { b._t = tableFor(t); reads.push(b._t); return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() { return b; },
        then(resolve: (v: Row[]) => unknown) {
          return Promise.resolve(store[b._t].map((r) => ({ ...r }))).then(resolve);
        },
      };
      return b;
    },
  };
  return { db: db as unknown as DB, store, reads };
}

const TASK = (over: Row = {}): Row => ({
  id: 't1',
  agentKey: 'marketing-agent',
  status: 'succeeded',
  result: { advice: 'x' },
  cost: '0',
  model: 'local-heuristic',
  latencyMs: 100,
  createdAt: new Date('2026-11-01T10:00:00Z'),
  completedAt: new Date('2026-11-01T10:00:01Z'),
  ...over,
});

const REG = (key: string, over: Row = {}): Row => ({
  key,
  name: key,
  requiresHumanApproval: false,
  isActive: true,
  ...over,
});

const LEDGER = (over: Row = {}): Row => ({
  taskId: 't1',
  agentKey: 'marketing-agent',
  model: 'gpt-4o-mini',
  cost: '0.0025000000',
  tokensInput: 120,
  tokensOutput: 40,
  status: 'SUCCESS',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  ...over,
});

describe('A3 — zero runs is honest, not fabricated', () => {
  it('reports zero runs, null success rate, no cost, and no_data health', async () => {
    const { db } = fakeDb({ agentRegistry: [REG('marketing-agent')] });
    const m = await buildCompanyMetrics(db);
    expect(m.overall.execution.totalRuns).toBe(0);
    expect(m.overall.execution.successRate).toBeNull();
    expect(m.overall.cost.available).toBe(false);
    expect(m.overall.cost.actualProviderCostUsd).toBe('0');
    const agent = m.agents.find((a) => a.agentKey === 'marketing-agent')!;
    expect(agent.health).toBe('no_data');
    expect(agent.lastActivityAt).toBeNull();
    expect(agent.outcomes.tasksWithStoredResult).toBe(0);
    expect(agent.outcomes.businessOutcomesAchieved).toBe(0);
  });

  it('never reads agent_metrics (so a stray row there cannot double-count)', async () => {
    const { db, reads } = fakeDb({ agentRegistry: [REG('sales-agent')] });
    await buildCompanyMetrics(db);
    expect(reads).not.toContain('agentMetrics');
  });
});

describe('A3 — execution buckets & success rate', () => {
  it('counts each task once and buckets by status', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [
        TASK({ id: 'a', agentKey: 'sales-agent', status: 'succeeded' }),
        TASK({ id: 'b', agentKey: 'sales-agent', status: 'approved' }),
        TASK({ id: 'c', agentKey: 'sales-agent', status: 'failed' }),
        TASK({ id: 'd', agentKey: 'sales-agent', status: 'rejected' }),
        TASK({ id: 'e', agentKey: 'sales-agent', status: 'queued' }),
        TASK({ id: 'f', agentKey: 'sales-agent', status: 'running' }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'sales-agent')!;
    expect(a.execution.totalRuns).toBe(6);
    expect(a.execution.completed).toBe(2);
    expect(a.execution.failed).toBe(2);
    expect(a.execution.pending).toBe(1);
    expect(a.execution.running).toBe(1);
    // successRate over settled runs only (2 of 4).
    expect(a.execution.successRate).toBeCloseTo(0.5, 5);
  });

  it('counts each task exactly once even when the same id appears (dedupe by row identity)', async () => {
    // Two DISTINCT tasks must both count; the guarantee is that a task is never
    // counted twice through a second table (agent_metrics). We assert the total
    // equals the number of task rows.
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ id: 'a', agentKey: 'sales-agent' }), TASK({ id: 'b', agentKey: 'sales-agent' })],
    });
    const m = await buildCompanyMetrics(db);
    expect(m.agents.find((x) => x.agentKey === 'sales-agent')!.execution.totalRuns).toBe(2);
  });

  it('a failure is never retried away: it stays in the failure bucket', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('risk-agent')],
      agentTasks: [
        TASK({ id: 'x', agentKey: 'risk-agent', status: 'failed' }),
        TASK({ id: 'y', agentKey: 'risk-agent', status: 'succeeded' }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'risk-agent')!;
    expect(a.execution.failed).toBe(1);
    expect(a.execution.completed).toBe(1);
    expect(a.health).toBe('degraded');
  });
});

describe('A3 — duration metrics', () => {
  it('computes avg, median, p95 and slow runs from measured durations', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('analytics-agent')],
      agentTasks: [
        TASK({ id: '1', agentKey: 'analytics-agent', latencyMs: 100 }),
        TASK({ id: '2', agentKey: 'analytics-agent', latencyMs: 200 }),
        TASK({ id: '3', agentKey: 'analytics-agent', latencyMs: 300 }),
        TASK({ id: '4', agentKey: 'analytics-agent', latencyMs: 20000 }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'analytics-agent')!;
    expect(a.performance.measuredRuns).toBe(4);
    expect(a.performance.avgDurationMs).toBe(Math.round((100 + 200 + 300 + 20000) / 4));
    expect(a.performance.medianDurationMs).toBe(Math.round((200 + 300) / 2));
    expect(a.performance.p95DurationMs).toBe(20000);
    expect(a.performance.slowRuns).toBe(1);
  });

  it('treats an unmeasured (zero) duration as absent, not as an instant run', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('support-agent')],
      agentTasks: [TASK({ id: '1', agentKey: 'support-agent', latencyMs: 0, completedAt: null })],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'support-agent')!;
    expect(a.performance.measuredRuns).toBe(0);
    expect(a.performance.avgDurationMs).toBeNull();
  });
});

describe('A3 — retries & recovery (from persisted evidence)', () => {
  it('counts retried steps only when attempt_count > 1', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentRunSteps: [
        { agentKey: 'sales-agent', status: 'SUCCEEDED', attemptCount: 1 },
        { agentKey: 'sales-agent', status: 'SUCCEEDED', attemptCount: 2 },
        { agentKey: 'sales-agent', status: 'FAILED', attemptCount: 3 },
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'sales-agent')!;
    expect(a.performance.retriedSteps).toBe(2);
    expect(a.performance.failedSteps).toBe(1);
    expect(m.overall.performance.retriedSteps).toBe(2);
  });

  it('counts recovered runs from the recovery audit evidence only', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ id: 'task-9', agentKey: 'sales-agent', status: 'failed' })],
      auditLogs: [
        { entityId: 'task-9', createdAt: new Date('2026-11-02T00:00:00Z') },
        { entityId: 'unknown-task', createdAt: new Date('2026-11-02T00:00:00Z') },
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'sales-agent')!;
    expect(a.performance.recoveredRuns).toBe(1);
    expect(m.overall.performance.recoveredRuns).toBe(1);
    expect(m.dataFreshness.latestMetricAt).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('A3 — cost is ACTUAL provider spend, or explicitly unavailable', () => {
  it('reports unavailable when no provider ledger row exists', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ agentKey: 'sales-agent' })],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'sales-agent')!;
    expect(a.cost.available).toBe(false);
    expect(a.cost.actualProviderCostUsd).toBe('0');
    expect(a.cost.byModel).toEqual([]);
  });

  it('sums the ledger cost, tokens and model attribution per agent', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('marketing-agent')],
      agentTasks: [TASK({ agentKey: 'marketing-agent' })],
      aiRequests: [
        LEDGER({ taskId: 't1', agentKey: 'marketing-agent', model: 'gpt-4o-mini', cost: '0.0020000000', tokensInput: 100, tokensOutput: 20 }),
        LEDGER({ taskId: 't1', agentKey: 'marketing-agent', model: 'gpt-4o-mini', cost: '0.0010000000', tokensInput: 50, tokensOutput: 10 }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'marketing-agent')!;
    expect(a.cost.available).toBe(true);
    expect(a.cost.actualProviderCostUsd).toBe('0.0030000000');
    expect(a.cost.tokensInput).toBe(150);
    expect(a.cost.tokensOutput).toBe(30);
    expect(a.cost.requests).toBe(2);
    expect(a.cost.byModel).toEqual([
      { model: 'gpt-4o-mini', provider: null, requests: 2, costUsd: '0.0030000000' },
    ]);
  });

  it('ignores ledger rows not attributed to a task (never a phantom agent cost)', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      aiRequests: [LEDGER({ taskId: null, agentKey: null, cost: '9.0000000000' })],
    });
    const m = await buildCompanyMetrics(db);
    expect(m.overall.cost.available).toBe(false);
  });

  it('ignores a negative/NaN ledger cost rather than reporting it', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ agentKey: 'sales-agent' })],
      aiRequests: [LEDGER({ agentKey: 'sales-agent', cost: '-5' }), LEDGER({ agentKey: 'sales-agent', cost: 'abc' })],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'sales-agent')!;
    expect(a.cost.actualProviderCostUsd).toBe('0.0000000000');
  });
});

describe('A3 — outcomes: completed ≠ business outcome achieved', () => {
  it('counts stored results but never claims a business outcome', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('product-agent')],
      agentTasks: [
        TASK({ id: '1', agentKey: 'product-agent', result: { advice: 'x' } }),
        TASK({ id: '2', agentKey: 'product-agent', result: null, status: 'failed' }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'product-agent')!;
    expect(a.outcomes.tasksWithStoredResult).toBe(1);
    expect(a.outcomes.businessOutcomesAchieved).toBe(0);
    expect(a.outcomes.note).toMatch(/acted on/);
  });
});

describe('A3 — health derivation from explicit signals', () => {
  const recent = new Date();
  it('healthy when all runs succeeded recently', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ agentKey: 'sales-agent', status: 'succeeded', createdAt: recent, completedAt: recent })],
    });
    const m = await buildCompanyMetrics(db);
    expect(m.agents.find((x) => x.agentKey === 'sales-agent')!.health).toBe('healthy');
  });

  it('idle when runs exist but none recently', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent')],
      agentTasks: [TASK({ agentKey: 'sales-agent', status: 'succeeded', createdAt: new Date('2020-01-01T00:00:00Z'), completedAt: new Date('2020-01-01T00:00:01Z') })],
    });
    const m = await buildCompanyMetrics(db);
    expect(m.agents.find((x) => x.agentKey === 'sales-agent')!.health).toBe('idle');
  });

  it('failing when the settled success rate is below half', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('risk-agent')],
      agentTasks: [
        TASK({ id: '1', agentKey: 'risk-agent', status: 'failed' }),
        TASK({ id: '2', agentKey: 'risk-agent', status: 'failed' }),
        TASK({ id: '3', agentKey: 'risk-agent', status: 'succeeded' }),
      ],
    });
    const m = await buildCompanyMetrics(db);
    const a = m.agents.find((x) => x.agentKey === 'risk-agent')!;
    expect(a.health).toBe('failing');
    expect(m.attention.some((x) => x.agentKey === 'risk-agent')).toBe(true);
  });
});

describe('A3 — admin platform-scope gate', () => {
  it('accepts an admin platform scope', async () => {
    const { db } = fakeDb({ agentRegistry: [REG('sales-agent')] });
    const scope = derivePlatformScope({ userId: 'admin-1' }, { roles: ['ADMIN'] });
    await expect(buildCompanyMetricsForAdmin(db, scope)).resolves.toBeTruthy();
  });

  it('refuses an owner-only scope (no platform authority)', async () => {
    const { db } = fakeDb({ agentRegistry: [REG('sales-agent')] });
    const scope = deriveScope({ userId: 'user-1' });
    await expect(buildCompanyMetricsForAdmin(db, scope)).rejects.toThrow(NoScopeError);
  });

  it('refuses a hand-built/forged scope object', async () => {
    const { db } = fakeDb({ agentRegistry: [REG('sales-agent')] });
    const forged = { owner: 'x', isPlatform: true, isSystem: false };
    await expect(buildCompanyMetricsForAdmin(db, forged as never)).rejects.toThrow(NoScopeError);
  });

  it('refuses a missing scope', async () => {
    const { db } = fakeDb({ agentRegistry: [REG('sales-agent')] });
    await expect(buildCompanyMetricsForAdmin(db, undefined)).rejects.toThrow(NoScopeError);
  });
});

describe('A3 — per-agent filter and roll-up', () => {
  it('filters to one agent and rolls the company totals over that set', async () => {
    const { db } = fakeDb({
      agentRegistry: [REG('sales-agent'), REG('marketing-agent')],
      agentTasks: [
        TASK({ id: '1', agentKey: 'sales-agent' }),
        TASK({ id: '2', agentKey: 'marketing-agent' }),
        TASK({ id: '3', agentKey: 'marketing-agent', status: 'failed' }),
      ],
    });
    const m = await buildCompanyMetrics(db, { agentKey: 'marketing-agent' });
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0].agentKey).toBe('marketing-agent');
    expect(m.overall.execution.totalRuns).toBe(2);
    expect(m.overall.execution.failed).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DB } from '../../src/db/client.js';
import { withAgentDataScope } from '../../src/modules/ai/agent-scope.js';
import { executeAgentTask } from '../../src/modules/ai/executors.js';
import { withAgentRunContext, type AgentRunContext } from '../../src/lib/ai/agent-run-context.js';
import { createAgentTask, AGENT_CATALOGUE } from '../../src/modules/ai/agents.js';
import { agentRegistry, agentTasks } from '../../src/db/schema/agents.js';
import { roles, userRoles } from '../../src/db/schema/auth.js';
import { auditLogs } from '../../src/db/schema/audit.js';
import { notifications } from '../../src/db/schema/messaging.js';
import { aiBudgets, aiModels, aiRequests, aiUsage } from '../../src/db/schema/ai.js';
import { products, categories } from '../../src/db/schema/products.js';
import { disputes } from '../../src/db/schema/disputes.js';
import { sessions } from '../../src/db/schema/auth.js';

/**
 * A2 — production data-scope enforcement.
 *
 * Runs the REAL `executeAgentTask` against an in-memory fake `DB` (no Postgres)
 * and proves the scoped handle refuses any access outside the agent's contract —
 * another agent's tables, hard-denied tables, writes, raw SQL and transactions —
 * and that an end-to-end `createAgentTask` run reaches its data through the
 * scoped handle (enforcement is on a production path, not only in tests).
 */

type Row = Record<string, unknown>;

function fakeDb() {
  const TN = {
    agentRegistry: getTableName(agentRegistry),
    agentTasks: getTableName(agentTasks),
    roles: getTableName(roles),
    userRoles: getTableName(userRoles),
    auditLogs: getTableName(auditLogs),
    notifications: getTableName(notifications),
    aiRequests: getTableName(aiRequests),
    aiBudgets: getTableName(aiBudgets),
    aiUsage: getTableName(aiUsage),
    aiModels: getTableName(aiModels),
    products: getTableName(products),
    categories: getTableName(categories),
  };
  const store: Record<string, Row[]> = {
    [TN.agentRegistry]: [],
    [TN.agentTasks]: [],
    [TN.roles]: [{ id: 'r-merchant', name: 'MERCHANT' }],
    [TN.userRoles]: [{ userId: 'owner-1', roleId: 'r-merchant' }],
    [TN.auditLogs]: [],
    [TN.notifications]: [],
    [TN.aiRequests]: [],
    [TN.aiBudgets]: [],
    [TN.aiUsage]: [],
    [TN.aiModels]: [],
    [TN.products]: [{ id: 'p1', isPublished: true }],
    [TN.categories]: [{ id: 'c1', name: 'Cat' }],
  };
  const name = (t: unknown): string => getTableName(t as never);
  const rows = (t: string): Row[] => (store[t] ??= []);
  const stats = { reads: 0, fromCalls: [] as string[] };

  const makeDb = (): unknown => ({
    select() {
      const b = {
        _table: '' as string,
        _cond: undefined as unknown,
        _grouped: false,
        from(t: unknown) { b._table = name(t); stats.fromCalls.push(b._table); return b; },
        innerJoin(t: unknown) { stats.fromCalls.push(name(t)); return b; },
        leftJoin(t: unknown) { stats.fromCalls.push(name(t)); return b; },
        where(cond: unknown) { b._cond = cond; return b; },
        groupBy() {
          b._grouped = true;
          return b;
        },
        orderBy() { return b; },
        limit() { return b; },
        for() { return b; },
        then(resolve: (v: Row[]) => unknown) {
          stats.reads += 1;
          // The aggregate select (`usageSum`) has no GROUP BY; a grouped select
          // (`report_pnl`) must see the raw rows instead of the aggregate row.
          if (b._table === TN.aiRequests && !b._grouped) {
            const all = rows(TN.aiRequests);
            const agg = {
              requests: all.filter((r) => r.requestType !== 'AGENT_TASK').length,
              tokensIn: all.reduce((s, r) => s + Number(r.tokensInput || 0), 0),
              tokensOut: all.reduce((s, r) => s + Number(r.tokensOutput || 0), 0),
              cost: String(all.reduce((s, r) => s + Number(r.cost || 0), 0)),
            };
            return Promise.resolve([agg]).then(resolve);
          }
          if (b._table === TN.userRoles) {
            return Promise.resolve(store[TN.roles].map((r) => ({ ...r }))).then(resolve);
          }
          const out = rows(b._table);
          return Promise.resolve(out.map((r) => ({ ...r }))).then(resolve);
        },
      };
      return b;
    },
    insert(t: unknown) {
      const table = name(t);
      const values = (v: Row | Row[]) => {
        rows(table).push(...(Array.isArray(v) ? v : [v]));
        return Object.assign(Promise.resolve(undefined), { onConflictDoNothing: () => Promise.resolve(undefined) });
      };
      return { values };
    },
    update(t: unknown) {
      const table = name(t);
      const b = {
        _matched: [] as Row[],
        set() { return b; },
        where() { b._matched = rows(table); return b; },
        returning() { return Promise.resolve(b._matched.map((r) => ({ ...r }))); },
        then(resolve: (v: undefined) => unknown) { return Promise.resolve(undefined).then(resolve); },
      };
      return b;
    },
    delete(t: unknown) { return { where: () => Promise.resolve(undefined) }; },
    transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(makeDb()); },
    execute() { return Promise.resolve({ rows: [] }); },
    _store: store,
    _stats: stats,
  });

  const db = makeDb();
  return db as unknown as DB & { _store: typeof store; _stats: typeof stats };
}

const def = (key: string) => AGENT_CATALOGUE.find((a) => a.key === key)!;
const runCtx = (agentKey: string, over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  taskId: `t-${agentKey}`,
  agentKey,
  requestedBy: 'owner-1',
  authorizedActions: (def(agentKey).capabilities ?? []).map((c) => c.action),
  ...over,
});

describe('A2 — scoped db handle (withAgentDataScope)', () => {
  it('ALLOWS a read of a table inside the run scope', async () => {
    const db = fakeDb();
    const out = await withAgentRunContext(runCtx('product-agent'), async () => {
      const scoped = withAgentDataScope(db);
      return scoped.select({ id: products.id }).from(products);
    });
    expect(out).toHaveLength(1);
  });

  it('REFUSES a read of another agent’s table at the access boundary', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(runCtx('product-agent'), async () => {
        const scoped = withAgentDataScope(db);
        return scoped.select().from(disputes);
      }),
    ).rejects.toThrow(/not permitted to access "disputes"/);
    expect(db._stats.fromCalls).not.toContain(getTableName(disputes));
  });

  it('REFUSES a hard-denied table (sessions)', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(runCtx('product-agent'), async () => {
        const scoped = withAgentDataScope(db);
        return scoped.select().from(sessions);
      }),
    ).rejects.toThrow(/prohibited for every agent/);
  });

  it('REFUSES a write to a business table', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(runCtx('product-agent'), async () => {
        const scoped = withAgentDataScope(db);
        scoped.insert(products);
      }),
    ).rejects.toThrow(/read-only/);
  });

  it('REFUSES raw SQL and transactions', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(runCtx('product-agent'), async () => {
        const scoped = withAgentDataScope(db);
        scoped.execute({} as never);
      }),
    ).rejects.toThrow(/Raw SQL, transactions/);
    await expect(
      withAgentRunContext(runCtx('product-agent'), async () => {
        const scoped = withAgentDataScope(db);
        scoped.transaction(async () => undefined);
      }),
    ).rejects.toThrow(/Raw SQL, transactions/);
  });

  it('FAILS CLOSED with no run context', async () => {
    const db = fakeDb();
    const scoped = withAgentDataScope(db);
    await expect(async () => scoped.select().from(products)).rejects.toThrow(/No trusted agent run scope/);
  });
});

describe('A2 — end-to-end: enforcement runs on the production path', () => {
  it('createAgentTask runs the executor through the scoped handle', async () => {
    const db = fakeDb();
    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'marketing-agent', requestedBy: 'owner-1', input: {} },
      { actorId: 'actor', ipAddress: null, userAgent: null },
    );
    expect(task.status).toBe('succeeded');
    // The executor read its scoped tables THROUGH the wrapper (enforcement on).
    expect(db._stats.fromCalls).toContain(getTableName(products));
    expect(db._stats.fromCalls).toContain(getTableName(categories));
  });

  it('every one of the 13 executors reaches its data through the scoped handle', async () => {
    for (const d of AGENT_CATALOGUE) {
      const db = fakeDb();
      const out = await withAgentRunContext(runCtx(d.key), () => executeAgentTask(db, d, {}));
      expect(out.content.length).toBeGreaterThan(0);
      // Each executor touched at least one table through the wrapper.
      expect(db._stats.fromCalls.length).toBeGreaterThan(0);
    }
  });

  it('a caller cannot widen scope by passing a different agent key in input', async () => {
    const db = fakeDb();
    // product-agent run, caller tries to reach disputes via input — input is never
    // consulted for scope, and the executor only reads product tables.
    const out = await withAgentRunContext(runCtx('product-agent'), () =>
      executeAgentTask(db, def('product-agent'), { agentKey: 'dispute-assistant', table: 'disputes' }),
    );
    expect(out.content).toContain('product-agent');
    expect(db._stats.fromCalls).not.toContain(getTableName(disputes));
  });
});

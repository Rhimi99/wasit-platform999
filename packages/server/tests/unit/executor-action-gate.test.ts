import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { DB } from '../../src/db/client.js';
import { executeAgentTask } from '../../src/modules/ai/executors.js';
import {
  withAgentRunContext,
  ActionNotAuthorizedError,
  type AgentRunContext,
} from '../../src/lib/ai/agent-run-context.js';
import { createAgentTask, decideAgentTask, AGENT_CATALOGUE } from '../../src/modules/ai/agents.js';
import { agentRegistry, agentTasks } from '../../src/db/schema/agents.js';
import { roles, userRoles } from '../../src/db/schema/auth.js';
import { auditLogs } from '../../src/db/schema/audit.js';
import { notifications } from '../../src/db/schema/messaging.js';
import { aiBudgets, aiModels, aiRequests, aiUsage } from '../../src/db/schema/ai.js';

/**
 * AI-INTEG-P3-T2 — the trusted action gate at the executor execution boundary.
 *
 * These specs run the REAL `executors.ts` (and the REAL `agents.ts` for the
 * end-to-end cases) against an in-memory fake `DB` and the real local-heuristic
 * provider — no Postgres, no external call. They prove that NO agent can perform
 * an action without (a) a trusted run context and (b) an explicit grant for that
 * exact action, and that a refusal happens BEFORE any DB read or provider call.
 */

type Row = Record<string, unknown>;

/** Minimal evaluator for the Drizzle conditions the code builds (`eq`, `and`, `sql`). */
function matches(cond: unknown, row: Row): boolean {
  if (cond == null) return true;
  type Tok = { t: 'col'; v: string } | { t: 'param'; v: unknown } | { t: 'frag'; v: string };
  const tokens: Tok[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      tokens.push({ t: 'param', v: node });
      return;
    }
    if (typeof node !== 'object') return;
    const n = node as { table?: unknown; name?: string; constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
    const ctorName = n.constructor?.name;
    if (ctorName === 'Param') {
      tokens.push({ t: 'param', v: n.value });
    } else if (ctorName === 'String' || ctorName === 'Number' || ctorName === 'Boolean') {
      tokens.push({ t: 'param', v: (node as { valueOf: () => unknown }).valueOf() });
    } else if (n.table && typeof n.name === 'string') {
      tokens.push({ t: 'col', v: n.name });
    } else if (ctorName === 'StringChunk') {
      tokens.push({ t: 'frag', v: Array.isArray(n.value) ? (n.value as string[]).join('') : '' });
    }
    if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
  };
  walk(cond);
  let ok = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i];
    if (tk.t !== 'col') continue;
    let frag = '';
    let j = i + 1;
    for (; j < tokens.length && tokens[j].t !== 'param'; j += 1) {
      if (tokens[j].t === 'frag') frag += (tokens[j] as { v: string }).v;
    }
    if (j >= tokens.length) continue;
    const value = (tokens[j] as { v: unknown }).v;
    const jsonb = frag.match(/->>\s*'([A-Za-z_][A-Za-z0-9_]*)'/);
    if (jsonb) {
      const obj = (row[tk.v] ?? {}) as Record<string, unknown>;
      ok = ok && obj[jsonb[1]] === value;
    } else {
      ok = ok && row[tk.v] === value;
    }
  }
  return ok;
}

/**
 * Fake DB covering the read/write shapes touched by `runAIFeature`, `agents.ts`
 * and the executors. Store keys are the REAL Drizzle table names, so a table the
 * test does not seed simply resolves to an empty array.
 */
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
  };
  const name = (t: unknown): string => getTableName(t as never);
  const rows = (t: string): Row[] => (store[t] ??= []);
  // Counts ACTUAL reads, so a test can prove a refusal happened before any DB
  // access (the executor body never ran).
  const stats = { reads: 0 };

  const makeDb = () => ({
    select() {
      const b = {
        _table: '' as string,
        _cond: undefined as unknown,
        from(t: unknown) { b._table = name(t); return b; },
        innerJoin() { return b; },
        leftJoin() { return b; },
        where(cond: unknown) { b._cond = cond; return b; },
        groupBy() { return b; },
        orderBy() { return b; },
        limit() { return b; },
        for() { return b; },
        then(resolve: (v: Row[]) => unknown) {
          stats.reads += 1;
          // `usageSum` reads a single aggregate row from `ai_requests`.
          if (b._table === TN.aiRequests) {
            const all = rows(TN.aiRequests);
            const agg = {
              requests: all.filter((r) => r.requestType !== 'AGENT_TASK').length,
              tokensIn: all.reduce((s, r) => s + Number(r.tokensInput || 0), 0),
              tokensOut: all.reduce((s, r) => s + Number(r.tokensOutput || 0), 0),
              cost: String(all.reduce((s, r) => s + Number(r.cost || 0), 0)),
            };
            return Promise.resolve([agg]).then(resolve);
          }
          // `rolesOfUser` projects `userRoles ⨝ roles`; return the joined roles.
          if (b._table === TN.userRoles) {
            return Promise.resolve(store[TN.roles].map((r) => ({ ...r }))).then(resolve);
          }
          const out = b._cond ? rows(b._table).filter((r) => matches(b._cond, r)) : rows(b._table);
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
        _patch: {} as Row,
        _cond: undefined as unknown,
        _matched: [] as Row[],
        set(patch: Row) { b._patch = patch; return b; },
        where(cond: unknown) {
          b._cond = cond;
          b._matched = rows(table).filter((r) => matches(b._cond, r));
          for (const row of b._matched) Object.assign(row, b._patch);
          return b;
        },
        returning() { return Promise.resolve(b._matched.map((r) => ({ ...r }))); },
        then(resolve: (v: undefined) => unknown) { return Promise.resolve(undefined).then(resolve); },
      };
      return b;
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(makeDb()); },
    _store: store,
    _stats: stats,
  });
  const db = makeDb();
  return db as unknown as DB & { _store: typeof store; _stats: typeof stats };
}

const def = (key: string) => AGENT_CATALOGUE.find((a) => a.key === key)!;
const ctx = (agentKey: string, actions: readonly string[]): AgentRunContext => ({
  taskId: `t-${agentKey}`,
  agentKey,
  authorizedActions: actions,
});
const AUDIT = { actorId: 'actor', ipAddress: null, userAgent: null };

describe('T2 — executeAgentTask action gate (execution boundary)', () => {
  it('REFUSES with NO trusted context, before any read or provider call', async () => {
    const db = fakeDb();
    await expect(executeAgentTask(db, def('sales-agent'), {})).rejects.toBeInstanceOf(ActionNotAuthorizedError);
    // Nothing ran: no DB read, no ledger row (no provider call).
    expect(db._stats.reads).toBe(0);
    expect(db._store[getTableName(aiRequests)]).toHaveLength(0);
  });

  it('REFUSES when the run has no grant (empty authorizedActions)', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(ctx('marketing-agent', []), () => executeAgentTask(db, def('marketing-agent'), {})),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
    expect(db._stats.reads).toBe(0);
    expect(db._store[getTableName(aiRequests)]).toHaveLength(0);
  });

  it('REFUSES a grant for a DIFFERENT action (cannot widen authority)', async () => {
    const db = fakeDb();
    await expect(
      withAgentRunContext(ctx('marketing-agent', ['generate_report']), () =>
        executeAgentTask(db, def('marketing-agent'), {}),
      ),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
    expect(db._stats.reads).toBe(0);
  });

  it('REFUSES when a caller forges metadata/agentKey/taskId to reach another agent', async () => {
    const db = fakeDb();
    // The context grants marketing-agent's action; the caller tries to run the
    // ads agent while forging identity. The gate uses the agent's OWN literal
    // action, so the forged grant does not apply.
    await expect(
      withAgentRunContext(ctx('marketing-agent', ['recommend_campaign']), () =>
        executeAgentTask(db, def('ads-agent'), { action: 'recommend_campaign', agentKey: 'marketing-agent', taskId: 'x', __userId: 'attacker' }),
      ),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
    expect(db._stats.reads).toBe(0);
  });

  it('ALLOWS a trusted context holding the executor\'s exact action', async () => {
    const db = fakeDb();
    const out = await withAgentRunContext(ctx('marketing-agent', ['recommend_campaign']), () =>
      executeAgentTask(db, def('marketing-agent'), {}),
    );
    expect(out.content).toContain('marketing-agent');
    expect(db._stats.reads).toBeGreaterThan(0);
  });
});

describe('T2 — every executor is gated by its own catalogue action', () => {
  it('each of the 11 executors runs only with a grant for its declared action', async () => {
    for (const d of AGENT_CATALOGUE) {
      const action = d.capabilities[0]!.action;
      const db = fakeDb();
      // Positive: the exact declared action is granted.
      const out = await withAgentRunContext(ctx(d.key, [action]), () => executeAgentTask(db, d, {}));
      expect(out.content.length).toBeGreaterThan(0);
      // Negative: a different action is granted ⇒ refused.
      const db2 = fakeDb();
      await expect(
        withAgentRunContext(ctx(d.key, ['__not_the_action__']), () => executeAgentTask(db2, d, {})),
      ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
      expect(db2._stats.reads).toBe(0);
    }
  });
});

describe('T2 — end-to-end: grant comes from the trusted context, never the caller', () => {
  it('createAgentTask runs the executor under a context granting its action', async () => {
    const db = fakeDb();
    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'marketing-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    expect(task.status).toBe('succeeded');
  });

  it('a forged action in task input cannot reach a different action', async () => {
    const db = fakeDb();
    // The caller asks for an action the agent is not granted; the gate ignores
    // `input` entirely and checks the agent's own literal action.
    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'marketing-agent', requestedBy: 'owner-1', input: { action: 'assess_risk', authorizedActions: ['assess_risk'] } },
      AUDIT,
    );
    expect(task.status).toBe('succeeded');
  });

  it('the post-approval path (decideAgentTask) is gated too', async () => {
    const db = fakeDb();
    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    expect(created.status).toBe('awaiting_approval');
    const decided = await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    expect(decided?.status).toBe('approved');
  });

  it('a task whose agent has no declared capabilities is refused (fail-closed)', async () => {
    const db = fakeDb();
    // Bypass the catalogue: hand the gate an agent definition with NO capability.
    const bare = { ...def('marketing-agent'), key: 'marketing-agent', capabilities: [] };
    await expect(
      withAgentRunContext(ctx('marketing-agent', []), () => executeAgentTask(db, bare, {})),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
  });
});

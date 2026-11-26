import { describe, it, expect, vi } from 'vitest';
import type { DB } from '../../src/db/client.js';
import { aiExecutionSwitches } from '../../src/db/schema/ai-execution-switch.js';
import { openGlobalSwitchRow } from '../support/open-switch-row.js';

/**
 * AI-INTEG-P3-T1 — the trusted execution context bound by `createAgentTask` /
 * `decideAgentTask` in the REAL `agents.ts`.
 *
 * `executors.ts` is mocked (T1 explicitly does not touch it); the mock records
 * the run context and budget it observes at execution time, so these specs prove
 * the context is built from the STORED task row and the registry — never from
 * caller-supplied `input` — and that a per-run budget is bound for both the
 * direct and the post-approval execution paths.
 */
const captured: Array<{ taskId?: string; agentKey?: string; requestedBy?: string; roles?: string[]; hasBudget: boolean }> = [];

// Result the mocked executor returns; tests reassign it to drive the cost path.
let nextResult: { content: string; tokensInput: number; tokensOutput: number; cost?: string } = {
  content: '{"ok":true}',
  tokensInput: 1,
  tokensOutput: 1,
};
// When set, the mocked executor throws it (to exercise the failure path).
let nextError: Error | null = null;
// When set, the mocked executor awaits it before returning — lets a test hold
// one provider call in flight while a second caller races for the same task.
let executorGate: Promise<void> | null = null;

vi.mock('../../src/modules/ai/executors.js', async () => {
  const ctxMod = await import('../../src/lib/ai/agent-run-context.js');
  return {
    executeAgentTask: vi.fn(async () => {
      const ctx = ctxMod.getAgentRunContext();
      captured.push({
        taskId: ctx?.taskId,
        agentKey: ctx?.agentKey,
        requestedBy: ctx?.requestedBy,
        roles: ctx?.requesterRoles as string[] | undefined,
        hasBudget: Boolean(ctxMod.getAgentRunBudget()),
      });
      if (executorGate) await executorGate;
      if (nextError) throw nextError;
      return nextResult;
    }),
  };
});

const { createAgentTask, decideAgentTask, reconcileTaskCostFromLedger } = await import('../../src/modules/ai/agents.js');
const { AgentCostRecordingError, AgentRunBudgetExceededError } = await import('../../src/lib/ai/agent-run-context.js');
const { agentRegistry, agentTasks } = await import('../../src/db/schema/agents.js');
const { roles, userRoles } = await import('../../src/db/schema/auth.js');
const { auditLogs } = await import('../../src/db/schema/audit.js');
const { notifications } = await import('../../src/db/schema/messaging.js');
const { aiRequests } = await import('../../src/db/schema/ai.js');

type Row = Record<string, unknown>;
const TABLES = {
  agentRegistry,
  agentTasks,
  roles,
  userRoles,
  auditLogs,
  notifications,
  aiRequests,
  aiExecutionSwitches,
} as const;

/**
 * Minimal evaluator for the Drizzle SQL condition objects the code builds
 * (`eq(col, val)`, `and(...)`, `sql\`...\``). It walks the whole `queryChunks`
 * tree depth-first, collecting column references and bound parameters in
 * encounter order, then pairs them (each `eq` contributes exactly one column and
 * one param). A fragment with no columns is treated as an opaque always-true
 * predicate. This lets the fake honour a CONDITIONAL UPDATE (the atomic claim),
 * which is the behaviour under test.
 */
function matches(cond: unknown, row: Row): boolean {
  if (cond == null) return true;
  type Tok = { t: 'col'; v: string } | { t: 'param'; v: unknown } | { t: 'frag'; v: string };
  const tokens: Tok[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    // A primitive bound into a raw `sql` template arrives either as a boxed
    // String/Number (possibly from another realm, so `instanceof` is unreliable)
    // or as a bare primitive; `eq()`'s own placeholder arrives as a `Param`.
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
  // Pair each column reference with the next bound value. If the SQL between
  // them extracts a JSONB key (`->>'key'`), compare against that key of the
  // column's object value instead of the column itself.
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

function fakeDb() {
  const store: Record<string, Row[]> = {
    agentRegistry: [],
    agentTasks: [],
    roles: [{ id: 'r-merchant', name: 'MERCHANT' }],
    userRoles: [{ userId: 'owner-1', roleId: 'r-merchant' }],
    auditLogs: [],
    notifications: [],
    aiRequests: [],
    aiExecutionSwitches: [openGlobalSwitchRow()],
  };
  const nameOf = new Map<unknown, string>(Object.entries(TABLES).map(([n, t]) => [t, n]));
  const tableName = (t: unknown): string => nameOf.get(t) ?? 'agentTasks';
  // Test-only seam: fires ONCE after the next `agentTasks` read, so a test can
  // interleave a concurrent writer between a caller's read and its fenced write.
  const hooks: { onTaskSelect?: () => void } = {};

  const makeDb = () => ({
    select() {
      const b = {
        _table: 'agentTasks' as string,
        _cond: undefined as unknown,
        from(t: unknown) { b._table = tableName(t); return b; },
        innerJoin() { return b; },
        where(cond: unknown) { b._cond = cond; return b; },
        orderBy() { return b; },
        limit() { return b; },
        for() { return b; },
        then(resolve: (rows: Row[]) => unknown) {
          // Simulate the `userRoles ⨝ roles` projection used by `rolesOfUser`.
          if (b._table === 'userRoles') return Promise.resolve(store.roles.map((r) => ({ ...r }))).then(resolve);
          const rows = store[b._table];
          const out = b._cond ? rows.filter((r) => matches(b._cond, r)) : rows;
          const snapshot = out.map((r) => ({ ...r }));
          if (b._table === 'agentTasks' && hooks.onTaskSelect) {
            const hook = hooks.onTaskSelect;
            hooks.onTaskSelect = undefined;
            hook();
          }
          return Promise.resolve(snapshot).then(resolve);
        },
      };
      return b;
    },
    insert(t: unknown) {
      const table = tableName(t);
      const values = (v: Row | Row[]) => {
        store[table].push(...(Array.isArray(v) ? v : [v]));
        return Object.assign(Promise.resolve(undefined), { onConflictDoNothing: () => Promise.resolve(undefined) });
      };
      return { values };
    },
    update(t: unknown) {
      const table = tableName(t);
      const b = {
        _patch: {} as Row,
        _cond: undefined as unknown,
        _matched: [] as Row[],
        set(patch: Row) { b._patch = patch; return b; },
        where(cond: unknown) {
          b._cond = cond;
          // Capture the rows that matched BEFORE mutating, so `.returning()`
          // reports them even though the mutation changed the columns the
          // condition tested (e.g. status awaiting_approval → running).
          b._matched = store[table].filter((r) => matches(b._cond, r));
          for (const row of b._matched) Object.assign(row, b._patch);
          return b;
        },
        returning() {
          return Promise.resolve(b._matched.map((r) => ({ ...r })));
        },
        // Awaited without `.returning()` (e.g. the locked terminal UPDATE).
        then(resolve: (v: undefined) => unknown) { return Promise.resolve(undefined).then(resolve); },
      };
      return b;
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(makeDb()); },
    _store: store,
    _hooks: hooks,
  });
  const db = makeDb();
  return db as unknown as DB & { _store: typeof store; _hooks: typeof hooks };
}

const AUDIT = { actorId: 'actor', ipAddress: null, userAgent: null };

describe('createAgentTask — trusted context', () => {
  it('binds the STORED task id and agent key, ignoring forged input', async () => {
    captured.length = 0;
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: { taskId: 'forged', agentKey: 'forged', __userId: 'attacker' } },
      AUDIT,
    );

    expect(captured).toHaveLength(1);
    // taskId/agentKey come from the stored row + registry, never from input.
    expect(captured[0].taskId).toBe(task.id);
    expect(captured[0].taskId).not.toBe('forged');
    expect(captured[0].agentKey).toBe('product-agent');
    expect(captured[0].requestedBy).toBe('owner-1');
    expect(captured[0].hasBudget).toBe(true);
  });

  it('resolves requester roles from the database, not from the caller', async () => {
    captured.length = 0;
    const db = fakeDb();

    await createAgentTask(
      db,
      ['ADMIN'], // passed as the *caller* role list
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );

    // The run context carries the DB-resolved roles (MERCHANT), not the caller's.
    expect(captured[0].roles).toEqual(['MERCHANT']);
  });
});

describe('decideAgentTask — trusted context after approval', () => {
  it('binds the context on the post-approval execution path too', async () => {
    captured.length = 0;
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    expect(created.status).toBe('awaiting_approval');
    expect(captured).toHaveLength(0); // not executed yet

    await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);

    expect(captured).toHaveLength(1);
    expect(captured[0].taskId).toBe(created.id);
    expect(captured[0].agentKey).toBe('risk-agent');
    expect(captured[0].requestedBy).toBe('owner-1'); // owner, not the approver
    expect(captured[0].hasBudget).toBe(true);
  });
});

// ───────────────────────── AI-INTEG-P3-T1.1 (F1 — cost persistence) ─────────────────────────

describe('agent_tasks.cost — persisted, accumulated, never reset (F1)', () => {
  it('persists the measured cost from the executor on success', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001234000' };
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );

    expect(task.status).toBe('succeeded');
    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.cost).toBe('0.0001234000');
  });

  it('keeps the cost UNKNOWN (not a misleading zero) when the executor reports none', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1 }; // no cost
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );

    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.cost).toBeUndefined(); // left unset, NOT stored as '0'
    expect(task.cost).toBe('0'); // collapsed only at the API boundary
  });

  it('accumulates a post-approval cost onto a prior stored cost without resetting it', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0002' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    // A prior attempt already recorded some spend for this task.
    const row = db._store.agentTasks.find((t) => t.id === created.id)!;
    row.cost = '0.0010000000';

    await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);

    const after = db._store.agentTasks.find((t) => t.id === created.id)!;
    expect(after.cost).toBe('0.0012000000'); // 0.001 + 0.0002, exactly
  });

  it('persists the measured cost on the FAILURE path when cost recording failed', async () => {
    captured.length = 0;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0009' };
    nextError = new AgentCostRecordingError('0.0009', 'ledger down');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    expect(task.status).toBe('failed');
    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.cost).toBe('0.0009'); // spend is real (post-provider) — not lost
  });

  it('does NOT write a cost on failure when the cost is genuinely unknown', async () => {
    captured.length = 0;
    nextResult = { content: '', tokensInput: 0, tokensOutput: 0 };
    nextError = new Error('executor blew up before any provider call');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.cost).toBeUndefined();
  });
});

// ───────────────────────── AI-INTEG-P3-G3 (OVER_BUDGET cost propagation) ─────────────────────────
// When a completed provider call pushes the run over its ceiling, `runAIFeature`
// records the measured cost on `ai_requests` (status OVER_BUDGET) and throws
// `AgentRunBudgetExceededError` carrying that call's cost (`actualCostUsd`). These
// specs prove the task-termination path persists the SAME call cost onto
// `agent_tasks.cost` — exactly once, without re-adding a prior cost, and without
// inventing a cost for a pre-flight refusal that spent nothing.
describe('G3 — OVER_BUDGET cost propagates to agent_tasks.cost', () => {
  const overBudget = (callCostUsd: string, spentUsd = callCostUsd) =>
    new AgentRunBudgetExceededError('1.0000000000', spentUsd, callCostUsd);

  it('createAgentTask: persists the measured call cost on the direct (no-approval) path', async () => {
    captured.length = 0;
    nextError = overBudget('0.5000000000');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    expect(task.status).toBe('failed'); // refusal meaning preserved — never succeeded
    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.status).toBe('failed');
    expect(row.cost).toBe('0.5000000000'); // the exact call cost, not lost
  });

  it('createAgentTask: does NOT invent a cost for a PRE-FLIGHT refusal (no call happened)', async () => {
    captured.length = 0;
    // Pre-flight refusal: no `actualCostUsd` (the provider was never called).
    nextError = new AgentRunBudgetExceededError('1.0000000000', '1.0000000000');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.status).toBe('failed');
    expect(row.cost).toBeUndefined(); // nothing spent ⇒ no misleading zero
  });

  it('decideAgentTask: accumulates the call cost onto a prior stored cost (no double count)', async () => {
    captured.length = 0;
    nextError = null;
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    const row = db._store.agentTasks.find((t) => t.id === created.id)!;
    row.cost = '0.0010000000'; // a prior attempt already recorded spend
    // The run's cumulative spend (0.0015) is greater than the call's own cost
    // (0.0005): using `spentUsd` here would double-count to 0.0025.
    nextError = overBudget('0.0005000000', '0.0015000000');

    const done = await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    nextError = null;

    expect(done.status).toBe('failed'); // over-budget stays a failure, not a success
    const after = db._store.agentTasks.find((t) => t.id === created.id)!;
    expect(after.cost).toBe('0.0015000000'); // 0.001 prior + 0.0005 call — the call cost only
  });

  it('decideAgentTask: leaves the cost untouched on a pre-flight refusal', async () => {
    captured.length = 0;
    nextError = null;
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    const row = db._store.agentTasks.find((t) => t.id === created.id)!;
    row.cost = '0.0020000000';
    nextError = new AgentRunBudgetExceededError('0.0001000000', '0.0020000000'); // no actualCostUsd

    await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    nextError = null;

    const after = db._store.agentTasks.find((t) => t.id === created.id)!;
    expect(after.cost).toBe('0.0020000000'); // unchanged — nothing spent, nothing invented
  });

  it('does not change AgentCostRecordingError behaviour (still persists its cost)', async () => {
    captured.length = 0;
    nextError = new AgentCostRecordingError('0.0009', 'ledger down');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    expect(task.status).toBe('failed');
    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.cost).toBe('0.0009'); // unchanged representation (not re-normalised)
  });

  it('rejects a malformed call cost instead of writing a misleading value', async () => {
    captured.length = 0;
    nextError = new AgentRunBudgetExceededError('1.0000000000', 'NaN', 'not-a-number');
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );
    nextError = null;

    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.status).toBe('failed');
    expect(row.cost).toBeUndefined(); // malformed ⇒ left untouched, never a bogus number
  });
});


// ───────────────────────── AI-INTEG-P3-T1.3 (atomic claim & cost) ─────────────────────────

/** A deferred the mock executor awaits, so two calls can be held in flight at once. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('decideAgentTask — atomic claim (AI-INTEG-P3-T1.3)', () => {
  it('lets only ONE of two concurrent approvals win the claim; the loser runs nothing', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    captured.length = 0; // ignore the create-time (non-)execution

    // Hold the winner's provider call open so the loser provably races it.
    const gate = deferred();
    executorGate = gate.promise;

    const first = decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    // The loser is a SECOND approver on the SAME task.
    const second = decideAgentTask(db, created.id, 'approver-3', 'APPROVE', null, AUDIT);
    gate.resolve();

    const results = await Promise.allSettled([first, second]);
    executorGate = null;

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1); // exactly one claim succeeded
    expect(rejected).toHaveLength(1); // the other was refused
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    expect(captured).toHaveLength(1); // the provider was called EXACTLY once
  });

  it('refuses a second approval after the task already completed (no provider call)', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    captured.length = 0;

    await expect(decideAgentTask(db, created.id, 'approver-3', 'APPROVE', null, AUDIT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(captured).toHaveLength(0); // the refused call never reached the provider
  });

  it('does not hold a row lock across the provider call (claim is a lone statement)', async () => {
    // If a transaction/lock were open across the provider call, the mock
    // executor (which awaits a gate) would deadlock. A successful run proves the
    // lock is NOT held during execution.
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    const gate = deferred();
    executorGate = gate.promise;
    const p = decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    gate.resolve();
    const done = await p;
    executorGate = null;
    expect(done.status).toBe('approved');
  });
  it('refuses a REJECT that loses the race to an APPROVE (no misleading success)', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    await decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    captured.length = 0;

    await expect(decideAgentTask(db, created.id, 'approver-3', 'REJECT', 'too late', AUDIT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const row = db._store.agentTasks.find((t) => t.id === created.id)!;
    expect(row.status).toBe('approved'); // the reject did NOT overwrite the outcome
  });
});

describe('cost accumulation reads the CURRENT row, not the stale snapshot (T1.3)', () => {
  it('does not lose a cost written by another writer during the provider call', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0002' };
    const db = fakeDb();

    const created = await createAgentTask(
      db,
      ['ADMIN'],
      'owner-1',
      { agentKey: 'risk-agent', requestedBy: 'owner-1', input: { action: 'assess_risk' } },
      AUDIT,
    );
    const row = db._store.agentTasks.find((t) => t.id === created.id)!;
    row.cost = '0.0010000000';

    // While the winner is inside the provider call, a concurrent writer commits
    // more spend on the SAME task. The stale `getTask` snapshot (0.001) must NOT
    // be what we accumulate onto; the locked re-read must pick up 0.005.
    const gate = deferred();
    executorGate = gate.promise;
    const p = decideAgentTask(db, created.id, 'approver-2', 'APPROVE', null, AUDIT);
    row.cost = '0.0050000000';
    gate.resolve();
    const done = await p;
    executorGate = null;

    expect(done.status).toBe('approved');
    expect(done.cost).toBe('0.0052000000'); // 0.005 (current) + 0.0002, NOT 0.001 + 0.0002
  });
});

// ─────────────────── AI-INTEG-P3-T1.6 (terminal fencing & cost recovery) ───────────────────
// These specs exercise the REAL `agents.ts` against a fake DB. They prove the
// application-level guarantees (single-writer fence, evidence-only recovery).
// They do NOT prove real PostgreSQL concurrency: the fake DB runs single-threaded
// and simulates row locks, so atomicity under two live connections is UNVERIFIED.

function seedRunningTask(db: ReturnType<typeof fakeDb>, id: string, cost?: string): Row {
  const row: Row = { id, agentKey: 'risk-agent', requestedBy: 'owner-1', input: {}, status: 'running', tokensInput: 0, tokensOutput: 0 };
  if (cost !== undefined) row.cost = cost;
  db._store.agentTasks.push(row);
  return row;
}

describe('T1.6 — terminal fencing: a stale writer cannot touch a settled task', () => {
  it('recovery is fenced out when the task becomes terminal between read and write', async () => {
    captured.length = 0;
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-race');
    db._store.aiRequests.push({ id: 'req-1', status: 'SUCCESS', cost: '0.0004', metadata: { __agentTaskId: 'task-race' } });

    // A concurrent writer settles the task right after recovery's initial read.
    db._hooks.onTaskSelect = () => {
      row.status = 'approved';
      row.cost = '0.0099';
    };

    const result = await reconcileTaskCostFromLedger(db, 'task-race', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('fenced_out');
    expect(row.status).toBe('approved'); // the concurrent decision stands
    expect(row.cost).toBe('0.0099'); // the recovered cost was NOT applied
  });

  it('a terminal task is never reopened or re-costed by recovery', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-done', '0.002');
    row.status = 'succeeded';
    db._store.aiRequests.push({ id: 'req-x', status: 'SUCCESS', cost: '0.0005', metadata: { __agentTaskId: 'task-done' } });

    const result = await reconcileTaskCostFromLedger(db, 'task-done', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('not_running');
    expect(row.status).toBe('succeeded');
    expect(row.cost).toBe('0.002');
  });
});

describe('T1.6 — evidence-based cost recovery', () => {
  it('recovers the EXACT cost from a single clear ledger row and closes as failed', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-1');
    db._store.aiRequests.push({ id: 'req-1', status: 'SUCCESS', cost: '0.0007500000', metadata: { __agentTaskId: 'task-1' } });

    const result = await reconcileTaskCostFromLedger(db, 'task-1', AUDIT);

    expect(result).toMatchObject({ recovered: true, reason: 'recovered', costUsd: '0.0007500000' });
    expect(row.status).toBe('failed'); // never claims success — the result was not saved
    expect(row.cost).toBe('0.0007500000'); // exact ledger value, not an estimate
    expect((row.error as { message: string }).message).toContain('cost recovered from ai_requests');
  });

  it('is idempotent: a repeat recovery does NOT double the cost', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-2');
    db._store.aiRequests.push({ id: 'req-1', status: 'SUCCESS', cost: '0.0003000000', metadata: { __agentTaskId: 'task-2' } });

    const first = await reconcileTaskCostFromLedger(db, 'task-2', AUDIT);
    const second = await reconcileTaskCostFromLedger(db, 'task-2', AUDIT);

    expect(first.recovered).toBe(true);
    expect(second.recovered).toBe(false);
    expect(second.reason).toBe('not_running');
    expect(row.cost).toBe('0.0003000000'); // unchanged on the second pass
  });

  it('refuses to reconcile when several ledger rows make the attempt ambiguous', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-3');
    db._store.aiRequests.push({ id: 'req-1', status: 'SUCCESS', cost: '0.0001', metadata: { __agentTaskId: 'task-3' } });
    db._store.aiRequests.push({ id: 'req-2', status: 'SUCCESS', cost: '0.0002', metadata: { __agentTaskId: 'task-3' } });

    const result = await reconcileTaskCostFromLedger(db, 'task-3', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('ambiguous_ledger_rows');
    expect(row.status).toBe('running'); // left untouched
    expect(row.cost).toBeUndefined(); // no sum, no guess
  });

  it('does NOT close or zero the cost when there is no provider evidence', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-4');

    const result = await reconcileTaskCostFromLedger(db, 'task-4', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('no_ledger_row');
    expect(row.status).toBe('running'); // absence of evidence is NOT a timeout
    expect(row.cost).toBeUndefined(); // absence of a row is NOT zero cost
  });

  it('ignores a non-billable (failed) ledger row', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-5');
    db._store.aiRequests.push({ id: 'req-1', status: 'FAILED', cost: '0', metadata: { __agentTaskId: 'task-5' } });

    const result = await reconcileTaskCostFromLedger(db, 'task-5', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('ledger_row_not_billable');
    expect(row.status).toBe('running');
  });

  it('never calls the provider during recovery', async () => {
    captured.length = 0;
    const db = fakeDb();
    const row = seedRunningTask(db, 'task-6');
    db._store.aiRequests.push({ id: 'req-1', status: 'SUCCESS', cost: '0.0001', metadata: { __agentTaskId: 'task-6' } });

    await reconcileTaskCostFromLedger(db, 'task-6', AUDIT);

    expect(captured).toHaveLength(0); // the executor (provider) was never invoked
    expect(row.status).toBe('failed');
  });

  it('only recovers the row whose trusted ledger id matches (no cross-task leakage)', async () => {
    const db = fakeDb();
    const rowA = seedRunningTask(db, 'task-A');
    const rowB = seedRunningTask(db, 'task-B');
    db._store.aiRequests.push({ id: 'req-a', status: 'SUCCESS', cost: '0.0001', metadata: { __agentTaskId: 'task-A' } });
    db._store.aiRequests.push({ id: 'req-b', status: 'SUCCESS', cost: '0.0009', metadata: { __agentTaskId: 'task-B' } });

    const result = await reconcileTaskCostFromLedger(db, 'task-A', AUDIT);

    expect(result.costUsd).toBe('0.0001000000');
    expect(rowA.cost).toBe('0.0001000000');
    expect(rowB.status).toBe('running'); // the other task is untouched
    expect(rowB.cost).toBeUndefined();
  });
});

// ─────────────────── AI-INTEG-P3-G2 (trusted reconciliation evidence) ───────────────────
// A caller with `AI_USE` can POST arbitrary `metadata` to `/api/ai/run`. Before
// G2 that metadata (including `taskId`) reached `ai_requests` verbatim, so a
// forged `taskId` looked like reconciliation evidence for someone else's task.
// Reconciliation now keys on the SERVER-OWNED `__agentTaskId`, which is written
// only from a trusted run context and stripped from every caller object.
describe('G2 — reconciliation keys on server-owned evidence, not caller metadata', () => {
  it('abstains when the only matching row carries a forged (untrusted) taskId', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'victim-task');
    // Exactly what a forged `/api/ai/run` request would leave behind: a plain
    // `taskId`, with NO server-owned `__agentTaskId`.
    db._store.aiRequests.push({ id: 'req-forged', status: 'SUCCESS', cost: '9.99', metadata: { taskId: 'victim-task' } });

    const result = await reconcileTaskCostFromLedger(db, 'victim-task', AUDIT);

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('no_ledger_row'); // forged row is NOT evidence
    expect(row.status).toBe('running'); // victim task untouched
    expect(row.cost).toBeUndefined(); // no attacker-chosen cost applied
  });

  it('recovers only from the server-owned ledger id when both keys are present', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'real-task');
    // A forged row (plain taskId) must not be counted; only the trusted one is.
    db._store.aiRequests.push({ id: 'req-forged', status: 'SUCCESS', cost: '9.99', metadata: { taskId: 'real-task' } });
    db._store.aiRequests.push({ id: 'req-real', status: 'SUCCESS', cost: '0.0002000000', metadata: { __agentTaskId: 'real-task' } });

    const result = await reconcileTaskCostFromLedger(db, 'real-task', AUDIT);

    expect(result).toMatchObject({ recovered: true, reason: 'recovered', costUsd: '0.0002000000' });
    expect(row.cost).toBe('0.0002000000'); // the trusted row, not the forged one
  });

  it('abstains (no cost recovered) when forged and trusted rows are both present', async () => {
    const db = fakeDb();
    const row = seedRunningTask(db, 'mixed-task');
    db._store.aiRequests.push({ id: 'req-forged', status: 'SUCCESS', cost: '9.99', metadata: { taskId: 'mixed-task' } });
    db._store.aiRequests.push({ id: 'req-t1', status: 'SUCCESS', cost: '0.0001', metadata: { __agentTaskId: 'mixed-task' } });
    db._store.aiRequests.push({ id: 'req-t2', status: 'SUCCESS', cost: '0.0002', metadata: { __agentTaskId: 'mixed-task' } });

    const result = await reconcileTaskCostFromLedger(db, 'mixed-task', AUDIT);

    // Two trusted rows ⇒ ambiguous: abstain rather than guess or sum.
    expect(result.recovered).toBe(false);
    expect(result.reason).toBe('ambiguous_ledger_rows');
    expect(row.status).toBe('running');
    expect(row.cost).toBeUndefined();
  });

  it('never calls the provider while abstaining on forged evidence', async () => {
    captured.length = 0;
    const db = fakeDb();
    seedRunningTask(db, 'victim-task');
    db._store.aiRequests.push({ id: 'req-forged', status: 'SUCCESS', cost: '9.99', metadata: { taskId: 'victim-task' } });

    await reconcileTaskCostFromLedger(db, 'victim-task', AUDIT);

    expect(captured).toHaveLength(0); // no provider call during reconciliation
  });
});

describe('T1.6 — non-step task paths keep their prior behaviour', () => {
  it('a directly-created task still succeeds and records its cost', async () => {
    captured.length = 0;
    nextError = null;
    nextResult = { content: '{"ok":true}', tokensInput: 1, tokensOutput: 1, cost: '0.0001234000' };
    const db = fakeDb();

    const task = await createAgentTask(
      db,
      ['MERCHANT'],
      'owner-1',
      { agentKey: 'product-agent', requestedBy: 'owner-1', input: {} },
      AUDIT,
    );

    expect(task.status).toBe('succeeded');
    expect(captured).toHaveLength(1);
    const row = db._store.agentTasks.find((t) => t.id === task.id)!;
    expect(row.status).toBe('succeeded');
    expect(row.cost).toBe('0.0001234000');
  });
});


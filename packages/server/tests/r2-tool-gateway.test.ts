import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../src/db/client.js';
import {
  allTools,
  declaredToolIds,
  findTool,
  isRegisteredTool,
  isUnboundTool,
  registeredToolIds,
  toolGrantForAgent,
  unboundToolsForAgent,
  UNBOUND_DECLARED_TOOLS,
  FUTURE_TOOL_CONTRACTS,
  rolesAllowPlatformScope,
  rolesHoldPermission,
  PLATFORM_METRICS,
  PLATFORM_READ_ORDERS,
  RISK_READ_OVERVIEW,
  DISPUTES_READ_SUMMARY,
  COMPLIANCE_READ_PLATFORM,
  MARKET_READ_OVERVIEW,
  MARKET_READ_OWN,
  ADS_READ_CAMPAIGNS,
  DEVELOPMENT_READ_PLATFORM,
  SUPPLIER_READ_OWN,
  MERCHANT_READ_OWN,
  SALES_READ_ORDERS_OWN,
  SALES_READ_ORDERS_PLATFORM,
  SALES_READ_MARKET_TOTALS,
  PRODUCT_READ_PUBLIC,
  PRODUCT_READ_OWNED,
  PRODUCT_READ_PLATFORM,
  MARKETING_READ_CATALOGUE_OWNED,
  MARKETING_READ_CATALOGUE_PLATFORM,
  MARKETING_READ_VIDEOS_OWNED,
  FINANCE_READ_LEDGER,
  PAYMENTS_READ_SETTLEMENTS,
  OPERATIONS_READ_HEALTH,
} from '../src/lib/ai/tool-registry.js';
import {
  boundHandlerIds,
  getToolHandler,
} from '../src/lib/ai/tool-handlers.js';
import {
  IdempotencyCache,
  invokeTool,
  ToolGatewayError,
} from '../src/lib/ai/tool-gateway.js';
import {
  getAgentRunContext,
  withAgentRunContext,
  type AgentRunContext,
} from '../src/lib/ai/agent-run-context.js';
import { setAiExecutionEnabled, isAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import { db as realDb } from '../src/db/client.js';
import { aiExecutionSwitches } from '../src/db/schema/ai-execution-switch.js';
import {
  assertTableAccess,
  HARD_DENY_TABLES,
  PLATFORM_INFRA_TABLES,
} from '../src/modules/ai/agent-scope.js';
import { AGENT_CATALOGUE } from '../src/modules/ai/catalogue.js';
import { ROLE_PERMISSIONS } from '@wasit/shared';

/**
 * R2 — Tool Gateway foundation.
 *
 * Exercises the REAL registry, handlers and gateway against an in-memory fake
 * `DB` (no Postgres, no network, no commercial write). Every assertion is about
 * the gateway's own contract: what it refuses, in what order, and what it audits.
 */

type Row = Record<string, unknown>;

const TABLES = [
  'products', 'categories', 'product_variants', 'product_images', 'inventory_items',
  'suppliers', 'merchants', 'companies', 'orders', 'order_items',
  'users', 'daily_kpis', 'campaigns', 'ad_events', 'trust_scores',
  'risk_profiles', 'risk_events', 'disputes', 'dispute_messages', 'media_assets',
  'audit_logs', 'seller_entities',
];

type FakeDb = DB & {
  _store: Record<string, Row[]>;
  _stats: { fromCalls: string[]; auditRows: number };
};

function fakeDb(): FakeDb {
  const store: Record<string, Row[]> = {};
  for (const t of TABLES) store[t] = [];
  const stats = { fromCalls: [] as string[], auditRows: 0 };

  const builder = (table: string): unknown => {
    const b: Record<string, unknown> = {
      _table: table,
      from(t: unknown) {
        b._table = getTableName(t as never);
        // The kill switch is platform control data, not tool data: its read is
        // not a "table the handler touched" and must not be counted as one.
        if (b._table !== getTableName(aiExecutionSwitches as never)) stats.fromCalls.push(b._table as string);
        return b;
      },
      leftJoin(t: unknown) { stats.fromCalls.push(getTableName(t as never)); return b; },
      innerJoin(t: unknown) { stats.fromCalls.push(getTableName(t as never)); return b; },
      where() { return b; },
      groupBy() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(resolve: (v: Row[]) => unknown) {
        // The kill switch is an authority, not tool data: always read the REAL
        // row, so a fake table store can never fake an "enabled" state.
        if (b._table === getTableName(aiExecutionSwitches as never)) {
          return realDb.select().from(aiExecutionSwitches).then((rows) => resolve(rows as Row[]));
        }
        return Promise.resolve((store[b._table as string] ?? []).map((r) => ({ ...r }))).then(resolve);
      },
    };
    return b;
  };

  const db = {
    select() { return builder(''); },
    insert(t: unknown) {
      const table = getTableName(t as never);
      return {
        values(v: Row | Row[]) {
          (store[table] ??= []).push(...(Array.isArray(v) ? v : [v]));
          if (table === 'audit_logs') stats.auditRows += 1;
          return Object.assign(Promise.resolve(undefined), {
            onConflictDoNothing: () => Promise.resolve(undefined),
          });
        },
      };
    },
    update() { return { set() { return { where: () => Promise.resolve(undefined) }; } }; },
    delete() { return { where: () => Promise.resolve(undefined) }; },
    execute() { throw new Error('raw SQL is not available to a tool handler'); },
    transaction() { throw new Error('transactions are not available to a tool handler'); },
    query: {},
    _store: store,
    _stats: stats,
  };
  return db as unknown as FakeDb;
}

function ctx(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    taskId: 'task-r2-1',
    agentKey: 'analytics-agent',
    requestedBy: 'user-1',
    requesterRoles: ['MERCHANT'],
    authorizedActions: ['identify_leads'],
    allowedTools: [PLATFORM_METRICS, PLATFORM_READ_ORDERS, SALES_READ_ORDERS_OWN],
    ...over,
  } as AgentRunContext;
}

async function expectRefusal(
  db: DB,
  toolId: string,
  code: string,
  args: Record<string, unknown> = {},
): Promise<ToolGatewayError> {
  try {
    await invokeTool(db, toolId, args);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolGatewayError);
    const e = err as ToolGatewayError;
    expect(e.code, `expected ${code}, got ${e.code}: ${e.message}`).toBe(code);
    expect(e.toolId).toBe(toolId);
    return e;
  }
  throw new Error(`expected a refusal with ${code}, but the call succeeded`);
}

describe('R2 — registry: schema validation and structure', () => {
  it('registers every declared tool exactly once', () => {
    const ids = registeredToolIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps registered and unbound sets disjoint', () => {
    for (const id of UNBOUND_DECLARED_TOOLS) {
      expect(isRegisteredTool(id), id).toBe(false);
      expect(isUnboundTool(id), id).toBe(true);
    }
  });

  it('gives every tool a strict Zod schema that rejects unknown keys', () => {
    for (const tool of allTools()) {
      expect(tool.inputSchema, tool.id).toBeInstanceOf(z.ZodType);
      const result = tool.inputSchema.safeParse({ __unexpected__: true });
      expect(result.success, `${tool.id} accepted an unknown key`).toBe(false);
    }
  });

  it('accepts empty args where the schema allows them', () => {
    for (const tool of allTools()) {
      const result = tool.inputSchema.safeParse({});
      expect(typeof result.success, tool.id).toBe('boolean');
    }
  });

  it('declares only read effects — no write tool exists', () => {
    for (const tool of allTools()) expect(tool.effect).toBe('read');
  });

  it('marks every tool idempotent (all reads are repeatable)', () => {
    for (const tool of allTools()) expect(tool.idempotent, tool.id).toBe(true);
  });

  it('names at least one table per tool, all lower_snake_case', () => {
    for (const tool of allTools()) {
      expect(tool.tables.length, tool.id).toBeGreaterThan(0);
      for (const t of tool.tables) expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('never names a hard-denied or platform-infra table', () => {
    for (const tool of allTools()) {
      for (const t of tool.tables) {
        expect(HARD_DENY_TABLES.has(t), `${tool.id} -> ${t}`).toBe(false);
        expect(PLATFORM_INFRA_TABLES.has(t), `${tool.id} -> ${t}`).toBe(false);
      }
    }
  });

  it('binds a handler to every registered tool, and only to those', () => {
    expect(boundHandlerIds().sort()).toEqual(registeredToolIds().sort());
    for (const id of registeredToolIds()) expect(getToolHandler(id), id).toBeTypeOf('function');
  });
});

describe('R2 — unbound tools stay inert', () => {
  it('keeps finance, payments and operations unbound', () => {
    for (const id of [FINANCE_READ_LEDGER, PAYMENTS_READ_SETTLEMENTS, OPERATIONS_READ_HEALTH]) {
      expect(isRegisteredTool(id), id).toBe(false);
      expect(isUnboundTool(id), id).toBe(true);
      expect(getToolHandler(id), id).toBeUndefined();
    }
  });

  it('keeps the whole outreach surface unbound', () => {
    const outreach = UNBOUND_DECLARED_TOOLS.filter((id) => id.startsWith('outreach.') || id.startsWith('messaging.'));
    expect(outreach.length).toBeGreaterThan(0);
    for (const id of outreach) {
      expect(isRegisteredTool(id), id).toBe(false);
      expect(getToolHandler(id), id).toBeUndefined();
    }
  });

  it('publishes a future contract for each unbound financial/operations tool', () => {
    const contracts = FUTURE_TOOL_CONTRACTS.map((c) => c.id);
    expect(contracts).toContain(FINANCE_READ_LEDGER);
    expect(contracts).toContain(PAYMENTS_READ_SETTLEMENTS);
    expect(contracts).toContain(OPERATIONS_READ_HEALTH);
    for (const c of FUTURE_TOOL_CONTRACTS) {
      expect(isRegisteredTool(c.id), c.id).toBe(false);
      expect(c.outputContract.length, c.id).toBeGreaterThan(0);
      expect(c.blockedBy.length, c.id).toBeGreaterThan(0);
    }
  });

  it('gives the finance contract no path to the hard-denied ledger tables', () => {
    const finance = FUTURE_TOOL_CONTRACTS.find((c) => c.id === FINANCE_READ_LEDGER)!;
    expect(finance.blockedBy).toMatch(/transaction_ledger|pre-aggregat/i);
    expect(finance.effect).toBe('read');
  });

  it('derives an agent grant list that excludes every unbound tool', () => {
    for (const agent of AGENT_CATALOGUE) {
      for (const id of toolGrantForAgent(agent)) expect(isRegisteredTool(id), id).toBe(true);
      for (const id of unboundToolsForAgent(agent)) expect(isRegisteredTool(id), id).toBe(false);
    }
  });

  it('reports the settlement agent as having an unbound settlement tool', () => {
    // AI-AGENT-MERGE-01: the finance agent no longer declares the ledger tool
    // (the ledger is hard-denied, so accounting reads order aggregates instead).
    // The unbound-tool invariant is asserted on an agent that still declares one.
    const settlement = AGENT_CATALOGUE.find((a) => a.key === 'payment-settlement-agent')!;
    expect(unboundToolsForAgent(settlement)).toContain(PAYMENTS_READ_SETTLEMENTS);
    expect(toolGrantForAgent(settlement)).not.toContain(PAYMENTS_READ_SETTLEMENTS);
  });
});

describe('R2 — gateway refuses unknown and unbound tools', () => {
  it('refuses a tool id that is not declared anywhere', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx(), () => expectRefusal(db, 'totally.made_up', 'TOOL_NOT_REGISTERED'));
  });

  it('refuses an unbound declared tool with TOOL_NOT_BOUND', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ allowedTools: [FINANCE_READ_LEDGER], requesterRoles: ['SUPER_ADMIN'] }),
      () => expectRefusal(db, FINANCE_READ_LEDGER, 'TOOL_NOT_BOUND'),
    );
  });

  it('refuses every unbound tool, regardless of grants', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ allowedTools: UNBOUND_DECLARED_TOOLS, requesterRoles: ['SUPER_ADMIN'] }),
      async () => {
        for (const id of UNBOUND_DECLARED_TOOLS) {
          await expectRefusal(db, id, 'TOOL_NOT_BOUND');
        }
      },
    );
  });

  it('audits every refusal', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx(), () => expectRefusal(db, 'nope.tool', 'TOOL_NOT_REGISTERED'));
    expect(db._stats.auditRows).toBe(1);
    expect(db._store['audit_logs']![0]!.action).toBe('AI.TOOL_REFUSED');
  });
});

describe('R2 — gateway requires a trusted run context', () => {
  it('refuses when no run context is present', async () => {
    const db = fakeDb();
    await expectRefusal(db, PLATFORM_METRICS, 'NO_RUN_CONTEXT');
  });

  it('never takes identity from the args', async () => {
    const db = fakeDb();
    await expectRefusal(db, PLATFORM_METRICS, 'NO_RUN_CONTEXT', { agentKey: 'sales-agent' });
  });
});

describe('R2 — gateway enforces the A1 grant list', () => {
  it('refuses a tool the run was not granted', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ allowedTools: [] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'ACTION_NOT_AUTHORIZED'),
    );
  });

  it('refuses a tool granted to a different agent', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ agentKey: 'marketing-agent', allowedTools: [PLATFORM_READ_ORDERS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'ACTION_NOT_AUTHORIZED'),
    );
  });

  it('allows the granted tool', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPER_ADMIN'] }),
      async () => {
        const out = await invokeTool(db, PLATFORM_METRICS, {});
        expect(out.toolId).toBe(PLATFORM_METRICS);
        expect(out.replayed).toBe(false);
      },
    );
  });
});

describe('R2 — gateway enforces RBAC and platform scope', () => {
  it('refuses a requester without the tool permission', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['CUSTOMER'], allowedTools: [RISK_READ_OVERVIEW] }),
      () => expectRefusal(db, RISK_READ_OVERVIEW, 'PERMISSION_DENIED'),
    );
  });

  it('refuses a non-admin on a platform-scoped tool', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPPORT'], allowedTools: [SALES_READ_ORDERS_PLATFORM] }),
      () => expectRefusal(db, SALES_READ_ORDERS_PLATFORM, 'PLATFORM_SCOPE_DENIED'),
    );
  });

  it('admits an admin on a platform-scoped tool', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['ADMIN'], allowedTools: [SALES_READ_ORDERS_PLATFORM] }),
      async () => {
        const out = await invokeTool(db, SALES_READ_ORDERS_PLATFORM, {});
        expect(out.data.scope).toBe('platform');
      },
    );
  });

  it('exposes the RBAC helpers correctly', () => {
    expect(rolesAllowPlatformScope(['ADMIN'])).toBe(true);
    expect(rolesAllowPlatformScope(['MERCHANT'])).toBe(false);
    expect(rolesHoldPermission(['ADMIN'], 'anything:at:all', {})).toBe(true);
    expect(
      rolesHoldPermission(['MERCHANT'], 'ai:use', ROLE_PERMISSIONS as unknown as Record<string, ReadonlySet<string>>),
    ).toBe(true);
  });
});

describe('R2 — gateway validates input with Zod', () => {
  it('refuses an arg that violates the schema', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPER_ADMIN'], allowedTools: [PLATFORM_METRICS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'INVALID_INPUT', { limit: 9999 }),
    );
  });

  it('refuses an unknown arg key (strict schema)', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPER_ADMIN'], allowedTools: [PLATFORM_METRICS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'INVALID_INPUT', { sneaky: true }),
    );
  });

  it('never reaches the handler on invalid input', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPER_ADMIN'], allowedTools: [PLATFORM_METRICS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'INVALID_INPUT', { limit: -1 }),
    );
    expect(db._stats.fromCalls).toHaveLength(0);
  });
});

describe('R2 — gateway enforces A2 data scope', () => {
  it('refuses a tool whose tables fall outside the agent contract', async () => {
    const db = fakeDb();
    // `support-agent` may read threads/messages/users — not the platform KPI set.
    await withAgentRunContext(
      ctx({ agentKey: 'support-agent', requesterRoles: ['SUPER_ADMIN'], allowedTools: [PLATFORM_METRICS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'SCOPE_DENIED'),
    );
  });

  it('never touches the database when scope is refused', async () => {
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ agentKey: 'support-agent', requesterRoles: ['SUPER_ADMIN'], allowedTools: [PLATFORM_METRICS] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'SCOPE_DENIED'),
    );
    expect(db._stats.fromCalls).toHaveLength(0);
  });

  it('refuses a tool whose declared table is hard-denied, by construction', () => {
    for (const tool of allTools()) {
      for (const t of tool.tables) expect(HARD_DENY_TABLES.has(t)).toBe(false);
    }
  });
});

describe('R2 — gateway enforces the A1 kill switch', () => {
  afterEach(async () => {
    await setAiExecutionEnabled(realDb, null);
  });

  it('refuses every tool while the switch is off', async () => {
    await setAiExecutionEnabled(realDb, false);
    expect(await isAiExecutionEnabled(realDb)).toBe(false);
    const db = fakeDb();
    await withAgentRunContext(
      ctx({ requesterRoles: ['SUPER_ADMIN'] }),
      () => expectRefusal(db, PLATFORM_METRICS, 'AI_EXECUTION_DISABLED'),
    );
  });

  it('refuses before any identity or data work', async () => {
    await setAiExecutionEnabled(realDb, false);
    const db = fakeDb();
    await withAgentRunContext(ctx({ allowedTools: [] }), () =>
      expectRefusal(db, PLATFORM_METRICS, 'AI_EXECUTION_DISABLED'),
    );
    expect(db._stats.fromCalls).toHaveLength(0);
  });

  it('resumes when the switch is turned back on', async () => {
    await setAiExecutionEnabled(realDb, true);
    const db = fakeDb();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      const out = await invokeTool(db, PLATFORM_METRICS, {});
      expect(out.toolId).toBe(PLATFORM_METRICS);
    });
  });
});

describe('R2 — idempotency', () => {
  it('replays a cached result for the same key without re-running the handler', async () => {
    const db = fakeDb();
    const cache = new IdempotencyCache();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      const first = await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
      expect(first.replayed).toBe(false);
      const readsAfterFirst = db._stats.fromCalls.length;

      const second = await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
      expect(second.replayed).toBe(true);
      expect(second.data).toEqual(first.data);
      expect(db._stats.fromCalls.length).toBe(readsAfterFirst);
    });
  });

  it('does not cache when no key is supplied', async () => {
    const db = fakeDb();
    const cache = new IdempotencyCache();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      await invokeTool(db, PLATFORM_METRICS, {}, { cache });
      const second = await invokeTool(db, PLATFORM_METRICS, {}, { cache });
      expect(second.replayed).toBe(false);
      expect(cache.size).toBe(0);
    });
  });

  it('keys are scoped per agent and task, so two runs never share a replay', async () => {
    const db = fakeDb();
    const cache = new IdempotencyCache();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
    });
    await withAgentRunContext(
      ctx({ taskId: 'task-r2-2', requesterRoles: ['SUPER_ADMIN'] }),
      async () => {
        const out = await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
        expect(out.replayed).toBe(false);
      },
    );
  });

  it('expires an entry after its TTL', async () => {
    const cache = new IdempotencyCache(1);
    cache.set('k', { v: 1 });
    expect(cache.get('k')).toEqual({ v: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get('k')).toBeUndefined();
  });

  it('bounds the cache so a hostile key space cannot grow it', () => {
    const cache = new IdempotencyCache(60_000, 3);
    for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, { i });
    expect(cache.size).toBe(3);
  });

  it('audits a replay as AI.TOOL_REPLAYED', async () => {
    const db = fakeDb();
    const cache = new IdempotencyCache();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
      await invokeTool(db, PLATFORM_METRICS, {}, { idempotencyKey: 'k1', cache });
    });
    const actions = db._store['audit_logs']!.map((r) => r.action);
    expect(actions).toContain('AI.TOOL_EXECUTED');
    expect(actions).toContain('AI.TOOL_REPLAYED');
  });
});

describe('R2 — audit logging', () => {
  it('audits a successful execution with the tool, agent and task', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      await invokeTool(db, PLATFORM_METRICS, {});
    });
    const row = db._store['audit_logs']!.find((r) => r.action === 'AI.TOOL_EXECUTED')!;
    expect(row.entityType).toBe('TOOL');
    expect(row.entityId).toBe(PLATFORM_METRICS);
    expect(row.actorId).toBe('user-1');
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.agentKey).toBe('analytics-agent');
    expect(meta.taskId).toBe('task-r2-1');
    expect(meta.effect).toBe('read');
  });

  it('audits a refusal with its stable code', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx({ allowedTools: [] }), () =>
      expectRefusal(db, PLATFORM_METRICS, 'ACTION_NOT_AUTHORIZED'),
    );
    const row = db._store['audit_logs']![0]!;
    expect(row.action).toBe('AI.TOOL_REFUSED');
    expect((row.metadata as Record<string, unknown>).code).toBe('ACTION_NOT_AUTHORIZED');
  });

  it('records bounded args in the audit trail and rejects over-long ones', async () => {
    const db = fakeDb();
    const atCap = 'x'.repeat(64);
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'], allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
      expectRefusal(db, PRODUCT_READ_PUBLIC, 'SCOPE_DENIED', { productId: atCap }),
    );
    const meta = db._store['audit_logs']![0]!.metadata as { args: Record<string, string> };
    expect(meta.args.productId).toHaveLength(64);

    // No tool schema admits a value longer than the redaction cap, so the
    // truncation path is defence in depth rather than the first line.
    for (const tool of allTools()) {
      const ok = tool.inputSchema.safeParse({ productId: 'x'.repeat(200) });
      expect(ok.success, tool.id).toBe(false);
    }
  });

  it('audits a handler failure as AI.TOOL_FAILED', async () => {
    const db = fakeDb();
    // The authority read must succeed (the switch is checked first); the
    // handler's own read is what breaks.
    let selects = 0;
    const failing = {
      ...db,
      select(...args: unknown[]) {
        selects += 1;
        if (selects > 1) throw new Error('boom');
        return (db.select as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as DB;
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      await expect(invokeTool(failing, PLATFORM_READ_ORDERS, {})).rejects.toBeInstanceOf(ToolGatewayError);
    });
    expect(db._store['audit_logs']!.some((r) => r.action === 'AI.TOOL_FAILED')).toBe(true);
  });
});

describe('R2 — HARD_DENY and raw SQL', () => {
  it('refuses every hard-denied table to every agent, including an admin run', async () => {
    const db = fakeDb();
    const denied = [...HARD_DENY_TABLES].slice(0, 12);
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      for (const table of denied) {
        expect(() => assertTableAccess(getAgentRunContext()!, table, 'read'), table).toThrow();
      }
    });
  });

  it('has no registered tool whose declared tables intersect HARD_DENY', () => {
    const denied = new Set([...HARD_DENY_TABLES]);
    for (const tool of allTools()) {
      for (const t of tool.tables) expect(denied.has(t), `${tool.id} -> ${t}`).toBe(false);
    }
  });

  it('refuses a write to a hard-denied table from inside an agent run', async () => {
    await withAgentRunContext(ctx({ requesterRoles: ['SUPER_ADMIN'] }), async () => {
      expect(() => assertTableAccess(getAgentRunContext()!, 'transaction_ledger', 'write')).toThrow();
      expect(() => assertTableAccess(getAgentRunContext()!, 'payouts', 'write')).toThrow();
    });
  });

  it('gives no handler access to raw SQL or a transaction', async () => {
    const db = fakeDb();
    // The fake throws on `execute`/`transaction`, so a handler that used either
    // would fail the call. Run every bound tool with full authority and assert
    // none of them raised that error.
    await withAgentRunContext(
      ctx({
        agentKey: 'analytics-agent',
        requesterRoles: ['SUPER_ADMIN'],
        allowedTools: registeredToolIds(),
      }),
      async () => {
        for (const tool of allTools()) {
          try {
            await invokeTool(db, tool.id, {});
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            expect(message, tool.id).not.toMatch(/raw SQL|transactions are not available/);
          }
        }
      },
    );
  });
});

describe('R2 — no execution path bypasses the gateway', () => {
  it('exposes every handler only through the gateway entry point', () => {
    // `getToolHandler` is a lookup, not an execution path: every handler is
    // only reachable through `invokeTool`, which is the exported entry point.
    for (const id of boundHandlerIds()) {
      expect(getToolHandler(id), id).toBeTypeOf('function');
    }
    expect(boundHandlerIds().length).toBe(registeredToolIds().length);
  });

  it('has no handler for any unbound or unknown id', () => {
    for (const id of UNBOUND_DECLARED_TOOLS) expect(getToolHandler(id)).toBeUndefined();
    expect(getToolHandler('made.up.tool')).toBeUndefined();
  });

  it('declares every registered tool in the catalogue tool space', () => {
    const declared = new Set(declaredToolIds());
    for (const id of registeredToolIds()) expect(declared.has(id), id).toBe(true);
  });

  it('refuses before running any handler when the run is not granted the tool', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx({ allowedTools: [] }), () =>
      expectRefusal(db, PLATFORM_METRICS, 'ACTION_NOT_AUTHORIZED'),
    );
    expect(db._stats.fromCalls).toHaveLength(0);
    expect(db._store['audit_logs']!.filter((r) => r.action === 'AI.TOOL_EXECUTED')).toHaveLength(0);
  });
});

describe('R2 — every registered tool is reachable only with full authority', () => {
  it('each registered tool refuses with no run context', async () => {
    const db = fakeDb();
    for (const tool of allTools()) {
      await expectRefusal(db, tool.id, 'NO_RUN_CONTEXT');
    }
  });

  it('each registered tool refuses when the run lacks the grant', async () => {
    const db = fakeDb();
    await withAgentRunContext(ctx({ allowedTools: [], requesterRoles: ['SUPER_ADMIN'] }), async () => {
      for (const tool of allTools()) {
        await expectRefusal(db, tool.id, 'ACTION_NOT_AUTHORIZED');
      }
    });
  });

  it('each registered tool has a schema that is strict', () => {
    for (const tool of allTools()) {
      const parsed = tool.inputSchema.safeParse({ __x__: 1 });
      expect(parsed.success, tool.id).toBe(false);
    }
  });
});

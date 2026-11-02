import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AGENT_CATALOGUE, findAgentSpec, allAgentSpecs } from '../src/modules/ai/catalogue.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { executeAgentTask } from '../src/modules/ai/executors.js';
import {
  SALES_READ_ORDERS_OWN,
  SALES_READ_ORDERS_PLATFORM,
  SALES_READ_MARKET_TOTALS,
  MERCHANT_READ_OWN,
  SUPPLIER_READ_OWN,
  UNBOUND_DECLARED_TOOLS,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';

/**
 * G5 Phase 2 (A3) — unify `execSalesAgent` behind the central Tool Gateway.
 *
 * The sales agent is DUAL-SCOPE: its own order book (owner) and the platform-wide
 * order book (admins) come from two registered, read-only tools, while the public
 * catalogue/entity counts it always exposed come from a third. The owner is
 * resolved from the trusted run context (`getAgentRunContext().requestedBy`),
 * never from the args.
 *
 * DB-FREE BY DESIGN. This spec never imports `db/client`; the batch forbids tests
 * that open a database connection. Isolation, the identity rule, the admin gate
 * and the exact output contract are proven by exercising the REAL Tool Gateway
 * (`invokeTool`) and the REAL executor (`executeAgentTask`) against a recording
 * fake that stands in only at the drizzle boundary: it resolves each query from
 * the SQL parameters the handler actually binds, so it proves what the handler
 * asks the database for — it never re-implements the handler's logic. A real
 * end-to-end run against the isolated test DB is deferred to a separately
 * approved batch.
 *
 * Every assertion is scoped to ids this file created in its fake.
 */

const dialect = new PgDialect();

// The tables whose reads carry tenant data (vs. the AI bookkeeping tables the
// reasoning path touches, which the fake answers with empty/zero rows).
const DATA_TABLES = new Set(['orders', 'products', 'suppliers', 'merchants', 'companies', 'trust_scores']);

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'SUPPORT' | 'CUSTOMER';

interface OrderRow {
  id: string;
  buyerId: string;
  sellerId: string;
  orderNumber: string;
  itemsTotal: string;
  status: string;
  createdAt: Date;
}

interface SalesKpi {
  orders: number;
  gmv: string;
  commission: string;
  paymentFees: string;
  net: string;
}

interface FakeOptions {
  ownedSellerIds?: string[];
  orders?: OrderRow[];
  kpi?: SalesKpi;
  counts?: { products?: number; suppliers?: number; merchants?: number; companies?: number };
  avgTrust?: number;
  failOnDataRead?: boolean;
}

/**
 * A recording stand-in for the drizzle `DB` boundary. `execute` answers
 * `resolveOwnedSellerIds` (the caller's owned seller-entity ids); the select
 * chain answers the data reads from the SQL parameters the handler binds. The
 * orders table serves two shapes — the KPI aggregate (its `where` carries a
 * `Date`) and the recent-orders list — so a test can see exactly which scope the
 * handler asked for without re-implementing the handler.
 */
function makeFakeDb(opts: FakeOptions) {
  const whereParams: { table: string; params: unknown[] }[] = [];
  const limits: number[] = [];
  const auditWrites: Record<string, unknown>[] = [];
  const tablesRead: string[] = [];

  function rowsFor(table: string, sqlText: string): unknown[] {
    switch (table) {
      case 'orders':
        // The KPI aggregate filters on the window start (`created_at >=`); the
        // recent-orders list filters on the owner scope only.
        return sqlText.includes('created_at')
          ? [{ ...(opts.kpi ?? { orders: 0, gmv: '0', commission: '0', paymentFees: '0', net: '0' }) }]
          : (opts.orders ?? []).map((o) => ({
              id: o.id,
              orderNumber: o.orderNumber,
              itemsTotal: o.itemsTotal,
              status: o.status,
              createdAt: o.createdAt,
            }));
      case 'products':
        return [{ v: opts.counts?.products ?? 0 }];
      case 'suppliers':
        return [{ v: opts.counts?.suppliers ?? 0 }];
      case 'merchants':
        return [{ v: opts.counts?.merchants ?? 0 }];
      case 'companies':
        return [{ v: opts.counts?.companies ?? 0 }];
      case 'trust_scores':
        return [{ v: opts.avgTrust ?? 0 }];
      case 'ai_requests':
        // `usageSum` reads a single aggregate row and dereferences it.
        return [{ requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' }];
      default:
        return [];
    }
  }

  const db = {
    execute: async () => ({ rows: (opts.ownedSellerIds ?? []).map((id) => ({ id })) }),
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const collect = (cond?: unknown) => {
          const params = cond === undefined ? [] : dialect.sqlToQuery(cond as never).params;
          const sqlText = cond === undefined ? '' : dialect.sqlToQuery(cond as never).sql;
          if (cond !== undefined) whereParams.push({ table: name, params });
          if (DATA_TABLES.has(name)) {
            if (opts.failOnDataRead) throw new Error('boom: data read failed');
            tablesRead.push(name);
          }
          return rowsFor(name, sqlText);
        };
        const run = (cond?: unknown) => Promise.resolve(collect(cond));
        const limit = (n: number) => {
          limits.push(n);
          return run(undefined).then((rows) => rows.slice(0, n));
        };
        return Object.assign(run(undefined), {
          where: (cond: unknown) => Object.assign(run(cond), { orderBy: () => ({ limit }), limit }),
          limit,
        });
      },
    }),
    insert: () => ({ values: async (v: Record<string, unknown>) => void auditWrites.push(v) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  };

  return { db, whereParams, limits, auditWrites, tablesRead };
}

function ctx(overrides: {
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
  agentKey?: string;
}) {
  return {
    taskId: `g5p2-sales-ctx-${Math.random().toString(36).slice(2)}`,
    agentKey: overrides.agentKey ?? 'sales-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['MERCHANT']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p2-sales-operator',
  };
}

async function expectRefusal(p: Promise<unknown>, code: string): Promise<ToolGatewayError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe(code);
    return err as ToolGatewayError;
  }
  throw new Error(`expected ToolGatewayError(${code}) but the call resolved`);
}

const OWNER_A = 'g5p2-sales-owner-a';
const OWNER_B = 'g5p2-sales-owner-b';

describe('G5 Phase 2 (A3) — the sales tools are registered, read-only and bound', () => {
  it('registers the three sales tools with bound handlers', () => {
    for (const id of [SALES_READ_ORDERS_OWN, SALES_READ_ORDERS_PLATFORM, SALES_READ_MARKET_TOTALS]) {
      const tool = findTool(id);
      expect(tool, id).toBeTruthy();
      expect(tool?.effect, id).toBe('read');
      expect(isRegisteredTool(id), id).toBe(true);
      expect(registeredToolIds(), id).toContain(id);
      expect(getToolHandler(id), id).toBeTruthy();
    }
  });

  it('scopes the tools exactly as designed (owner / platform / public totals)', () => {
    expect(findTool(SALES_READ_ORDERS_OWN)?.platformScoped).toBe(false);
    expect(findTool(SALES_READ_ORDERS_OWN)?.permission).toBe('order:read:own');
    expect(findTool(SALES_READ_ORDERS_PLATFORM)?.platformScoped).toBe(true);
    expect(findTool(SALES_READ_ORDERS_PLATFORM)?.permission).toBe('order:read');
    expect(findTool(SALES_READ_MARKET_TOTALS)?.platformScoped).toBe(false);
    expect(findTool(SALES_READ_MARKET_TOTALS)?.permission).toBe('ai:use');
  });

  it('is registered, not left in the unbound list', () => {
    for (const id of [SALES_READ_ORDERS_OWN, SALES_READ_ORDERS_PLATFORM, SALES_READ_MARKET_TOTALS]) {
      expect(UNBOUND_DECLARED_TOOLS, id).not.toContain(id);
    }
  });

  it('uses strict schemas that accept only periodDays/limit (no identity/scope injection)', () => {
    const orderTool = findTool(SALES_READ_ORDERS_OWN)!;
    expect(orderTool.inputSchema.safeParse({}).success).toBe(true);
    expect(orderTool.inputSchema.safeParse({ periodDays: 7, limit: 5 }).success).toBe(true);
    expect(orderTool.inputSchema.safeParse({ periodDays: '7' }).success).toBe(true); // coerce
    for (const bad of [{ requestedBy: 'victim' }, { userId: 'victim' }, { scope: 'platform' }]) {
      expect(orderTool.inputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Bound checks.
    expect(orderTool.inputSchema.safeParse({ periodDays: 0 }).success).toBe(false);
    expect(orderTool.inputSchema.safeParse({ periodDays: 366 }).success).toBe(false);
    expect(orderTool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(orderTool.inputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(orderTool.inputSchema.safeParse({ limit: 1.5 }).success).toBe(false);

    const totalsTool = findTool(SALES_READ_MARKET_TOTALS)!;
    expect(totalsTool.inputSchema.safeParse({}).success).toBe(true);
    expect(totalsTool.inputSchema.safeParse({ limit: 5 }).success).toBe(false); // no knobs
    expect(totalsTool.inputSchema.safeParse({ userId: 'victim' }).success).toBe(false);
  });
});

describe('G5 Phase 2 (A3) — the gateway fails closed (no handler reached)', () => {
  it('refuses when there is no trusted run context', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(invokeTool(db as never, SALES_READ_ORDERS_OWN, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db as never, SALES_READ_ORDERS_OWN, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('refuses a run granted only the merchant tool (no cross-tool widening)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MERCHANT_READ_OWN] }), () =>
        invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
      ),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN] }), () =>
        invokeTool(db as never, SALES_READ_ORDERS_OWN, { requestedBy: 'victim', userId: 'victim', scope: 'platform' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('rejects out-of-range periodDays and limit', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN] }), () =>
        invokeTool(db as never, SALES_READ_ORDERS_OWN, { periodDays: 9999 }),
      ),
      'INVALID_INPUT',
    );
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN] }), () =>
        invokeTool(db as never, SALES_READ_ORDERS_OWN, { limit: 9999 }),
      ),
      'INVALID_INPUT',
    );
  });

  it('denies the owner tool to a role that lacks order:read:own', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requesterRoles: ['SUPPORT'] }), () =>
        invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
      ),
      'PERMISSION_DENIED',
    );
  });
});

describe('G5 Phase 2 (A3) — the caller reads only their own order book', () => {
  const ORDERS: OrderRow[] = [
    { id: 'o-a', buyerId: OWNER_A, sellerId: 's-x', orderNumber: 'A-1', itemsTotal: '100.00', status: 'PAID', createdAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'o-b', buyerId: OWNER_B, sellerId: 's-y', orderNumber: 'B-1', itemsTotal: '200.00', status: 'PAID', createdAt: new Date('2026-01-03T00:00:00Z') },
  ];

  it('scopes the read to the caller (buyer id) and their owned seller entities', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: ['ent-a'], orders: ORDERS, kpi: { orders: 1, gmv: '100.00', commission: '5.00', paymentFees: '1.00', net: '94.00' } });
    const out = await withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
    );
    expect(out.data.scope).toBe('own');
    expect(out.data.noScope).toBe(false);
    // The owner predicate bound the caller's user id and their owned entity ids —
    // never a foreign id, and never a platform-wide (unscoped) read.
    const orderWhere = whereParams.filter((w) => w.table === 'orders');
    const scoped = orderWhere.map((w) => w.params).find((p) => p.includes(OWNER_A));
    expect(scoped).toBeTruthy();
    expect(scoped).toContain('ent-a');
    expect(orderWhere.every((w) => !w.params.includes(OWNER_B))).toBe(true);
  });

  it('resolves the owner from the trusted context, ignoring any args identity', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: [], orders: ORDERS, kpi: { orders: 1, gmv: '100.00', commission: '0', paymentFees: '0', net: '100.00' } });
    await withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
    );
    // The only owner id bound is the trusted context identity.
    const ownerParams = whereParams.flatMap((w) => w.params).filter((p) => typeof p === 'string' && p.startsWith('g5p2-sales-owner'));
    expect(ownerParams).toEqual([OWNER_A, OWNER_A]); // KPI where + recent where
  });

  it('refuses a caller with no trustworthy owner (no order query is attempted)', async () => {
    const { db, tablesRead } = makeFakeDb({ ownedSellerIds: ['ent-a'], orders: ORDERS });
    const out = await withAgentRunContext(
      ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requestedBy: 'system', requesterRoles: ['MERCHANT'] }),
      () => invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
    );
    expect(out.data.noScope).toBe(true);
    expect(out.data.recentOrders).toEqual([]);
    expect(tablesRead).toHaveLength(0);
  });

  it('returns the caller\'s own orders and never another tenant\'s', async () => {
    const { db } = makeFakeDb({ ownedSellerIds: [], orders: [ORDERS[0]], kpi: { orders: 1, gmv: '100.00', commission: '5.00', paymentFees: '1.00', net: '94.00' } });
    const out = await withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, SALES_READ_ORDERS_OWN, {}),
    );
    const recent = out.data.recentOrders as { id: string }[];
    expect(recent.map((o) => o.id)).toEqual(['o-a']);
    const kpi = out.data.kpi as SalesKpi;
    expect(kpi.orders).toBe(1);
    expect(kpi.gmv).toBe('100.00');
    expect(kpi.net).toBe('94.00');
  });

  it('honours an explicit in-range limit', async () => {
    const { db, limits } = makeFakeDb({ ownedSellerIds: [], orders: ORDERS });
    await withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, SALES_READ_ORDERS_OWN, { limit: 2 }),
    );
    expect(limits).toContain(2);
  });
});

describe('G5 Phase 2 (A3) — the platform order book is admin-only', () => {
  const ORDERS: OrderRow[] = [
    { id: 'o-1', buyerId: 'any-1', sellerId: 's-1', orderNumber: 'P-1', itemsTotal: '50.00', status: 'PAID', createdAt: new Date('2026-01-01T00:00:00Z') },
  ];

  it('admits an ADMIN and reads across every owner', async () => {
    const { db, whereParams } = makeFakeDb({ orders: ORDERS, kpi: { orders: 1, gmv: '50.00', commission: '0', paymentFees: '0', net: '50.00' } });
    const out = await withAgentRunContext(
      ctx({ allowedTools: [SALES_READ_ORDERS_PLATFORM], requesterRoles: ['ADMIN'], requestedBy: 'g5p2-admin' }),
      () => invokeTool(db as never, SALES_READ_ORDERS_PLATFORM, {}),
    );
    expect(out.data.scope).toBe('platform');
    // No owner predicate is bound on the platform read.
    expect(whereParams.filter((w) => w.table === 'orders').every((w) => !w.params.includes('g5p2-admin'))).toBe(true);
  });

  it('admits a SUPER_ADMIN', async () => {
    const { db } = makeFakeDb({ orders: ORDERS, kpi: { orders: 1, gmv: '50.00', commission: '0', paymentFees: '0', net: '50.00' } });
    const out = await withAgentRunContext(
      ctx({ allowedTools: [SALES_READ_ORDERS_PLATFORM], requesterRoles: ['SUPER_ADMIN'], requestedBy: 'g5p2-super' }),
      () => invokeTool(db as never, SALES_READ_ORDERS_PLATFORM, {}),
    );
    expect(out.data.scope).toBe('platform');
  });

  it('refuses a non-admin that holds order:read (platform scope denied)', async () => {
    const { db } = makeFakeDb({ orders: ORDERS });
    await expectRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [SALES_READ_ORDERS_PLATFORM], requesterRoles: ['SUPPORT'], requestedBy: 'g5p2-support' }),
        () => invokeTool(db as never, SALES_READ_ORDERS_PLATFORM, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
  });

  it('refuses a merchant that lacks order:read', async () => {
    const { db } = makeFakeDb({ orders: ORDERS });
    await expectRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [SALES_READ_ORDERS_PLATFORM], requesterRoles: ['MERCHANT'], requestedBy: OWNER_A }),
        () => invokeTool(db as never, SALES_READ_ORDERS_PLATFORM, {}),
      ),
      'PERMISSION_DENIED',
    );
  });
});

describe('G5 Phase 2 (A3) — the public market totals expose aggregates only', () => {
  it('returns summed counts and the average trust score for any caller', async () => {
    const { db } = makeFakeDb({ counts: { products: 12, suppliers: 3, merchants: 4, companies: 5 }, avgTrust: 77 });
    const out = await withAgentRunContext(
      ctx({ allowedTools: [SALES_READ_MARKET_TOTALS], requesterRoles: ['MERCHANT'], requestedBy: OWNER_A }),
      () => invokeTool(db as never, SALES_READ_MARKET_TOTALS, {}),
    );
    expect(out.data).toEqual({ activeProducts: 12, suppliers: 3, merchants: 4, companies: 5, avgTrust: 77 });
  });

  it('is available to a plain merchant (not platform-gated)', async () => {
    const { db } = makeFakeDb({ counts: {} });
    const out = await withAgentRunContext(
      ctx({ allowedTools: [SALES_READ_MARKET_TOTALS], requesterRoles: ['CUSTOMER'], requestedBy: OWNER_A }),
      () => invokeTool(db as never, SALES_READ_MARKET_TOTALS, {}),
    );
    expect(out.data).toBeTruthy();
  });

  it('still requires the trusted run context', async () => {
    const { db } = makeFakeDb({ counts: {} });
    await expectRefusal(invokeTool(db as never, SALES_READ_MARKET_TOTALS, {}), 'NO_RUN_CONTEXT');
  });
});

describe('G5 Phase 2 (A3) — read-only and audited', () => {
  it('records AI.TOOL_EXECUTED for each invocation and performs no writes', async () => {
    const { db, auditWrites } = makeFakeDb({ ownedSellerIds: [], orders: [], counts: {} });
    const c = ctx({ allowedTools: [SALES_READ_ORDERS_OWN, SALES_READ_MARKET_TOTALS], requestedBy: OWNER_A });
    await withAgentRunContext(c, () => invokeTool(db as never, SALES_READ_ORDERS_OWN, {}));
    await withAgentRunContext(c, () => invokeTool(db as never, SALES_READ_MARKET_TOTALS, {}));
    const executed = auditWrites.filter((w) => w.action === 'AI.TOOL_EXECUTED');
    expect(executed.map((w) => w.entityId)).toEqual([SALES_READ_ORDERS_OWN, SALES_READ_MARKET_TOTALS]);
    // No audit row is anything but an audit write — the tools never insert data.
    expect(auditWrites.every((w) => typeof w.action === 'string' && String(w.action).startsWith('AI.'))).toBe(true);
  });
});

describe('G5 Phase 2 (A3) — the tools are granted to sales-agent ONLY', () => {
  it('grants the three sales tools to sales-agent and no other agent', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      for (const id of [SALES_READ_ORDERS_OWN, SALES_READ_ORDERS_PLATFORM, SALES_READ_MARKET_TOTALS]) {
        if (agent.key === 'sales-agent') expect(grant, `${agent.key}:${id}`).toContain(id);
        else expect(grant, `${agent.key}:${id}`).not.toContain(id);
      }
    }
  });

  it('does not touch the shared READ_TOOLS group (other consumers unchanged)', () => {
    const sales = findAgentSpec('sales-agent')!;
    expect(sales.allowedTools).toEqual([
      'platform.metrics',
      'platform.read_orders',
      'report.generate',
      SALES_READ_ORDERS_OWN,
      SALES_READ_ORDERS_PLATFORM,
      SALES_READ_MARKET_TOTALS,
    ]);
    for (const key of ['marketing-agent', 'product-agent', 'customer-intelligence-agent']) {
      const grant = toolGrantForAgent(findAgentSpec(key)!);
      expect(grant, key).not.toContain(SALES_READ_ORDERS_OWN);
      expect(grant, key).not.toContain(SALES_READ_MARKET_TOTALS);
    }
    // The sibling owner-scoped tools are untouched.
    expect(toolGrantForAgent(findAgentSpec('merchant-agent')!)).toContain(MERCHANT_READ_OWN);
    expect(toolGrantForAgent(findAgentSpec('supplier-agent')!)).toContain(SUPPLIER_READ_OWN);
  });

  it('preserves sales-agent permissions, scope and approval declarations', () => {
    const sales = findAgentSpec('sales-agent')!;
    expect(sales.permissionsRequired).toEqual(['ai:use', 'order:read:own']);
    expect(sales.requiresPlatformScope).not.toBe(true);
    expect(sales.approvalActions).toEqual(['finance.refund', 'commission.change']);
    expect(sales.requiresHumanApproval).toBe(true);
  });

  it('keeps the catalogue internally consistent (keys unique, permissions present)', () => {
    const specs = allAgentSpecs();
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of specs) expect(s.permissionsRequired.length, s.key).toBeGreaterThan(0);
  });
});

describe('G5 Phase 2 (A3) — execSalesAgent routes through the gateway (source contract)', () => {
  it('reads ONLY through invokeTool (no direct query, no inline platform gate)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');
    const start = SRC.indexOf('async function execSalesAgent(');
    expect(start).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    const body = next === -1 ? rest : rest.slice(0, next);

    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes(SALES_READ_ORDERS_OWN)).toBe(true);
    expect(body.includes(SALES_READ_ORDERS_PLATFORM)).toBe(true);
    expect(body.includes(SALES_READ_MARKET_TOTALS)).toBe(true);
    expect(body.includes('.from(')).toBe(false);
    expect(body.includes('db.select')).toBe(false);
    expect(body.includes('requirePlatformGate(')).toBe(false);
    expect(body.includes('resolveOwnedSellerIds(')).toBe(false);
  });

  it('preserves the exact output contract of the former direct read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');
    const start = SRC.indexOf('async function execSalesAgent(');
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    const body = next === -1 ? rest : rest.slice(0, next);

    for (const key of ['agentKey', 'action', 'scope', 'scopedToOwnSales', 'periodDays', 'kpi', 'recentOrders', 'leadsPotential', 'readOnly', 'generatedAt']) {
      expect(body.includes(key), key).toBe(true);
    }
    expect(body.includes("scope: isPlatform ? 'platform' : 'own'")).toBe(true);
    expect(body.includes('scopedToOwnSales: !isPlatform')).toBe(true);
    expect(body.includes('reasonAboutAgent(')).toBe(true);
    expect(body.includes('withProposal(')).toBe(true);
    expect(body.includes("'You are the WASIT Sales Agent.'")).toBe(true);
    // Only the known scope/permission refusals are swallowed; anything else is
    // re-thrown (never a silent fallback).
    expect(body.includes("err.code === 'PLATFORM_SCOPE_DENIED'")).toBe(true);
    expect(body.includes("err.code === 'PERMISSION_DENIED'")).toBe(true);
    expect(body.includes('throw err')).toBe(true);
  });
});

describe('G5 Phase 2 (A3) — the executor routes end-to-end through the gateway', () => {
  const sales = findAgentSpec('sales-agent')!;
  const GRANT = toolGrantForAgent(sales);

  const ORDERS: OrderRow[] = [
    { id: 'o-a', buyerId: OWNER_A, sellerId: 's-x', orderNumber: 'A-1', itemsTotal: '100.00', status: 'PAID', createdAt: new Date('2026-01-02T00:00:00Z') },
  ];

  async function run(userId: string, roles: RoleName[], input: Record<string, unknown>, opts: FakeOptions) {
    const { db, whereParams } = makeFakeDb(opts);
    const res = await withAgentRunContext(
      ctx({ allowedTools: GRANT, requesterRoles: roles, requestedBy: userId }),
      () => executeAgentTask(db as never, sales, { ...input, __userId: userId }),
    );
    const parsed = JSON.parse((res as { content: string }).content) as Record<string, unknown>;
    return { res, parsed, whereParams };
  }

  it('a merchant gets the OWN scope, with only their own order book', async () => {
    const { parsed, whereParams } = await run(OWNER_A, ['MERCHANT'], {}, {
      ownedSellerIds: ['ent-a'],
      orders: ORDERS,
      kpi: { orders: 1, gmv: '100.00', commission: '5.00', paymentFees: '1.00', net: '94.00' },
      counts: { products: 2, suppliers: 1, merchants: 1, companies: 1 },
      avgTrust: 60,
    });
    expect(parsed.scope).toBe('own');
    expect(parsed.scopedToOwnSales).toBe(true);
    expect(parsed.readOnly).toBe(true);
    const kpi = parsed.kpi as Record<string, unknown>;
    expect(kpi.orders).toBe(1);
    expect(kpi.gmv).toBe('100.00');
    expect(kpi.net).toBe('94.00');
    expect(kpi.activeProducts).toBe(2);
    expect(kpi.avgTrust).toBe(60);
    expect(parsed).toHaveProperty('leadsPotential');
    expect(parsed).toHaveProperty('recentOrders');
    // The owner id was bound; no platform-wide read was taken.
    expect(whereParams.filter((w) => w.table === 'orders').some((w) => w.params.includes(OWNER_A))).toBe(true);
  });

  it('an admin gets the PLATFORM scope across every owner', async () => {
    const { parsed, whereParams } = await run('g5p2-admin', ['ADMIN'], {}, {
      orders: ORDERS,
      kpi: { orders: 9, gmv: '900.00', commission: '0', paymentFees: '0', net: '900.00' },
      counts: { products: 2, suppliers: 1, merchants: 1, companies: 1 },
      avgTrust: 60,
    });
    expect(parsed.scope).toBe('platform');
    expect(parsed.scopedToOwnSales).toBe(false);
    expect((parsed.kpi as Record<string, unknown>).orders).toBe(9);
    // No owner predicate was bound for the platform read.
    expect(whereParams.filter((w) => w.table === 'orders').every((w) => !w.params.includes('g5p2-admin'))).toBe(true);
  });

  it('a scheduler principal is refused with NO_SCOPE (status refused)', async () => {
    const { parsed } = await run('system', [], {}, { ownedSellerIds: [], orders: [], counts: {} });
    expect(parsed.status).toBe('refused');
    expect(parsed.error).toBe('NO_SCOPE');
    expect(parsed.readOnly).toBe(true);
  });

  it('a scheduled run carrying ADMIN roles still cannot reach the platform order book', async () => {
    // A trusted scheduled run executes with the scheduler's OWN admin roles
    // (`trustedPrincipalRoles()` = SUPER_ADMIN), which WOULD pass the gateway's
    // platform gate. The executor must refuse the `system` principal BEFORE any
    // gateway call, so no order query runs and neither sales tool is reached.
    //
    // This is the regression guard for the `SYSTEM_PRINCIPAL` check in
    // `execSalesAgent`: with it removed, `sales.read_orders_platform` would
    // succeed for the admin-carrying `system` run, read the platform-wide order
    // book and return `scope: 'platform'` — every assertion below would fail.
    const { db, whereParams, tablesRead, auditWrites } = makeFakeDb({
      ownedSellerIds: [],
      orders: ORDERS,
      kpi: { orders: 7, gmv: '700.00', commission: '0', paymentFees: '0', net: '700.00' },
      counts: { products: 2, suppliers: 1, merchants: 1, companies: 1 },
      avgTrust: 55,
    });
    const res = await withAgentRunContext(
      ctx({ allowedTools: GRANT, requesterRoles: ['SUPER_ADMIN'], requestedBy: 'system' }),
      () => executeAgentTask(db as never, sales, { __userId: 'system' }),
    );
    const parsed = JSON.parse((res as { content: string }).content) as Record<string, unknown>;

    expect(parsed.status).toBe('refused');
    expect(parsed.error).toBe('NO_SCOPE');
    expect(parsed.readOnly).toBe(true);

    // No order read happened at all — the refusal precedes the gateway.
    expect(tablesRead).toHaveLength(0);
    expect(whereParams.filter((w) => w.table === 'orders')).toHaveLength(0);

    // Neither sales tool was invoked: the gateway audits every call, so an empty
    // audit trail proves the platform (and owner) tools were never reached.
    expect(auditWrites).toHaveLength(0);
    const reached = auditWrites.filter(
      (w) => w.entityId === SALES_READ_ORDERS_PLATFORM || w.entityId === SALES_READ_ORDERS_OWN,
    );
    expect(reached).toHaveLength(0);
  });

  it('a non-admin never widens to the platform book when the platform tool is denied', async () => {
    // The platform tool is granted to the run, but the merchant role is denied at
    // the gateway — the executor must fall back to the OWNER tool, not fail open.
    const { parsed, whereParams } = await run(OWNER_A, ['MERCHANT'], {}, {
      ownedSellerIds: [],
      orders: ORDERS,
      kpi: { orders: 1, gmv: '100.00', commission: '0', paymentFees: '0', net: '100.00' },
      counts: {},
    });
    expect(parsed.scope).toBe('own');
    expect(whereParams.filter((w) => w.table === 'orders').some((w) => w.params.includes(OWNER_A))).toBe(true);
  });

  it('a non-refusal tool error is re-thrown, never swallowed', async () => {
    const { db } = makeFakeDb({ failOnDataRead: true });
    await expect(
      withAgentRunContext(
        ctx({ allowedTools: GRANT, requesterRoles: ['MERCHANT'], requestedBy: OWNER_A }),
        () => executeAgentTask(db as never, sales, { __userId: OWNER_A }),
      ),
    ).rejects.toThrow();
  });
});

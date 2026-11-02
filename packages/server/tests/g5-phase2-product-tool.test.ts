import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AGENT_CATALOGUE, findAgentSpec, allAgentSpecs } from '../src/modules/ai/catalogue.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { executeAgentTask } from '../src/modules/ai/executors.js';
import {
  PRODUCT_READ_PUBLIC,
  PRODUCT_READ_OWNED,
  PRODUCT_READ_PLATFORM,
  SALES_READ_ORDERS_OWN,
  MERCHANT_READ_OWN,
  UNBOUND_DECLARED_TOOLS,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';

/**
 * G5 Phase 2 (A4) — unify `execProductAgent` behind the central Tool Gateway.
 *
 * The product agent applies a THREE-TIER product-visibility policy (admin →
 * owner ∪ public → public), so it is served by three registered, read-only
 * tools instead of one: `product.read_public` (published/ACTIVE only),
 * `product.read_owned` (the caller's own listings, any status) and
 * `product.read_platform` (any listing; admins only). The owner is resolved from
 * the trusted run context (`getAgentRunContext().requestedBy`), never the args.
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
const DATA_TABLES = new Set(['products', 'product_variants', 'product_images', 'inventory_items']);

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'SUPPLIER' | 'SUPPORT' | 'CUSTOMER';

interface ProductRow {
  id: string;
  sellerId: string;
  sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  name: string;
  sku: string;
  basePrice: string | null;
  currencyCode: string;
  categoryName: string | null;
  isPublished: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'SUSPENDED';
  brand: string | null;
  moq: number;
}

interface FakeOptions {
  /** Owned seller-entity ids returned by `resolveOwnedSellerIds`. */
  ownedSellerIds?: string[];
  /** The catalogue the fake serves, filtered by the predicate the handler binds. */
  products?: ProductRow[];
  variants?: Record<string, number>;
  images?: Record<string, number>;
  inventory?: Record<string, number>;
  failOnDataRead?: boolean;
}

const OWNER_A = 'g5p2-product-owner-a';
const OWNER_B = 'g5p2-product-owner-b';
const ENT_A = 'g5p2-product-ent-a';
const ENT_B = 'g5p2-product-ent-b';

/** The catalogue used across the executor-level specs. */
const CATALOGUE: ProductRow[] = [
  { id: 'p-pub-a', sellerId: ENT_A, sellerType: 'MERCHANT', name: 'G5P2 Published A', sku: 'S-PUBA', basePrice: '10.0000', currencyCode: 'TND', categoryName: 'G5P2 Cat', isPublished: true, status: 'ACTIVE', brand: 'BrandA', moq: 1 },
  { id: 'p-draft-a', sellerId: ENT_A, sellerType: 'MERCHANT', name: 'G5P2 Draft A', sku: 'S-DRAFTA', basePrice: '20.0000', currencyCode: 'TND', categoryName: null, isPublished: false, status: 'DRAFT', brand: null, moq: 2 },
  { id: 'p-draft-b', sellerId: ENT_B, sellerType: 'MERCHANT', name: 'G5P2 Secret Draft B', sku: 'S-DRAFTB', basePrice: '30.0000', currencyCode: 'TND', categoryName: 'G5P2 Cat B', isPublished: false, status: 'DRAFT', brand: 'BrandB', moq: 1 },
  { id: 'p-pub-b', sellerId: ENT_B, sellerType: 'MERCHANT', name: 'G5P2 Published B', sku: 'S-PUBB', basePrice: '40.0000', currencyCode: 'TND', categoryName: 'G5P2 Cat B', isPublished: true, status: 'ACTIVE', brand: 'BrandB', moq: 3 },
];

/**
 * A recording stand-in for the drizzle `DB` boundary. `execute` answers
 * `resolveOwnedSellerIds` (the caller's owned seller-entity ids); the select
 * chain resolves each table from the SQL predicate the handler binds, so a test
 * can see exactly which scope the handler asked for without re-implementing it.
 */
function makeFakeDb(opts: FakeOptions) {
  const whereParams: { table: string; params: unknown[]; sql: string }[] = [];
  const auditWrites: Record<string, unknown>[] = [];
  const tablesRead: string[] = [];

  function rowsFor(table: string, cond: unknown): unknown[] {
    const params = cond === undefined ? [] : dialect.sqlToQuery(cond as never).params;
    const sqlText = cond === undefined ? '' : dialect.sqlToQuery(cond as never).sql;
    switch (table) {
      case 'products': {
        // The tier is encoded in the predicate the handler built: an owned read
        // binds `seller_id IN (...)`, a public read binds `is_published`/status,
        // and the platform read has neither.
        const tier = sqlText.includes('seller_id') ? 'owned' : sqlText.includes('is_published') ? 'public' : 'platform';
        const requestedId = params.find((p): p is string => typeof p === 'string' && (opts.products ?? []).some((x) => x.id === p));
        const owned = params.filter((p): p is string => typeof p === 'string' && (opts.ownedSellerIds ?? []).includes(p));
        let cands = opts.products ?? [];
        if (requestedId) cands = cands.filter((x) => x.id === requestedId);
        if (tier === 'owned') cands = cands.filter((x) => owned.includes(x.sellerId));
        if (tier === 'public') cands = cands.filter((x) => x.isPublished && x.status === 'ACTIVE');
        return cands.map((x) => ({
          id: x.id, name: x.name, sku: x.sku, basePrice: x.basePrice, currencyCode: x.currencyCode,
          categoryName: x.categoryName, sellerType: x.sellerType, isPublished: x.isPublished, brand: x.brand, moq: x.moq,
        }));
      }
      case 'product_variants': {
        const pid = params.find((p): p is string => typeof p === 'string');
        const n = Number((pid ? opts.variants?.[pid] : undefined) ?? 0);
        return Array.from({ length: n }, (_, i) => ({ name: `v${i}`, sku: `S-V${i}`, price: '1.0000', attributes: null }));
      }
      case 'product_images': {
        const pid = params.find((p): p is string => typeof p === 'string');
        const n = Number((pid ? opts.images?.[pid] : undefined) ?? 0);
        return Array.from({ length: n }, (_, i) => ({ url: `https://img/${i}.png`, isPrimary: i === 0 }));
      }
      case 'inventory_items': {
        const pid = params.find((p): p is string => typeof p === 'string');
        return [{ v: (pid && opts.inventory?.[pid]) ?? 0 }];
      }
      case 'ai_requests':
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
          if (cond !== undefined) {
            const { params, sql } = dialect.sqlToQuery(cond as never);
            whereParams.push({ table: name, params, sql });
          }
          if (DATA_TABLES.has(name)) {
            if (opts.failOnDataRead) throw new Error('boom: data read failed');
            tablesRead.push(name);
          }
          return rowsFor(name, cond);
        };
        const q = (cond?: unknown) => {
          const p = Promise.resolve(collect(cond));
          const limit = (n: number) => p.then((rows) => rows.slice(0, n));
          return Object.assign(p, { limit, orderBy: () => ({ limit }) });
        };
        return Object.assign(q(undefined), {
          where: (cond: unknown) => q(cond),
          leftJoin: () => ({ where: (cond: unknown) => q(cond) }),
        });
      },
    }),
    insert: () => ({ values: async (v: Record<string, unknown>) => void auditWrites.push(v) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  };

  return { db, whereParams, auditWrites, tablesRead };
}

function ctx(overrides: {
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
  agentKey?: string;
}) {
  return {
    taskId: `g5p2-product-ctx-${Math.random().toString(36).slice(2)}`,
    agentKey: overrides.agentKey ?? 'product-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['MERCHANT']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p2-product-operator',
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

describe('G5 Phase 2 (A4) — the product tools are registered, read-only and bound', () => {
  it('registers the three product tools with bound handlers', () => {
    for (const id of [PRODUCT_READ_PUBLIC, PRODUCT_READ_OWNED, PRODUCT_READ_PLATFORM]) {
      const tool = findTool(id);
      expect(tool, id).toBeTruthy();
      expect(tool?.effect, id).toBe('read');
      expect(isRegisteredTool(id), id).toBe(true);
      expect(registeredToolIds(), id).toContain(id);
      expect(getToolHandler(id), id).toBeTruthy();
      expect(UNBOUND_DECLARED_TOOLS, id).not.toContain(id);
    }
  });

  it('scopes the tools exactly as designed (public / owner / platform)', () => {
    expect(findTool(PRODUCT_READ_PUBLIC)?.platformScoped).toBe(false);
    expect(findTool(PRODUCT_READ_PUBLIC)?.permission).toBe('ai:use');
    expect(findTool(PRODUCT_READ_OWNED)?.platformScoped).toBe(false);
    expect(findTool(PRODUCT_READ_OWNED)?.permission).toBe('ai:use');
    expect(findTool(PRODUCT_READ_PLATFORM)?.platformScoped).toBe(true);
    expect(findTool(PRODUCT_READ_PLATFORM)?.permission).toBe('product:read');
  });

  it('uses strict schemas that accept only productId (no identity/scope injection)', () => {
    for (const id of [PRODUCT_READ_PUBLIC, PRODUCT_READ_OWNED, PRODUCT_READ_PLATFORM]) {
      const tool = findTool(id)!;
      expect(tool.inputSchema.safeParse({}).success, id).toBe(true);
      expect(tool.inputSchema.safeParse({ productId: 'p-1' }).success, id).toBe(true);
      for (const bad of [{ requestedBy: 'victim' }, { userId: 'victim' }, { scope: 'platform' }, { sellerId: 'x' }]) {
        expect(tool.inputSchema.safeParse(bad).success, `${id}:${JSON.stringify(bad)}`).toBe(false);
      }
      // Bound checks.
      expect(tool.inputSchema.safeParse({ productId: '' }).success, id).toBe(false);
      expect(tool.inputSchema.safeParse({ productId: 'x'.repeat(65) }).success, id).toBe(false);
    }
  });
});

describe('G5 Phase 2 (A4) — the gateway fails closed (no handler reached)', () => {
  it('refuses when there is no trusted run context', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(invokeTool(db as never, PRODUCT_READ_PUBLIC, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db as never, PRODUCT_READ_PUBLIC, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('refuses a run granted only the sales tool (no cross-tool widening)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SALES_READ_ORDERS_OWN] }), () =>
        invokeTool(db as never, PRODUCT_READ_PUBLIC, {}),
      ),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_OWNED] }), () =>
        invokeTool(db as never, PRODUCT_READ_OWNED, { requestedBy: 'victim', userId: 'victim', scope: 'platform' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('rejects an out-of-range productId', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
        invokeTool(db as never, PRODUCT_READ_PUBLIC, { productId: 'x'.repeat(65) }),
      ),
      'INVALID_INPUT',
    );
  });

  it('denies a role that lacks the tool permission', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC], requesterRoles: [] }), () =>
        invokeTool(db as never, PRODUCT_READ_PUBLIC, {}),
      ),
      'PERMISSION_DENIED',
    );
  });

  it('denies the platform tool to a non-admin (before any handler runs)', async () => {
    const { db, tablesRead } = makeFakeDb({ products: CATALOGUE });
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PLATFORM], requesterRoles: ['MERCHANT'] }), () =>
        invokeTool(db as never, PRODUCT_READ_PLATFORM, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
    // The refusal precedes the handler: no catalogue query was issued.
    expect(tablesRead).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A4) — the public tier exposes only published/ACTIVE listings', () => {
  it('returns a published/ACTIVE listing', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
      invokeTool(db as never, PRODUCT_READ_PUBLIC, { productId: 'p-pub-a' }),
    );
    expect(out.data.scope).toBe('public');
    expect(out.data.found).toBe(true);
    expect((out.data.product as { id: string }).id).toBe('p-pub-a');
  });

  it('never returns an unpublished or non-ACTIVE listing by guessing its id', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
      invokeTool(db as never, PRODUCT_READ_PUBLIC, { productId: 'p-draft-b' }),
    );
    expect(out.data.found).toBe(false);
    expect(out.data.product).toBeNull();
  });

  it('without an id prefers a published sample', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
      invokeTool(db as never, PRODUCT_READ_PUBLIC, {}),
    );
    expect((out.data.product as { isPublished: boolean }).isPublished).toBe(true);
  });
});

describe('G5 Phase 2 (A4) — the owner tier reads only the caller\'s own listings', () => {
  it('returns the caller\'s own draft and never another tenant\'s', async () => {
    const a = await withAgentRunContext(
      ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: OWNER_A }),
      () => invokeTool(makeFakeDb({ ownedSellerIds: [ENT_A], products: CATALOGUE }).db as never, PRODUCT_READ_OWNED, { productId: 'p-draft-a' }),
    );
    expect((a.data.product as { id: string }).id).toBe('p-draft-a');

    const b = await withAgentRunContext(
      ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: OWNER_A }),
      () => invokeTool(makeFakeDb({ ownedSellerIds: [ENT_A], products: CATALOGUE }).db as never, PRODUCT_READ_OWNED, { productId: 'p-draft-b' }),
    );
    expect(b.data.product).toBeNull();
  });

  it('never leaks another tenant\'s draft name', async () => {
    const { db } = makeFakeDb({ ownedSellerIds: [ENT_A], products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, PRODUCT_READ_OWNED, {}),
    );
    // A sample of the owner's catalogue must never carry another tenant's draft.
    expect(out.data.product).not.toBeNull();
    expect(JSON.stringify(out.data)).not.toContain('G5P2 Secret Draft B');
    expect((out.data.product as { id: string }).id).not.toBe('p-draft-b');
  });

  it('resolves the owner from the trusted context, ignoring a forged identity in the args', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: [ENT_A], products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, PRODUCT_READ_OWNED, { productId: 'p-draft-a' }),
    );
    expect((out.data.product as { id: string }).id).toBe('p-draft-a');
    // The owned scope bound ENT_A (from the context), never a caller-supplied id.
    const owned = whereParams.find((w) => w.table === 'products' && w.sql.includes('seller_id'));
    expect(owned?.params).toContain(ENT_A);
    expect(owned?.params).not.toContain(ENT_B);
  });

  it('returns an empty scope (and runs no query) for a caller who owns no seller entity', async () => {
    const { db, whereParams, tablesRead } = makeFakeDb({ ownedSellerIds: [], products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, PRODUCT_READ_OWNED, { productId: 'p-draft-a' }),
    );
    expect(out.data.noScope).toBe(true);
    expect(out.data.product).toBeNull();
    expect(whereParams.filter((w) => w.table === 'products')).toHaveLength(0);
    expect(tablesRead).toHaveLength(0);
  });

  it('the scheduler principal is never treated as an owner', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: [ENT_A], products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_OWNED], requestedBy: 'system' }), () =>
      invokeTool(db as never, PRODUCT_READ_OWNED, {}),
    );
    expect(out.data.noScope).toBe(true);
    expect(whereParams.filter((w) => w.table === 'products')).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A4) — the platform tier is admin-only', () => {
  it('an admin reads any listing, published or not', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PLATFORM], requesterRoles: ['ADMIN'] }), () =>
      invokeTool(db as never, PRODUCT_READ_PLATFORM, { productId: 'p-draft-b' }),
    );
    expect(out.data.scope).toBe('platform');
    expect((out.data.product as { id: string }).id).toBe('p-draft-b');
  });

  it('a super-admin is admitted', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PLATFORM], requesterRoles: ['SUPER_ADMIN'] }), () =>
      invokeTool(db as never, PRODUCT_READ_PLATFORM, {}),
    );
    expect(out.data.scope).toBe('platform');
  });
});

describe('G5 Phase 2 (A4) — read-only audit', () => {
  it('records an AI.TOOL_EXECUTED audit row for the invocation', async () => {
    const { db, auditWrites } = makeFakeDb({ products: CATALOGUE });
    await withAgentRunContext(ctx({ allowedTools: [PRODUCT_READ_PUBLIC] }), () =>
      invokeTool(db as never, PRODUCT_READ_PUBLIC, { productId: 'p-pub-a' }),
    );
    const executed = auditWrites.filter((w) => w.action === 'AI.TOOL_EXECUTED');
    expect(executed).toHaveLength(1);
    expect(executed[0].entityId).toBe(PRODUCT_READ_PUBLIC);
  });
});

describe('G5 Phase 2 (A4) — the tool is granted to product-agent ONLY', () => {
  it('grants the product tools to product-agent and no other agent', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      for (const id of [PRODUCT_READ_PUBLIC, PRODUCT_READ_OWNED, PRODUCT_READ_PLATFORM]) {
        if (agent.key === 'product-agent') expect(grant, `${agent.key}:${id}`).toContain(id);
        else expect(grant, `${agent.key}:${id}`).not.toContain(id);
      }
    }
  });

  it('does not touch the shared CATALOG_TOOLS group (marketing/supplier/merchant unchanged)', () => {
    const product = findAgentSpec('product-agent')!;
    expect(product.allowedTools).toEqual([
      'platform.read_catalog',
      'platform.metrics',
      'report.generate',
      PRODUCT_READ_PUBLIC,
      PRODUCT_READ_OWNED,
      PRODUCT_READ_PLATFORM,
    ]);
    for (const key of ['marketing-agent', 'supplier-agent', 'merchant-agent']) {
      const grant = toolGrantForAgent(findAgentSpec(key)!);
      expect(grant, key).not.toContain(PRODUCT_READ_PUBLIC);
      expect(grant, key).not.toContain(PRODUCT_READ_OWNED);
      expect(grant, key).not.toContain(PRODUCT_READ_PLATFORM);
    }
  });

  it('leaves A1/A2/A3 tools granted to their own agents only (no regression)', () => {
    expect(toolGrantForAgent(findAgentSpec('supplier-agent')!)).not.toContain(PRODUCT_READ_OWNED);
    expect(toolGrantForAgent(findAgentSpec('merchant-agent')!)).not.toContain(PRODUCT_READ_OWNED);
    expect(toolGrantForAgent(findAgentSpec('sales-agent')!)).not.toContain(PRODUCT_READ_PUBLIC);
    // And the reverse: product-agent does not gain their tools.
    const product = toolGrantForAgent(findAgentSpec('product-agent')!);
    expect(product).not.toContain(MERCHANT_READ_OWN);
    expect(product).not.toContain(SALES_READ_ORDERS_OWN);
  });

  it('does not change product-agent permissions, scope or approval declarations', () => {
    const product = findAgentSpec('product-agent')!;
    expect(product.permissionsRequired).toEqual(['ai:use']);
    expect(product.requiresPlatformScope).not.toBe(true);
    expect(product.approvalActions).toEqual([]);
    expect(product.requiresHumanApproval).toBe(false);
  });

  it('keeps the catalogue internally consistent (keys unique, permissions present)', () => {
    const specs = allAgentSpecs();
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of specs) expect(s.permissionsRequired.length, s.key).toBeGreaterThan(0);
  });
});

describe('G5 Phase 2 (A4) — execProductAgent routes through the gateway (source contract)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');

  function bodyOf(name: string): string {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('reads ONLY through invokeTool (no direct query, no legacy helper)', () => {
    const body = bodyOf('execProductAgent');
    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes(PRODUCT_READ_PUBLIC)).toBe(true);
    expect(body.includes(PRODUCT_READ_OWNED)).toBe(true);
    expect(body.includes(PRODUCT_READ_PLATFORM)).toBe(true);
    expect(body.includes('.from(')).toBe(false);
    expect(body.includes('pickProduct(')).toBe(false);
    expect(body.includes('resolveOwnedSellerIds(')).toBe(false);
    expect(body.includes('requirePlatformGate(')).toBe(false);
    // Only the known scope/permission refusals are swallowed; anything else is
    // re-thrown (never a silent fallback).
    expect(body.includes("err.code === 'PLATFORM_SCOPE_DENIED'")).toBe(true);
    expect(body.includes("err.code === 'PERMISSION_DENIED'")).toBe(true);
    expect(body.includes('throw err')).toBe(true);
  });

  it('preserves the output contract (agentKey, action, product, completeness, readOnly, generatedAt)', () => {
    const body = bodyOf('execProductAgent');
    for (const key of ['agentKey', 'action', 'product', 'completeness', 'readOnly', 'generatedAt', 'score', 'issues', 'recommendation']) {
      expect(body.includes(key), key).toBe(true);
    }
    expect(body.includes('reasonAboutAgent(')).toBe(true);
    expect(body.includes('withProposal(')).toBe(true);
    expect(body.includes("'You are the WASIT Product Agent.'")).toBe(true);
  });
});

describe('G5 Phase 2 (A4) — the executor routes end-to-end through the gateway', () => {
  const product = findAgentSpec('product-agent')!;
  const GRANT = toolGrantForAgent(product);

  async function run(userId: string, roles: RoleName[], input: Record<string, unknown>, opts: FakeOptions) {
    const { db, whereParams, tablesRead, auditWrites } = makeFakeDb(opts);
    const res = await withAgentRunContext(
      ctx({ allowedTools: GRANT, requesterRoles: roles, requestedBy: userId }),
      () => executeAgentTask(db as never, product, { ...input, __userId: userId }),
    );
    const parsed = JSON.parse((res as { content: string }).content) as Record<string, unknown>;
    return { res, parsed, whereParams, tablesRead, auditWrites };
  }

  it('a customer reads a published product and gets the completeness contract', async () => {
    const { parsed } = await run(OWNER_A, ['CUSTOMER'], { action: 'analyze_product', productId: 'p-pub-a' }, {
      ownedSellerIds: [],
      products: CATALOGUE,
      variants: { 'p-pub-a': 2 },
      images: { 'p-pub-a': 1 },
      inventory: { 'p-pub-a': 5 },
    });
    expect(parsed.agentKey).toBe('product-agent');
    expect(parsed.readOnly).toBe(true);
    expect((parsed.product as { id: string }).id).toBe('p-pub-a');
    expect((parsed.product as { variants: number }).variants).toBe(2);
    expect((parsed.product as { images: number }).images).toBe(1);
    expect((parsed.product as { inventoryQty: number }).inventoryQty).toBe(5);
    expect(parsed).toHaveProperty('completeness');
  });

  it('a merchant reads its own draft but never another merchant\'s', async () => {
    const mine = await run(OWNER_A, ['MERCHANT'], { action: 'analyze_product', productId: 'p-draft-a' }, {
      ownedSellerIds: [ENT_A], products: CATALOGUE, variants: { 'p-draft-a': 1 }, images: {}, inventory: { 'p-draft-a': 1 },
    });
    expect((mine.parsed.product as { id: string }).id).toBe('p-draft-a');

    const theirs = await run(OWNER_A, ['MERCHANT'], { action: 'analyze_product', productId: 'p-draft-b' }, {
      ownedSellerIds: [ENT_A], products: CATALOGUE, variants: {}, images: {}, inventory: {},
    });
    expect(theirs.parsed.product).toBeUndefined();
    expect(theirs.parsed.error).toBeTruthy();
    expect(JSON.stringify(theirs.parsed)).not.toContain('G5P2 Secret Draft B');
  });

  it('forging productId or scope in the task input cannot widen the read', async () => {
    const { parsed } = await run(OWNER_A, ['CUSTOMER'], {
      action: 'analyze_product',
      productId: 'p-draft-b',
      // Every one of these is caller-controlled and must be ignored: the runner
      // overwrites __userId with the trusted requester, and scope keys are unused.
      __userId: OWNER_B,
      userId: OWNER_B,
      sellerId: ENT_B,
      isPublished: true,
    }, { ownedSellerIds: [], products: CATALOGUE, variants: {}, images: {}, inventory: {} });
    expect(parsed.product).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Draft B');
  });

  it('an admin reaches the platform tier across every owner', async () => {
    const { parsed } = await run('g5p2-product-admin', ['ADMIN'], { action: 'analyze_product', productId: 'p-draft-b' }, {
      ownedSellerIds: [], products: CATALOGUE, variants: {}, images: {}, inventory: {},
    });
    expect((parsed.product as { id: string }).id).toBe('p-draft-b');
  });

  it('a non-admin never widens to the platform tier (falls back to owned/public)', async () => {
    const { parsed, tablesRead } = await run(OWNER_A, ['MERCHANT'], { action: 'analyze_product', productId: 'p-draft-a' }, {
      ownedSellerIds: [ENT_A], products: CATALOGUE, variants: {}, images: {}, inventory: {},
    });
    expect((parsed.product as { id: string }).id).toBe('p-draft-a');
    // A catalogue read happened (owned/public), but the platform refusal is
    // recorded as a refused audit row, not a data read.
    expect(tablesRead).toContain('products');
  });

  it('a scheduler principal carrying admin roles still sees ONLY public data (never the platform tier)', async () => {
    // A trusted scheduled run executes with the scheduler's OWN admin roles
    // (`trustedPrincipalRoles()` = SUPER_ADMIN), which WOULD pass the gateway's
    // platform gate. The executor must skip the platform tier for the `system`
    // principal, so a scheduled run can never read another tenant's draft. The
    // original `execProductAgent` treated `system` as a non-admin too, so this
    // preserves the previous behaviour exactly (no refusal, public-only view).
    const { parsed, auditWrites } = await run('system', ['SUPER_ADMIN'], { action: 'analyze_product', productId: 'p-draft-b' }, {
      ownedSellerIds: [], products: CATALOGUE, variants: {}, images: {}, inventory: {},
    });
    expect(parsed.product).toBeUndefined();
    expect(parsed.error).toBeTruthy();
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Draft B');
    // The platform tool was never reached: the gateway audits every call, so no
    // audit row may reference it.
    const reached = auditWrites.filter((w) => w.entityId === PRODUCT_READ_PLATFORM);
    expect(reached).toHaveLength(0);
  });

  it('a non-refusal tool error is re-thrown, never swallowed', async () => {
    const { db } = makeFakeDb({ products: CATALOGUE, failOnDataRead: true, ownedSellerIds: [ENT_A] });
    await expect(
      withAgentRunContext(
        ctx({ allowedTools: GRANT, requesterRoles: ['MERCHANT'], requestedBy: OWNER_A }),
        () => executeAgentTask(db as never, product, { __userId: OWNER_A, productId: 'p-draft-a' }),
      ),
    ).rejects.toThrow();
  });
});

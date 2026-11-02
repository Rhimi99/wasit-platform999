import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AGENT_CATALOGUE, findAgentSpec, allAgentSpecs } from '../src/modules/ai/catalogue.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import {
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
 * G5 Phase 2 (A2) — unify `execMerchantAgent` behind the central Tool Gateway.
 *
 * The merchant agent's owned-entity read moves to a new registered, read-only,
 * OWNER-scoped tool (`merchant.read_owned`). The owner is resolved from the
 * trusted run context (`getAgentRunContext().requestedBy`), never from the args,
 * and an explicit `merchantId` is honoured only when the caller owns it.
 *
 * DB-FREE BY DESIGN. The batch forbids tests that open a database connection, so
 * this spec never imports `db/client`. Isolation and the identity rule are proven
 * by exercising the REAL Tool Gateway (`invokeTool`) against a recording fake that
 * stands in only at the drizzle boundary: the fake resolves the owner-scope query
 * from the SQL parameters the handler actually binds, so it proves what the
 * handler asks the database for — it never re-implements the handler's logic. A
 * real end-to-end run against the isolated test DB is deferred to a separately
 * approved batch (the run must not race `gm-agent-cycle`, which pauses
 * `merchant-agent` on the documented assumption that no other spec executes it).
 *
 * Every assertion is scoped to ids this file created in its fake.
 */

const dialect = new PgDialect();

type RoleName = 'MERCHANT' | 'SUPPLIER' | 'ADMIN';

interface OwnedEntityRow {
  id: string;
  seller_type: 'SUPPLIER' | 'MERCHANT' | 'COMPANY';
  name: string;
}

interface MerchantRow {
  id: string;
  userId: string;
  storeName: string;
  countryId: string | null;
  verified: boolean;
  isActive: boolean;
}

/**
 * A recording stand-in for the drizzle `DB` boundary. `execute` returns the
 * caller's owned entities (what `listOwnedSellerEntities` selects); the select
 * chain resolves the merchant table from the SQL parameters the handler binds, so
 * a test can see exactly which ids the handler scoped the read to.
 */
function makeFakeDb(ownedEntities: OwnedEntityRow[], merchants: MerchantRow[]) {
  const whereParams: unknown[][] = [];
  const limits: number[] = [];
  const auditWrites: Record<string, unknown>[] = [];

  const db = {
    execute: async () => ({ rows: ownedEntities }),
    select: () => ({
      from: () => ({
        where: (cond: unknown) => ({
          limit: (n: number) => {
            const { params } = dialect.sqlToQuery(cond as never);
            whereParams.push(params);
            limits.push(n);
            const ids = params.filter((p): p is string => typeof p === 'string');
            return Promise.resolve(
              merchants
                .filter((m) => ids.includes(m.id))
                .slice(0, n)
                .map((m) => ({
                  id: m.id,
                  storeName: m.storeName,
                  countryId: m.countryId,
                  verified: m.verified,
                  isActive: m.isActive,
                })),
            );
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        auditWrites.push(v);
      },
    }),
  };

  return { db, whereParams, limits, auditWrites };
}

function ctx(overrides: {
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
  agentKey?: string;
}) {
  return {
    taskId: `g5p2-merchant-ctx-${Math.random().toString(36).slice(2)}`,
    agentKey: overrides.agentKey ?? 'merchant-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['MERCHANT']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p2-merchant-operator',
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

const OWNER_A = 'g5p2-merchant-owner-a';
const OWNER_B = 'g5p2-merchant-owner-b';

describe('G5 Phase 2 (A2) — the tool is registered, read-only and owner-scoped', () => {
  it('registers merchant.read_owned with a bound handler', () => {
    const tool = findTool(MERCHANT_READ_OWN);
    expect(tool, MERCHANT_READ_OWN).toBeTruthy();
    expect(tool?.effect).toBe('read');
    expect(tool?.platformScoped).toBe(false);
    expect(tool?.permission).toBe('ai:use');
    expect(isRegisteredTool(MERCHANT_READ_OWN)).toBe(true);
    expect(registeredToolIds()).toContain(MERCHANT_READ_OWN);
    expect(getToolHandler(MERCHANT_READ_OWN)).toBeTruthy();
  });

  it('is registered, not left in the unbound list', () => {
    expect(UNBOUND_DECLARED_TOOLS).not.toContain(MERCHANT_READ_OWN);
  });

  it('uses a strict schema that accepts only merchantId/limit', () => {
    const tool = findTool(MERCHANT_READ_OWN)!;
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
    expect(tool.inputSchema.safeParse({ merchantId: 'm-1', limit: 5 }).success).toBe(true);
    // Unknown keys are rejected outright (no identity/scope injection).
    expect(tool.inputSchema.safeParse({ requestedBy: 'victim' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ userId: 'victim' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ scope: 'platform' }).success).toBe(false);
    // Bound checks.
    expect(tool.inputSchema.safeParse({ merchantId: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ merchantId: 'x'.repeat(65) }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });
});

describe('G5 Phase 2 (A2) — the gateway fails closed (no handler reached)', () => {
  it('refuses when there is no trusted run context', async () => {
    const { db } = makeFakeDb([], []);
    await expectRefusal(invokeTool(db as never, MERCHANT_READ_OWN, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted', async () => {
    const { db } = makeFakeDb([], []);
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db as never, MERCHANT_READ_OWN, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('refuses a run granted only the supplier tool (no cross-tool widening)', async () => {
    const { db } = makeFakeDb([], []);
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SUPPLIER_READ_OWN] }), () =>
        invokeTool(db as never, MERCHANT_READ_OWN, {}),
      ),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    const { db } = makeFakeDb([], []);
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MERCHANT_READ_OWN] }), () =>
        invokeTool(db as never, MERCHANT_READ_OWN, { requestedBy: 'victim', userId: 'victim', scope: 'platform' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('rejects an out-of-range limit', async () => {
    const { db } = makeFakeDb([], []);
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MERCHANT_READ_OWN] }), () =>
        invokeTool(db as never, MERCHANT_READ_OWN, { limit: 9999 }),
      ),
      'INVALID_INPUT',
    );
  });
});

describe('G5 Phase 2 (A2) — the caller reads only their own merchant', () => {
  const MERCHANTS: MerchantRow[] = [
    { id: 'm-a', userId: OWNER_A, storeName: 'G5P2 A Store', countryId: 'TN', verified: true, isActive: true },
    { id: 'm-b', userId: OWNER_B, storeName: 'G5P2 B Store', countryId: 'FR', verified: false, isActive: true },
  ];

  it('returns the caller\'s own merchant, and never a supplier/company they also own', async () => {
    const { db, whereParams } = makeFakeDb(
      [
        { id: 'm-a', seller_type: 'MERCHANT', name: 'G5P2 A Store' },
        { id: 'sup-a', seller_type: 'SUPPLIER', name: 'G5P2 A Supplier' },
        { id: 'co-a', seller_type: 'COMPANY', name: 'G5P2 A Company' },
      ],
      MERCHANTS,
    );

    const out = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(db as never, MERCHANT_READ_OWN, {}),
    );

    expect(out.data.scope).toBe('own');
    expect(out.data.scopedToOwned).toBe(true);
    const rows = out.data.merchants as { id: string; name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m-a');
    expect(rows[0].name).toBe('G5P2 A Store');
    // The read was scoped to the owned MERCHANT only — the owned SUPPLIER/COMPANY
    // ids were never bound into the query.
    expect(whereParams).toHaveLength(1);
    expect(whereParams[0]).toEqual(['m-a']);
  });

  it('never leaks another tenant\'s merchant', async () => {
    const a = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(makeFakeDb([{ id: 'm-a', seller_type: 'MERCHANT', name: 'A' }], MERCHANTS).db as never, MERCHANT_READ_OWN, {}),
    );
    const b = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_B }),
      () => invokeTool(makeFakeDb([{ id: 'm-b', seller_type: 'MERCHANT', name: 'B' }], MERCHANTS).db as never, MERCHANT_READ_OWN, {}),
    );
    expect((a.data.merchants as { id: string }[]).map((m) => m.id)).toEqual(['m-a']);
    expect((b.data.merchants as { id: string }[]).map((m) => m.id)).toEqual(['m-b']);
  });

  it('an explicit id the caller OWNS is returned', async () => {
    const { db, whereParams } = makeFakeDb([{ id: 'm-a', seller_type: 'MERCHANT', name: 'A' }], MERCHANTS);
    const out = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(db as never, MERCHANT_READ_OWN, { merchantId: 'm-a' }),
    );
    expect(out.data.found).toBe(true);
    expect(out.data.scopedToOwned).toBe(false);
    const rows = out.data.merchants as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m-a');
    expect(whereParams[0]).toEqual(['m-a']);
  });

  it('an explicit id the caller does NOT own yields an empty scope and no query', async () => {
    const { db, whereParams } = makeFakeDb([{ id: 'm-a', seller_type: 'MERCHANT', name: 'A' }], MERCHANTS);
    const out = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(db as never, MERCHANT_READ_OWN, { merchantId: 'm-b' }),
    );
    expect(out.data.found).toBe(false);
    expect(out.data.scopedToOwned).toBe(false);
    expect(out.data.merchants).toHaveLength(0);
    // An unowned id is never even queried (no cross-tenant read is attempted).
    expect(whereParams).toHaveLength(0);
  });

  it('resolves the owner from the trusted context, ignoring a forged identity in the args', async () => {
    const { db, whereParams } = makeFakeDb([{ id: 'm-a', seller_type: 'MERCHANT', name: 'A' }], MERCHANTS);
    // The run executes as OWNER_A; a forged identity in the args is impossible
    // (strict schema) and the context identity is what the handler uses.
    const out = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(db as never, MERCHANT_READ_OWN, {}),
    );
    expect((out.data.merchants as { id: string }[]).map((m) => m.id)).toEqual(['m-a']);
    expect(whereParams[0]).toEqual(['m-a']);
  });

  it('returns an empty scope for a caller who owns no merchant', async () => {
    const { db, whereParams } = makeFakeDb([], MERCHANTS);
    const out = await withAgentRunContext(
      ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }),
      () => invokeTool(db as never, MERCHANT_READ_OWN, {}),
    );
    expect(out.data.merchants).toHaveLength(0);
    expect(whereParams).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A2) — limit bounds and read-only audit', () => {
  const MERCHANTS: MerchantRow[] = [
    { id: 'm-1', userId: OWNER_A, storeName: 'S1', countryId: null, verified: false, isActive: true },
    { id: 'm-2', userId: OWNER_A, storeName: 'S2', countryId: null, verified: false, isActive: true },
    { id: 'm-3', userId: OWNER_A, storeName: 'S3', countryId: null, verified: false, isActive: true },
  ];
  const OWNED: OwnedEntityRow[] = MERCHANTS.map((m) => ({ id: m.id, seller_type: 'MERCHANT', name: m.storeName }));

  it('defaults the limit to 10 when none is supplied', async () => {
    const { db, limits } = makeFakeDb(OWNED, MERCHANTS);
    await withAgentRunContext(ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MERCHANT_READ_OWN, {}),
    );
    expect(limits).toEqual([10]);
  });

  it('honours an explicit in-range limit', async () => {
    const { db, limits } = makeFakeDb(OWNED, MERCHANTS);
    const out = await withAgentRunContext(ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MERCHANT_READ_OWN, { limit: 2 }),
    );
    expect(limits).toEqual([2]);
    expect((out.data.merchants as unknown[]).length).toBe(2);
  });

  it('records an AI.TOOL_EXECUTED audit row for the invocation', async () => {
    const { db, auditWrites } = makeFakeDb(OWNED, MERCHANTS);
    const c = ctx({ allowedTools: [MERCHANT_READ_OWN], requestedBy: OWNER_A });
    await withAgentRunContext(c, () => invokeTool(db as never, MERCHANT_READ_OWN, {}));
    const executed = auditWrites.filter((w) => w.action === 'AI.TOOL_EXECUTED');
    expect(executed).toHaveLength(1);
    expect(executed[0].entityId).toBe(MERCHANT_READ_OWN);
  });
});

describe('G5 Phase 2 (A2) — the tool is granted to merchant-agent ONLY', () => {
  it('grants merchant.read_owned to merchant-agent and no other agent', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      if (agent.key === 'merchant-agent') expect(grant, agent.key).toContain(MERCHANT_READ_OWN);
      else expect(grant, agent.key).not.toContain(MERCHANT_READ_OWN);
    }
  });

  it('does not touch the shared CATALOG_TOOLS group (marketing/product/supplier unchanged)', () => {
    const merchant = findAgentSpec('merchant-agent')!;
    expect(merchant.allowedTools).toEqual([
      'platform.read_catalog',
      'platform.metrics',
      'report.generate',
      MERCHANT_READ_OWN,
    ]);
    for (const key of ['marketing-agent', 'product-agent', 'supplier-agent']) {
      expect(toolGrantForAgent(findAgentSpec(key)!), key).not.toContain(MERCHANT_READ_OWN);
    }
    // The supplier tool stays with the supplier agent alone.
    expect(toolGrantForAgent(findAgentSpec('supplier-agent')!)).toContain(SUPPLIER_READ_OWN);
    expect(toolGrantForAgent(merchant)).not.toContain(SUPPLIER_READ_OWN);
  });

  it('does not change merchant-agent permissions, scope or approval declarations', () => {
    const merchant = findAgentSpec('merchant-agent')!;
    expect(merchant.permissionsRequired).toEqual(['ai:use']);
    expect(merchant.requiresPlatformScope).not.toBe(true);
    expect(merchant.approvalActions).toEqual([]);
    expect(merchant.requiresHumanApproval).toBe(false);
  });

  it('keeps the catalogue internally consistent (keys unique, permissions present)', () => {
    const specs = allAgentSpecs();
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of specs) expect(s.permissionsRequired.length, s.key).toBeGreaterThan(0);
  });
});

describe('G5 Phase 2 (A2) — execMerchantAgent routes through the gateway (source contract)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');

  function bodyOf(name: string): string {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('reads ONLY through invokeTool (no direct query, no owned-entity helper)', () => {
    const body = bodyOf('execMerchantAgent');
    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes('MERCHANT_READ_OWN')).toBe(true);
    expect(body.includes('.from(')).toBe(false);
    expect(body.includes('listOwnedSellerEntities(')).toBe(false);
    expect(body.includes('requirePlatformGate(')).toBe(false);
  });

  it('preserves the exact output contract of the former direct read', () => {
    const body = bodyOf('execMerchantAgent');
    for (const key of ['agentKey', 'action', 'scopedToOwned', 'merchants', 'note', 'readOnly', 'generatedAt']) {
      expect(body.includes(key), key).toBe(true);
    }
    // scopedToOwned stays `!requestedId` (true for an owned-list read, false for
    // any explicit-id read — owned or not), matching the old executor exactly.
    expect(body.includes('scopedToOwned: !requestedId')).toBe(true);
    // The not-found note is unchanged, verbatim.
    expect(body.includes("'Merchant not found in your scope.'")).toBe(true);
    expect(body.includes("'Review completeness and verification status.'")).toBe(true);
    // The per-field shape of a merchant row is unchanged (name ← storeName).
    for (const field of ['id', 'name', 'countryId', 'verified', 'isActive']) {
      expect(body.includes(field), field).toBe(true);
    }
    // Reasoning and proposal composition are unchanged.
    expect(body.includes('reasonAboutAgent(')).toBe(true);
    expect(body.includes('withProposal(')).toBe(true);
    expect(body.includes("'You are the WASIT Merchant Agent.'")).toBe(true);
    expect(body.includes("adviceText('Merchant review: {{count}} record(s) in scope.'")).toBe(true);
  });
});

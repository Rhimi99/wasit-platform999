import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AGENT_CATALOGUE, SENSITIVE_ACTIONS, findAgentSpec, allAgentSpecs } from '../src/modules/ai/catalogue.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { executeAgentTask } from '../src/modules/ai/executors.js';
import {
  MARKETING_READ_CATALOGUE_OWNED,
  MARKETING_READ_CATALOGUE_PLATFORM,
  MARKETING_READ_VIDEOS_OWNED,
  PRODUCT_READ_PUBLIC,
  PRODUCT_READ_OWNED,
  SUPPLIER_READ_OWN,
  UNBOUND_DECLARED_TOOLS,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';

/**
 * G5 Phase 2 (A5) — unify `execMarketingAgent` behind the central Tool Gateway.
 *
 * The marketing agent surfaces two things: a catalogue snapshot (platform-wide
 * for an admin, otherwise scoped to the seller entities the caller owns) and the
 * caller's OWN generated marketing videos. Each is served by a registered,
 * read-only tool — `marketing.read_catalogue_owned`, `marketing.read_catalogue_platform`
 * (admin-only) and `marketing.read_videos_owned` — instead of a direct query. The
 * owner is resolved from the trusted run context (`getAgentRunContext().requestedBy`),
 * never the args. No campaign/ad-spend write is introduced.
 *
 * DB-FREE BY DESIGN. This spec never imports `db/client`; the batch forbids tests
 * that open a database connection. Isolation, the identity rule, the admin gate
 * and the exact output contract are proven by exercising the REAL Tool Gateway
 * (`invokeTool`) and the REAL executor (`executeAgentTask`) against a recording
 * fake that stands in only at the drizzle boundary: it resolves each query from
 * the SELECT shape and the SQL parameters the handler actually binds, so it
 * proves what the handler asks the database for — it never re-implements the
 * handler's logic. A real end-to-end run against the isolated test DB is deferred
 * to a separately approved batch.
 *
 * Every assertion is scoped to ids this file created in its fake.
 */

const dialect = new PgDialect();

// The tables whose reads carry tenant data (vs. the AI bookkeeping tables the
// reasoning path touches, which the fake answers with empty/zero rows).
const DATA_TABLES = new Set(['products', 'categories', 'media_assets']);

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'SUPPLIER' | 'SUPPORT' | 'CUSTOMER';

interface CatalogueRow {
  id: string;
  sellerId: string;
  categoryName: string | null;
  brand: string | null;
  isPublished: boolean;
}

interface MediaRow {
  id: string;
  ownerUserId: string;
  kind: string;
  status: string;
  title: string;
  productId: string | null;
  campaignId: string | null;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  provider: string;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeOptions {
  /** Owned seller-entity ids returned by `resolveOwnedSellerIds`. */
  ownedSellerIds?: string[];
  /** The published catalogue the fake serves, filtered by the predicate bound. */
  catalogue?: CatalogueRow[];
  /** Media assets the fake serves, filtered by owner + kind. */
  media?: MediaRow[];
  failOnDataRead?: boolean;
}

const OWNER_A = 'g5p2-marketing-owner-a';
const OWNER_B = 'g5p2-marketing-owner-b';
const ENT_A = 'g5p2-marketing-ent-a';
const ENT_B = 'g5p2-marketing-ent-b';

/** The published catalogue used across the executor-level specs. */
const CATALOGUE: CatalogueRow[] = [
  { id: 'm-pub-a', sellerId: ENT_A, categoryName: 'G5P2 Cat A', brand: 'BrandA', isPublished: true },
  { id: 'm-pub-a2', sellerId: ENT_A, categoryName: 'G5P2 Cat A', brand: null, isPublished: true },
  { id: 'm-pub-b', sellerId: ENT_B, categoryName: 'G5P2 Cat B', brand: 'BrandB', isPublished: true },
  { id: 'm-draft-b', sellerId: ENT_B, categoryName: 'G5P2 Secret Cat B', brand: 'BrandB', isPublished: false },
];

function mediaRow(over: Partial<MediaRow> & { id: string; ownerUserId: string; title: string }): MediaRow {
  return {
    kind: 'MARKETING_VIDEO',
    status: 'READY',
    productId: null,
    campaignId: null,
    mimeType: 'video/mp4',
    extension: 'mp4',
    sizeBytes: 1024,
    durationSeconds: 12,
    width: 640,
    height: 360,
    provider: 'structural',
    language: 'ar',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

const MEDIA: MediaRow[] = [
  mediaRow({ id: 'mv-a', ownerUserId: OWNER_A, title: 'G5P2 Owner A Video' }),
  mediaRow({ id: 'mv-b', ownerUserId: OWNER_B, title: 'G5P2 Secret Owner B Video' }),
];

/**
 * A recording stand-in for the drizzle `DB` boundary. `execute` answers
 * `resolveOwnedSellerIds` (the caller's owned seller-entity ids); the select
 * chain resolves each table from the SELECT shape and the SQL predicate the
 * handler binds, so a test can see exactly which scope the handler asked for
 * without re-implementing it.
 */
function makeFakeDb(opts: FakeOptions) {
  const whereParams: { table: string; params: unknown[]; sql: string }[] = [];
  const auditWrites: Record<string, unknown>[] = [];
  const tablesRead: string[] = [];

  function catalogueRows(cond: unknown): { tier: 'owned' | 'platform'; rows: CatalogueRow[] } {
    const sqlText = cond === undefined ? '' : dialect.sqlToQuery(cond as never).sql;
    const params = cond === undefined ? [] : dialect.sqlToQuery(cond as never).params;
    const owned = params.filter((p): p is string => typeof p === 'string' && (opts.ownedSellerIds ?? []).includes(p));
    const isOwned = sqlText.includes('seller_id');
    const rows = (opts.catalogue ?? []).filter((r) => r.isPublished && (!isOwned || owned.includes(r.sellerId)));
    return { tier: isOwned ? 'owned' : 'platform', rows };
  }

  function rowsFor(table: string, cond: unknown, cols: Record<string, unknown> | undefined): unknown[] {
    switch (table) {
      case 'products': {
        const { rows } = catalogueRows(cond);
        const keys = Object.keys(cols ?? {});
        // The handler issues three shapes over `products`: a `count(*)` (key `v`),
        // a category grouping (key `category`) and a brand grouping (key `brand`).
        if (keys.includes('v')) return [{ v: rows.length }];
        if (keys.includes('category')) {
          const byCat = new Map<string, number>();
          for (const r of rows) {
            const k = r.categoryName ?? 'Uncategorised';
            byCat.set(k, (byCat.get(k) ?? 0) + 1);
          }
          return [...byCat.entries()]
            .map(([category, p]) => ({ category, p }))
            .sort((a, b) => b.p - a.p);
        }
        if (keys.includes('brand')) {
          const byBrand = new Map<string, number>();
          for (const r of rows) {
            if (r.brand === null) continue;
            byBrand.set(r.brand, (byBrand.get(r.brand) ?? 0) + 1);
          }
          return [...byBrand.entries()].map(([brand, p]) => ({ brand, p })).sort((a, b) => b.p - a.p);
        }
        return rows;
      }
      case 'categories':
        return [];
      case 'media_assets': {
        const params = cond === undefined ? [] : dialect.sqlToQuery(cond as never).params;
        const owner = params.find((p): p is string => typeof p === 'string' && (opts.media ?? []).some((m) => m.ownerUserId === p));
        return (opts.media ?? [])
          .filter((m) => (owner ? m.ownerUserId === owner : true) && m.kind === 'MARKETING_VIDEO')
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      case 'ai_requests':
        return [{ requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' }];
      default:
        return [];
    }
  }

  const db = {
    execute: async () => ({ rows: (opts.ownedSellerIds ?? []).map((id) => ({ id })) }),
    select: (cols?: Record<string, unknown>) => ({
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
          return rowsFor(name, cond, cols);
        };
        const q = (cond?: unknown) => {
          const p = Promise.resolve(collect(cond));
          const limit = (n: number) => p.then((rows) => rows.slice(0, n));
          const orderBy = () => ({ limit });
          const groupBy = () => ({ orderBy, limit });
          return Object.assign(p, { limit, orderBy, groupBy });
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
    taskId: `g5p2-marketing-ctx-${Math.random().toString(36).slice(2)}`,
    agentKey: overrides.agentKey ?? 'marketing-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['MERCHANT']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p2-marketing-operator',
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

const MARKETING_TOOLS = [MARKETING_READ_CATALOGUE_OWNED, MARKETING_READ_CATALOGUE_PLATFORM, MARKETING_READ_VIDEOS_OWNED];

describe('G5 Phase 2 (A5) — the marketing tools are registered, read-only and bound', () => {
  it('registers the three marketing tools with bound handlers', () => {
    for (const id of MARKETING_TOOLS) {
      const tool = findTool(id);
      expect(tool, id).toBeTruthy();
      expect(tool?.effect, id).toBe('read');
      expect(isRegisteredTool(id), id).toBe(true);
      expect(registeredToolIds(), id).toContain(id);
      expect(getToolHandler(id), id).toBeTruthy();
      expect(UNBOUND_DECLARED_TOOLS, id).not.toContain(id);
    }
  });

  it('scopes the tools exactly as designed (owner / platform / videos)', () => {
    expect(findTool(MARKETING_READ_CATALOGUE_OWNED)?.platformScoped).toBe(false);
    expect(findTool(MARKETING_READ_CATALOGUE_OWNED)?.permission).toBe('ai:use');
    expect(findTool(MARKETING_READ_CATALOGUE_PLATFORM)?.platformScoped).toBe(true);
    expect(findTool(MARKETING_READ_CATALOGUE_PLATFORM)?.permission).toBe('analytics:read:all');
    expect(findTool(MARKETING_READ_VIDEOS_OWNED)?.platformScoped).toBe(false);
    expect(findTool(MARKETING_READ_VIDEOS_OWNED)?.permission).toBe('ai:use');
  });

  it('uses strict schemas that accept only a bounded limit (no identity/scope injection)', () => {
    for (const id of MARKETING_TOOLS) {
      const tool = findTool(id)!;
      expect(tool.inputSchema.safeParse({}).success, id).toBe(true);
      expect(tool.inputSchema.safeParse({ limit: 3 }).success, id).toBe(true);
      for (const bad of [{ requestedBy: 'victim' }, { userId: 'victim' }, { scope: 'platform' }, { sellerId: 'x' }]) {
        expect(tool.inputSchema.safeParse(bad).success, `${id}:${JSON.stringify(bad)}`).toBe(false);
      }
      // Bounded: the agent has always clamped to 10.
      expect(tool.inputSchema.safeParse({ limit: 0 }).success, id).toBe(false);
      expect(tool.inputSchema.safeParse({ limit: 11 }).success, id).toBe(false);
    }
  });
});

describe('G5 Phase 2 (A5) — the gateway fails closed (no handler reached)', () => {
  it('refuses when there is no trusted run context', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('refuses a run granted only a sibling agent tool (no cross-tool widening)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SUPPLIER_READ_OWN] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}),
      ),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, { requestedBy: 'victim', userId: 'victim', scope: 'platform' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('rejects an out-of-range limit', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, { limit: 11 }),
      ),
      'INVALID_INPUT',
    );
  });

  it('denies a role that lacks the tool permission', async () => {
    const { db } = makeFakeDb({});
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED], requesterRoles: [] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}),
      ),
      'PERMISSION_DENIED',
    );
  });

  it('denies the platform tool to a permission-holding non-admin (before any handler runs)', async () => {
    // SUPPORT holds `analytics:read:all` but is NOT an admin, so it clears the
    // permission gate and is refused by the platform-scope gate.
    const { db, tablesRead } = makeFakeDb({ catalogue: CATALOGUE });
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_PLATFORM], requesterRoles: ['SUPPORT'] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_PLATFORM, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
    // The refusal precedes the handler: no catalogue query was issued.
    expect(tablesRead).toHaveLength(0);
  });

  it('denies the platform tool to a role lacking its permission', async () => {
    const { db, tablesRead } = makeFakeDb({ catalogue: CATALOGUE });
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_PLATFORM], requesterRoles: ['MERCHANT'] }), () =>
        invokeTool(db as never, MARKETING_READ_CATALOGUE_PLATFORM, {}),
      ),
      'PERMISSION_DENIED',
    );
    expect(tablesRead).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A5) — the owner catalogue snapshot reads only the caller\'s own listings', () => {
  it('returns the caller\'s own published aggregates and never another tenant\'s', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: [ENT_A], catalogue: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}),
    );
    expect(out.data.scope).toBe('own');
    const snap = out.data.snapshot as { published: number; topCategories: { name: string }[]; topBrands: { name: string }[] };
    // Only ENT_A's two published rows.
    expect(snap.published).toBe(2);
    expect(JSON.stringify(snap)).not.toContain('G5P2 Cat B');
    expect(JSON.stringify(snap)).not.toContain('G5P2 Secret Cat B');
    // The owned scope bound ENT_A (from the context), never a caller-supplied id.
    const owned = whereParams.find((w) => w.table === 'products' && w.sql.includes('seller_id'));
    expect(owned?.params).toContain(ENT_A);
    expect(owned?.params).not.toContain(ENT_B);
  });

  it('returns an empty scope (and runs no query) for a caller who owns no seller entity', async () => {
    const { db, whereParams, tablesRead } = makeFakeDb({ ownedSellerIds: [], catalogue: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}),
    );
    expect(out.data.noScope).toBe(true);
    expect((out.data.snapshot as { published: number }).published).toBe(0);
    expect(whereParams.filter((w) => w.table === 'products')).toHaveLength(0);
    expect(tablesRead).toHaveLength(0);
  });

  it('the scheduler principal is never treated as an owner', async () => {
    const { db, whereParams } = makeFakeDb({ ownedSellerIds: [ENT_A], catalogue: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_OWNED], requestedBy: 'system' }), () =>
      invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {}),
    );
    expect(out.data.noScope).toBe(true);
    expect(whereParams.filter((w) => w.table === 'products')).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A5) — the platform catalogue snapshot is admin-only', () => {
  it('an admin reads the published catalogue across every seller', async () => {
    const { db } = makeFakeDb({ catalogue: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_PLATFORM], requesterRoles: ['ADMIN'] }), () =>
      invokeTool(db as never, MARKETING_READ_CATALOGUE_PLATFORM, {}),
    );
    expect(out.data.scope).toBe('platform');
    // Every published row (3), never the unpublished draft.
    expect((out.data.snapshot as { published: number }).published).toBe(3);
    expect(JSON.stringify(out.data)).not.toContain('G5P2 Secret Cat B');
  });

  it('a super-admin is admitted', async () => {
    const { db } = makeFakeDb({ catalogue: CATALOGUE });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_CATALOGUE_PLATFORM], requesterRoles: ['SUPER_ADMIN'] }), () =>
      invokeTool(db as never, MARKETING_READ_CATALOGUE_PLATFORM, {}),
    );
    expect(out.data.scope).toBe('platform');
  });
});

describe('G5 Phase 2 (A5) — the videos tool reads only the caller\'s own media', () => {
  it('returns the caller\'s own marketing videos and never another user\'s', async () => {
    const { db, whereParams } = makeFakeDb({ media: MEDIA });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_VIDEOS_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MARKETING_READ_VIDEOS_OWNED, {}),
    );
    expect(out.data.scope).toBe('own');
    const videos = out.data.videos as { id: string; title: string; previewable: boolean; downloadable: boolean }[];
    expect(videos.map((v) => v.id)).toEqual(['mv-a']);
    expect(JSON.stringify(videos)).not.toContain('G5P2 Secret Owner B Video');
    // A READY asset carries previewable/downloadable flags and signed URLs.
    expect(videos[0].previewable).toBe(true);
    expect(videos[0].downloadable).toBe(true);
    const bound = whereParams.find((w) => w.table === 'media_assets');
    expect(bound?.params).toContain(OWNER_A);
    expect(bound?.params).not.toContain(OWNER_B);
  });

  it('resolves the owner from the trusted context, ignoring a forged identity in the args', async () => {
    const { db, whereParams } = makeFakeDb({ media: MEDIA });
    // A caller-supplied `userId` is not a schema field: the strict schema refuses
    // it outright, so a forged identity can never reach the handler at all.
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_VIDEOS_OWNED], requestedBy: OWNER_A }), () =>
        invokeTool(db as never, MARKETING_READ_VIDEOS_OWNED, { userId: OWNER_B }),
      ),
      'INVALID_INPUT',
    );
    expect(whereParams.filter((w) => w.table === 'media_assets')).toHaveLength(0);
  });

  it('a caller with no trustworthy identity runs no query and gets an empty list', async () => {
    const { db, whereParams, tablesRead } = makeFakeDb({ media: MEDIA });
    const out = await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_VIDEOS_OWNED], requestedBy: 'system' }), () =>
      invokeTool(db as never, MARKETING_READ_VIDEOS_OWNED, {}),
    );
    expect(out.data.videos).toEqual([]);
    expect(whereParams.filter((w) => w.table === 'media_assets')).toHaveLength(0);
    expect(tablesRead).toHaveLength(0);
  });
});

describe('G5 Phase 2 (A5) — isolation: the marketing tools never touch ads/campaigns/reports', () => {
  it('reads only products/categories/media_assets', async () => {
    const { db, tablesRead } = makeFakeDb({ ownedSellerIds: [ENT_A], catalogue: CATALOGUE, media: MEDIA });
    await withAgentRunContext(
      ctx({ allowedTools: MARKETING_TOOLS, requesterRoles: ['ADMIN'], requestedBy: OWNER_A }),
      async () => {
        await invokeTool(db as never, MARKETING_READ_CATALOGUE_OWNED, {});
        await invokeTool(db as never, MARKETING_READ_CATALOGUE_PLATFORM, {});
        await invokeTool(db as never, MARKETING_READ_VIDEOS_OWNED, {});
      },
    );
    for (const t of tablesRead) expect(DATA_TABLES.has(t), t).toBe(true);
    // No advertising/campaign/report table was ever read.
    expect(tablesRead).not.toContain('campaigns');
    expect(tablesRead).not.toContain('ad_events');
    expect(tablesRead).not.toContain('ads');
  });
});

describe('G5 Phase 2 (A5) — read-only audit', () => {
  it('records an AI.TOOL_EXECUTED audit row for the invocation', async () => {
    const { db, auditWrites } = makeFakeDb({ media: MEDIA });
    await withAgentRunContext(ctx({ allowedTools: [MARKETING_READ_VIDEOS_OWNED], requestedBy: OWNER_A }), () =>
      invokeTool(db as never, MARKETING_READ_VIDEOS_OWNED, {}),
    );
    const executed = auditWrites.filter((w) => w.action === 'AI.TOOL_EXECUTED');
    expect(executed).toHaveLength(1);
    expect(executed[0].entityId).toBe(MARKETING_READ_VIDEOS_OWNED);
  });
});

describe('G5 Phase 2 (A5) — the tools are granted to marketing-agent ONLY', () => {
  it('grants the marketing tools to marketing-agent and no other agent', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      for (const id of MARKETING_TOOLS) {
        if (agent.key === 'marketing-agent') expect(grant, `${agent.key}:${id}`).toContain(id);
        else expect(grant, `${agent.key}:${id}`).not.toContain(id);
      }
    }
  });

  it('does not touch the shared CATALOG_TOOLS group (product/supplier/merchant unchanged)', () => {
    const marketing = findAgentSpec('marketing-agent')!;
    expect(marketing.allowedTools).toEqual([
      'platform.read_catalog',
      'platform.metrics',
      'report.generate',
      MARKETING_READ_CATALOGUE_OWNED,
      MARKETING_READ_CATALOGUE_PLATFORM,
      MARKETING_READ_VIDEOS_OWNED,
    ]);
    for (const key of ['product-agent', 'supplier-agent', 'merchant-agent']) {
      const grant = toolGrantForAgent(findAgentSpec(key)!);
      expect(grant, key).not.toContain(MARKETING_READ_CATALOGUE_OWNED);
      expect(grant, key).not.toContain(MARKETING_READ_CATALOGUE_PLATFORM);
      expect(grant, key).not.toContain(MARKETING_READ_VIDEOS_OWNED);
    }
  });

  it('leaves A1/A2/A3/A4 tools granted to their own agents only (no regression)', () => {
    expect(toolGrantForAgent(findAgentSpec('supplier-agent')!)).not.toContain(MARKETING_READ_CATALOGUE_OWNED);
    expect(toolGrantForAgent(findAgentSpec('product-agent')!)).not.toContain(MARKETING_READ_CATALOGUE_PLATFORM);
    const marketing = toolGrantForAgent(findAgentSpec('marketing-agent')!);
    expect(marketing).not.toContain(PRODUCT_READ_PUBLIC);
    expect(marketing).not.toContain(PRODUCT_READ_OWNED);
    expect(marketing).not.toContain(SUPPLIER_READ_OWN);
  });

  it('does not change marketing-agent permissions, scope or approval declarations', () => {
    const marketing = findAgentSpec('marketing-agent')!;
    expect(marketing.permissionsRequired).toEqual(['ai:use']);
    expect(marketing.requiresPlatformScope).not.toBe(true);
    expect(marketing.approvalActions).toEqual([]);
    expect(marketing.requiresHumanApproval).toBe(false);
  });

  it('introduces no write tool and preserves the sensitive-action approvals', () => {
    for (const id of MARKETING_TOOLS) expect(findTool(id)?.effect, id).toBe('read');
    // The marketing agent still declares no approval action, and the sensitive
    // action list (which gates campaign spend / deploys / money) is untouched.
    expect(findAgentSpec('marketing-agent')!.approvalActions).toEqual([]);
    expect(SENSITIVE_ACTIONS.has('ads.spend_increase')).toBe(true);
    expect(SENSITIVE_ACTIONS.has('finance.payout')).toBe(true);
  });

  it('keeps the catalogue internally consistent (keys unique, permissions present)', () => {
    const specs = allAgentSpecs();
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of specs) expect(s.permissionsRequired.length, s.key).toBeGreaterThan(0);
  });
});

describe('G5 Phase 2 (A5) — execMarketingAgent routes through the gateway (source contract)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');

  function bodyOf(name: string): string {
    const start = SRC.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  it('reads ONLY through invokeTool (no direct query, no legacy helper)', () => {
    const body = bodyOf('execMarketingAgent');
    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes(MARKETING_READ_CATALOGUE_OWNED)).toBe(true);
    expect(body.includes(MARKETING_READ_CATALOGUE_PLATFORM)).toBe(true);
    expect(body.includes(MARKETING_READ_VIDEOS_OWNED)).toBe(true);
    // No direct drizzle read: the only `.from(` in the body is `Array.from(`, so
    // the body must contain no `db.select` / `.from(products)` style query.
    expect(body.includes('db.select(')).toBe(false);
    expect(body.includes('.from(products)')).toBe(false);
    expect(body.includes('.from(categories)')).toBe(false);
    expect(body.includes('.from(mediaAssets)')).toBe(false);
    expect(body.includes('listRecentMarketingVideos(')).toBe(false);
    expect(body.includes('canReadPlatformData(')).toBe(false);
    expect(body.includes('resolveOwnedSellerIds(')).toBe(false);
    expect(body.includes('requirePlatformGate(')).toBe(false);
    // Only the known scope/permission refusals are swallowed; anything else is
    // re-thrown (never a silent fallback).
    expect(body.includes("err.code === 'PLATFORM_SCOPE_DENIED'")).toBe(true);
    expect(body.includes("err.code === 'PERMISSION_DENIED'")).toBe(true);
    expect(body.includes('throw err')).toBe(true);
  });

  it('preserves the output contract (agentKey, action, snapshot, campaignSuggestion, marketingVideos, readOnly, generatedAt)', () => {
    const body = bodyOf('execMarketingAgent');
    for (const key of [
      'agentKey',
      'action',
      'snapshot',
      'campaignSuggestion',
      'marketingVideos',
      'marketingVideosHint',
      'readOnly',
      'generatedAt',
    ]) {
      expect(body.includes(key), key).toBe(true);
    }
    expect(body.includes('reasonAboutAgent(')).toBe(true);
    expect(body.includes('withProposal(')).toBe(true);
    expect(body.includes("'You are the WASIT Marketing Agent.'")).toBe(true);
  });
});

describe('G5 Phase 2 (A5) — the executor routes end-to-end through the gateway', () => {
  const marketing = findAgentSpec('marketing-agent')!;
  const GRANT = toolGrantForAgent(marketing);

  async function run(userId: string, roles: RoleName[], input: Record<string, unknown>, opts: FakeOptions) {
    const { db, whereParams, tablesRead, auditWrites } = makeFakeDb(opts);
    const res = await withAgentRunContext(
      ctx({ allowedTools: GRANT, requesterRoles: roles, requestedBy: userId }),
      () => executeAgentTask(db as never, marketing, { ...input, __userId: userId }),
    );
    const parsed = JSON.parse((res as { content: string }).content) as Record<string, unknown>;
    return { res, parsed, whereParams, tablesRead, auditWrites };
  }

  it('a merchant gets its own snapshot + own videos, with the legacy output shape', async () => {
    const { parsed } = await run(OWNER_A, ['MERCHANT'], { action: 'recommend_campaign', limit: 3 }, {
      ownedSellerIds: [ENT_A],
      catalogue: CATALOGUE,
      media: MEDIA,
    });
    expect(parsed.agentKey).toBe('marketing-agent');
    expect(parsed.action).toBe('recommend_campaign');
    expect(parsed.readOnly).toBe(true);
    expect(parsed).toHaveProperty('snapshot');
    expect(parsed).toHaveProperty('campaignSuggestion');
    expect(Array.isArray(parsed.marketingVideos)).toBe(true);
    expect((parsed.marketingVideos as { id: string }[]).map((v) => v.id)).toEqual(['mv-a']);
    // The merchant's snapshot is its OWN catalogue, never another tenant's.
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Cat B');
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Owner B Video');
    expect((parsed.snapshot as { published: number }).published).toBe(2);
  });

  it('an admin gets the platform-wide snapshot', async () => {
    const { parsed } = await run('g5p2-marketing-admin', ['ADMIN'], { action: 'recommend_campaign' }, {
      ownedSellerIds: [],
      catalogue: CATALOGUE,
      media: MEDIA,
    });
    expect((parsed.snapshot as { published: number }).published).toBe(3);
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Cat B');
  });

  it('a non-admin with no owned entity gets an EMPTY snapshot (never platform data)', async () => {
    const { parsed, tablesRead, auditWrites } = await run(OWNER_A, ['CUSTOMER'], { action: 'recommend_campaign' }, {
      ownedSellerIds: [],
      catalogue: CATALOGUE,
      media: MEDIA,
    });
    expect((parsed.snapshot as { published: number }).published).toBe(0);
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Cat B');
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Cat B');
    // The owned tier short-circuited (no owner entity) and the platform tier was
    // REFUSED — so no catalogue row was ever read for this non-admin, and the
    // platform tool was never EXECUTED (only a refusal was audited).
    expect(tablesRead).not.toContain('products');
    const executed = auditWrites.filter((w) => w.action === 'AI.TOOL_EXECUTED' && w.entityId === MARKETING_READ_CATALOGUE_PLATFORM);
    expect(executed).toHaveLength(0);
    const refused = auditWrites.filter((w) => w.action === 'AI.TOOL_REFUSED' && w.entityId === MARKETING_READ_CATALOGUE_PLATFORM);
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  it('forging identity or scope in the task input cannot widen the read', async () => {
    const { parsed } = await run(OWNER_A, ['MERCHANT'], {
      action: 'recommend_campaign',
      // Every one of these is caller-controlled and must be ignored: the runner
      // overwrites __userId with the trusted requester, and scope keys are unused.
      __userId: OWNER_B,
      userId: OWNER_B,
      sellerId: ENT_B,
      scope: 'platform',
    }, { ownedSellerIds: [ENT_A], catalogue: CATALOGUE, media: MEDIA });
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Cat B');
    expect(JSON.stringify(parsed)).not.toContain('G5P2 Secret Owner B Video');
    expect((parsed.snapshot as { published: number }).published).toBe(2);
  });

  it('a scheduler principal carrying admin roles still sees ONLY the empty/own snapshot', async () => {
    // A trusted scheduled run executes with the scheduler's OWN admin roles
    // (`trustedPrincipalRoles()` = SUPER_ADMIN), which WOULD pass the gateway's
    // platform gate. The executor must skip the platform tier for the `system`
    // principal, so a scheduled run can never read the platform-wide catalogue.
    const { parsed, auditWrites } = await run('system', ['SUPER_ADMIN'], { action: 'recommend_campaign' }, {
      ownedSellerIds: [],
      catalogue: CATALOGUE,
      media: MEDIA,
    });
    expect((parsed.snapshot as { published: number }).published).toBe(0);
    expect(parsed.marketingVideos).toEqual([]);
    // The platform tool was never reached: the gateway audits every call, so no
    // audit row may reference it.
    const reached = auditWrites.filter((w) => w.entityId === MARKETING_READ_CATALOGUE_PLATFORM);
    expect(reached).toHaveLength(0);
  });

  it('a non-refusal tool error is re-thrown, never swallowed', async () => {
    const { db } = makeFakeDb({ catalogue: CATALOGUE, media: MEDIA, failOnDataRead: true, ownedSellerIds: [ENT_A] });
    await expect(
      withAgentRunContext(
        ctx({ allowedTools: GRANT, requesterRoles: ['MERCHANT'], requestedBy: OWNER_A }),
        () => executeAgentTask(db as never, marketing, { __userId: OWNER_A }),
      ),
    ).rejects.toThrow();
  });
});

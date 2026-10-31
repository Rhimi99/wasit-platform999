import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { suppliers, merchants, companies } from '../src/db/schema/trade.js';
import { products, categories } from '../src/db/schema/products.js';
import { orders } from '../src/db/schema/commerce.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { MARKET_READ_OVERVIEW, MARKET_READ_OWN, findTool, isRegisteredTool } from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';
import { createAgentTask, getTask } from '../src/modules/ai/runner.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-03.6 — market-research-agent Tool Gateway migration.
 *
 * The platform aggregates (`market.read_overview`, platformScoped) are admin-only
 * and read ONLY through the gateway; the caller's own slice (`market.read_own`)
 * resolves its owner from the trusted run context, never from the args. These
 * specs prove the separation, the refusal + audit, the anti-forgery property and
 * that no direct Drizzle read survives in the executor.
 */

const AUDIT = { actorId: 'ai03-market-research' };
const createdUserIds: string[] = [];
const createdSellerIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdOrderIds: string[] = [];

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'COMPANY' | 'MERCHANT' | 'RISK';

async function insertUser(roleName: RoleName): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `ai03-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`,
    passwordHash: await argon2.hash('Ai03Pass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

async function insertSupplierEntity(userId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(suppliers).values({ id, userId, companyName: name, slug: `ai03-sup-${id}`, isActive: true });
  createdSellerIds.push(id);
  return id;
}

async function insertProduct(sellerId: string, name: string): Promise<string> {
  const categoryId = randomUUID();
  await db.insert(categories).values({ id: categoryId, name: `AI03 Cat ${categoryId.slice(0, 6)}`, slug: `ai03-cat-${categoryId}`, isActive: true });
  createdCategoryIds.push(categoryId);
  const id = randomUUID();
  await db.insert(products).values({
    id,
    sellerId,
    sellerType: 'SUPPLIER',
    categoryId,
    name,
    slug: `ai03-prod-${id}`,
    sku: `AI03-SKU-${id.slice(0, 12)}`,
    currencyCode: 'TND',
    basePrice: '25.0000',
    moq: 1,
    unit: 'piece',
    status: 'ACTIVE',
    isPublished: true,
  });
  createdProductIds.push(id);
  return id;
}

async function insertOrder(sellerId: string, buyerId: string, itemsTotal: string): Promise<string> {
  const id = randomUUID();
  await db.insert(orders).values({
    id,
    orderNumber: `AI03-${id.slice(0, 16)}`,
    buyerId,
    buyerType: 'COMPANY',
    sellerId,
    sellerType: 'SUPPLIER',
    currencyCode: 'TND',
    itemsTotal,
    commission: '0',
    buyerCommission: '0',
    paymentFee: '0',
    grandTotal: itemsTotal,
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });
  createdOrderIds.push(id);
  return id;
}

function ctx(overrides: {
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
}) {
  return {
    taskId: `ai03-ctx-${randomUUID()}`,
    agentKey: 'market-research-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['SUPER_ADMIN']) as never,
    requestedBy: overrides.requestedBy ?? 'ai03-operator',
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

function adviceOf(task: { result: unknown }): Record<string, unknown> {
  return JSON.parse(String((task.result as { advice: string }).advice)) as Record<string, unknown>;
}

afterAll(async () => {
  if (createdOrderIds.length > 0) await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  if (createdProductIds.length > 0) await db.delete(products).where(inArray(products.id, createdProductIds));
  if (createdCategoryIds.length > 0) await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  if (createdSellerIds.length > 0) await db.delete(suppliers).where(inArray(suppliers.id, createdSellerIds));
  if (createdUserIds.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('AI-03.6 — the new tools are registered and bound', () => {
  it('registers market.read_overview (platform) and market.read_own (own)', () => {
    expect(isRegisteredTool(MARKET_READ_OVERVIEW)).toBe(true);
    expect(isRegisteredTool(MARKET_READ_OWN)).toBe(true);
    expect(findTool(MARKET_READ_OVERVIEW)?.platformScoped).toBe(true);
    expect(findTool(MARKET_READ_OWN)?.platformScoped).toBe(false);
  });

  it('binds a real handler to each new tool', () => {
    expect(getToolHandler(MARKET_READ_OVERVIEW)).toBeTruthy();
    expect(getToolHandler(MARKET_READ_OWN)).toBeTruthy();
  });
});

describe('AI-03.6 — COMPANY gets only its own slice, never the platform aggregates', () => {
  it('runs market-research for a COMPANY: own slice present, platform snapshot absent', async () => {
    const company = await insertUser('COMPANY');
    const entity = await insertSupplierEntity(company, `AI03 Co ${randomUUID().slice(0, 8)}`);
    await insertProduct(entity, 'Owned product');
    await insertOrder(entity, company, '123.0000');

    const task = await createAgentTask(
      db, ['COMPANY'], company,
      { agentKey: 'market-research-agent', taskType: 'research.scan_market', input: {} }, AUDIT,
    );
    expect(task.status).not.toBe('blocked');
    const advice = adviceOf(task);
    // Own slice is present and reflects the caller's own catalogue/sales.
    expect(advice.scope).toBe('own');
    expect(advice.scopedToOwned).toBe(true);
    expect((advice.yourMarket as { products: number }).products).toBe(1);
    // The platform-wide aggregates are absent for a non-admin — never read.
    expect(advice).not.toHaveProperty('snapshot');
  });

  it('a SUPER_ADMIN gets the platform aggregates', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const task = await createAgentTask(
      db, ['SUPER_ADMIN'], admin,
      { agentKey: 'market-research-agent', taskType: 'research.scan_market', input: {} }, AUDIT,
    );
    const advice = adviceOf(task);
    expect(advice.scope).toBe('platform');
    const snapshot = advice.snapshot as { products: number; totalOrderValue: string } | undefined;
    expect(snapshot).toBeTruthy();
    expect(typeof snapshot?.products).toBe('number');
    expect(typeof snapshot?.totalOrderValue).toBe('string');
  });

  it('never leaks another owner\'s slice through market.read_own', async () => {
    const ownerA = await insertUser('COMPANY');
    const ownerB = await insertUser('COMPANY');
    const entityA = await insertSupplierEntity(ownerA, `AI03 A ${randomUUID().slice(0, 8)}`);
    const entityB = await insertSupplierEntity(ownerB, `AI03 B ${randomUUID().slice(0, 8)}`);
    await insertProduct(entityA, 'A product');
    await insertProduct(entityB, 'B product 1');
    await insertProduct(entityB, 'B product 2');

    const taskA = await createAgentTask(
      db, ['COMPANY'], ownerA,
      { agentKey: 'market-research-agent', taskType: 'research.scan_market', input: {} }, AUDIT,
    );
    const taskB = await createAgentTask(
      db, ['COMPANY'], ownerB,
      { agentKey: 'market-research-agent', taskType: 'research.scan_market', input: {} }, AUDIT,
    );
    expect((adviceOf(taskA).yourMarket as { products: number }).products).toBe(1);
    expect((adviceOf(taskB).yourMarket as { products: number }).products).toBe(2);
  });
});

describe('AI-03.6 — direct access to the aggregate tool is refused and audited', () => {
  it('refuses market.read_overview for a non-admin holding the permission (PLATFORM_SCOPE_DENIED)', async () => {
    // RISK holds analytics:read:all but is not an admin → platform scope refused.
    const c = ctx({ allowedTools: [MARKET_READ_OVERVIEW], requesterRoles: ['RISK'] });
    await expectRefusal(
      withAgentRunContext(c, () => invokeTool(db, MARKET_READ_OVERVIEW, {})),
      'PLATFORM_SCOPE_DENIED',
    );
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_REFUSED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityId).toBe(MARKET_READ_OVERVIEW);
    expect((rows[0].metadata as { code?: string }).code).toBe('PLATFORM_SCOPE_DENIED');
  });

  it('refuses market.read_overview for a COMPANY that lacks the permission (PERMISSION_DENIED)', async () => {
    const c = ctx({ allowedTools: [MARKET_READ_OVERVIEW], requesterRoles: ['COMPANY'] });
    await expectRefusal(
      withAgentRunContext(c, () => invokeTool(db, MARKET_READ_OVERVIEW, {})),
      'PERMISSION_DENIED',
    );
  });

  it('runs market.read_overview for an ADMIN and audits execution', async () => {
    const c = ctx({ allowedTools: [MARKET_READ_OVERVIEW], requesterRoles: ['ADMIN'] });
    const out = await withAgentRunContext(c, () => invokeTool(db, MARKET_READ_OVERVIEW, {}));
    expect(out.toolId).toBe(MARKET_READ_OVERVIEW);
    expect(out.data).toHaveProperty('snapshot');
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_EXECUTED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
  });
});

describe('AI-03.6 — identity cannot be forged through the args', () => {
  it('rejects args that try to name the owner (strict schema)', async () => {
    await expectRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [MARKET_READ_OWN], requesterRoles: ['SUPER_ADMIN'] }),
        () => invokeTool(db, MARKET_READ_OWN, { userId: 'victim', requestedBy: 'victim' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('resolves market.read_own from the trusted context, ignoring a forged requestedBy', async () => {
    const owner = await insertUser('COMPANY');
    const victim = await insertUser('COMPANY');
    const ownerEntity = await insertSupplierEntity(owner, `AI03 ctx ${randomUUID().slice(0, 8)}`);
    const victimEntity = await insertSupplierEntity(victim, `AI03 victim ${randomUUID().slice(0, 8)}`);
    await insertProduct(ownerEntity, 'owner product');
    await insertProduct(victimEntity, 'victim product 1');
    await insertProduct(victimEntity, 'victim product 2');

    // The run executes as `owner`; a forged identity in args is impossible (schema)
    // and the context identity is what the handler uses.
    const c = ctx({ allowedTools: [MARKET_READ_OWN], requesterRoles: ['COMPANY'], requestedBy: owner });
    const out = await withAgentRunContext(c, () => invokeTool(db, MARKET_READ_OWN, {}));
    expect(out.data.products).toBe(1);
  });
});

describe('AI-03.6 — no direct Drizzle read survives in the executor', () => {
  it('execMarketResearchAgent reads ONLY through invokeTool', () => {
    const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');
    const start = SRC.indexOf('async function execMarketResearchAgent(');
    expect(start).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    const body = next === -1 ? rest : rest.slice(0, next);
    expect(body.includes('invokeTool(')).toBe(true);
    expect(body.includes('.from(')).toBe(false);
  });
});

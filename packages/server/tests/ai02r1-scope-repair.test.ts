import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { merchants } from '../src/db/schema/trade.js';
import { categories, products } from '../src/db/schema/products.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { createAgentTask, executeDueTasks, getTask, decideAgentTask } from '../src/modules/ai/runner.js';
import { COMPLIANCE_READ_PLATFORM, findTool } from '../src/lib/ai/tool-registry.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { withAgentRunContext, requireAction, ActionNotAuthorizedError } from '../src/lib/ai/agent-run-context.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-02.1-R1 — security gap repair.
 *
 * Proves the two confirmed gaps are closed, end-to-end through the real runner
 * and executors on a disposable test database:
 *  - product-agent visibility: a non-owner can never read an unpublished product
 *    by guessing its id; a customer still reads published products; an owner
 *    reads their own; an admin reads any.
 *  - compliance-agent aggregates: platform-wide counts are reached only through
 *    the Tool Gateway (admin-only), never a direct query, and non-admins are
 *    refused at task creation and at the gateway.
 *  - requireAction: the grant list is read from the trusted run context only; a
 *    caller can no longer pass an array to widen its own authority.
 */

const AUDIT = { actorId: 'ai02r1-scope-repair' };
const createdUserIds: string[] = [];
const createdSellerIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];

async function insertUser(roleName: UserRole): Promise<string> {
  const id = randomUUID();
  const email = `ai02r1-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('Ai02R1Pass!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

async function insertMerchantEntity(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(merchants).values({ id, userId, storeName: `R1 Store ${id.slice(0, 8)}`, slug: `r1-store-${id}` });
  createdSellerIds.push(id);
  return id;
}

async function insertProduct(opts: {
  sellerId: string;
  sellerType: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  isPublished: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  name: string;
}): Promise<string> {
  const categoryId = randomUUID();
  await db.insert(categories).values({ id: categoryId, name: `R1 Cat ${categoryId.slice(0, 6)}`, slug: `r1-cat-${categoryId}`, isActive: true });
  createdCategoryIds.push(categoryId);
  const id = randomUUID();
  await db.insert(products).values({
    id,
    sellerId: opts.sellerId,
    sellerType: opts.sellerType,
    categoryId,
    name: opts.name,
    slug: `r1-prod-${id}`,
    sku: `R1-SKU-${id.slice(0, 12)}`,
    currencyCode: 'TND',
    basePrice: '19.9000',
    moq: 1,
    unit: 'piece',
    status: opts.status,
    isPublished: opts.isPublished,
  });
  createdProductIds.push(id);
  return id;
}

function adviceOf(task: { result: unknown }): Record<string, unknown> {
  return JSON.parse(String((task.result as { advice: string }).advice)) as Record<string, unknown>;
}

/** Creates (approving when gated), runs and returns a finished agent task. */
async function runAgent(
  agentKey: string,
  taskType: string,
  input: Record<string, unknown>,
  userId: string,
  roles: UserRole[],
) {
  const created = await createAgentTask(db, roles, userId, { agentKey, taskType, input }, AUDIT);
  if (created.status === 'awaiting_approval') {
    await decideAgentTask(db, created.id, userId, 'APPROVE', 'r1 auto approval', AUDIT);
  }
  await executeDueTasks(db, 50);
  return getTask(db, created.id);
}

afterAll(async () => {
  if (createdProductIds.length > 0) await db.delete(products).where(inArray(products.id, createdProductIds));
  if (createdCategoryIds.length > 0) await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  if (createdSellerIds.length > 0) await db.delete(merchants).where(inArray(merchants.id, createdSellerIds));
  if (createdUserIds.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(auditLogs).where(eq(auditLogs.entityType, 'TOOL'));
});

describe('AI-02.1-R1 — product-agent visibility', () => {
  it('a CUSTOMER reads a published product but never another owner\'s unpublished one', async () => {
    const merchantA = await insertUser('MERCHANT');
    const merchantB = await insertUser('MERCHANT');
    const sellerA = await insertMerchantEntity(merchantA);
    const sellerB = await insertMerchantEntity(merchantB);
    const customer = await insertUser('CUSTOMER');

    const pubA = await insertProduct({ sellerId: sellerA, sellerType: 'MERCHANT', isPublished: true, status: 'ACTIVE', name: 'R1 Public Widget A' });
    const secretB = 'R1 Secret Draft B';
    const unpubB = await insertProduct({ sellerId: sellerB, sellerType: 'MERCHANT', isPublished: false, status: 'DRAFT', name: secretB });

    // Published → visible.
    const ok = await runAgent('product-agent', 'product.audit_catalog', { action: 'analyze_product', productId: pubA }, customer, ['CUSTOMER']);
    expect(ok.status).toBe('succeeded');
    const okParsed = adviceOf(ok);
    expect((okParsed.product as { id?: string }).id).toBe(pubA);

    // Another owner's unpublished product → not visible, id never treated as proof.
    const denied = await runAgent('product-agent', 'product.audit_catalog', { action: 'analyze_product', productId: unpubB }, customer, ['CUSTOMER']);
    const deniedParsed = adviceOf(denied);
    expect(deniedParsed.product).toBeUndefined();
    expect(deniedParsed.error).toBeTruthy();
    expect(JSON.stringify(deniedParsed)).not.toContain(secretB);
  });

  it('a MERCHANT reads its own unpublished product but not another merchant\'s', async () => {
    const merchantA = await insertUser('MERCHANT');
    const merchantB = await insertUser('MERCHANT');
    const sellerA = await insertMerchantEntity(merchantA);
    const sellerB = await insertMerchantEntity(merchantB);

    const ownDraft = await insertProduct({ sellerId: sellerA, sellerType: 'MERCHANT', isPublished: false, status: 'DRAFT', name: 'R1 My Draft' });
    const otherSecret = 'R1 Other Merchant Draft';
    const otherDraft = await insertProduct({ sellerId: sellerB, sellerType: 'MERCHANT', isPublished: false, status: 'DRAFT', name: otherSecret });

    const mine = await runAgent('product-agent', 'product.audit_catalog', { action: 'analyze_product', productId: ownDraft }, merchantA, ['MERCHANT']);
    expect(mine.status).toBe('succeeded');
    expect((adviceOf(mine).product as { id?: string }).id).toBe(ownDraft);

    const theirs = await runAgent('product-agent', 'product.audit_catalog', { action: 'analyze_product', productId: otherDraft }, merchantA, ['MERCHANT']);
    const theirsParsed = adviceOf(theirs);
    expect(theirsParsed.product).toBeUndefined();
    expect(JSON.stringify(theirsParsed)).not.toContain(otherSecret);
  });

  it('forging productId or any scope in the task input cannot widen the read', async () => {
    const merchantA = await insertUser('MERCHANT');
    const merchantB = await insertUser('MERCHANT');
    const sellerA = await insertMerchantEntity(merchantA);
    const sellerB = await insertMerchantEntity(merchantB);
    const customer = await insertUser('CUSTOMER');

    const secretB = 'R1 Forged Target B';
    const unpubB = await insertProduct({ sellerId: sellerB, sellerType: 'MERCHANT', isPublished: false, status: 'DRAFT', name: secretB });

    const forged = await runAgent('product-agent', 'product.audit_catalog', {
      action: 'analyze_product',
      productId: unpubB,
      // Every one of these is caller-controlled and must be ignored: the runner
      // overwrites __userId with the trusted requester, and scope keys are unused.
      __userId: merchantB,
      userId: merchantB,
      sellerId: sellerB,
      isPublished: true,
    }, customer, ['CUSTOMER']);

    const parsed = adviceOf(forged);
    expect(parsed.product).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain(secretB);
    // sanity: sellerA is a valid anchor the customer is NOT (no ownership leak)
    expect(sellerA).toBeTruthy();
  });

  it('an ADMIN reads any product, published or not', async () => {
    const merchantB = await insertUser('MERCHANT');
    const sellerB = await insertMerchantEntity(merchantB);
    const admin = await insertUser('ADMIN');

    const unpubB = await insertProduct({ sellerId: sellerB, sellerType: 'MERCHANT', isPublished: false, status: 'DRAFT', name: 'R1 Admin Sees Draft' });

    const task = await runAgent('product-agent', 'product.audit_catalog', { action: 'analyze_product', productId: unpubB }, admin, ['ADMIN']);
    expect(task.status).toBe('succeeded');
    expect((adviceOf(task).product as { id?: string }).id).toBe(unpubB);
  });
});

describe('AI-02.1-R1 — compliance-agent platform aggregates are gateway-protected', () => {
  const NON_ADMIN: UserRole[] = ['CUSTOMER', 'SUPPORT', 'RISK', 'DISPUTE'];

  it('the compliance tool is registered and platform-scoped', () => {
    const tool = findTool(COMPLIANCE_READ_PLATFORM);
    expect(tool).toBeTruthy();
    expect(tool?.platformScoped).toBe(true);
    expect(tool?.effect).toBe('read');
  });

  it.each(NON_ADMIN)('refuses a compliance task for %s at creation (runner scope gate)', async (role) => {
    const userId = await insertUser(role);
    await expect(
      createAgentTask(db, [role], userId, { agentKey: 'compliance-agent', taskType: 'compliance.check', input: {} }, AUDIT),
    ).rejects.toThrow();
  });

  it('a SUPER_ADMIN runs the compliance scan through the gateway and gets findings', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const task = await runAgent('compliance-agent', 'compliance.check', { action: 'check' }, admin, ['SUPER_ADMIN']);
    expect(task.status).toBe('succeeded');
    const parsed = adviceOf(task);
    expect(parsed.agentKey).toBe('compliance-agent');
    expect(Array.isArray(parsed.findings)).toBe(true);
    const findings = parsed.findings as { area: string; count: number }[];
    expect(findings.map((f) => f.area)).toEqual(['KYC/KYB', 'DISPUTES']);
    expect(typeof findings[0].count).toBe('number');
  });

  it('the gateway itself refuses a non-admin requester and audits the refusal', async () => {
    const taskId = `r1-compliance-${randomUUID()}`;
    await expect(
      withAgentRunContext(
        { taskId, agentKey: 'compliance-agent', allowedTools: [COMPLIANCE_READ_PLATFORM], requesterRoles: ['SUPPORT'], requestedBy: 'r1-support' },
        () => invokeTool(db, COMPLIANCE_READ_PLATFORM, {}),
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_SCOPE_DENIED' });

    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_REFUSED' and ${auditLogs.metadata}->>'taskId' = ${taskId}`);
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as { code?: string }).code).toBe('PLATFORM_SCOPE_DENIED');
  });

  it('the gateway refuses a non-admin that lacks the permission (RBAC) and audits it', async () => {
    const taskId = `r1-compliance-rbac-${randomUUID()}`;
    await expect(
      withAgentRunContext(
        { taskId, agentKey: 'compliance-agent', allowedTools: [COMPLIANCE_READ_PLATFORM], requesterRoles: ['CUSTOMER'], requestedBy: 'r1-customer' },
        () => invokeTool(db, COMPLIANCE_READ_PLATFORM, {}),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_REFUSED' and ${auditLogs.metadata}->>'taskId' = ${taskId}`);
    expect(rows.length).toBe(1);
  });

  it('forged scope in the args is rejected before the handler runs', async () => {
    const taskId = `r1-compliance-forge-${randomUUID()}`;
    await expect(
      withAgentRunContext(
        { taskId, agentKey: 'compliance-agent', allowedTools: [COMPLIANCE_READ_PLATFORM], requesterRoles: ['SUPER_ADMIN'], requestedBy: 'r1-admin' },
        () => invokeTool(db, COMPLIANCE_READ_PLATFORM, { platformScoped: false, isAdmin: true, userId: 'victim', scope: 'own' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a SUPER_ADMIN invocation is audited as executed', async () => {
    const taskId = `r1-compliance-ok-${randomUUID()}`;
    await withAgentRunContext(
      { taskId, agentKey: 'compliance-agent', allowedTools: [COMPLIANCE_READ_PLATFORM], requesterRoles: ['SUPER_ADMIN'], requestedBy: 'r1-admin' },
      () => invokeTool(db, COMPLIANCE_READ_PLATFORM, {}),
    );
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_EXECUTED' and ${auditLogs.metadata}->>'taskId' = ${taskId}`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityId).toBe(COMPLIANCE_READ_PLATFORM);
  });
});

describe('AI-02.1-R1 — requireAction reads grants from the trusted context only', () => {
  const base = { taskId: 'r1-req', agentKey: 'x', requestedBy: 'u' };

  it('authorizes from authorizedActions (default) and allowedTools ("tools" scope)', async () => {
    await withAgentRunContext({ ...base, authorizedActions: ['a.read'], allowedTools: ['t.read'] }, async () => {
      expect(() => requireAction('a.read')).not.toThrow();
      expect(() => requireAction('t.read', 'tools')).not.toThrow();
    });
  });

  it('refuses a tool id not in the tools grant list even when it is a capability action', async () => {
    await withAgentRunContext({ ...base, authorizedActions: ['t.read'], allowedTools: [] }, async () => {
      expect(() => requireAction('t.read', 'tools')).toThrow(ActionNotAuthorizedError);
      expect(() => requireAction('t.read')).not.toThrow();
    });
  });

  it('refuses an action not in the capability list even when it is a granted tool', async () => {
    await withAgentRunContext({ ...base, authorizedActions: [], allowedTools: ['t.read'] }, async () => {
      expect(() => requireAction('t.read')).toThrow(ActionNotAuthorizedError);
    });
  });

  it('fails closed with no run context', () => {
    expect(() => requireAction('anything')).toThrow(ActionNotAuthorizedError);
    expect(() => requireAction('anything', 'tools')).toThrow(ActionNotAuthorizedError);
  });

  it('fails closed when the selected grant list is absent', async () => {
    await withAgentRunContext({ ...base }, async () => {
      expect(() => requireAction('anything')).toThrow(ActionNotAuthorizedError);
      expect(() => requireAction('anything', 'tools')).toThrow(ActionNotAuthorizedError);
    });
  });
});

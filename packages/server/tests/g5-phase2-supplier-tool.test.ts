import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { suppliers, merchants } from '../src/db/schema/trade.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import { SUPPLIER_READ_OWN, findTool, isRegisteredTool } from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';
import { createAgentTask, getTask } from '../src/modules/ai/runner.js';

/**
 * G5 Phase 2 (A1) — unify `execSupplierAgent` behind the central Tool Gateway.
 *
 * The supplier agent's owned-entity read moves to a new registered, read-only,
 * OWNER-scoped tool (`supplier.read_owned`). The owner is resolved from the
 * trusted run context (`getAgentRunContext().requestedBy`), never from the args,
 * and an explicit `supplierId` is honoured only when the caller owns it. This
 * spec proves:
 *   - the tool is registered, read-only and NOT platform-scoped;
 *   - a missing run context and an ungranted tool are refused;
 *   - identity cannot be forged through the args (strict schema);
 *   - a caller sees ONLY their own supplier entities (no cross-tenant leak);
 *   - an unowned explicit id yields an empty scope, never another tenant's row;
 *   - the read is read-only (no rows created) and audited;
 *   - the real executor routes end-to-end through the gateway with the same
 *     output shape and no widening.
 *
 * Every assertion is scoped to ids this file created, because the suite runs
 * files in parallel against one shared database.
 */

const AUDIT = { actorId: 'g5p2-supplier-tool' };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdMerchantIds: string[] = [];

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'COMPANY';

async function insertUser(roleName: RoleName): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `g5p2-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`,
    passwordHash: await argon2.hash('G5P2Pass123!'),
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
  await db.insert(suppliers).values({ id, userId, companyName: name, slug: `g5p2-sup-${id}`, isActive: true });
  createdSupplierIds.push(id);
  return id;
}

async function insertMerchantEntity(userId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(merchants).values({ id, userId, storeName: name, slug: `g5p2-mer-${id}`, isActive: true });
  createdMerchantIds.push(id);
  return id;
}

function ctx(overrides: {
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
}) {
  return {
    taskId: `g5p2-ctx-${randomUUID()}`,
    agentKey: 'supplier-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['MERCHANT']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p2-operator',
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
  if (createdTaskIds.length > 0) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdMerchantIds.length > 0) await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  if (createdSupplierIds.length > 0) await db.delete(suppliers).where(inArray(suppliers.id, createdSupplierIds));
  if (createdUserIds.length > 0) {
    await db.delete(auditLogs).where(sql`${auditLogs.metadata}->>'actorId' = ${AUDIT.actorId}`);
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('G5 Phase 2 (A1) — the new tool is registered, read-only and owner-scoped', () => {
  it('registers supplier.read_owned with a bound handler', () => {
    const tool = findTool(SUPPLIER_READ_OWN);
    expect(tool, SUPPLIER_READ_OWN).toBeTruthy();
    expect(tool?.effect).toBe('read');
    expect(tool?.platformScoped).toBe(false);
    expect(isRegisteredTool(SUPPLIER_READ_OWN)).toBe(true);
    expect(getToolHandler(SUPPLIER_READ_OWN)).toBeTruthy();
  });
});

describe('G5 Phase 2 (A1) — gateway refuses the unauthorized path (fail-closed)', () => {
  it('refuses the tool when there is no trusted run context', async () => {
    await expectRefusal(invokeTool(db, SUPPLIER_READ_OWN, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted', async () => {
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db, SUPPLIER_READ_OWN, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    await expectRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [SUPPLIER_READ_OWN] }),
        () => invokeTool(db, SUPPLIER_READ_OWN, { requestedBy: 'victim', userId: 'victim', scope: 'platform' }),
      ),
      'INVALID_INPUT',
    );
  });

  it('rejects an out-of-range limit', async () => {
    await expectRefusal(
      withAgentRunContext(ctx({ allowedTools: [SUPPLIER_READ_OWN] }), () => invokeTool(db, SUPPLIER_READ_OWN, { limit: 9999 })),
      'INVALID_INPUT',
    );
  });
});

describe('G5 Phase 2 (A1) — the caller sees only their own supplier entities', () => {
  it('returns the caller\'s own supplier, and never a merchant entity they also own', async () => {
    const owner = await insertUser('MERCHANT');
    await insertSupplierEntity(owner, 'G5P2 Owned Supplier');
    await insertMerchantEntity(owner, 'G5P2 Owned Merchant');

    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: owner });
    const out = await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, {}));
    expect(out.data.scope).toBe('own');
    expect(out.data.scopedToOwned).toBe(true);
    const rows = out.data.suppliers as { id: string; name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('G5P2 Owned Supplier');
  });

  it('never leaks another tenant\'s supplier through the tool', async () => {
    const ownerA = await insertUser('MERCHANT');
    const ownerB = await insertUser('MERCHANT');
    await insertSupplierEntity(ownerA, 'G5P2 A Supplier');
    await insertSupplierEntity(ownerB, 'G5P2 B Supplier');

    const a = await withAgentRunContext(
      ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: ownerA }),
      () => invokeTool(db, SUPPLIER_READ_OWN, {}),
    );
    const b = await withAgentRunContext(
      ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: ownerB }),
      () => invokeTool(db, SUPPLIER_READ_OWN, {}),
    );
    expect((a.data.suppliers as { name: string }[]).map((s) => s.name)).toEqual(['G5P2 A Supplier']);
    expect((b.data.suppliers as { name: string }[]).map((s) => s.name)).toEqual(['G5P2 B Supplier']);
  });

  it('an explicit id the caller does NOT own yields an empty scope, never another tenant\'s row', async () => {
    const ownerA = await insertUser('MERCHANT');
    const ownerB = await insertUser('MERCHANT');
    const bSupplier = await insertSupplierEntity(ownerB, 'G5P2 B Only');

    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: ownerA });
    const out = await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, { supplierId: bSupplier }));
    expect(out.data.found).toBe(false);
    expect(out.data.suppliers).toHaveLength(0);
    expect(out.data.scopedToOwned).toBe(false);
  });

  it('an explicit id the caller owns is returned', async () => {
    const owner = await insertUser('MERCHANT');
    const own = await insertSupplierEntity(owner, 'G5P2 Owned By Id');

    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: owner });
    const out = await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, { supplierId: own }));
    expect(out.data.found).toBe(true);
    const rows = out.data.suppliers as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(own);
  });

  it('resolves the owner from the trusted context, ignoring a forged identity in the args', async () => {
    const owner = await insertUser('MERCHANT');
    const victim = await insertUser('MERCHANT');
    await insertSupplierEntity(owner, 'G5P2 owner supplier');
    await insertSupplierEntity(victim, 'G5P2 victim supplier');

    // The run executes as `owner`; a forged identity in the args is impossible
    // (strict schema) and the context identity is what the handler uses.
    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: owner });
    const out = await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, {}));
    expect((out.data.suppliers as { name: string }[]).map((s) => s.name)).toEqual(['G5P2 owner supplier']);
  });
});

describe('G5 Phase 2 (A1) — read-only and audited', () => {
  it('writes an AI.TOOL_EXECUTED audit row for the invocation', async () => {
    const owner = await insertUser('MERCHANT');
    await insertSupplierEntity(owner, 'G5P2 audit supplier');
    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: owner });
    await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, {}));
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_EXECUTED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityId).toBe(SUPPLIER_READ_OWN);
  });

  it('repeated reads create no rows (read-only, no write anywhere)', async () => {
    const owner = await insertUser('MERCHANT');
    await insertSupplierEntity(owner, 'G5P2 stable supplier');
    const count = async () => Number((await db.select({ v: sql<number>`count(*)::int` }).from(suppliers))[0]?.v ?? 0);
    const before = await count();
    const c = ctx({ allowedTools: [SUPPLIER_READ_OWN], requestedBy: owner });
    for (let i = 0; i < 3; i++) {
      const out = await withAgentRunContext(c, () => invokeTool(db, SUPPLIER_READ_OWN, {}));
      expect(out.effect).toBe('read');
    }
    expect(await count()).toBe(before);
  });
});

describe('G5 Phase 2 (A1) — the real executor routes end-to-end through the gateway', () => {
  it('runs supplier-agent for an owner and returns their own supplier, unchanged shape', async () => {
    const owner = await insertUser('MERCHANT');
    const own = await insertSupplierEntity(owner, 'G5P2 E2E Supplier');
    const created = await createAgentTask(
      db, ['MERCHANT'], owner,
      { agentKey: 'supplier-agent', taskType: 'supplier.onboard', input: {} }, AUDIT,
    );
    createdTaskIds.push(created.id);
    const task = await getTask(db, created.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    const advice = adviceOf(task);
    expect(advice.agentKey).toBe('supplier-agent');
    expect(advice.readOnly).toBe(true);
    expect(advice.scopedToOwned).toBe(true);
    const rows = advice.suppliers as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(own);
  });

  it('runs supplier-agent for a caller with no owned supplier and returns an empty scope', async () => {
    const owner = await insertUser('MERCHANT');
    const created = await createAgentTask(
      db, ['MERCHANT'], owner,
      { agentKey: 'supplier-agent', taskType: 'supplier.onboard', input: {} }, AUDIT,
    );
    createdTaskIds.push(created.id);
    const task = await getTask(db, created.id);
    const advice = adviceOf(task);
    expect(advice.suppliers).toHaveLength(0);
  });

  it('does not expose another tenant\'s supplier end-to-end', async () => {
    const ownerA = await insertUser('MERCHANT');
    const ownerB = await insertUser('MERCHANT');
    const bSupplier = await insertSupplierEntity(ownerB, 'G5P2 B E2E');

    const task = await createAgentTask(
      db, ['MERCHANT'], ownerA,
      { agentKey: 'supplier-agent', taskType: 'supplier.onboard', input: { supplierId: bSupplier } }, AUDIT,
    );
    createdTaskIds.push(task.id);
    const advice = adviceOf(await getTask(db, task.id));
    // An id the caller does not own yields an empty scope.
    expect(advice.suppliers).toHaveLength(0);
    expect(advice.note).toBe('Supplier not found in your scope.');
  });
});

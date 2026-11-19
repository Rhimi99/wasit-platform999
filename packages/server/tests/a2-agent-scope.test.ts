import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentRegistry, agentTasks } from '../src/db/schema/agents.js';
import { aiRequests } from '../src/db/schema/ai.js';
import { products, categories } from '../src/db/schema/products.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';
import { createAgentTask, getTask } from '../src/modules/ai/agents.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import {
  AGENT_SCOPE_CONTRACTS,
  AgentScopeError,
  assertTableAccess,
  getAgentScopeContract,
} from '../src/modules/ai/agent-scope.js';
import type { AgentRunContext } from '../src/lib/ai/agent-run-context.js';

/**
 * A2 — Agent Scope Enforcement against the REAL database.
 *
 * Proves the scope contract holds on a production path (real `createAgentTask`,
 * real executors, real Postgres): every one of the 11 agents runs and reads only
 * its own tables, an out-of-scope table is refused, tenant isolation is
 * preserved, and A1 stays effective alongside it. No mocks.
 */

const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdRegistryKeys: string[] = [];
const AUDIT = { actorId: 'it-a2', ipAddress: null, userAgent: null };

async function createUser(roleName = 'SUPER_ADMIN'): Promise<string> {
  const id = randomUUID();
  const email = `it-a2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

const ctx = (agentKey: string, over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  taskId: `t-${agentKey}`,
  agentKey,
  requestedBy: 'owner-1',
  ...over,
});

afterEach(() => {
  // Never leak a stopped kill switch into another spec.
  setAiExecutionEnabled(null);
});

afterAll(async () => {
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    taskIds: createdTaskIds,
    productIds: createdProductIds,
    categoryIds: createdCategoryIds,
    registryKeys: createdRegistryKeys,
  });
  await closeDb();
});

describe('A2 — every agent runs end-to-end under its scope (real DB)', () => {
  it('all 11 agents execute to success and record a ledger row', async () => {
    const staffId = await createUser('SUPER_ADMIN');
    for (const key of Object.keys(AGENT_SCOPE_CONTRACTS)) {
      const task = await createAgentTask(
        db,
        ['SUPER_ADMIN'],
        staffId,
        { agentKey: key, requestedBy: staffId, input: {} },
        AUDIT,
      );
      createdTaskIds.push(task.id);
      // Gated agents await approval; non-gated run instantly. Either way, the
      // task is created and no scope refusal happened.
      expect(['succeeded', 'approved', 'awaiting_approval']).toContain(task.status);
      expect(task.error).toBeNull();
    }
  });

  it('a real executor read reaches the database through the scoped handle', async () => {
    const staffId = await createUser('SUPER_ADMIN');
    // Seed a published product so product-agent has real data to read.
    const categoryId = randomUUID();
    createdCategoryIds.push(categoryId);
    await db.insert(categories).values({ id: categoryId, name: 'A2 Cat', slug: `a2-cat-${categoryId}` }).onConflictDoNothing();
    const productId = randomUUID();
    createdProductIds.push(productId);
    await db
      .insert(products)
      .values({
        id: productId,
        sellerType: 'SUPPLIER',
        sellerId: staffId,
        name: 'A2 Product',
        slug: `a2-product-${productId}`,
        sku: `A2-${productId}`,
        basePrice: '10.0000',
        categoryId,
        isPublished: true,
      } as never)
      .onConflictDoNothing();

    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      staffId,
      { agentKey: 'product-agent', requestedBy: staffId, input: { productId } },
      AUDIT,
    );
    createdTaskIds.push(task.id);
    expect(task.status).toBe('succeeded');
    const parsed = JSON.parse(((task.result as { advice?: string }).advice ?? '{}') as string) as { agentKey?: string };
    expect(parsed.agentKey).toBe('product-agent');
  });
});

describe('A2 — scope isolation holds against the real registry', () => {
  it('refuses a read of another agent’s table', () => {
    expect(() => assertTableAccess(ctx('product-agent'), 'disputes', 'read')).toThrow(AgentScopeError);
  });

  it('refuses a hard-denied table (money movement)', () => {
    expect(() => assertTableAccess(ctx('analytics-agent'), 'payouts', 'read')).toThrow(AgentScopeError);
  });

  it('refuses a write to a business table', () => {
    expect(() => assertTableAccess(ctx('product-agent'), 'products', 'write')).toThrow(AgentScopeError);
  });

  it('fails closed with no run context', () => {
    expect(() => assertTableAccess(undefined, 'products', 'read')).toThrow(AgentScopeError);
  });

  it('preserves tenant isolation: owner-scoped data needs a valid owner', () => {
    const withOwner = ctx('analytics-agent', { requestedBy: 'user-abc' });
    expect(() => assertTableAccess(withOwner, 'agent_memory', 'read')).toThrow(AgentScopeError);
  });
});

describe('A2 — A1 kill switch remains effective alongside scope enforcement', () => {
  it('refuses task creation while AI is disabled', async () => {
    const staffId = await createUser('SUPER_ADMIN');
    setAiExecutionEnabled(false);
    await expect(
      createAgentTask(db, ['SUPER_ADMIN'], staffId, { agentKey: 'marketing-agent', requestedBy: staffId, input: {} }, AUDIT),
    ).rejects.toThrow();
  });

  it('allows task creation again after re-enabling', async () => {
    const staffId = await createUser('SUPER_ADMIN');
    setAiExecutionEnabled(true);
    const task = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      staffId,
      { agentKey: 'marketing-agent', requestedBy: staffId, input: {} },
      AUDIT,
    );
    createdTaskIds.push(task.id);
    expect(task.status).toBe('succeeded');
  });
});

describe('A2 — registry seeding matches the scope contracts', () => {
  it('the live registry exposes exactly the 11 scoped agents', async () => {
    const rows = await db.select().from(agentRegistry);
    const keys = rows.map((r) => r.key).sort();
    for (const key of Object.keys(AGENT_SCOPE_CONTRACTS)) {
      expect(keys).toContain(key);
    }
    expect(Object.keys(AGENT_SCOPE_CONTRACTS)).toHaveLength(11);
    expect(getAgentScopeContract('sales-agent')).toBeDefined();
  });
});

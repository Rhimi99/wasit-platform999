import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import type { UserRole } from '@wasit/shared';
import { createAgentTask } from '../src/modules/ai/agents.js';
import { AGENT_CATALOGUE, PLATFORM_SCOPE_ROLES } from '../src/modules/ai/catalogue.js';

/**
 * `requiresPlatformScope` must be enforced, not merely declared.
 *
 * A2 bounds an agent to a set of *tables*; it says nothing about rows. So an
 * agent whose data is platform-wide returns every tenant's rows, and letting a
 * caller who only holds `ai:use` run it is a cross-tenant read. These tests pin
 * the boundary in both directions: non-staff are refused before a task row
 * exists, staff are not, and agents that are not platform-wide stay available.
 */

const AUDIT = { actorId: 'it-platform-scope', ipAddress: null, userAgent: null };
const createdUserIds: string[] = [];

const PLATFORM_AGENTS = AGENT_CATALOGUE.filter((a) => a.requiresPlatformScope).map((a) => a.key);

async function insertUser(roleName: string) {
  const id = randomUUID();
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email: `psc-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`,
    passwordHash: await argon2.hash('PlatformScopePass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return id;
}

async function attempt(agentKey: string, roleName: UserRole) {
  const userId = await insertUser(roleName);
  try {
    const task = await createAgentTask(
      db,
      [roleName],
      userId,
      { agentKey, requestedBy: userId, input: {} },
      { ...AUDIT, actorId: userId },
    );
    return { refused: false as const, task };
  } catch (err) {
    return { refused: true as const, message: err instanceof Error ? err.message : String(err) };
  }
}

afterAll(async () => {
  await db.delete(agentTasks).where(sql`${agentTasks.requestedBy} in (select id from users where email like 'psc-%@wasit.tn')`);
  for (const id of createdUserIds) {
    await db.delete(userRoles).where(eq(userRoles.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeDb();
});

describe('platform-scope boundary', () => {
  it('declares the boundary for exactly the platform-wide agents', () => {
    expect(PLATFORM_SCOPE_ROLES).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(PLATFORM_AGENTS.sort()).toEqual(
      [
        'ads-agent',
        'analytics-agent',
        'compliance-agent',
        'development-agent',
        'dispute-assistant',
        'finance-agent',
        'market-research-agent',
        'operations-agent',
        'outreach-acquisition-agent',
        'payment-settlement-agent',
        'risk-agent',
      ].sort(),
    );
  });

  it.each(['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'SUPPORT'])(
    'refuses %s on every platform-wide agent, before writing a task',
    async (roleName) => {
      for (const agentKey of ['development-agent', 'analytics-agent', 'outreach-acquisition-agent']) {
        const before = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentTasks)
          .where(sql`${agentTasks.agentKey} = ${agentKey} and ${agentTasks.requestedBy} in (select id from users where email like 'psc-%@wasit.tn')`);

        const result = await attempt(agentKey, roleName as UserRole);
        expect(result.refused, `${roleName} → ${agentKey}`).toBe(true);
        expect(result.refused && result.message).toContain('platform-wide');

        const after = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentTasks)
          .where(sql`${agentTasks.agentKey} = ${agentKey} and ${agentTasks.requestedBy} in (select id from users where email like 'psc-%@wasit.tn')`);
        expect(after[0]!.n).toBe(before[0]!.n);
      }
    },
  );

  it('audits the refusal with its own code', async () => {
    const userId = await insertUser('CUSTOMER');
    await expect(
      createAgentTask(
        db,
        ['CUSTOMER'],
        userId,
        { agentKey: 'development-agent', requestedBy: userId, input: {} },
        { ...AUDIT, actorId: userId },
      ),
    ).rejects.toThrow(/platform-wide/);

    const rows = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_RUN_REFUSED'), eq(auditLogs.entityId, 'development-agent')))
      .orderBy(sql`${auditLogs.createdAt} desc`)
      .limit(5);
    const codes = rows.map((r) => (r.metadata as { code?: string } | null)?.code);
    expect(codes).toContain('PLATFORM_SCOPE_REQUIRED');
  });

  it('does not refuse a platform administrator', async () => {
    const result = await attempt('development-agent', 'SUPER_ADMIN');
    expect(result.refused).toBe(false);
  });

  it('leaves a non-platform agent available to a customer', async () => {
    const result = await attempt('sales-agent', 'CUSTOMER');
    expect(result.refused).toBe(false);
  });
});

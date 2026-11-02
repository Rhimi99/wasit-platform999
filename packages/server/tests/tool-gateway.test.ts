import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import {
  allTools,
  findTool,
  registeredToolIds,
  UNBOUND_DECLARED_TOOLS,
  OPERATIONS_READ_HEALTH,
  RISK_READ_OVERVIEW,
  DISPUTES_READ_SUMMARY,
  PAYMENTS_READ_SETTLEMENTS,
  FINANCE_READ_LEDGER,
  PLATFORM_METRICS,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';
import { createAgentTask, getTask, executeDueTasks } from '../src/modules/ai/runner.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tool Gateway (AI-02.1).
 *
 * Proves the central gateway is the mandatory chokepoint for agent tools: an
 * unregistered tool can never run, an absent run context is refused, RBAC and
 * platform scope are enforced server-side, invalid input is rejected, identity
 * cannot be forged, every attempt is audited, and concurrent runs never share a
 * grant list. Every assertion is scoped to the ids this file created, because
 * the suite runs files in parallel against one database.
 */

const AUDIT = { actorId: 'ai02-tool-gateway-operator' };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];

type RoleName = 'SUPER_ADMIN' | 'MERCHANT' | 'SUPPORT' | 'RISK';

async function insertUser(roleName: RoleName): Promise<string> {
  const id = randomUUID();
  const email = `ai02-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('Ai02Pass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

/** A trusted run context with a unique task id (so audit rows are traceable). */
function ctx(overrides: {
  agentKey?: string;
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
}) {
  return {
    taskId: `ai02-ctx-${randomUUID()}`,
    agentKey: overrides.agentKey ?? 'analytics-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['SUPER_ADMIN']) as never,
    requestedBy: overrides.requestedBy ?? 'ai02-operator',
  };
}

async function expectGatewayRefusal(p: Promise<unknown>, code: string): Promise<ToolGatewayError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe(code);
    return err as ToolGatewayError;
  }
  throw new Error(`expected a ToolGatewayError(${code}) but the call resolved`);
}

afterAll(async () => {
  if (createdTaskIds.length > 0) await db.delete(auditLogs).where(eq(auditLogs.entityType, 'TOOL'));
  if (createdUserIds.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('registry — single source of truth, every tool has a real handler', () => {
  it('registers only read-only tools, each with a bound implementation', () => {
    expect(registeredToolIds().length).toBeGreaterThan(0);
    for (const t of allTools()) {
      expect(t.effect, t.id).toBe('read');
      expect(getToolHandler(t.id), `${t.id} must have a handler`).toBeTruthy();
    }
  });

  it('declared-but-unbound ids are NOT registered (allowedTools is not authority)', () => {
    for (const id of UNBOUND_DECLARED_TOOLS) {
      expect(findTool(id), id).toBeUndefined();
    }
  });

  it('the gateway-routed executors read ONLY through invokeTool (no direct cross-owner query)', () => {
    const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');
    const bodyOf = (name: string): string => {
      const start = SRC.indexOf(`async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const rest = SRC.slice(start + 1);
      const next = rest.indexOf('\nasync function ');
      return next === -1 ? rest : rest.slice(0, next);
    };
    for (const name of [
      'execAnalyticsAgent',
      'execOperationsAgent',
      'execRiskAgent',
      'execDisputeAssistant',
      'execFinanceAgent',
      'execPaymentSettlementAgent',
      'execComplianceAgent',
    ]) {
      const body = bodyOf(name);
      expect(body.includes('invokeTool('), `${name} must route through the gateway`).toBe(true);
      // No direct Drizzle read remains in a routed executor.
      expect(body.includes('.from('), `${name} must not query tables directly`).toBe(false);
    }
  });
});

describe('gateway — fail-closed authorization', () => {
  it('refuses a tool that is not registered', async () => {
    await expectGatewayRefusal(
      withAgentRunContext(ctx({ allowedTools: ['evil.tool'] }), () => invokeTool(db, 'evil.tool', {})),
      'TOOL_NOT_REGISTERED',
    );
  });

  it('refuses a declared-but-unregistered tool id', async () => {
    await expectGatewayRefusal(
      withAgentRunContext(ctx({ allowedTools: ['platform.read_catalog'] }), () => invokeTool(db, 'platform.read_catalog', {})),
      'TOOL_NOT_REGISTERED',
    );
  });

  it('refuses any tool without a trusted run context', async () => {
    await expectGatewayRefusal(invokeTool(db, OPERATIONS_READ_HEALTH, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a registered tool the run was not granted', async () => {
    await expectGatewayRefusal(
      withAgentRunContext(ctx({ allowedTools: [] }), () => invokeTool(db, OPERATIONS_READ_HEALTH, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('refuses when the requester lacks the tool permission (RBAC)', async () => {
    // SUPPORT holds dispute:read but NOT risk:read.
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [RISK_READ_OVERVIEW], requesterRoles: ['SUPPORT'] }),
        () => invokeTool(db, RISK_READ_OVERVIEW, {}),
      ),
      'PERMISSION_DENIED',
    );
  });

  it('refuses a platform-scoped tool for a non-admin that holds the permission', async () => {
    // RISK holds risk:read but is not an admin → platform data is refused.
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [RISK_READ_OVERVIEW], requesterRoles: ['RISK'] }),
        () => invokeTool(db, RISK_READ_OVERVIEW, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
  });

  it('refuses invalid input (unknown key, wrong type, out-of-range)', async () => {
    const granted = ctx({ allowedTools: [OPERATIONS_READ_HEALTH] });
    await expectGatewayRefusal(withAgentRunContext(granted, () => invokeTool(db, OPERATIONS_READ_HEALTH, { nope: 1 })), 'INVALID_INPUT');
    await expectGatewayRefusal(withAgentRunContext(granted, () => invokeTool(db, OPERATIONS_READ_HEALTH, { limit: 'x' })), 'INVALID_INPUT');
    await expectGatewayRefusal(withAgentRunContext(granted, () => invokeTool(db, OPERATIONS_READ_HEALTH, { limit: 9999 })), 'INVALID_INPUT');
  });

  it('cannot forge identity or roles through the args (strict schema + context-only RBAC)', async () => {
    // A caller passing userId/requestedBy/roles in the args is rejected outright
    // by the strict schema, even when the requester passes RBAC and scope.
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ allowedTools: [OPERATIONS_READ_HEALTH], requesterRoles: ['SUPER_ADMIN'] }),
        () => invokeTool(db, OPERATIONS_READ_HEALTH, { requestedBy: 'victim', userId: 'victim', roles: ['SUPER_ADMIN'] }),
      ),
      'INVALID_INPUT',
    );
  });
});

describe('gateway — real read tools execute and are audited', () => {
  it('runs a real read tool for a SUPER_ADMIN and writes an execution audit row', async () => {
    const c = ctx({ allowedTools: [OPERATIONS_READ_HEALTH], requesterRoles: ['SUPER_ADMIN'] });
    const out = await withAgentRunContext(c, () => invokeTool(db, OPERATIONS_READ_HEALTH, {}));
    expect(out.toolId).toBe(OPERATIONS_READ_HEALTH);
    expect(out.effect).toBe('read');
    expect(out.data).toHaveProperty('orderPipeline');
    expect(out.data).toHaveProperty('failedAgentTasks');

    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_EXECUTED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityId).toBe(OPERATIONS_READ_HEALTH);
  });

  it('audits a refusal with its reason code', async () => {
    const c = ctx({ allowedTools: [] });
    await expectGatewayRefusal(withAgentRunContext(c, () => invokeTool(db, OPERATIONS_READ_HEALTH, {})), 'ACTION_NOT_AUTHORIZED');
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_REFUSED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as { code?: string }).code).toBe('ACTION_NOT_AUTHORIZED');
  });

  it('runs every registered read tool end-to-end as SUPER_ADMIN', async () => {
    for (const t of allTools()) {
      const c = ctx({ allowedTools: [t.id], requesterRoles: ['SUPER_ADMIN'] });
      const out = await withAgentRunContext(c, () => invokeTool(db, t.id, {}));
      expect(out.toolId, t.id).toBe(t.id);
      expect(typeof out.data).toBe('object');
    }
  });
});

describe('gateway — isolation and integration with the runner', () => {
  it('does not leak a grant list between concurrent runs', async () => {
    const allowed = ctx({ allowedTools: [OPERATIONS_READ_HEALTH], requesterRoles: ['SUPER_ADMIN'] });
    const denied = ctx({ allowedTools: [], requesterRoles: ['SUPER_ADMIN'] });
    const [ok, refused] = await Promise.all([
      withAgentRunContext(allowed, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return invokeTool(db, OPERATIONS_READ_HEALTH, {});
      }),
      withAgentRunContext(denied, () => invokeTool(db, OPERATIONS_READ_HEALTH, {})).catch((e) => e),
    ]);
    expect((ok as { toolId: string }).toolId).toBe(OPERATIONS_READ_HEALTH);
    expect(refused).toBeInstanceOf(ToolGatewayError);
    expect((refused as ToolGatewayError).code).toBe('ACTION_NOT_AUTHORIZED');
  });

  it('runs a real platform agent task through the gateway (admin) and succeeds', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const created = await createAgentTask(db, ['SUPER_ADMIN'], admin, { agentKey: 'operations-agent', taskType: 'operations.health_check', input: {} }, AUDIT);
    createdTaskIds.push(created.id);
    await executeDueTasks(db, 50);
    const done = await getTask(db, created.id);
    expect(done.status).toBe('succeeded');
    const advice = JSON.parse((done.result as { advice: string }).advice) as Record<string, unknown>;
    expect(advice.agentKey).toBe('operations-agent');
    expect(advice).toHaveProperty('orderPipeline');
    expect(advice.readOnly).toBe(true);
  });

  it('refuses a platform agent task for a non-admin (scope isolation intact)', async () => {
    const merchant = await insertUser('MERCHANT');
    // The runner refuses a non-admin at creation for a platform-scoped agent.
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant, { agentKey: 'risk-agent', taskType: 'risk.scan', input: {} }, AUDIT),
    ).rejects.toThrow();
  });

  it('exposes the registered platform tools to the platform agents (scoping list)', () => {
    expect(findTool(PLATFORM_METRICS)).toBeTruthy();
    for (const id of [OPERATIONS_READ_HEALTH, RISK_READ_OVERVIEW, DISPUTES_READ_SUMMARY, PAYMENTS_READ_SETTLEMENTS, FINANCE_READ_LEDGER]) {
      expect(findTool(id), id).toBeTruthy();
    }
  });
});

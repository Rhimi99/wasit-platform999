import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { campaigns, adEvents } from '../src/db/schema/ads.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { invokeTool, ToolGatewayError } from '../src/lib/ai/tool-gateway.js';
import {
  ADS_READ_CAMPAIGNS,
  DEVELOPMENT_READ_PLATFORM,
  UNBOUND_DECLARED_TOOLS,
  allTools,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';
import { getToolHandler } from '../src/lib/ai/tool-handlers.js';
import { AGENT_CATALOGUE, findAgentSpec } from '../src/modules/ai/catalogue.js';
import { createAgentTask, decideAgentTask, executeDueTasks, getTask } from '../src/modules/ai/runner.js';
import { DEFAULT_SCHEDULES } from '../src/modules/ai/copilot.js';
import { OUTBOX_ROUTES, allowedOutboxAgentKeys } from '../src/modules/ai/outbox-routes.js';
import { SYSTEM_PRINCIPAL, deriveScope, NoScopeError } from '../src/modules/ai/scope.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * G5 Phase 1 — unify `execAdsAgent` and `execDevelopmentAgent` behind the
 * central Tool Gateway.
 *
 * These two executors were the last cross-owner readers that kept an inline
 * `requirePlatformGate` instead of the gateway. Phase 1 routes their reads
 * through two new registered read-only, platform-scoped tools
 * (`ads.read_campaigns`, `development.read_platform`) while KEEPING the inline
 * gate. This spec proves:
 *   - only the authorized path succeeds;
 *   - a missing trusted run context is refused;
 *   - an agent that was not granted the tool is refused;
 *   - platform scope is preserved (a role holding the permission but not an
 *     admin is still refused);
 *   - no data outside the scope leaks and no write occurs;
 *   - the scheduler, SYSTEM_PRINCIPAL and every other agent are untouched.
 *
 * Every assertion is scoped to ids this file created, because the suite runs
 * files in parallel against one shared database.
 */

const AUDIT = { actorId: 'g5p1-tool-unification' };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];

type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MARKETER' | 'RISK' | 'MERCHANT';

async function insertUser(roleName: RoleName): Promise<string> {
  const id = randomUUID();
  const email = `g5p1-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id, email, passwordHash: await argon2.hash('G5P1Pass123!'), firstName: roleName, isActive: true, emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

function ctx(overrides: {
  agentKey?: string;
  allowedTools?: readonly string[];
  requesterRoles?: readonly RoleName[];
  requestedBy?: string;
}) {
  return {
    taskId: `g5p1-ctx-${randomUUID()}`,
    agentKey: overrides.agentKey ?? 'ads-agent',
    allowedTools: overrides.allowedTools ?? [],
    requesterRoles: (overrides.requesterRoles ?? ['SUPER_ADMIN']) as never,
    requestedBy: overrides.requestedBy ?? 'g5p1-operator',
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
  if (createdTaskIds.length > 0) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length > 0) {
    await db.delete(auditLogs).where(sql`${auditLogs.metadata}->>'actorId' = ${AUDIT.actorId}`);
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('G5 Phase 1 — the two new tools are registered, read-only and platform-scoped', () => {
  it('registers ads.read_campaigns and development.read_platform with bound handlers', () => {
    for (const id of [ADS_READ_CAMPAIGNS, DEVELOPMENT_READ_PLATFORM]) {
      const tool = findTool(id);
      expect(tool, id).toBeTruthy();
      expect(tool?.effect, id).toBe('read');
      expect(tool?.platformScoped, id).toBe(true);
      expect(isRegisteredTool(id), id).toBe(true);
      expect(registeredToolIds(), id).toContain(id);
      expect(getToolHandler(id), `${id} must have a handler`).toBeTruthy();
    }
  });

  it('every registered tool is still read-only (no write tool was introduced)', () => {
    for (const t of allTools()) expect(t.effect, t.id).toBe('read');
  });

  it('declared-but-unbound tools remain unregistered and inert (not enabled by G5)', () => {
    for (const id of UNBOUND_DECLARED_TOOLS) {
      expect(findTool(id), id).toBeUndefined();
      expect(registeredToolIds(), id).not.toContain(id);
    }
  });
});

describe('G5 Phase 1 — gateway refuses the unauthorized path (fail-closed)', () => {
  it('refuses both tools when there is no trusted run context', async () => {
    await expectGatewayRefusal(invokeTool(db, ADS_READ_CAMPAIGNS, {}), 'NO_RUN_CONTEXT');
    await expectGatewayRefusal(invokeTool(db, DEVELOPMENT_READ_PLATFORM, {}), 'NO_RUN_CONTEXT');
  });

  it('refuses a tool the run was not granted (agent lacks the tool)', async () => {
    await expectGatewayRefusal(
      withAgentRunContext(ctx({ agentKey: 'ads-agent', allowedTools: [] }), () => invokeTool(db, ADS_READ_CAMPAIGNS, {})),
      'ACTION_NOT_AUTHORIZED',
    );
    await expectGatewayRefusal(
      withAgentRunContext(ctx({ agentKey: 'development-agent', allowedTools: [] }), () => invokeTool(db, DEVELOPMENT_READ_PLATFORM, {})),
      'ACTION_NOT_AUTHORIZED',
    );
  });

  it('preserves platform scope: a role holding the permission but not an admin is refused', async () => {
    // RISK holds `analytics:read:all` but is not an admin → platform data refused.
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ agentKey: 'development-agent', allowedTools: [DEVELOPMENT_READ_PLATFORM], requesterRoles: ['RISK'] }),
        () => invokeTool(db, DEVELOPMENT_READ_PLATFORM, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
    // MARKETER holds `ad:manage` but is not an admin → platform data refused.
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ agentKey: 'ads-agent', allowedTools: [ADS_READ_CAMPAIGNS], requesterRoles: ['MARKETER'] }),
        () => invokeTool(db, ADS_READ_CAMPAIGNS, {}),
      ),
      'PLATFORM_SCOPE_DENIED',
    );
  });

  it('cannot forge identity or scope through parameters (strict schema)', async () => {
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ agentKey: 'ads-agent', allowedTools: [ADS_READ_CAMPAIGNS], requesterRoles: ['SUPER_ADMIN'] }),
        () => invokeTool(db, ADS_READ_CAMPAIGNS, { requestedBy: 'victim', userId: 'victim', isPlatform: true }),
      ),
      'INVALID_INPUT',
    );
    await expectGatewayRefusal(
      withAgentRunContext(
        ctx({ agentKey: 'development-agent', allowedTools: [DEVELOPMENT_READ_PLATFORM], requesterRoles: ['SUPER_ADMIN'] }),
        () => invokeTool(db, DEVELOPMENT_READ_PLATFORM, { scope: 'platform', roles: ['SUPER_ADMIN'] }),
      ),
      'INVALID_INPUT',
    );
  });
});

describe('G5 Phase 1 — authorized access succeeds and is audited, with no write', () => {
  it('runs both tools for a SUPER_ADMIN and returns the expected snapshot shape', async () => {
    const ads = await withAgentRunContext(
      ctx({ agentKey: 'ads-agent', allowedTools: [ADS_READ_CAMPAIGNS], requesterRoles: ['SUPER_ADMIN'] }),
      () => invokeTool(db, ADS_READ_CAMPAIGNS, {}),
    );
    expect(ads.toolId).toBe(ADS_READ_CAMPAIGNS);
    expect(ads.effect).toBe('read');
    const adsSnap = ads.data.snapshot as Record<string, unknown>;
    for (const k of ['campaigns', 'activeCampaigns', 'impressions', 'clicks', 'conversions', 'ctr', 'budgetVsSpend']) {
      expect(adsSnap, k).toHaveProperty(k);
    }

    const dev = await withAgentRunContext(
      ctx({ agentKey: 'development-agent', allowedTools: [DEVELOPMENT_READ_PLATFORM], requesterRoles: ['SUPER_ADMIN'] }),
      () => invokeTool(db, DEVELOPMENT_READ_PLATFORM, {}),
    );
    expect(dev.toolId).toBe(DEVELOPMENT_READ_PLATFORM);
    const devSnap = dev.data.snapshot as Record<string, unknown>;
    for (const k of ['users', 'products', 'orders', 'campaigns', 'kpiDays', 'lastDaily']) {
      expect(devSnap, k).toHaveProperty(k);
    }
  });

  it('writes an AI.TOOL_EXECUTED audit row for each invocation', async () => {
    const c = ctx({ agentKey: 'ads-agent', allowedTools: [ADS_READ_CAMPAIGNS], requesterRoles: ['SUPER_ADMIN'] });
    await withAgentRunContext(c, () => invokeTool(db, ADS_READ_CAMPAIGNS, {}));
    const rows = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} = 'AI.TOOL_EXECUTED' and ${auditLogs.metadata}->>'taskId' = ${c.taskId}`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityId).toBe(ADS_READ_CAMPAIGNS);
  });

  it('repeated reads create no rows (read-only, no write anywhere)', async () => {
    const countCampaigns = async () => Number((await db.select({ v: sql<number>`count(*)::int` }).from(campaigns))[0]?.v ?? 0);
    const countEvents = async () => Number((await db.select({ v: sql<number>`count(*)::int` }).from(adEvents))[0]?.v ?? 0);
    const beforeCampaigns = await countCampaigns();
    const beforeEvents = await countEvents();

    const c = ctx({ agentKey: 'ads-agent', allowedTools: [ADS_READ_CAMPAIGNS], requesterRoles: ['SUPER_ADMIN'] });
    for (let i = 0; i < 3; i++) {
      const out = await withAgentRunContext(c, () => invokeTool(db, ADS_READ_CAMPAIGNS, {}));
      expect(out.effect).toBe('read');
    }
    expect(await countCampaigns()).toBe(beforeCampaigns);
    expect(await countEvents()).toBe(beforeEvents);
  });
});

describe('G5 Phase 1 — the real executors route through the gateway (integration)', () => {
  async function runAndComplete(agentKey: string, input: Record<string, unknown>, staffId: string) {
    const created = await createAgentTask(db, ['SUPER_ADMIN'], staffId, { agentKey, requestedBy: staffId, input }, AUDIT);
    createdTaskIds.push(created.id);
    if (created.status === 'awaiting_approval') {
      await decideAgentTask(db, created.id, staffId, 'APPROVE', 'g5p1 auto approval', AUDIT);
      await executeDueTasks(db, 50);
      return getTask(db, created.id);
    }
    return created;
  }

  it('runs ads-agent end-to-end as an admin and returns its snapshot', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const task = await runAndComplete('ads-agent', { action: 'recommend_ads' }, admin);
    expect(['succeeded', 'approved']).toContain(task.status);
    const advice = JSON.parse(((task.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    expect(advice.agentKey).toBe('ads-agent');
    expect(advice).toHaveProperty('snapshot');
    expect(advice.readOnly).toBe(true);
  });

  it('runs development-agent end-to-end as an admin and returns its next steps', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const task = await runAndComplete('development-agent', { action: 'dev_plan' }, admin);
    expect(['succeeded', 'approved']).toContain(task.status);
    const advice = JSON.parse(((task.result as { advice?: string }).advice ?? '{}')) as Record<string, unknown>;
    expect(advice.agentKey).toBe('development-agent');
    expect(advice).toHaveProperty('nextSteps');
    expect(advice.readOnly).toBe(true);
  });

  it('refuses a platform agent task for a non-admin (scope isolation intact)', async () => {
    const merchant = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant, { agentKey: 'ads-agent', taskType: 'ads.propose_budget', input: {} }, AUDIT),
    ).rejects.toThrow();
  });

  it('the two executors read ONLY through invokeTool (no direct cross-owner query)', () => {
    const SRC = readFileSync(join(__dirname, '..', 'src', 'modules', 'ai', 'executors.ts'), 'utf8');
    const bodyOf = (name: string): string => {
      const start = SRC.indexOf(`async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const rest = SRC.slice(start + 1);
      const next = rest.indexOf('\nasync function ');
      return next === -1 ? rest : rest.slice(0, next);
    };
    for (const name of ['execAdsAgent', 'execDevelopmentAgent']) {
      const body = bodyOf(name);
      expect(body.includes('invokeTool('), `${name} must route through the gateway`).toBe(true);
      expect(body.includes('requirePlatformGate('), `${name} must keep its inline gate`).toBe(true);
      expect(body.includes('.from('), `${name} must not query tables directly`).toBe(false);
    }
  });
});

describe('G5 Phase 1 — no widening: tools granted only to their own agent; scheduler untouched', () => {
  it('grants ads.read_campaigns only to ads-agent and development.read_platform only to development-agent', () => {
    for (const agent of AGENT_CATALOGUE) {
      const grant = toolGrantForAgent(agent);
      if (agent.key === 'ads-agent') expect(grant, agent.key).toContain(ADS_READ_CAMPAIGNS);
      else expect(grant, agent.key).not.toContain(ADS_READ_CAMPAIGNS);
      if (agent.key === 'development-agent') expect(grant, agent.key).toContain(DEVELOPMENT_READ_PLATFORM);
      else expect(grant, agent.key).not.toContain(DEVELOPMENT_READ_PLATFORM);
    }
  });

  it('does not change either agent permission set or platform-scope declaration', () => {
    const ads = findAgentSpec('ads-agent')!;
    const dev = findAgentSpec('development-agent')!;
    expect(ads.requiresPlatformScope).toBe(true);
    expect(dev.requiresPlatformScope).toBe(true);
    expect(ads.permissionsRequired).toEqual(['ai:use', 'ad:create']);
    expect(dev.permissionsRequired).toEqual(['ai:use']);
    expect(ads.approvalActions).toEqual(['ads.spend_increase']);
    expect(dev.approvalActions).toEqual(['prod.deploy', 'prod.migrate']);
  });

  it('leaves the scheduler and outbox principals untouched (neither agent is scheduled or routed)', () => {
    const scheduled = DEFAULT_SCHEDULES.map((s) => s.agentKey);
    expect(scheduled).not.toContain('ads-agent');
    expect(scheduled).not.toContain('development-agent');
    expect(allowedOutboxAgentKeys()).not.toContain('ads-agent');
    expect(allowedOutboxAgentKeys()).not.toContain('development-agent');
    for (const route of Object.values(OUTBOX_ROUTES)) {
      expect(route.agentKey).not.toBe('ads-agent');
      expect(route.agentKey).not.toBe('development-agent');
    }
  });

  it('SYSTEM_PRINCIPAL still cannot be used as an owner scope', () => {
    expect(() => deriveScope({ userId: SYSTEM_PRINCIPAL })).toThrow(NoScopeError);
  });
});

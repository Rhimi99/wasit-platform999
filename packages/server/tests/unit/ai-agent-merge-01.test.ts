import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOGUE,
  CORE_SPECIALIST_KEYS,
  SENSITIVE_ACTIONS,
  SUPERVISOR_KEY,
  agentLayerCounts,
  executableAgents,
  findAgentSpec,
} from '../../src/modules/ai/catalogue.js';
import { EXECUTABLE_AGENT_KEYS, EXECUTOR_ACTION } from '../../src/modules/ai/executors.js';
import {
  AGENT_SCOPE_CONTRACTS,
  AgentScopeError,
  assertTableAccess,
  getAgentScopeContract,
} from '../../src/modules/ai/agent-scope.js';
import type { AgentRunContext } from '../../src/lib/ai/agent-run-context.js';

/**
 * AI-AGENT-MERGE-01 — the merge contract, asserted without a database.
 *
 * The General Manager's constraints are executable here: no agent replaced, no
 * agent deleted, no function lost, no permission widened, and no new external,
 * financial or technical power without an approval gate.
 */

const OFFICIAL_TWELVE = [
  'sales-agent',
  'marketing-agent',
  'ads-agent',
  'product-agent',
  'support-agent',
  'analytics-agent',
  'market-research-agent',
  'b2b-agent',
  'risk-agent',
  'dispute-assistant',
  'development-agent',
  'marketing-video-agent',
];

const ALL_KEYS = [
  ...OFFICIAL_TWELVE,
  'finance-agent',
  'payment-settlement-agent',
  'compliance-agent',
  'supplier-agent',
  'merchant-agent',
  'customer-intelligence-agent',
  'operations-agent',
  'outreach-acquisition-agent',
  SUPERVISOR_KEY,
].sort();

/** Permissions as they stood before the merge — the merge may not widen them. */
const PERMISSIONS_BEFORE: Record<string, string[]> = {
  'sales-agent': ['ai:use'],
  'marketing-agent': ['ai:use'],
  'ads-agent': ['ai:use', 'ad:create'],
  'product-agent': ['ai:use'],
  'support-agent': ['ai:use'],
  'analytics-agent': ['ai:use', 'analytics:read:own'],
  'market-research-agent': ['ai:use'],
  'b2b-agent': ['ai:use'],
  'risk-agent': ['risk:read'],
  'dispute-assistant': ['dispute:read'],
  'development-agent': ['ai:use'],
  'marketing-video-agent': ['ai:use'],
  'finance-agent': ['ai:use', 'revenue:read'],
  'payment-settlement-agent': ['ai:use', 'order:read'],
  'compliance-agent': ['ai:use', 'order:read'],
  'supplier-agent': ['ai:use'],
  'merchant-agent': ['ai:use'],
  'customer-intelligence-agent': ['ai:use', 'analytics:read:own'],
  'operations-agent': ['ai:use'],
  'outreach-acquisition-agent': ['ai:use'],
  [SUPERVISOR_KEY]: ['ai:manage'],
};


/** A trusted run context for an agent, with the contract's own table allow-list. */
function runContext(agentKey: string): AgentRunContext {
  const contract = getAgentScopeContract(agentKey)!;
  return {
    taskId: 't-contract',
    agentKey,
    requestedBy: 'owner-1',
    allowedTables: contract.allowedTables,
    authorizedActions: [],
    allowedTools: [],
    requesterRoles: ['SUPER_ADMIN'],
  } as AgentRunContext;
}

describe('AI-AGENT-MERGE-01 — identity is preserved', () => {
  it('keeps exactly the same 21 agents, with no replacement and no deletion', () => {
    expect(AGENT_CATALOGUE.map((a) => a.key).sort()).toEqual(ALL_KEYS);
    expect(new Set(AGENT_CATALOGUE.map((a) => a.key)).size).toBe(21);
  });

  it('keeps the official twelve core specialists in the approved order', () => {
    expect([...CORE_SPECIALIST_KEYS]).toEqual(OFFICIAL_TWELVE);
    for (const key of OFFICIAL_TWELVE) expect(findAgentSpec(key)?.tier).toBe('CORE_SPECIALIST');
  });

  it('keeps every agent’s tier, category and task types unique', () => {
    expect(agentLayerCounts()).toEqual({
      total: 21,
      specialised: 20,
      supervisor: 1,
      executable: 20,
      declared: 0,
      copilot: 1,
    });

    const taskTypes = AGENT_CATALOGUE.flatMap((a) => a.taskTypes ?? []);
    expect(new Set(taskTypes).size).toBe(taskTypes.length);

    const names = AGENT_CATALOGUE.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not widen a single permission', () => {
    for (const [key, perms] of Object.entries(PERMISSIONS_BEFORE)) {
      expect(findAgentSpec(key)?.permissionsRequired.slice().sort(), key).toEqual(perms.slice().sort());
    }
  });

  it('keeps the marketing video agent planning-only: no render or publish executor', () => {
    const video = findAgentSpec('marketing-video-agent')!;
    // GM decision (AI-FIRST-COMPLETION-02): the agent plans a video; the render
    // runs in the media module (an audited write agents may not perform) and
    // publication has no executor at all.
    expect(video.executable).toBe(true);
    expect(video.tier).toBe('CORE_SPECIALIST');
    expect(EXECUTABLE_AGENT_KEYS).toContain('marketing-video-agent');
    expect(EXECUTOR_ACTION['marketing-video-agent']).toBe('plan_video');
    for (const gated of ['render_video', 'publish_video']) {
      expect(video.capabilities.find((c) => c.action === gated)?.requiresApproval, gated).toBe(true);
    }
  });
});

describe('AI-AGENT-MERGE-01 — merged specialisations', () => {
  it('makes the growth agent rank markets without ever sending or spending', () => {
    const growth = findAgentSpec('outreach-acquisition-agent')!;
    const actions = growth.capabilities.map((c) => c.action);

    expect(actions).toEqual(expect.arrayContaining(['discover_markets', 'qualify_opportunities', 'draft']));
    // Backward compatibility: the historical cycle and its actions survive.
    expect(actions).toEqual(expect.arrayContaining(['discover', 'verify', 'classify_fit']));
    expect(growth.taskTypes).toContain('outreach.run_cycle');
    expect(growth.taskTypes).toEqual(expect.arrayContaining(['growth.discover_markets']));

    for (const action of ['outreach.send', 'growth.paid_campaign']) {
      expect(growth.approvalActions, action).toContain(action);
      expect(SENSITIVE_ACTIONS.has(action), action).toBe(true);
    }
    expect(growth.requiresHumanApproval).toBe(true);
    expect(EXECUTOR_ACTION[growth.key]).toBe('discover_markets');
  });

  it('makes the finance agent account read-only and never touch money', () => {
    const finance = findAgentSpec('finance-agent')!;
    const actions = finance.capabilities.map((c) => c.action);

    expect(actions).toEqual(expect.arrayContaining(['report_pnl', 'report_revenue', 'report_costs']));
    // Backward compatibility with the previous reconciliation task.
    expect(finance.taskTypes).toContain('finance.reconcile');
    expect(finance.allowedTools).not.toContain('finance.read_ledger');

    for (const action of ['finance.payout', 'finance.refund', 'commission.change']) {
      expect(finance.approvalActions).toContain(action);
      expect(SENSITIVE_ACTIONS.has(action), action).toBe(true);
    }
    // No capability can move money, and no executor can either.
    for (const action of actions) {
      expect(action).not.toMatch(/payout|refund|settle|transfer|withdraw|charge/);
    }
    expect(EXECUTOR_ACTION[finance.key]).toBe('report_pnl');
  });

  it('makes the maintenance agent diagnose automatically and repair only with approval', () => {
    const maintenance = findAgentSpec('development-agent')!;
    const actions = maintenance.capabilities.map((c) => c.action);

    expect(actions).toEqual(
      expect.arrayContaining(['diagnose_platform', 'propose_patch', 'write_tests', 'dev_plan']),
    );
    expect(maintenance.taskTypes).toContain('dev.plan_change');

    for (const action of ['code.apply_patch', 'code.merge', 'prod.deploy', 'prod.migrate']) {
      expect(maintenance.approvalActions).toContain(action);
      expect(SENSITIVE_ACTIONS.has(action), action).toBe(true);
    }
    expect(maintenance.requiresHumanApproval).toBe(false);
    expect(EXECUTOR_ACTION[maintenance.key]).toBe('diagnose_platform');
  });

  it('never lets an executor perform an action its agent does not declare', () => {
    for (const agent of executableAgents()) {
      const action = EXECUTOR_ACTION[agent.key];
      expect(action, `${agent.key} has an executor but no declared action`).toBeTruthy();
      expect(agent.capabilities.map((c) => c.action), `${agent.key}:${action}`).toContain(action);
    }
  });

  it('keeps every approval-declaring capability behind a sensitive approval action', () => {
    for (const agent of AGENT_CATALOGUE) {
      const gated = agent.capabilities.filter((c) => c.requiresApproval === true);
      if (gated.length === 0) continue;
      const approvalActions = agent.approvalActions ?? [];
      expect(approvalActions.length, agent.key).toBeGreaterThan(0);
      for (const action of approvalActions) {
        expect(SENSITIVE_ACTIONS.has(action), `${agent.key}:${action}`).toBe(true);
      }
    }
  });
});

describe('AI-AGENT-MERGE-01 — the gates hold outside the model', () => {
  it('gives every executable agent one contract and every other agent none', () => {
    expect(Object.keys(AGENT_SCOPE_CONTRACTS).sort()).toEqual(EXECUTABLE_AGENT_KEYS.slice().sort());
  });

  it('keeps the finance contract away from the ledger and the policy tables', () => {
    const contract = getAgentScopeContract('finance-agent')!;
    expect(contract.readOnly).toBe(true);
    expect(contract.allowedTables).not.toContain('transaction_ledger');
    expect(contract.allowedTables).not.toContain('commission_policies');
    const ctx = runContext('finance-agent');
    for (const table of ['transaction_ledger', 'commission_policies', 'audit_logs', 'users']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).toThrow(AgentScopeError);
    }
    for (const table of ['orders', 'campaigns', 'ad_events']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).not.toThrow();
    }
  });

  it('keeps the growth contract on platform reference data only', () => {
    const contract = getAgentScopeContract('outreach-acquisition-agent')!;
    expect(contract.readOnly).toBe(true);
    const ctx = runContext('outreach-acquisition-agent');
    for (const table of ['transaction_ledger', 'audit_logs', 'users', 'payouts']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).toThrow(AgentScopeError);
    }
    for (const table of ['countries', 'suppliers', 'merchants', 'companies', 'products', 'categories']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).not.toThrow();
    }
  });

  it('lets the maintenance contract read run state but never the audit trail', () => {
    const ctx = runContext('development-agent');
    for (const table of ['agent_tasks', 'agent_runs', 'agent_run_steps']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).not.toThrow();
    }
    for (const table of ['audit_logs', 'alert_events', 'transaction_ledger']) {
      expect(() => assertTableAccess(ctx, table, 'read'), table).toThrow(AgentScopeError);
    }
  });
});

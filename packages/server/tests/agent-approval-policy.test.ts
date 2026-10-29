import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS, PERMISSIONS, userHasAnyRole, type UserRole } from '@wasit/shared';
import { AGENT_CATALOGUE, findAgentSpec, SENSITIVE_ACTIONS, isSensitiveAction, resolveApproval } from '../src/modules/ai/catalogue.js';

/**
 * Pure catalogue policy tests — no database, no runner import.
 *
 * These pin the least-privilege model: the capability gate (`permissionsRequired`)
 * plus the data-access scope (`scope`/`requiresPlatformScope`). They are the
 * contract both the create-time and execution-time checks in the runner enforce.
 */

const BUSINESS_ROLES: UserRole[] = ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY'];

function allowed(role: UserRole, agent: (typeof AGENT_CATALOGUE)[number]): boolean {
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return true;
  const perms = ROLE_PERMISSIONS[role] as ReadonlySet<string>;
  return agent.permissionsRequired.every((p) => perms.has(p));
}

describe('agent least-privilege policy', () => {
  it('never lets a business role call the sensitive work agents', () => {
    for (const role of BUSINESS_ROLES) {
      for (const key of ['risk-agent', 'dispute-assistant', 'finance-agent', 'payment-settlement-agent', 'compliance-agent']) {
        const a = findAgentSpec(key)!;
        expect(allowed(role, a), `${role}/${key}`).toBe(false);
      }
    }
  });

  it('restricts platform-wide aggregates to analytics:read:all', () => {
    const analytics = findAgentSpec('analytics-agent')!;
    expect(analytics.requiresPlatformScope).toBe(true);
    expect(analytics.permissionsRequired).toContain(PERMISSIONS.ANALYTICS_READ_ALL);
    for (const role of BUSINESS_ROLES) {
      expect(userHasAnyRole([role], PERMISSIONS.ANALYTICS_READ_ALL), role).toBe(false);
      expect(allowed(role, analytics), role).toBe(false);
    }
  });

  it('does not gate the market-research agent: its output is anonymised counts only', () => {
    // Platform-wide *counts* are not another tenant's records, so a business
    // role may request it; the executor still scopes raw rows to the caller.
    const market = findAgentSpec('market-research-agent')!;
    expect(market.requiresPlatformScope).toBeFalsy();
  });

  it('scopes the private-data agents to the caller (own)', () => {
    for (const key of ['sales-agent', 'support-agent', 'customer-intelligence-agent']) {
      expect(findAgentSpec(key)!.scope, key).toBe('own');
    }
  });

  it('binds sales/support to the matching own-scoped read permission', () => {
    expect(findAgentSpec('sales-agent')!.permissionsRequired).toContain(PERMISSIONS.ORDER_READ_OWN);
    expect(findAgentSpec('support-agent')!.permissionsRequired).toContain(PERMISSIONS.MESSAGE_READ_OWN);
  });
});

/**
 * Pure approval-gate policy tests — no database, no runner import.
 *
 * These pin the P0 regression: a task type (e.g. `finance.reconcile`) is a
 * different string from the sensitive action it may produce (e.g.
 * `finance.payout`). The gate must key off the agent's `approvalActions` and the
 * global `SENSITIVE_ACTIONS`, never compare the two strings directly.
 */

function agent(key: string) {
  const a = findAgentSpec(key);
  if (!a) throw new Error(`missing catalogue agent ${key}`);
  return a;
}

describe('approval gate policy', () => {
  it('gates a financial agent whose task type differs from its approval action', () => {
    const fin = agent('finance-agent');
    expect(fin.taskTypes).toContain('finance.reconcile');
    expect(fin.approvalActions).not.toContain('finance.reconcile');
    const r = resolveApproval(fin, 'finance.reconcile');
    expect(r.requiresApproval).toBe(true);
    expect(r.approvalAction).toBe('finance.payout');
  });

  it('gates the outreach agent and labels it with outreach.send', () => {
    const r = resolveApproval(agent('outreach-acquisition-agent'), 'outreach.run_cycle');
    expect(r.requiresApproval).toBe(true);
    expect(r.approvalAction).toBe('outreach.send');
  });

  it('gates every agent that declares approval actions, on every task type', () => {
    for (const a of AGENT_CATALOGUE) {
      if (a.approvalActions.length === 0) continue;
      for (const t of a.taskTypes) {
        const r = resolveApproval(a, t);
        expect(r.requiresApproval, `${a.key}/${t}`).toBe(true);
        expect(r.approvalAction).not.toBeNull();
      }
    }
  });

  it('gates a globally sensitive task type even when the agent did not list it', () => {
    const r = resolveApproval(agent('outreach-acquisition-agent'), 'outreach.send');
    expect(r.requiresApproval).toBe(true);
    expect(r.approvalAction).toBe('outreach.send');
  });

  it('does NOT gate read-only agents', () => {
    for (const key of ['analytics-agent', 'product-agent', 'support-agent', 'market-research-agent', 'supplier-agent', 'merchant-agent', 'customer-intelligence-agent']) {
      const r = resolveApproval(agent(key), undefined);
      expect(r.requiresApproval, key).toBe(false);
      expect(r.approvalAction, key).toBeNull();
    }
  });

  it('does NOT gate the supervisor (oversight, no mutation)', () => {
    const sup = agent('agent-supervisor');
    expect(sup.approvalActions).toEqual([]);
    expect(resolveApproval(sup, 'supervisor.observe').requiresApproval).toBe(false);
  });

  it('falls back to the coarse flag when no approval actions are declared', () => {
    const synthetic = { ...agent('analytics-agent'), requiresHumanApproval: true, approvalActions: [] as string[] };
    const r = resolveApproval(synthetic as never, 'analytics.report');
    expect(r.requiresApproval).toBe(true);
    expect(r.approvalAction).toBe('analytics.report');
  });

  it('is deterministic and free of self-referencing task type comparison', () => {
    const fin = agent('finance-agent');
    expect(resolveApproval(fin, 'finance.reconcile')).toEqual(resolveApproval(fin, 'finance.reconcile'));
  });

  it('exposes the sensitive actions that must never auto-run', () => {
    for (const action of ['finance.payout', 'finance.refund', 'payment.settle', 'outreach.send', 'commission.change', 'prod.deploy', 'risk.block_account', 'dispute.final_decision', 'compliance.final_ruling', 'ads.spend_increase']) {
      expect(isSensitiveAction(action), action).toBe(true);
    }
    expect(SENSITIVE_ACTIONS.has('analytics.report')).toBe(false);
  });
});

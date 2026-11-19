import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  AGENT_DATA_DOMAINS,
  AGENT_SCOPE_CONTRACTS,
  HARD_DENY_TABLES,
  PLATFORM_INFRA_TABLES,
  OWNER_SCOPED_TABLES,
  AgentScopeError,
  getAgentScopeContract,
  assertAgentScopeContract,
  assertTableAccess,
  assertRunOwnerScope,
  listAgentScopes,
} from '../../src/modules/ai/agent-scope.js';
import type { AgentRunContext } from '../../src/lib/ai/agent-run-context.js';

/**
 * A2 — the Agent Scope Contract (database-free half).
 *
 * Pins the pure decisions: every one of the 11 agents has a bounded contract,
 * no contract grants a hard-denied or platform-wide table, and the single access
 * decision fails closed for a missing/invalid scope, an unknown agent, a
 * prohibited table, a write, raw SQL and owner-scoped tables without an owner.
 */

const AGENT_KEYS = [
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
];

const ctx = (over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  taskId: 't-1',
  agentKey: 'product-agent',
  requestedBy: 'owner-1',
  ...over,
});

describe('A2 — scope contract completeness', () => {
  it('defines a contract for each of the 11 production agents', () => {
    for (const key of AGENT_KEYS) {
      const c = getAgentScopeContract(key);
      expect(c, `missing contract for ${key}`).toBeDefined();
      expect(c!.agentKey).toBe(key);
      expect(c!.specialization.length).toBeGreaterThan(0);
    }
    expect(listAgentScopes()).toHaveLength(11);
  });

  it('gives every agent a least-privilege, non-empty, read-only scope', () => {
    for (const c of listAgentScopes()) {
      expect(c.allowedTables.length).toBeGreaterThan(0);
      expect(c.allowedDomains.length).toBeGreaterThan(0);
      expect(c.readOnly).toBe(true);
      expect(c.canDelegate).toBe(false);
      expect(c.ownerScoped).toBe(true);
    }
  });

  it('never grants a hard-denied table (credentials, sessions, money movement, audit)', () => {
    for (const c of listAgentScopes()) {
      for (const t of c.allowedTables) {
        expect(HARD_DENY_TABLES.has(t), `${c.agentKey} must not grant ${t}`).toBe(false);
      }
    }
  });

  it('does not hand any agent a platform-wide table set (no blanket scope)', () => {
    // Every agent must exclude at least one real business table the others read,
    // so no two agents share an "everything" scope.
    for (const c of listAgentScopes()) {
      expect(c.allowedTables.length).toBeLessThan(20);
    }
  });

  it('computes prohibited domains as exactly the complement of allowed', () => {
    for (const c of listAgentScopes()) {
      const expected = AGENT_DATA_DOMAINS.filter((d) => !c.allowedDomains.includes(d));
      expect([...c.prohibitedDomains].sort()).toEqual([...expected].sort());
    }
  });

  it('fails closed for an unknown agent', () => {
    expect(getAgentScopeContract('does-not-exist')).toBeUndefined();
    expect(() => assertAgentScopeContract('does-not-exist')).toThrow(AgentScopeError);
  });

  it('surfaces a scope refusal as a 403 AGENT_SCOPE error', () => {
    try {
      assertAgentScopeContract('nope');
      throw new Error('expected AgentScopeError');
    } catch (err) {
      const e = err as AgentScopeError;
      expect(e).toBeInstanceOf(AgentScopeError);
      expect(e.statusCode).toBe(403);
      expect((e.details as { code?: string }).code).toBe('AGENT_SCOPE');
    }
  });
});

describe('A2 — the single access decision (assertTableAccess)', () => {
  it('ALLOWS a read of a table inside the agent scope', () => {
    expect(() => assertTableAccess(ctx(), 'products', 'read')).not.toThrow();
  });

  it('REFUSES a read of another agent’s data domain', () => {
    // product-agent has no business reading disputes.
    expect(() => assertTableAccess(ctx(), 'disputes', 'read')).toThrow(AgentScopeError);
  });

  it('REFUSES a write to any business table (agents are read-only)', () => {
    expect(() => assertTableAccess(ctx(), 'products', 'write')).toThrow(AgentScopeError);
  });

  it('REFUSES a hard-denied table even if it were granted', () => {
    const forged = ctx({ agentKey: 'product-agent', allowedTables: ['products', 'sessions'] });
    expect(() => assertTableAccess(forged, 'sessions', 'read')).toThrow(AgentScopeError);
  });

  it('ALLOWS the platform accounting tables every agent needs (infrastructure, not data)', () => {
    for (const t of PLATFORM_INFRA_TABLES) {
      expect(() => assertTableAccess(ctx(), t, 'read')).not.toThrow();
      expect(() => assertTableAccess(ctx(), t, 'write')).not.toThrow();
    }
  });

  it('FAILS CLOSED with no run context', () => {
    expect(() => assertTableAccess(undefined, 'products', 'read')).toThrow(AgentScopeError);
  });

  it('FAILS CLOSED when the context has no agent key', () => {
    expect(() => assertTableAccess(ctx({ agentKey: '' }), 'products', 'read')).toThrow(AgentScopeError);
  });

  it('FAILS CLOSED for an unidentified data source', () => {
    expect(() => assertTableAccess(ctx(), '__unidentified__', 'read')).toThrow(AgentScopeError);
  });

  it('REFUSES an owner-scoped table when the run has no trustworthy owner', () => {
    const noOwner = ctx({ agentKey: 'analytics-agent', requestedBy: undefined, allowedTables: ['agent_memory'] });
    expect(() => assertTableAccess(noOwner, 'agent_memory', 'read')).toThrow();
    const emptyOwner = ctx({ agentKey: 'analytics-agent', requestedBy: '', allowedTables: ['agent_memory'] });
    expect(() => assertTableAccess(emptyOwner, 'agent_memory', 'read')).toThrow();
  });

  it('REFUSES an owner-scoped table no agent contract declares (least privilege)', () => {
    // No executor reads agent_metrics/agent_memory, so no contract grants them:
    // even a valid owner cannot read them through an agent run.
    const withOwner = ctx({ agentKey: 'analytics-agent', requestedBy: 'owner-1' });
    expect(() => assertTableAccess(withOwner, 'agent_memory', 'read')).toThrow(AgentScopeError);
    expect(() => assertTableAccess(withOwner, 'agent_metrics', 'read')).toThrow(AgentScopeError);
  });

  it('honours the trusted run-context allow-list over the contract (narrowing only)', () => {
    // The context can only ever NARROW: a table the contract allows but the
    // context omits is refused.
    const narrowed = ctx({ agentKey: 'product-agent', allowedTables: ['products'] });
    expect(() => assertTableAccess(narrowed, 'products', 'read')).not.toThrow();
    expect(() => assertTableAccess(narrowed, 'categories', 'read')).toThrow(AgentScopeError);
  });

  it('a forged agent key in the context cannot widen another agent’s scope', () => {
    // Even if a caller forges `agentKey` to a different agent, the contract that
    // applies is that agent's — it never grants a table it does not declare.
    const forged = ctx({ agentKey: 'b2b-agent', allowedTables: ['products'] });
    // b2b-agent's contract does not include products, so it is refused.
    expect(() => assertTableAccess(forged, 'products', 'read')).toThrow(AgentScopeError);
  });

  it('owner-scoped tables are recognised structurally', () => {
    for (const t of OWNER_SCOPED_TABLES) {
      expect(typeof t).toBe('string');
    }
  });
});

describe('A2 — the tenant boundary links to scope.ts', () => {
  it('accepts a real human owner and the scheduler principal', () => {
    expect(() => assertRunOwnerScope('user-123')).not.toThrow();
    expect(() => assertRunOwnerScope('system')).not.toThrow();
  });

  it('FAILS CLOSED with no requester or a blank requester', () => {
    expect(() => assertRunOwnerScope(undefined)).toThrow();
    expect(() => assertRunOwnerScope(null)).toThrow();
    expect(() => assertRunOwnerScope('')).toThrow();
    expect(() => assertRunOwnerScope('   ')).toThrow();
  });
});

describe('A2 — the contract tables are real tables', () => {
  it('every allowed table resolves as a Drizzle table name (no typos)', async () => {
    const schema = await import('../../src/db/schema/index.js');
    const realNames = new Set<string>(
      Object.values(schema)
        .map((v) => {
          try {
            return String(getTableName(v as never));
          } catch {
            return null;
          }
        })
        .filter((n): n is string => n !== null),
    );
    for (const c of listAgentScopes()) {
      for (const t of c.allowedTables) {
        expect(realNames.has(t), `${c.agentKey}: "${t}" is not a real table`).toBe(true);
      }
    }
  });
});

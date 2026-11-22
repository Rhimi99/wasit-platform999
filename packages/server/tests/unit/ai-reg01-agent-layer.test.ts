import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOGUE,
  COPILOT_CATALOGUE,
  COPILOT_KEY,
  SUPERVISOR_KEY,
  agentCount,
  agentLayerCounts,
  agentRunRefusal,
  allAgentSpecs,
  declaredOnlyAgents,
  executableAgents,
  findAgentSpec,
} from '../../src/modules/ai/catalogue.js';
import { AGENT_CATALOGUE as RUNTIME_CATALOGUE, createAgentTask } from '../../src/modules/ai/agents.js';
import { AGENT_SCOPE_CONTRACTS } from '../../src/modules/ai/agent-scope.js';
import { EXECUTABLE_AGENT_KEYS } from '../../src/modules/ai/executors.js';
import { auditLogs } from '../../src/db/schema/audit.js';
import { agentTasks } from '../../src/db/schema/agents.js';
import type { DB } from '../../src/db/client.js';

/**
 * AI-REG-01 — one agent layer.
 *
 * These assertions are the contract that keeps the catalogue, the executor
 * table, the scope contracts and the runtime agent list from drifting apart.
 * They are DB-free: runnability is a code property, not a registry row.
 */

const DECLARED_ONLY = [
  'payment-settlement-agent',
  'compliance-agent',
  'supplier-agent',
  'merchant-agent',
  'customer-intelligence-agent',
  'operations-agent',
].sort();

const ENFORCED_PERMISSIONS: Record<string, string[]> = {
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
  'finance-agent': ['ai:use', 'revenue:read'],
  'outreach-acquisition-agent': ['ai:use'],
};

function stubDb(): { db: DB; inserts: unknown[] } {
  const inserts: unknown[] = [];
  const db = {
    insert(table: unknown) {
      inserts.push(table);
      return { values: async () => undefined };
    },
    select() {
      throw new Error('a refused run must not read the database');
    },
  } as unknown as DB;
  return { db, inserts };
}

describe('AI-REG-01 — the agent layer is one source of truth', () => {
  it('is exactly 20 specialised agents plus the supervisor as #21', () => {
    expect(AGENT_CATALOGUE).toHaveLength(21);
    expect(agentCount()).toBe(21);
    expect(new Set(AGENT_CATALOGUE.map((a) => a.key)).size).toBe(21);
    expect(AGENT_CATALOGUE.filter((a) => a.isSupervisor === true)).toHaveLength(1);
    expect(AGENT_CATALOGUE[AGENT_CATALOGUE.length - 1]?.key).toBe(SUPERVISOR_KEY);
    expect(agentLayerCounts()).toEqual({
      total: 21,
      specialised: 20,
      supervisor: 1,
      executable: 14,
      declared: 6,
      copilot: 1,
    });
  });

  it('keeps the Copilot separate and never counted among the agents', () => {
    expect(COPILOT_KEY).toBe('wasit-copilot');
    expect(AGENT_CATALOGUE.some((a) => a.key === COPILOT_KEY)).toBe(false);
    expect(agentCount()).toBe(21);
    expect(allAgentSpecs()).toHaveLength(22);
    expect(findAgentSpec(COPILOT_KEY)).toBe(COPILOT_CATALOGUE);
    expect(agentRunRefusal(COPILOT_CATALOGUE)?.code).toBe('COPILOT_NOT_RUNNABLE');
  });

  it('marks executable exactly the agents that have a real executor', () => {
    const fromCatalogue = executableAgents().map((a) => a.key).sort();
    expect(fromCatalogue).toEqual([...EXECUTABLE_AGENT_KEYS].sort());
    expect(RUNTIME_CATALOGUE.map((a) => a.key).sort()).toEqual(fromCatalogue);
    expect(RUNTIME_CATALOGUE.every((a) => a.executable === true)).toBe(true);
    expect(fromCatalogue).toHaveLength(14);
  });

  it('keeps a scope contract for every executable agent and none for the rest', () => {
    expect(Object.keys(AGENT_SCOPE_CONTRACTS).sort()).toEqual(
      executableAgents().map((a) => a.key).sort(),
    );
  });

  it('preserves the enforced permissions of every executable agent', () => {
    for (const [key, perms] of Object.entries(ENFORCED_PERMISSIONS)) {
      expect(findAgentSpec(key)?.permissionsRequired.slice().sort()).toEqual(perms.slice().sort());
    }
  });

  it('declares the six declared-only agents explicitly', () => {
    expect(declaredOnlyAgents().map((a) => a.key).sort()).toEqual(DECLARED_ONLY);
  });

  it('refuses every agent without an executor, and the supervisor by name', () => {
    expect(declaredOnlyAgents()).toHaveLength(6);
    for (const agent of declaredOnlyAgents()) {
      const refusal = agentRunRefusal(agent);
      expect(refusal?.code).toBe('AGENT_NOT_EXECUTABLE');
      expect(refusal?.message).toContain(agent.key);
    }
    expect(agentRunRefusal(findAgentSpec(SUPERVISOR_KEY))?.code).toBe('SUPERVISOR_NOT_RUNNABLE');
    for (const agent of executableAgents()) {
      expect(agentRunRefusal(agent)).toBeNull();
    }
    expect(agentRunRefusal(undefined)?.code).toBe('UNKNOWN_AGENT');
  });

  it('refuses non-executable agents before any task row is written', async () => {
    for (const agentKey of [...DECLARED_ONLY, SUPERVISOR_KEY]) {
      const { db, inserts } = stubDb();
      await expect(
        createAgentTask(
          db,
          ['CUSTOMER'],
          'user-1',
          { agentKey, requestedBy: 'user-1', input: {} },
          { actorId: 'user-1' },
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      // The refusal is audited and measured; a task row is NEVER written.
      // (AI-MET-01 records a `blocked` measurement — a count, not a task.)
      expect(inserts.filter((t) => t === auditLogs)).toHaveLength(1);
      expect(inserts).not.toContain(agentTasks);
    }
  });

  it('refuses the Copilot through the run path as well', async () => {
    const { db, inserts } = stubDb();
    await expect(
      createAgentTask(
        db,
        ['SUPER_ADMIN'],
        'user-1',
        { agentKey: COPILOT_KEY, requestedBy: 'user-1', input: {} },
        { actorId: 'user-1' },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(inserts).toContain(auditLogs);
    expect(inserts).not.toContain(agentTasks);
  });
});

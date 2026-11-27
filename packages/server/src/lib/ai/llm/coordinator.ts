import { getAgentScopeContract, type AgentScopeContract } from '../../../modules/ai/agent-scope';

/**
 * The coordinator identity (WASIT-COPILOT-01).
 *
 * The Copilot is NOT a 21st specialised agent: it has no executor, it is refused
 * by `agentRunRefusal`, and it is excluded from `AGENT_SCOPE_CONTRACTS` (which
 * describes exactly the 20 agents). What it does have is a *narrower* generation
 * grant than any agent: it may cite only the server-owned catalogue, and no
 * business table at all.
 */
export const COORDINATOR_AGENT_KEY = 'wasit-copilot';

/** The only fact source a coordinator plan may cite. Not a database table. */
export const CATALOGUE_SOURCE = 'agent_catalogue';

export const COORDINATOR_GENERATION_SCOPE: AgentScopeContract = {
  agentKey: COORDINATOR_AGENT_KEY,
  specialization: 'Coordination: understand a goal, choose specialised agents, aggregate results.',
  allowedDomains: [],
  // Empty of business tables on purpose: a plan is chosen from the catalogue,
  // never from a tenant's rows.
  allowedTables: [CATALOGUE_SOURCE],
  readOnly: true,
  prohibitedDomains: [],
  canDelegate: false,
  ownerScoped: true,
};

/**
 * The scope used to check a generation request's fact sources. Specialised
 * agents resolve through their contract (A2); the coordinator gets the
 * catalogue-only contract above, which cannot name any table.
 */
export function generationScopeFor(agentKey: string): AgentScopeContract | undefined {
  if (agentKey === COORDINATOR_AGENT_KEY) return COORDINATOR_GENERATION_SCOPE;
  return getAgentScopeContract(agentKey);
}

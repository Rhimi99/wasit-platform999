import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOGUE,
  COPILOT_CATALOGUE,
  COPILOT_KEY,
  CORE_SPECIALIST_KEYS,
  SENSITIVE_ACTIONS,
  SUPERVISOR_KEY,
  agentRunRefusal,
  catalogueIntegrity,
  coreSpecialistAgents,
  declaredOnlyAgents,
  executableAgents,
  findAgentSpec,
  governanceAgents,
  isSensitiveAction,
  supportingAgents,
} from '../../src/modules/ai/catalogue.js';
import { EXECUTABLE_AGENT_KEYS } from '../../src/modules/ai/executors.js';

/**
 * AI-ARCH-ALIGN-01 — the official WASIT AI structure, as code.
 *
 * The approved structure has exactly twelve Core Specialist Agents, a set of
 * internal supporting agents, and two governance layers (the Copilot and the
 * Supervisor) that are NOT specialists. These assertions keep the code honest:
 * an agent is official only if it is in `CORE_SPECIALIST_KEYS` AND carries the
 * matching tier, so neither side can be edited alone without a failure.
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

describe('AI-ARCH-ALIGN-01 — the twelve official Core Specialist Agents', () => {
  it('declares exactly the twelve official identities, in the approved order', () => {
    expect([...CORE_SPECIALIST_KEYS]).toEqual(OFFICIAL_TWELVE);
    expect(coreSpecialistAgents().map((a) => a.key)).toEqual(OFFICIAL_TWELVE);
  });

  it('gives every core specialist a complete, non-conflicting identity', () => {
    for (const agent of coreSpecialistAgents()) {
      expect(agent.tier, agent.key).toBe('CORE_SPECIALIST');
      expect(agent.name.trim(), agent.key).not.toBe('');
      expect(agent.nameAr, agent.key).toBeTruthy();
      expect(agent.mission, agent.key).toBeTruthy();
      expect(agent.description, agent.key).toBeTruthy();
      expect(agent.capabilities.length, agent.key).toBeGreaterThan(0);
      expect(agent.taskTypes?.length, agent.key).toBeGreaterThan(0);
      expect(agent.permissionsRequired.length, agent.key).toBeGreaterThan(0);
      // The approval decision is explicit for every official agent.
      expect(typeof agent.requiresHumanApproval, agent.key).toBe('boolean');
    }
  });

  it('keeps names and keys unique across the whole catalogue', () => {
    const keys = AGENT_CATALOGUE.map((a) => a.key);
    const names = AGENT_CATALOGUE.map((a) => a.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps task types unique per agent, so a goal cannot be routed ambiguously', () => {
    const seen = new Map<string, string>();
    for (const agent of AGENT_CATALOGUE) {
      for (const taskType of agent.taskTypes ?? []) {
        const owner = seen.get(taskType);
        expect(owner, `${taskType} is claimed by ${owner} and ${agent.key}`).toBeUndefined();
        seen.set(taskType, agent.key);
      }
    }
  });

  it('reports a clean structure through catalogueIntegrity()', () => {
    expect(catalogueIntegrity()).toEqual({ ok: true, problems: [] });
  });

  it('never counts the Copilot or the Supervisor as a specialist', () => {
    const core = coreSpecialistAgents().map((a) => a.key);
    expect(core).not.toContain(COPILOT_KEY);
    expect(core).not.toContain(SUPERVISOR_KEY);
    expect(AGENT_CATALOGUE.some((a) => a.key === COPILOT_KEY)).toBe(false);
  });

  it('separates supporting agents from the official twelve', () => {
    const supporting = supportingAgents().map((a) => a.key).sort();
    expect(supporting).toEqual(
      [
        'compliance-agent',
        'customer-intelligence-agent',
        'finance-agent',
        'merchant-agent',
        'operations-agent',
        'outreach-acquisition-agent',
        'payment-settlement-agent',
        'supplier-agent',
      ].sort(),
    );
    for (const key of supporting) {
      expect(OFFICIAL_TWELVE).not.toContain(key);
    }
  });

  it('classifies the Copilot and the Supervisor as governance, not specialists', () => {
    const governance = governanceAgents();
    expect(governance.map((a) => a.key).sort()).toEqual([COPILOT_KEY, SUPERVISOR_KEY].sort());
    expect(governance.every((a) => a.tier === 'GOVERNANCE')).toBe(true);
    expect(COPILOT_CATALOGUE.isCopilot).toBe(true);
    expect(findAgentSpec(SUPERVISOR_KEY)?.isSupervisor).toBe(true);
  });

  it('assigns a tier to every agent in the catalogue', () => {
    for (const agent of AGENT_CATALOGUE) {
      expect(agent.tier, agent.key).toBeDefined();
      expect(['CORE_SPECIALIST', 'SUPPORTING', 'GOVERNANCE']).toContain(agent.tier);
    }
  });
});

describe('AI-ARCH-ALIGN-01 — Marketing Video Agent contract', () => {
  const video = () => findAgentSpec('marketing-video-agent')!;

  it('exists as a core specialist with a full contract', () => {
    const spec = video();
    expect(spec.tier).toBe('CORE_SPECIALIST');
    expect(spec.name).toBe('Marketing Video Agent');
    expect(spec.mission).toBeTruthy();
    expect(spec.taskTypes).toEqual(expect.arrayContaining(['marketing.plan_video', 'marketing.produce_video']));
    expect(spec.capabilities.map((c) => c.action)).toEqual(
      expect.arrayContaining(['plan_video', 'write_script', 'build_storyboard', 'prepare_delivery']),
    );
  });

  it('separates production, approval and publication', () => {
    const spec = video();
    // Rendering and publishing are approval actions, and both are sensitive.
    expect(spec.approvalActions).toEqual(expect.arrayContaining(['video.publish', 'video.render_paid']));
    expect(isSensitiveAction('video.publish')).toBe(true);
    expect(SENSITIVE_ACTIONS.has('video.render_paid')).toBe(true);
    // The agent requires a human approval for its own tasks.
    expect(spec.requiresHumanApproval).toBe(true);
  });

  it('grants no publishing, spending or financial capability', () => {
    const spec = video();
    const actions = spec.capabilities.map((c) => c.action);
    for (const forbidden of ['send', 'publish', 'payout', 'refund', 'settle', 'spend']) {
      expect(actions).not.toContain(forbidden);
    }
    // No permission beyond the existing AI-use permission is introduced.
    expect(spec.permissionsRequired).toEqual(['ai:use']);
    // Its data scope is the caller's own catalogue, never the platform.
    expect(spec.scope).toBe('own');
  });

  it('is declared but NOT executable: no production tool exists on this branch', () => {
    const spec = video();
    expect(spec.executable).toBe(false);
    expect(executableAgents().map((a) => a.key)).not.toContain('marketing-video-agent');
    expect([...EXECUTABLE_AGENT_KEYS]).not.toContain('marketing-video-agent');
    expect(declaredOnlyAgents().map((a) => a.key)).toContain('marketing-video-agent');
    expect(agentRunRefusal(spec)).toMatchObject({ code: 'AGENT_NOT_EXECUTABLE' });
  });

  it('does not duplicate the Marketing Agent: different task types, same department', () => {
    const marketing = findAgentSpec('marketing-agent')!;
    expect(marketing.tier).toBe('CORE_SPECIALIST');
    expect(marketing.category).toBe(video().category);
    const marketingTypes = new Set(marketing.taskTypes ?? []);
    for (const taskType of video().taskTypes ?? []) {
      expect(marketingTypes.has(taskType)).toBe(false);
    }
  });
});

describe('AI-ARCH-ALIGN-01 — runnability is not identity', () => {
  it('refuses the Copilot, the Supervisor and every declared-only agent', () => {
    expect(agentRunRefusal(COPILOT_CATALOGUE)?.code).toBe('COPILOT_NOT_RUNNABLE');
    expect(agentRunRefusal(findAgentSpec(SUPERVISOR_KEY))?.code).toBe('SUPERVISOR_NOT_RUNNABLE');
    for (const agent of declaredOnlyAgents()) {
      expect(agentRunRefusal(agent)?.code).toBe('AGENT_NOT_EXECUTABLE');
    }
  });

  it('accepts every executable agent, and only those', () => {
    for (const agent of AGENT_CATALOGUE) {
      const refusal = agentRunRefusal(agent);
      expect(refusal === null, `${agent.key}: ${refusal?.message ?? ''}`).toBe(agent.executable === true);
    }
  });

  it('keeps the executable set at eleven core specialists after AI-AGENT-MERGE-01', () => {
    // The three new executors are supporting/growth agents; the twelve core
    // specialists still carry exactly eleven executors (video is identity-only).
    expect(coreSpecialistAgents().filter((a) => a.executable === true)).toHaveLength(11);
    expect(executableAgents()).toHaveLength(13);
  });
});

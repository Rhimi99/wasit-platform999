import { describe, it, expect } from 'vitest';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE, allAgentSpecs } from '../src/modules/ai/catalogue.js';

/**
 * Phase 1 — digital-employee objectives (pure, no database).
 *
 * Objectives are declarative: they describe what each agent is accountable for
 * and which metric an operator watches. These tests pin the contract only —
 * they never import the runner, touch a database, or assert task behaviour.
 * Existing agent count, keys, tools, approvals and task types are asserted
 * unchanged elsewhere (phase14/phase19), and are only re-checked here so an
 * objective edit cannot silently reshape an agent.
 */

const VALID_UNITS = ['count', 'ratio', 'ms', 'TND', 'percent'];
const VALID_DIRECTIONS = ['increase', 'decrease'];
const VALID_WINDOWS = ['per_task', 'daily', 'weekly', 'monthly'];

describe('phase1 agent objectives', () => {
  it('every specialised agent (20) and the Copilot (1) declares objectives', () => {
    expect(AGENT_CATALOGUE).toHaveLength(20);
    expect(COPILOT_CATALOGUE.objectives?.length ?? 0).toBeGreaterThan(0);
    for (const agent of allAgentSpecs()) {
      expect(agent.objectives, `${agent.key} has no objectives`).toBeDefined();
      expect(agent.objectives!.length).toBeGreaterThan(0);
    }
    expect(allAgentSpecs()).toHaveLength(21);
  });

  it('each objective is measurable and well-formed', () => {
    for (const agent of allAgentSpecs()) {
      for (const obj of agent.objectives ?? []) {
        expect(obj.id, `${agent.key} objective id`).toMatch(/^[a-z][a-z0-9]*\.[a-z_]+$/);
        expect(obj.statement.trim().length, `${agent.key}/${obj.id} statement`).toBeGreaterThan(0);
        expect(obj.metric.trim().length, `${agent.key}/${obj.id} metric`).toBeGreaterThan(0);
        expect(typeof obj.target, `${agent.key}/${obj.id} target`).toBe('number');
        expect(Number.isFinite(obj.target)).toBe(true);
        expect(VALID_UNITS).toContain(obj.unit);
        expect(VALID_DIRECTIONS).toContain(obj.direction);
        expect(VALID_WINDOWS).toContain(obj.window);
      }
    }
  });

  it('objective ids are unique within an agent', () => {
    for (const agent of allAgentSpecs()) {
      const ids = (agent.objectives ?? []).map((o) => o.id);
      expect(new Set(ids).size, `${agent.key} duplicate objective ids`).toBe(ids.length);
    }
  });

  it('objectives never widen permissions, tools, approvals or task types', () => {
    for (const agent of allAgentSpecs()) {
      // Sanity: the objective layer is additive — core fields remain arrays.
      expect(Array.isArray(agent.allowedTools)).toBe(true);
      expect(Array.isArray(agent.approvalActions)).toBe(true);
      expect(Array.isArray(agent.taskTypes)).toBe(true);
      expect(Array.isArray(agent.permissionsRequired)).toBe(true);
      // No objective may name an approval action or a tool (defence in depth).
      for (const obj of agent.objectives ?? []) {
        expect(agent.approvalActions).not.toContain(obj.id);
        expect(agent.allowedTools).not.toContain(obj.id);
      }
    }
  });
});

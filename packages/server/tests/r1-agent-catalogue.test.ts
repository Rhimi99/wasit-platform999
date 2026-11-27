import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOGUE,
  COPILOT_CATALOGUE,
  COPILOT_KEY,
  SENSITIVE_ACTIONS,
  SUPERVISOR_KEY,
  agentCount,
  allAgentSpecs,
  authorizedActionsForAgent,
  findAgentSpec,
  isSensitiveAction,
} from '../src/modules/ai/catalogue.js';
import { AGENT_CATALOGUE as EXECUTABLE_CATALOGUE } from '../src/modules/ai/agents.js';
import { AGENT_SCOPE_CONTRACTS } from '../src/modules/ai/agent-scope.js';

describe('R1 — catalogue identity: specialised agents + a separate Copilot', () => {
  it('declares exactly 21 specialised agents', () => {
    expect(AGENT_CATALOGUE).toHaveLength(21);
    expect(agentCount()).toBe(21);
  });

  it('keeps the Copilot outside the specialised agents', () => {
    expect(AGENT_CATALOGUE.some((a) => a.key === COPILOT_KEY)).toBe(false);
    expect(AGENT_CATALOGUE.some((a) => a.isCopilot)).toBe(false);
    expect(COPILOT_CATALOGUE.isCopilot).toBe(true);
    expect(COPILOT_CATALOGUE.key).toBe(COPILOT_KEY);
  });

  it('counts the Copilot in the full spec list but not in agentCount', () => {
    expect(allAgentSpecs()).toHaveLength(22);
    expect(allAgentSpecs()[0]!.key).toBe(COPILOT_KEY);
  });

  it('makes the last agent the Agent Supervisor', () => {
    expect(AGENT_CATALOGUE).toHaveLength(21);
    const last = AGENT_CATALOGUE[AGENT_CATALOGUE.length - 1]!;
    expect(last.key).toBe(SUPERVISOR_KEY);
    expect(last.name).toBe('Agent Supervisor');
    expect(last.isSupervisor).toBe(true);
    expect(last.category).toBe('oversight');
  });

  it('has exactly one supervisor', () => {
    expect(AGENT_CATALOGUE.filter((a) => a.isSupervisor)).toHaveLength(1);
  });
});

describe('R1 — catalogue integrity: unique keys, no duplicates', () => {
  it('uses unique keys', () => {
    const keys = AGENT_CATALOGUE.map((a) => a.key);
    expect(new Set(keys).size).toBe(21);
  });

  it('keeps the Copilot key distinct from every agent key', () => {
    expect(AGENT_CATALOGUE.map((a) => a.key)).not.toContain(COPILOT_KEY);
  });

  it('gives every agent a non-empty name, mission, category and Arabic name', () => {
    for (const a of AGENT_CATALOGUE) {
      expect(a.name.length, a.key).toBeGreaterThan(0);
      expect(a.mission?.length ?? 0, a.key).toBeGreaterThan(0);
      expect(a.category?.length ?? 0, a.key).toBeGreaterThan(0);
      expect(a.nameAr?.length ?? 0, a.key).toBeGreaterThan(0);
    }
  });

  it('gives every agent at least one declared capability action', () => {
    for (const a of AGENT_CATALOGUE) {
      expect(a.capabilities.length, a.key).toBeGreaterThan(0);
      for (const c of a.capabilities) expect(c.action.length, a.key).toBeGreaterThan(0);
    }
  });

  it('declares at least one task type per agent', () => {
    for (const a of AGENT_CATALOGUE) {
      expect((a.taskTypes ?? []).length, a.key).toBeGreaterThan(0);
    }
  });

  it('gives every agent at least one measurable objective with a valid unit', () => {
    const units = new Set(['count', 'ratio', 'ms', 'TND', 'percent']);
    for (const a of AGENT_CATALOGUE) {
      const objectives = a.objectives ?? [];
      expect(objectives.length, a.key).toBeGreaterThan(0);
      for (const o of objectives) {
        expect(o.id.length, a.key).toBeGreaterThan(0);
        expect(units.has(o.unit), `${a.key}/${o.id}`).toBe(true);
      }
    }
  });

  it('uses objective ids unique within their agent', () => {
    for (const a of AGENT_CATALOGUE) {
      const ids = (a.objectives ?? []).map((o) => o.id);
      expect(new Set(ids).size, a.key).toBe(ids.length);
    }
  });
});

describe('R1 — no new execution authority is granted', () => {
  it('marks exactly the 20 wired agents executable', () => {
    const executable = AGENT_CATALOGUE.filter((a) => a.executable === true).map((a) => a.key);
    expect(executable).toHaveLength(20);
    for (const key of executable) {
      expect(EXECUTABLE_CATALOGUE.some((a) => a.key === key), key).toBe(true);
    }
  });

  it('marks every agent without an executor non-executable', () => {
    const restored = AGENT_CATALOGUE.filter((a) => a.executable !== true).map((a) => a.key);
    expect(restored.sort()).toEqual(['agent-supervisor']);
  });

  it('never marks a non-executable agent as one the runtime catalogue knows', () => {
    const runtimeKeys = new Set(EXECUTABLE_CATALOGUE.map((a) => a.key));
    for (const a of AGENT_CATALOGUE.filter((x) => x.executable !== true)) {
      expect(runtimeKeys.has(a.key), a.key).toBe(false);
    }
  });

  it('keeps the runtime catalogue in step with the executable set (20)', () => {
    expect(EXECUTABLE_CATALOGUE).toHaveLength(20);
  });

  it('gives every executable agent exactly one A2 scope contract (20)', () => {
    expect(Object.keys(AGENT_SCOPE_CONTRACTS)).toHaveLength(20);
    for (const a of AGENT_CATALOGUE.filter((x) => x.executable !== true)) {
      expect(AGENT_SCOPE_CONTRACTS[a.key], a.key).toBeUndefined();
    }
  });

  it('derives authorised actions from capabilities only, never from allowedTools', () => {
    for (const a of AGENT_CATALOGUE) {
      expect(authorizedActionsForAgent(a)).toEqual(a.capabilities.map((c) => c.action));
    }
  });

  it('grants the supervisor no write-flavoured tool', () => {
    const supervisor = findAgentSpec(SUPERVISOR_KEY)!;
    for (const tool of supervisor.allowedTools ?? []) {
      expect(tool.includes('write') || tool.includes('persist') || tool.includes('send')).toBe(
        false,
      );
    }
  });
});

describe('R1 — approval metadata is coherent', () => {
  it('gates every agent that declares a sensitive approval action', () => {
    for (const a of AGENT_CATALOGUE) {
      for (const action of a.approvalActions ?? []) {
        expect(SENSITIVE_ACTIONS.has(action), `${a.key}/${action}`).toBe(true);
      }
    }
  });

  it('keeps every declared approval action a known sensitive action', () => {
    const declared = new Set(AGENT_CATALOGUE.flatMap((a) => a.approvalActions ?? []));
    for (const action of declared) expect(SENSITIVE_ACTIONS.has(action), action).toBe(true);
  });

  it('never gates a read-only agent that declares no approval action and no sensitive flag', () => {
    const readOnly = AGENT_CATALOGUE.filter(
      (a) => !a.requiresHumanApproval && (a.approvalActions ?? []).length === 0,
    );
    expect(readOnly.length).toBeGreaterThan(0);
    for (const a of readOnly) expect(a.requiresHumanApproval).toBe(false);
  });

  it('exposes the sensitive-action lookup', () => {
    expect(isSensitiveAction('finance.payout')).toBe(true);
    expect(isSensitiveAction('identify_leads')).toBe(false);
  });
});

describe('R1 — executable definitions match the live runtime catalogue', () => {
  it('keeps key, name and capabilities identical for the 11 live agents', () => {
    for (const runtime of EXECUTABLE_CATALOGUE) {
      const spec = findAgentSpec(runtime.key);
      expect(spec, runtime.key).toBeDefined();
      expect(spec!.name).toBe(runtime.name);
      expect(spec!.capabilities).toEqual(runtime.capabilities);
    }
  });

  it('keeps the approval flag identical for the 11 live agents', () => {
    for (const runtime of EXECUTABLE_CATALOGUE) {
      const spec = findAgentSpec(runtime.key)!;
      expect(spec.requiresHumanApproval, runtime.key).toBe(runtime.requiresHumanApproval);
    }
  });
});

describe('R1 — declared tools are declarative only', () => {
  it('never repeats a tool id within one agent', () => {
    for (const a of AGENT_CATALOGUE) {
      const tools = a.allowedTools ?? [];
      expect(new Set(tools).size, a.key).toBe(tools.length);
    }
  });

  it('declares tools as plain non-empty strings', () => {
    for (const a of AGENT_CATALOGUE) {
      for (const tool of a.allowedTools ?? []) {
        expect(typeof tool).toBe('string');
        expect(tool.length).toBeGreaterThan(0);
      }
    }
  });
});

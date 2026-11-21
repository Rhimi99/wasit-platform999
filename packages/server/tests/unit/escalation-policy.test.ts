import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ESCALATION_LIMITS,
  ESCALATION_CODES,
  SEVERITY_RANK,
  evaluateEscalations,
  fingerprintOf,
  settledOf,
  type EscalationFacts,
  type EscalationLimits,
  type WindowCounts,
} from '../../src/modules/ai/escalation-policy.js';

/**
 * AI-SUP-02 — the detection rules, as pure logic.
 *
 * Every case here is a literal fact bundle, so a rule's behaviour can be read
 * and changed without a database. The integration suite then proves the same
 * rules fire on real rows.
 */

const L: EscalationLimits = { ...DEFAULT_ESCALATION_LIMITS };

function counts(partial: Partial<WindowCounts> = {}): WindowCounts {
  return { attempts: 0, succeeded: 0, failed: 0, rejected: 0, blocked: 0, ...partial };
}

function facts(partial: Partial<EscalationFacts> = {}): EscalationFacts {
  return {
    agents: [],
    tasks: [],
    tools: [],
    supervisor: {
      enabled: true,
      failedCycles: 0,
      liveRuns: 0,
      oldestLiveRunMinutes: 0,
      interventionsLastHour: 0,
    },
    ...partial,
  };
}

function codes(f: EscalationFacts, limits: EscalationLimits = L) {
  return evaluateEscalations(f, limits).map((x) => x.code);
}

describe('AI-SUP-02 — escalation policy: counting and identity', () => {
  it('counts only settled attempts, not refusals, in the denominator', () => {
    expect(settledOf(counts({ succeeded: 2, failed: 1, rejected: 1, blocked: 9 }))).toBe(4);
  });

  it('gives one condition one fingerprint, and different conditions different ones', () => {
    const a = fingerprintOf('task_stalled', { taskId: 'task-1' });
    expect(fingerprintOf('task_stalled', { taskId: 'task-1' })).toBe(a);
    expect(fingerprintOf('task_stalled', { taskId: 'task-2' })).not.toBe(a);
    expect(fingerprintOf('task_attempts_exhausted', { taskId: 'task-1' })).not.toBe(a);
    // JSON-encoded identity: a separator inside a key cannot merge two cases.
    expect(fingerprintOf('agent_failure_rate', { agentKey: 'a|b' })).not.toBe(
      fingerprintOf('agent_failure_rate', { agentKey: 'a' }),
    );
  });

  it('declares a severity rank that puts CRITICAL above everything', () => {
    expect(SEVERITY_RANK.CRITICAL).toBeGreaterThan(SEVERITY_RANK.HIGH);
    expect(SEVERITY_RANK.HIGH).toBeGreaterThan(SEVERITY_RANK.WARNING);
    expect(SEVERITY_RANK.WARNING).toBeGreaterThan(SEVERITY_RANK.INFO);
  });

  it('reports nothing when nothing is wrong', () => {
    expect(codes(facts({ agents: [{ agentKey: 'x', current: counts({ succeeded: 10 }), previous: counts({ succeeded: 10 }) }] }))).toEqual([]);
  });
});

describe('AI-SUP-02 — escalation policy: failure and degradation', () => {
  it('escalates a repeated agent failure at HIGH, and near-total failure at CRITICAL', () => {
    const half = evaluateEscalations(
      facts({ agents: [{ agentKey: 'sales-agent', current: counts({ failed: 2, succeeded: 2 }), previous: counts() }] }),
      L,
    );
    expect(half.map((f) => f.severity)).toEqual(['HIGH']);

    const total = evaluateEscalations(
      facts({ agents: [{ agentKey: 'sales-agent', current: counts({ failed: 5 }), previous: counts() }] }),
      L,
    );
    expect(total[0].severity).toBe('CRITICAL');
    expect(total[0].evidence.failureRate).toBe(1);
  });

  it('does not escalate a failure rate computed from too few samples', () => {
    expect(
      codes(facts({ agents: [{ agentKey: 'x', current: counts({ failed: 2 }), previous: counts() }] })),
    ).toEqual([]);
  });

  it('escalates a material success-rate drop between windows', () => {
    const f = facts({
      agents: [
        {
          agentKey: 'support-agent',
          current: counts({ succeeded: 2, failed: 3 }),
          previous: counts({ succeeded: 5 }),
        },
      ],
    });
    const found = evaluateEscalations(f, L);
    const degradation = found.find((x) => x.code === 'metrics_degradation');
    expect(degradation).toBeTruthy();
    expect(degradation!.evidence.previousSuccessRate).toBe(1);
    expect(degradation!.evidence.currentSuccessRate).toBe(0.4);
  });

  it('ignores a drop that is within normal variation', () => {
    const f = facts({
      agents: [
        {
          agentKey: 'support-agent',
          current: counts({ succeeded: 4, failed: 1 }),
          previous: counts({ succeeded: 5 }),
        },
      ],
    });
    expect(codes(f)).not.toContain('metrics_degradation');
  });
});

describe('AI-SUP-02 — escalation policy: refusals and tools', () => {
  it('escalates a burst of refused runs as a boundary being pushed', () => {
    const found = evaluateEscalations(
      facts({ agents: [{ agentKey: 'ads-agent', current: counts({ blocked: 4 }), previous: counts() }] }),
      L,
    );
    expect(found[0].code).toBe('agent_scope_violations');
    expect(found[0].severity).toBe('HIGH');
    expect(found[0].agentKey).toBe('ads-agent');
  });

  it('escalates refused tool calls with their codes as evidence', () => {
    const found = evaluateEscalations(
      facts({
        tools: [{ agentKey: 'b2b-agent', failed: 0, refused: 3, timeouts: 0, refusalCodes: ['TOOL_SCOPE_DENIED'] }],
      }),
      L,
    );
    const scope = found.find((f) => f.code === 'agent_scope_violations');
    expect(scope?.evidence.refusalCodes).toEqual(['TOOL_SCOPE_DENIED']);
  });

  it('escalates tool failures, and calls them HIGH when they are timeouts', () => {
    const slow = evaluateEscalations(
      facts({ tools: [{ agentKey: 'x', failed: 3, refused: 0, timeouts: 3, refusalCodes: [] }] }),
      L,
    );
    expect(slow[0].severity).toBe('HIGH');

    const flaky = evaluateEscalations(
      facts({ tools: [{ agentKey: 'x', failed: 3, refused: 0, timeouts: 0, refusalCodes: [] }] }),
      L,
    );
    expect(flaky[0].severity).toBe('WARNING');
  });
});

describe('AI-SUP-02 — escalation policy: tasks and the supervisor itself', () => {
  const task = (over: Partial<EscalationFacts['tasks'][number]>) => ({
    id: 'task-1',
    agentKey: 'analytics-agent',
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    requiresApproval: false,
    ageMinutes: 10,
    ...over,
  });

  it('escalates a stalled task per task, and a much older one at HIGH', () => {
    const young = evaluateEscalations(facts({ tasks: [task({ ageMinutes: L.stallMinutes })] }), L);
    expect(young[0].code).toBe('task_stalled');
    expect(young[0].severity).toBe('WARNING');
    expect(young[0].taskId).toBe('task-1');

    const old = evaluateEscalations(facts({ tasks: [task({ ageMinutes: L.stallMinutes * 4 })] }), L);
    expect(old[0].severity).toBe('HIGH');
  });

  it('escalates an exhausted task rather than reporting it as merely stalled', () => {
    const found = evaluateEscalations(
      facts({ tasks: [task({ attempts: 3, maxAttempts: 3, status: 'queued', ageMinutes: L.stallMinutes * 5 })] }),
      L,
    );
    // One task, one case: the precise diagnosis wins over the generic one.
    expect(found.map((f) => f.code)).toEqual(['task_attempts_exhausted']);
    expect(found[0].severity).toBe('HIGH');
    expect(found[0].evidence.attempts).toBe(3);
  });

  it('does not call a task on its last attempt exhausted while it is still running', () => {
    const found = evaluateEscalations(facts({ tasks: [task({ attempts: 3, maxAttempts: 3, status: 'running' })] }), L);
    expect(found.map((f) => f.code)).not.toContain('task_attempts_exhausted');
  });

  it('escalates a pending approval as INFO — attention, not alarm', () => {
    const found = evaluateEscalations(
      facts({
        tasks: [task({ status: 'awaiting_approval', requiresApproval: true, ageMinutes: L.pendingApprovalMinutes })],
      }),
      L,
    );
    // Waiting on a human is not "stuck": only the approval condition applies.
    expect(found.map((f) => f.code)).toEqual(['approvals_pending']);
    expect(found[0].severity).toBe('INFO');
  });

  it('raises a long-pending approval to WARNING but never to HIGH', () => {
    const found = evaluateEscalations(
      facts({
        tasks: [task({ status: 'awaiting_approval', requiresApproval: true, ageMinutes: L.pendingApprovalMinutes * 5 })],
      }),
      L,
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('WARNING');
  });

  it('escalates supervisor cycle failures, escalating to CRITICAL when repeated', () => {
    const one = evaluateEscalations(facts({ supervisor: { ...facts().supervisor, failedCycles: 1 } }), L);
    expect(one[0].code).toBe('cycle_failed');
    expect(one[0].severity).toBe('HIGH');

    const many = evaluateEscalations(facts({ supervisor: { ...facts().supervisor, failedCycles: 3 } }), L);
    expect(many[0].severity).toBe('CRITICAL');
  });

  it('escalates an enabled-but-idle supervisor while runs stay open', () => {
    const found = evaluateEscalations(
      facts({
        supervisor: {
          enabled: true,
          failedCycles: 0,
          liveRuns: 2,
          oldestLiveRunMinutes: L.stallMinutes * 3,
          interventionsLastHour: 0,
        },
      }),
      L,
    );
    expect(found[0].code).toBe('cycle_inactive');
    expect(found[0].severity).toBe('CRITICAL');
  });

  it('does not call a disabled supervisor idle — that is a configuration choice', () => {
    const found = evaluateEscalations(
      facts({
        supervisor: {
          enabled: false,
          failedCycles: 0,
          liveRuns: 2,
          oldestLiveRunMinutes: L.stallMinutes * 3,
          interventionsLastHour: 0,
        },
      }),
      L,
    );
    expect(found.map((f) => f.code)).not.toContain('cycle_inactive');
  });

  it('orders findings most severe first so a capped scan keeps what matters', () => {
    const found = evaluateEscalations(
      facts({
        agents: [{ agentKey: 'x', current: counts({ failed: 2, succeeded: 1 }), previous: counts() }],
        tasks: [task({ ageMinutes: L.stallMinutes, status: 'running' })],
        supervisor: { ...facts().supervisor, failedCycles: 1 },
      }),
      L,
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
    const ranks = found.map((f) => SEVERITY_RANK[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it('keeps every title within the storage column limit', () => {
    const found = evaluateEscalations(
      facts({
        agents: [{ agentKey: 'a'.repeat(64), current: counts({ failed: 50, succeeded: 0 }), previous: counts() }],
        tasks: [task({ agentKey: 'b'.repeat(64), ageMinutes: 10_000, status: 'running' })],
      }),
      L,
    );
    for (const f of found) expect(f.title.length).toBeLessThanOrEqual(300);
  });

  it('emits only codes it declares', () => {
    const found = evaluateEscalations(
      facts({
        agents: [
          { agentKey: 'x', current: counts({ failed: 9 }), previous: counts({ succeeded: 9 }) },
        ],
        tasks: [task({ attempts: 9, maxAttempts: 3, ageMinutes: 9_999, status: 'running' })],
        tools: [{ agentKey: 'x', failed: 9, refused: 9, timeouts: 9, refusalCodes: ['A'] }],
        supervisor: { enabled: true, failedCycles: 9, liveRuns: 9, oldestLiveRunMinutes: 9_999, interventionsLastHour: 0 },
      }),
      L,
    );
    for (const f of found) expect(ESCALATION_CODES).toContain(f.code);
  });
});

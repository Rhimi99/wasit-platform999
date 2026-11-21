import { createHash } from 'node:crypto';

/**
 * AI-SUP-02 — pure escalation policy.
 *
 * The Supervisor already *acts* (contain / retry) through `supervisor.ts`. This
 * module answers the other half of oversight: which conditions deserve a human
 * decision, how severe they are, and what the General Manager should do about
 * them. It is deliberately pure — no database, no clock, no I/O — so every rule
 * is testable with literal facts and cannot depend on the thing it judges.
 *
 * Two invariants hold here:
 *  - a finding always names a real subject (agent, task, run) when one exists,
 *    so the GM can go look at the thing that broke;
 *  - a finding carries only counts, ids and codes as evidence — never a prompt,
 *    task input, memory note or personal data.
 */

export const ESCALATION_SEVERITIES = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'] as const;
export type EscalationSeverity = (typeof ESCALATION_SEVERITIES)[number];

export const ESCALATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/** Rank used to decide whether a repeat finding is an escalation or noise. */
export const SEVERITY_RANK: Record<EscalationSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Detection codes. Each one maps to exactly one `rule` value in storage. */
export const ESCALATION_CODES = [
  'cycle_failed',
  'cycle_inactive',
  'agent_failure_rate',
  'metrics_degradation',
  'agent_scope_violations',
  'task_stalled',
  'task_attempts_exhausted',
  'tool_failures',
  'approvals_pending',
] as const;
export type EscalationCode = (typeof ESCALATION_CODES)[number];

export interface EscalationLimits {
  /** Detection window. The comparison window is the one immediately before it. */
  windowMinutes: number;
  /** Failure share of settled attempts that warrants a human look. */
  failureRateThreshold: number;
  /** Below this many settled attempts a rate is noise, not a signal. */
  minSamples: number;
  /** Success-rate drop between the two windows that counts as degradation. */
  degradationDelta: number;
  /** An open task older than this is reported as stalled. */
  stallMinutes: number;
  /** An approval waiting longer than this needs the GM's attention. */
  pendingApprovalMinutes: number;
  /** Tool failures per agent in the window that warrant a look. */
  toolFailureCount: number;
  /** Refusals per agent in the window that suggest a boundary being pushed. */
  refusalCount: number;
  /** Supervisor cycle failures in the window that warrant a look. */
  cycleFailureCount: number;
  /**
   * After a case is resolved, the same condition does not open a new one for
   * this long. Without it, a GM who resolved "this agent is failing" while it
   * is still failing would be re-notified on every sweep.
   */
  reopenCooldownMinutes: number;
}

export const DEFAULT_ESCALATION_LIMITS: EscalationLimits = {
  windowMinutes: 60,
  failureRateThreshold: 0.5,
  minSamples: 3,
  degradationDelta: 0.25,
  stallMinutes: 120,
  pendingApprovalMinutes: 240,
  toolFailureCount: 3,
  refusalCount: 3,
  cycleFailureCount: 1,
  reopenCooldownMinutes: 60,
};

export interface WindowCounts {
  attempts: number;
  succeeded: number;
  failed: number;
  rejected: number;
  blocked: number;
}

export interface AgentWindowFacts {
  agentKey: string;
  current: WindowCounts;
  previous: WindowCounts;
}

export interface OpenTaskFacts {
  id: string;
  agentKey: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  requiresApproval: boolean;
  ageMinutes: number;
}

export interface ToolFacts {
  agentKey: string;
  failed: number;
  refused: number;
  timeouts: number;
  /** Refusal codes seen in the window, for evidence (codes only, no messages). */
  refusalCodes: string[];
}

export interface SupervisorFacts {
  /** Whether the supervisor cycle is switched on for this deployment. */
  enabled: boolean;
  /** `AI.AGENT_RUN_SUPERVISOR_FAILED` entries in the window. */
  failedCycles: number;
  /** Live (non-terminal) runs right now. */
  liveRuns: number;
  /** Age of the oldest live run, in minutes (0 when there is none). */
  oldestLiveRunMinutes: number;
  /** Supervisor interventions (contain/retry) in the last hour. */
  interventionsLastHour: number;
}

export interface EscalationFacts {
  agents: AgentWindowFacts[];
  tasks: OpenTaskFacts[];
  tools: ToolFacts[];
  supervisor: SupervisorFacts;
}

export interface Finding {
  code: EscalationCode;
  severity: EscalationSeverity;
  /** Stable identity of the condition — one open case per fingerprint. */
  fingerprint: string;
  agentKey: string | null;
  taskId: string | null;
  runId: string | null;
  /** One line, ≤ 300 characters (the storage column's limit). */
  title: string;
  /** What the GM should do, in plain language. */
  recommendation: string;
  /** Stable key the UI can translate instead of the text above. */
  recommendationKey: string;
  /** Counts, ids and codes only. */
  evidence: Record<string, unknown>;
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Settled attempts = those with a definitive outcome (not refusals). */
export function settledOf(c: WindowCounts): number {
  return c.succeeded + c.failed + c.rejected;
}

/**
 * Fingerprint of a condition. JSON-encoded rather than concatenated so a
 * separator inside a key cannot make two different conditions share a case
 * (and therefore silently merge two escalations).
 */
export function fingerprintOf(code: EscalationCode, subject: { agentKey?: string | null; taskId?: string | null; runId?: string | null }): string {
  const key = JSON.stringify([code, subject.agentKey ?? null, subject.taskId ?? null, subject.runId ?? null]);
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 40);
}

function finding(input: Omit<Finding, 'fingerprint'>): Finding {
  return {
    ...input,
    title: input.title.slice(0, 300),
    fingerprint: fingerprintOf(input.code, { agentKey: input.agentKey, taskId: input.taskId, runId: input.runId }),
  };
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${Math.round(v * 100)}%`;
}

/**
 * Turns facts into findings. Order is most-severe-first so a caller that caps
 * the number of cases per scan keeps the ones that matter most.
 */
export function evaluateEscalations(facts: EscalationFacts, limits: EscalationLimits): Finding[] {
  const out: Finding[] = [];
  const sup = facts.supervisor;

  // --- 1. The supervisor itself is failing or is not running -----------------
  if (sup.failedCycles >= limits.cycleFailureCount) {
    const critical = sup.failedCycles >= Math.max(3, limits.cycleFailureCount * 3);
    out.push(
      finding({
        code: 'cycle_failed',
        severity: critical ? 'CRITICAL' : 'HIGH',
        agentKey: null,
        taskId: null,
        runId: null,
        title: `Supervisor cycle failed ${sup.failedCycles} time(s) in the last ${limits.windowMinutes} minutes`,
        recommendation:
          'Check the server log for "agent run supervisor cycle failed". Containment and retries are not running, so stuck and looping tasks will accumulate.',
        recommendationKey: 'escalation.cycle_failed.recommendation',
        evidence: { failedCycles: sup.failedCycles, windowMinutes: limits.windowMinutes, liveRuns: sup.liveRuns },
      }),
    );
  }

  if (
    sup.enabled &&
    sup.liveRuns > 0 &&
    sup.interventionsLastHour === 0 &&
    sup.oldestLiveRunMinutes > limits.stallMinutes * 2
  ) {
    out.push(
      finding({
        code: 'cycle_inactive',
        severity: 'CRITICAL',
        agentKey: null,
        taskId: null,
        runId: null,
        title: `Supervisor is enabled but has not acted for an hour while ${sup.liveRuns} run(s) stay open`,
        recommendation:
          'Verify the scheduler is running (AGENT_RUNS_SUPERVISOR_ENABLED and the interval). An idle supervisor with old live runs means nothing is watching the agents.',
        recommendationKey: 'escalation.cycle_inactive.recommendation',
        evidence: {
          liveRuns: sup.liveRuns,
          oldestLiveRunMinutes: sup.oldestLiveRunMinutes,
          interventionsLastHour: sup.interventionsLastHour,
        },
      }),
    );
  }

  // --- 2. Repeated agent failure ---------------------------------------------
  for (const agent of facts.agents) {
    const settled = settledOf(agent.current);
    if (settled < limits.minSamples) continue;
    const failureRate = agent.current.failed / settled;
    if (failureRate < limits.failureRateThreshold) continue;
    out.push(
      finding({
        code: 'agent_failure_rate',
        severity: failureRate >= 0.8 ? 'CRITICAL' : 'HIGH',
        agentKey: agent.agentKey,
        taskId: null,
        runId: null,
        title: `${agent.agentKey} failed ${agent.current.failed} of ${settled} settled runs (${pct(failureRate)})`,
        recommendation:
          'Inspect the most recent failed task errors for this agent. If the cause is the provider or a missing input, disable the agent until it is fixed rather than letting it keep failing.',
        recommendationKey: 'escalation.agent_failure_rate.recommendation',
        evidence: {
          windowMinutes: limits.windowMinutes,
          settled,
          failed: agent.current.failed,
          rejected: agent.current.rejected,
          failureRate: Number(failureRate.toFixed(4)),
          threshold: limits.failureRateThreshold,
        },
      }),
    );
  }

  // --- 3. Performance degradation against the previous window ----------------
  for (const agent of facts.agents) {
    const cur = settledOf(agent.current);
    const prev = settledOf(agent.previous);
    if (cur < limits.minSamples || prev < limits.minSamples) continue;
    const curRate = agent.current.succeeded / cur;
    const prevRate = agent.previous.succeeded / prev;
    const drop = prevRate - curRate;
    if (drop < limits.degradationDelta) continue;
    out.push(
      finding({
        code: 'metrics_degradation',
        severity: drop >= limits.degradationDelta * 2 ? 'HIGH' : 'WARNING',
        agentKey: agent.agentKey,
        taskId: null,
        runId: null,
        title: `${agent.agentKey} success rate fell from ${pct(prevRate)} to ${pct(curRate)}`,
        recommendation:
          'Compare the two windows in the metrics report. A drop that keeps falling after the next window means a regression, not noise.',
        recommendationKey: 'escalation.metrics_degradation.recommendation',
        evidence: {
          windowMinutes: limits.windowMinutes,
          previousSuccessRate: Number(prevRate.toFixed(4)),
          currentSuccessRate: Number(curRate.toFixed(4)),
          drop: Number(drop.toFixed(4)),
          previousSettled: prev,
          currentSettled: cur,
        },
      }),
    );
  }

  // --- 4. Refusals: permissions and scope being pushed -----------------------
  for (const agent of facts.agents) {
    if (agent.current.blocked < limits.refusalCount) continue;
    out.push(
      finding({
        code: 'agent_scope_violations',
        severity: agent.current.blocked >= limits.refusalCount * 3 ? 'CRITICAL' : 'HIGH',
        agentKey: agent.agentKey,
        taskId: null,
        runId: null,
        title: `${agent.current.blocked} refused run(s) for ${agent.agentKey} in ${limits.windowMinutes} minutes`,
        recommendation:
          'Refusals are fail-closed by design. Confirm whether a caller is retrying something they are not allowed to run; if it is legitimate, the permission must be granted deliberately — never by widening the agent.',
        recommendationKey: 'escalation.agent_scope_violations.recommendation',
        evidence: { windowMinutes: limits.windowMinutes, refusedRuns: agent.current.blocked, threshold: limits.refusalCount },
      }),
    );
  }

  for (const tool of facts.tools) {
    if (tool.refused < limits.refusalCount) continue;
    out.push(
      finding({
        code: 'agent_scope_violations',
        severity: 'HIGH',
        agentKey: tool.agentKey,
        taskId: null,
        runId: null,
        title: `${tool.refused} refused tool call(s) for ${tool.agentKey} in ${limits.windowMinutes} minutes`,
        recommendation:
          'The tool gateway refused these calls, so nothing ran. Read the refusal codes to see whether it is a scope, permission or binding gap.',
        recommendationKey: 'escalation.agent_scope_violations.tool_recommendation',
        evidence: {
          windowMinutes: limits.windowMinutes,
          refusedToolCalls: tool.refused,
          refusalCodes: tool.refusalCodes.slice(0, 10),
          threshold: limits.refusalCount,
        },
      }),
    );
  }

  // --- 5. Tool failures -----------------------------------------------------
  for (const tool of facts.tools) {
    if (tool.failed < limits.toolFailureCount) continue;
    out.push(
      finding({
        code: 'tool_failures',
        severity: tool.timeouts >= limits.toolFailureCount ? 'HIGH' : 'WARNING',
        agentKey: tool.agentKey,
        taskId: null,
        runId: null,
        title: `${tool.failed} tool failure(s) for ${tool.agentKey} in ${limits.windowMinutes} minutes`,
        recommendation:
          'Check whether the failures are timeouts (the tool is too slow for its budget) or execution errors (the tool is broken). Both make the agent output unreliable.',
        recommendationKey: 'escalation.tool_failures.recommendation',
        evidence: {
          windowMinutes: limits.windowMinutes,
          failed: tool.failed,
          timeouts: tool.timeouts,
          threshold: limits.toolFailureCount,
        },
      }),
    );
  }

  // --- 6. Per-task conditions ----------------------------------------------
  // One task yields at most one case: the most precise diagnosis wins. A task
  // waiting on a human is not "stuck" (that is the expected state, and the
  // approval rule covers it), and a task with no attempts left is "exhausted"
  // rather than merely "stalled" — reporting both would be the same alarm twice.
  for (const task of facts.tasks) {
    if (task.status === 'awaiting_approval') {
      if (task.ageMinutes < limits.pendingApprovalMinutes) continue;
      out.push(
        finding({
          code: 'approvals_pending',
          severity: task.ageMinutes >= limits.pendingApprovalMinutes * 2 ? 'WARNING' : 'INFO',
          agentKey: task.agentKey,
          taskId: task.id,
          runId: null,
          title: `Approval for ${task.agentKey} has been waiting ${task.ageMinutes} minutes`,
          recommendation:
            'Approve or reject the task. A gate nobody answers silently stops the workflow it was meant to protect.',
          recommendationKey: 'escalation.approvals_pending.recommendation',
          evidence: { ageMinutes: task.ageMinutes, thresholdMinutes: limits.pendingApprovalMinutes },
        }),
      );
      continue;
    }

    // Only an OPEN task can be out of attempts: a queued task at the ceiling
    // will never be picked up again, while a terminal failure is already counted
    // as a failure rate rather than as a stuck task.
    const exhausted = task.attempts >= task.maxAttempts && task.status === 'queued';
    if (exhausted) {
      out.push(
        finding({
          code: 'task_attempts_exhausted',
          severity: 'HIGH',
          agentKey: task.agentKey,
          taskId: task.id,
          runId: null,
          title: `${task.agentKey} task used ${task.attempts}/${task.maxAttempts} attempts and is still ${task.status}`,
          recommendation:
            'Retrying will not help past the ceiling. Read the last error, fix the cause, then resubmit as a new task.',
          recommendationKey: 'escalation.task_attempts_exhausted.recommendation',
          evidence: { attempts: task.attempts, maxAttempts: task.maxAttempts, status: task.status, ageMinutes: task.ageMinutes },
        }),
      );
      continue;
    }

    if (task.ageMinutes >= limits.stallMinutes) {
      out.push(
        finding({
          code: 'task_stalled',
          severity: task.ageMinutes >= limits.stallMinutes * 4 ? 'HIGH' : 'WARNING',
          agentKey: task.agentKey,
          taskId: task.id,
          runId: null,
          title: `${task.agentKey} task has been ${task.status} for ${task.ageMinutes} minutes`,
          recommendation:
            'Open the task. If it is genuinely working, nothing to do; if it is stuck, contain it so the slot and the budget are released.',
          recommendationKey: 'escalation.task_stalled.recommendation',
          evidence: { status: task.status, ageMinutes: task.ageMinutes, thresholdMinutes: limits.stallMinutes },
        }),
      );
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

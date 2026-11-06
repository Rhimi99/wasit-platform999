import { ApiError } from '@wasit/shared';

/**
 * AI-02.1 — central state machine for agent runs and their steps.
 *
 * This module is the single source of truth for the lifecycle vocabulary. It is
 * pure (no database, no orchestration): later phases (planning, dispatching,
 * retry, aggregation) must route every status change through `assertRunTransition`
 * / `assertStepTransition` so an illegal move can never be persisted.
 *
 * Terminal states are protected: a run or step that has finished cannot silently
 * be revived. Reopening requires an explicit, deliberate policy flag — never a
 * default.
 */

export const RUN_STATES = [
  'DRAFT',
  'PLANNING',
  'AWAITING_APPROVAL',
  'DISPATCHING',
  'RUNNING',
  'PAUSED',
  'AGGREGATING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentRunStatus = (typeof RUN_STATES)[number];

export const RUN_STEP_STATES = [
  'PENDING',
  'BLOCKED',
  'READY',
  'AWAITING_APPROVAL',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYING',
  'SKIPPED',
  'CANCELLED',
] as const;
export type AgentRunStepStatus = (typeof RUN_STEP_STATES)[number];

/** Run states from which no further transition is allowed. */
export const TERMINAL_RUN_STATES: readonly AgentRunStatus[] = [
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
];

/** Step states from which no further transition is allowed (FAILED is not
 * terminal: it may still RETRYING or be CANCELLED). */
export const TERMINAL_STEP_STATES: readonly AgentRunStepStatus[] = [
  'SUCCEEDED',
  'SKIPPED',
  'CANCELLED',
];

/**
 * Legal run transitions. Every state appears, even when its list is empty, so a
 * missing entry is a compile-time error rather than a silent "allow all".
 */
export const RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  DRAFT: ['PLANNING', 'CANCELLED'],
  PLANNING: ['AWAITING_APPROVAL', 'DISPATCHING', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['PLANNING', 'DISPATCHING', 'FAILED', 'CANCELLED'],
  DISPATCHING: ['RUNNING', 'PAUSED', 'FAILED', 'CANCELLED'],
  RUNNING: ['AGGREGATING', 'PAUSED', 'FAILED', 'CANCELLED'],
  PAUSED: ['DISPATCHING', 'RUNNING', 'AGGREGATING', 'FAILED', 'CANCELLED'],
  AGGREGATING: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'],
  // Terminal states: no outgoing transitions.
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Legal step transitions. */
export const STEP_TRANSITIONS: Record<AgentRunStepStatus, readonly AgentRunStepStatus[]> = {
  PENDING: ['BLOCKED', 'READY', 'AWAITING_APPROVAL', 'SKIPPED', 'CANCELLED'],
  BLOCKED: ['PENDING', 'READY', 'SKIPPED', 'CANCELLED'],
  READY: ['RUNNING', 'AWAITING_APPROVAL', 'SKIPPED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'READY', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'RETRYING', 'CANCELLED'],
  FAILED: ['RETRYING', 'CANCELLED'],
  RETRYING: ['RUNNING', 'FAILED', 'CANCELLED'],
  // Terminal states: no outgoing transitions.
  SUCCEEDED: [],
  SKIPPED: [],
  CANCELLED: [],
};

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATES.includes(status);
}

export function isTerminalStepStatus(status: AgentRunStepStatus): boolean {
  return TERMINAL_STEP_STATES.includes(status);
}

/** True when `to` is a legal next state for `from` (ignoring reopen policy). */
export function canTransitionRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionStep(from: AgentRunStepStatus, to: AgentRunStepStatus): boolean {
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionOptions {
  /**
   * Reopening a terminal run/step is refused by default. A caller must opt in
   * explicitly (a deliberate administrative action), never by accident.
   */
  allowReopen?: boolean;
}

/**
 * Validates a run transition. Throws `409 CONFLICT` on an illegal move so the
 * failure is a clear, auditable rejection rather than a corrupt status write.
 */
export function assertRunTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
  options: TransitionOptions = {},
): void {
  if (from === to) {
    throw ApiError.conflict(`Run is already in status ${from}`);
  }
  if (isTerminalRunStatus(from) && !options.allowReopen) {
    throw ApiError.conflict(`Run is in a terminal status (${from}) and cannot be reopened`);
  }
  if (!canTransitionRun(from, to)) {
    throw ApiError.conflict(`Illegal run transition: ${from} -> ${to}`);
  }
}

/** Validates a step transition. Same fail-closed rules as the run. */
export function assertStepTransition(
  from: AgentRunStepStatus,
  to: AgentRunStepStatus,
  options: TransitionOptions = {},
): void {
  if (from === to) {
    throw ApiError.conflict(`Step is already in status ${from}`);
  }
  if (isTerminalStepStatus(from) && !options.allowReopen) {
    throw ApiError.conflict(`Step is in a terminal status (${from}) and cannot be reopened`);
  }
  if (!canTransitionStep(from, to)) {
    throw ApiError.conflict(`Illegal step transition: ${from} -> ${to}`);
  }
}

/**
 * Guard for marking a step SUCCEEDED: a step may only be recorded as successful
 * when it actually carries a result. This blocks "success" writes with no
 * evidence.
 */
export function assertStepSuccess(step: { status: AgentRunStepStatus; result: unknown }): void {
  if (step.status !== 'SUCCEEDED') {
    throw ApiError.conflict('Step is not in SUCCEEDED status');
  }
  if (step.result === null || step.result === undefined) {
    throw ApiError.conflict('A step cannot be SUCCEEDED without a result');
  }
}

/** Minimal step shape needed to judge whether a run may complete. */
export interface StepOutcome {
  stepKey: string;
  status: AgentRunStepStatus;
}

/**
 * Guards a run's move into a completion state.
 *
 * A run may not be declared COMPLETED unless every step has reached a terminal
 * state AND at least one step actually SUCCEEDED. If some steps ended without
 * success (SKIPPED/CANCELLED) the only honest outcome is PARTIALLY_COMPLETED.
 * Any non-terminal step makes completion illegal outright.
 */
export function assertRunCompletion(
  runStatus: AgentRunStatus,
  steps: StepOutcome[],
): void {
  if (runStatus !== 'COMPLETED' && runStatus !== 'PARTIALLY_COMPLETED') {
    throw ApiError.conflict('assertRunCompletion only applies to a completion state');
  }
  if (steps.length === 0) {
    throw ApiError.conflict('A run cannot complete without any steps');
  }
  const unfinished = steps.filter((s) => !isTerminalStepStatus(s.status));
  if (unfinished.length > 0) {
    throw ApiError.conflict(
      `A run cannot complete while steps are unfinished: ${unfinished.map((s) => s.stepKey).join(', ')}`,
    );
  }
  const succeeded = steps.filter((s) => s.status === 'SUCCEEDED').length;
  if (succeeded === 0) {
    throw ApiError.conflict('A run cannot be COMPLETED when no step succeeded');
  }
  if (runStatus === 'COMPLETED' && succeeded !== steps.length) {
    throw ApiError.conflict(
      'A run is only COMPLETED when every step succeeded; otherwise it is PARTIALLY_COMPLETED',
    );
  }
}

/** The honest completion status for a set of finished steps. */
export function resolveCompletionStatus(steps: StepOutcome[]): 'COMPLETED' | 'PARTIALLY_COMPLETED' {
  const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'SUCCEEDED');
  return allSucceeded ? 'COMPLETED' : 'PARTIALLY_COMPLETED';
}

export interface StepDependency {
  stepKey: string;
  dependsOn: string[];
}

/**
 * Validates the dependency graph of a run's steps:
 * - every referenced dependency must exist in the same run;
 * - a step may not depend on itself;
 * - the graph must be acyclic.
 *
 * Cycles are impossible to express as a row CHECK, so this run-level check is
 * the enforcement point. It is pure, so planning can call it before persisting.
 */
export function assertValidDependencies(steps: StepDependency[]): void {
  const keys = new Set(steps.map((s) => s.stepKey));
  if (keys.size !== steps.length) {
    throw ApiError.validation([{ field: 'stepKey', message: 'Duplicate stepKey in run', code: 'DUPLICATE' }]);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.stepKey) {
        throw ApiError.validation([
          { field: 'dependsOn', message: `Step ${step.stepKey} cannot depend on itself`, code: 'SELF_DEPENDENCY' },
        ]);
      }
      if (!keys.has(dep)) {
        throw ApiError.validation([
          { field: 'dependsOn', message: `Step ${step.stepKey} depends on unknown step ${dep}`, code: 'UNKNOWN_DEPENDENCY' },
        ]);
      }
    }
  }

  // Kahn's algorithm: any node left unvisited belongs to a cycle.
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.stepKey, step.dependsOn.length);
    adjacency.set(step.stepKey, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      adjacency.get(dep)!.push(step.stepKey);
    }
  }
  const queue: string[] = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    for (const next of adjacency.get(node)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited !== steps.length) {
    throw ApiError.validation([
      { field: 'dependsOn', message: 'Dependency cycle detected among steps', code: 'CYCLE' },
    ]);
  }
}

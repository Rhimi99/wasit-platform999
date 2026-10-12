/**
 * Pure supervisor policy — no database, no clock, no I/O, so it is trivially
 * testable and cannot be affected by an unreachable Copilot or provider.
 * `supervisor.ts` feeds it live task rows; both the guardrail and its tests use
 * exactly this logic.
 */
export interface SupervisorLimits {
  maxAttempts: number;
  stuckRuntimeSeconds: number;
  staleQueueSeconds: number;
  maxRunCostUsd: number;
  windowSeconds: number;
  failureRateThreshold: number;
  minSamples: number;
}

export const DEFAULT_SUPERVISOR_LIMITS: SupervisorLimits = {
  maxAttempts: 3,
  stuckRuntimeSeconds: 300,
  staleQueueSeconds: 3600,
  maxRunCostUsd: 5,
  windowSeconds: 3600,
  failureRateThreshold: 0.5,
  minSamples: 3,
};

export interface TaskFacts {
  status: string;
  attempts: number;
  maxAttempts: number;
  cost: number;
  startedAtMs: number | null;
  createdAtMs: number;
}

export interface SupervisorAssessment {
  contain: boolean;
  status: 'failed' | 'blocked' | 'queued';
  reason: string;
  action: string;
  severity: 'WARNING' | 'CRITICAL';
}

const HEALTHY: SupervisorAssessment = {
  contain: false,
  status: 'queued',
  reason: '',
  action: 'none',
  severity: 'WARNING',
};

/** Deterministic decision for one task. Order matters (most severe first). */
export function recommendIntervention(
  task: TaskFacts,
  limits: SupervisorLimits,
  nowMs: number,
): SupervisorAssessment {
  const running = task.status === 'running';
  const queued = task.status === 'queued';

  // 1) A running task that outlived the stuck ceiling.
  if (running && task.startedAtMs != null && nowMs - task.startedAtMs > limits.stuckRuntimeSeconds * 1000) {
    return {
      contain: true,
      status: 'failed',
      reason: `stuck: running longer than ${limits.stuckRuntimeSeconds}s`,
      action: 'fail-stuck-task',
      severity: 'CRITICAL',
    };
  }

  // 2) A queued task that has been waiting far too long.
  if (queued && nowMs - task.createdAtMs > limits.staleQueueSeconds * 1000) {
    return {
      contain: true,
      status: 'failed',
      reason: `stale: queued longer than ${limits.staleQueueSeconds}s`,
      action: 'fail-stale-task',
      severity: 'WARNING',
    };
  }

  // 3) Retry ceiling breached.
  const effectiveMax = Math.min(task.maxAttempts || limits.maxAttempts, limits.maxAttempts);
  if (task.attempts >= effectiveMax) {
    return {
      contain: true,
      status: 'failed',
      reason: `loop: attempts ${task.attempts} reached ceiling ${effectiveMax}`,
      action: 'halt-loop',
      severity: 'CRITICAL',
    };
  }

  // 4) Budget ceiling breached for this run.
  if (task.cost > limits.maxRunCostUsd) {
    return {
      contain: true,
      status: 'blocked',
      reason: `budget: cost ${task.cost} exceeds limit ${limits.maxRunCostUsd}`,
      action: 'block-budget',
      severity: 'CRITICAL',
    };
  }

  return HEALTHY;
}

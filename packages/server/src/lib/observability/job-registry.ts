/**
 * In-process registry of background-job runs.
 *
 * The scheduler runs jobs on intervals and swallows their errors so a failing
 * job can never take the process down. That resilience also made the failures
 * invisible: nothing recorded that `alerts` had not completed for an hour.
 * This registry keeps the last run of each job so the operational snapshot can
 * show liveness and consecutive failures.
 *
 * Scope: process-local. A restart empties it, which is honest rather than
 * wrong — the snapshot pairs it with DB-derived timestamps (last alert
 * evaluation, last escalation scan, last supervisor cycle) so a restart shows
 * up as "no in-process runs yet" instead of a fabricated healthy state.
 */

export type JobOutcome = 'ok' | 'failed' | 'skipped';

export interface JobRunStatus {
  name: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastOutcome: JobOutcome | 'never';
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  /** Last error message (never a payload); cleared by the next success. */
  lastError: string | null;
}

const jobs = new Map<string, JobRunStatus>();
let schedulerStartedAt: string | null = null;

export function recordJobRun(
  name: string,
  run: { outcome: JobOutcome; durationMs: number; error?: string | null; at?: Date },
): void {
  const previous = jobs.get(name);
  const failed = run.outcome === 'failed';
  jobs.set(name, {
    name,
    lastRunAt: (run.at ?? new Date()).toISOString(),
    lastDurationMs: run.durationMs,
    lastOutcome: run.outcome,
    consecutiveFailures: failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
    totalRuns: (previous?.totalRuns ?? 0) + 1,
    totalFailures: (previous?.totalFailures ?? 0) + (failed ? 1 : 0),
    lastError: failed ? (run.error ?? 'unknown error') : null,
  });
}

/** Wraps a job so its outcome and duration are recorded even when it throws. */
export function trackJob(
  name: string,
  job: () => Promise<JobOutcome>,
  now: () => number = Date.now,
): () => Promise<JobOutcome> {
  return async () => {
    const started = now();
    let outcome: JobOutcome = 'failed';
    let error: string | null = null;
    try {
      outcome = await job();
    } catch (err) {
      error = (err as Error).message;
      outcome = 'failed';
    }
    recordJobRun(name, { outcome, durationMs: now() - started, error });
    return outcome;
  };
}

export function markSchedulerStarted(at: Date = new Date()): void {
  schedulerStartedAt = at.toISOString();
}

export function markSchedulerStopped(): void {
  schedulerStartedAt = null;
}

export function schedulerInfo(): { running: boolean; startedAt: string | null; jobs: JobRunStatus[] } {
  return {
    running: schedulerStartedAt !== null,
    startedAt: schedulerStartedAt,
    jobs: [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Test seam: forget every recorded run. */
export function resetJobRegistry(): void {
  jobs.clear();
  schedulerStartedAt = null;
}

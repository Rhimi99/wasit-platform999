import { db } from '../db/client';
import { rolloverDueSubscriptions } from '../modules/subscriptions/service';
import { expireLapsedSubscriptions } from '../modules/subscriptions/collection';
import { advanceDueDeletionRetentions } from '../modules/privacy/service';
import { runDueAgentSchedules, reclaimExpiredLeases } from '../modules/ai/scheduling';
import { recoverStuckSteps } from '../modules/ai/dispatcher';
import { runSupervisorCycle, createSupervisorCycleGuard } from '../modules/ai/supervisor';
import { escalateOverdueDisputes } from '../modules/disputes/service';
import { resolveRateLimitStore } from './rate-limit/resolve';
import { evaluateAlerts } from './observability/alerts';
import { logger } from './observability/logger';
import { newId } from './ids';

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Minimal in-process scheduler for period-based jobs.
 *
 * Jobs today: subscription auto-renew rollover/expiry, privacy data-retention
 * window sweep, rate-limit bucket purge, alert rule evaluation, and (AI-01)
 * due agent-schedule execution. It is deliberately not a general cron
 * framework: a further job should be added as a named entry here, or the work
 * should move to the deployment platform's scheduler hitting the authenticated
 * admin route. Rollover and the retention sweep are idempotent, so a duplicate
 * run from another instance is a no-op. Agent scheduling is safe across
 * instances because a due schedule is claimed with a DB-level lease, not an
 * in-process flag.
 */

/**
 * Serialises a scheduled job inside one process: at most one cycle runs at a
 * time, and the guard is released in `finally` so a thrown cycle never wedges
 * it. Cross-instance safety is the job's own DB lease, not this guard.
 * Exported so the in-flight semantics can be unit-tested deterministically.
 */
export function createInFlightGuard(): <T>(job: () => Promise<T>) => Promise<T | undefined> {
  let inFlight = false;
  return async <T>(job: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await job();
    } finally {
      inFlight = false;
    }
  };
}

export function startScheduler(options: {
  rolloverIntervalMinutes: number;
  rateLimitPurgeIntervalMinutes?: number;
  alertsEnabled?: boolean;
  alertIntervalMinutes?: number;
  agentSchedulerEnabled?: boolean;
  agentSchedulerIntervalMinutes?: number;
  agentScheduleLeaseSeconds?: number;
  agentRunsRecoveryEnabled?: boolean;
  agentRunsRecoveryIntervalMinutes?: number;
  agentRunStepStuckSeconds?: number;
  agentRunsSupervisorEnabled?: boolean;
  agentRunsSupervisorIntervalMinutes?: number;
  disputeEscalationEnabled?: boolean;
  disputeEscalationIntervalMinutes?: number;
}): SchedulerHandle {
  const intervalMs = options.rolloverIntervalMinutes * 60 * 1000;
  const purgeIntervalMs = (options.rateLimitPurgeIntervalMinutes ?? 15) * 60 * 1000;
  const alertIntervalMs = (options.alertIntervalMinutes ?? 5) * 60 * 1000;
  const agentIntervalMs = (options.agentSchedulerIntervalMinutes ?? 5) * 60 * 1000;
  const agentLeaseSeconds = options.agentScheduleLeaseSeconds ?? 300;
  const recoveryIntervalMs = (options.agentRunsRecoveryIntervalMinutes ?? 5) * 60 * 1000;
  const recoveryStuckSeconds = options.agentRunStepStuckSeconds ?? 300;
  const supervisorIntervalMs = (options.agentRunsSupervisorIntervalMinutes ?? 5) * 60 * 1000;
  const disputeEscalationIntervalMs = (options.disputeEscalationIntervalMinutes ?? 30) * 60 * 1000;
  // Stable per-process worker id; the DB lease (not this string) is what keeps
  // two instances from running the same schedule.
  const workerId = `sched-${newId()}`;
  let lastPurgeAt = Date.now();
  let agentRunInFlight = false;
  // In-process guard for the recovery sweep; see runAgentRunRecovery below.
  const recoveryGuard = createInFlightGuard();
  // In-process guard for the supervisor cycle; see runSupervisor below.
  const supervisorGuard = createSupervisorCycleGuard();

  const runRollover = async (): Promise<void> => {
    try {
      const result = await rolloverDueSubscriptions(db);
      if (result.renewed > 0) {
        logger.info('subscription rollover', {
          renewed: result.renewed,
          skipped: result.skipped,
        });
      }
    } catch (err) {
      // A failed background job must never take the process down; it will be
      // retried on the next tick.
      logger.error('subscription rollover failed', { error: (err as Error).message });
    }
  };

  const runExpiry = async (): Promise<void> => {
    try {
      const result = await expireLapsedSubscriptions(db);
      if (result.expired > 0) {
        logger.info('subscription expiry', { expired: result.expired });
      }
    } catch (err) {
      logger.error('subscription expiry failed', { error: (err as Error).message });
    }
  };

  const runRetentionSweep = async (): Promise<void> => {
    try {
      const result = await advanceDueDeletionRetentions(db);
      if (result.retained > 0 || result.eligible > 0) {
        logger.info('privacy retention sweep', {
          retained: result.retained,
          eligible: result.eligible,
        });
      }
    } catch (err) {
      logger.error('privacy retention sweep failed', { error: (err as Error).message });
    }
  };

  const runRateLimitPurge = async (): Promise<void> => {
    try {
      const removed = await resolveRateLimitStore(db).purgeExpired();
      if (removed > 0) {
        logger.info('rate-limit purge', { removed });
      }
    } catch (err) {
      logger.error('rate-limit purge failed', { error: (err as Error).message });
    }
  };

  const runAlerts = async (): Promise<void> => {
    try {
      await evaluateAlerts(db);
    } catch (err) {
      logger.error('alert evaluation failed', { error: (err as Error).message });
    }
  };

  const runAgentSchedules = async (): Promise<void> => {
    // In-process guard: never overlap two sweeps in this instance. Cross-instance
    // safety comes from the DB lease inside runDueAgentSchedules, not from this.
    if (agentRunInFlight) return;
    agentRunInFlight = true;
    try {
      // Reclaim leases left by a crashed worker before claiming new work, so a
      // schedule stuck behind a dead lease becomes eligible again.
      await reclaimExpiredLeases(db);
      const result = await runDueAgentSchedules(db, workerId, { leaseSeconds: agentLeaseSeconds });
      if (result.claimed > 0) {
        logger.info('agent schedule sweep', { ...result });
      }
    } catch (err) {
      // A DB outage or unexpected error must not take the scheduler down; the
      // next tick retries. Individual run failures are already handled inside.
      logger.error('agent schedule sweep failed', { error: (err as Error).message });
    } finally {
      agentRunInFlight = false;
    }
  };

  const runDisputeEscalation = async (): Promise<void> => {
    try {
      const result = await escalateOverdueDisputes(db);
      if (result.escalated > 0) {
        logger.info('dispute escalation sweep', { scanned: result.scanned, escalated: result.escalated });
      }
    } catch (err) {
      // A failed background job must never take the process down; the next tick retries.
      logger.error('dispute escalation sweep failed', { error: (err as Error).message });
    }
  };

  const runAgentRunRecovery = async (): Promise<void> => {
    // In-process guard: never overlap two recovery sweeps in this instance. The
    // DB lease inside recoverStuckSteps is what keeps separate instances apart;
    // this guard only prevents self-overlap when a sweep outruns its interval.
    // The guard releases in `finally`, so a thrown sweep never wedges it.
    await recoveryGuard(async () => {
      const correlationId = newId();
      const startedAt = Date.now();
      try {
        // Reconcile steps stuck RUNNING beyond the configured timeout against their
        // linked task, then re-derive the affected runs' status. Idempotent and
        // lease-guarded, so overlapping sweeps (or instances) cannot double-process.
        const result = await recoverStuckSteps(
          db,
          { stuckSeconds: recoveryStuckSeconds, leaseSeconds: Math.max(recoveryStuckSeconds, 60) },
          { actorId: null, actorType: 'SYSTEM' },
        );
        // Log every cycle, including a clean no-op sweep, so operators can see the
        // job is alive. No sensitive data: only counts and a correlation id.
        logger.info('agent run recovery sweep', {
          correlationId,
          status: result.status,
          scanned: result.scanned,
          recovered: result.recovered,
          skippedLease: result.skippedLease,
          lostRace: result.lostRace,
          reconciledRuns: result.reconciledRuns,
          errors: result.errors,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        // A DB outage or unexpected error must not take the scheduler down; the
        // next tick retries. Individual step failures are isolated inside.
        logger.error('agent run recovery sweep failed', {
          correlationId,
          durationMs: Date.now() - startedAt,
          error: (err as Error).message,
        });
      }
    });
  };

  const runSupervisor = async (): Promise<void> => {
    // In-process guard: never overlap two supervisor cycles in this instance.
    // Cross-instance safety is the conditional DB writes inside the cycle.
    await supervisorGuard(async () => {
      const startedAt = Date.now();
      try {
        const result = await runSupervisorCycle(db, { actorId: null, actorType: 'SYSTEM' });
        // Log every cycle (including a clean no-op) so operators can see it alive.
        logger.info('agent run supervisor cycle', {
          status: result.status,
          scanned: result.scanned,
          contained: result.contained,
          retried: result.retried,
          errors: result.errors,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        // A supervisor failure must never take the scheduler down or stop the
        // agents' own work; the next tick retries. Per-run failures are isolated.
        logger.error('agent run supervisor cycle failed', {
          durationMs: Date.now() - startedAt,
          error: (err as Error).message,
        });
      }
    });
  };

  const tick = async (): Promise<void> => {
    await runRollover();
    await runExpiry();
    await runRetentionSweep();
    if (Date.now() - lastPurgeAt >= purgeIntervalMs) {
      lastPurgeAt = Date.now();
      await runRateLimitPurge();
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Don't keep the event loop alive solely for the scheduler, and don't overlap
  // with an in-flight run when the process is shutting down.
  timer.unref();

  // Alert evaluation runs on its own cadence: faster than the hourly rollover so
  // a database outage is noticed while it is still happening.
  const alertTimer = options.alertsEnabled ? setInterval(runAlerts, alertIntervalMs) : null;
  alertTimer?.unref();

  // Agent schedule sweep on its own cadence. Off unless explicitly enabled.
  const agentTimer = options.agentSchedulerEnabled ? setInterval(runAgentSchedules, agentIntervalMs) : null;
  agentTimer?.unref();

  // Agent-run stuck-step recovery sweep on its own cadence. Off unless enabled.
  const recoveryTimer = options.agentRunsRecoveryEnabled ? setInterval(runAgentRunRecovery, recoveryIntervalMs) : null;
  recoveryTimer?.unref();

  // Agent-run supervisor cycle on its own cadence. Off unless enabled.
  const supervisorTimer = options.agentRunsSupervisorEnabled ? setInterval(runSupervisor, supervisorIntervalMs) : null;
  supervisorTimer?.unref();

  // Dispute auto-escalation sweep on its own cadence. Off unless enabled.
  const disputeTimer = options.disputeEscalationEnabled ? setInterval(runDisputeEscalation, disputeEscalationIntervalMs) : null;
  disputeTimer?.unref();

  return {
    stop: () => {
      clearInterval(timer);
      if (alertTimer) clearInterval(alertTimer);
      if (agentTimer) clearInterval(agentTimer);
      if (recoveryTimer) clearInterval(recoveryTimer);
      if (supervisorTimer) clearInterval(supervisorTimer);
      if (disputeTimer) clearInterval(disputeTimer);
    },
  };
}
import { db } from '../db/client';
import { rolloverDueSubscriptions } from '../modules/subscriptions/service';
import { expireLapsedSubscriptions } from '../modules/subscriptions/collection';
import { advanceDueDeletionRetentions } from '../modules/privacy/service';
import { resolveRateLimitStore } from './rate-limit/resolve';
import { evaluateAlerts } from './observability/alerts';
import { logger } from './observability/logger';

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Minimal in-process scheduler for period-based jobs.
 *
 * Jobs today: subscription auto-renew rollover/expiry, privacy data-retention
 * window sweep, rate-limit bucket purge, and alert rule evaluation. It is
 * deliberately not a general cron framework: a further job should be added as a
 * named entry here, or the work should move to the deployment platform's
 * scheduler hitting the authenticated admin route. Rollover and the retention
 * sweep are idempotent, so a duplicate run from another instance is a no-op.
 */
export function startScheduler(options: {
  rolloverIntervalMinutes: number;
  rateLimitPurgeIntervalMinutes?: number;
  alertsEnabled?: boolean;
  alertIntervalMinutes?: number;
}): SchedulerHandle {
  const intervalMs = options.rolloverIntervalMinutes * 60 * 1000;
  const purgeIntervalMs = (options.rateLimitPurgeIntervalMinutes ?? 15) * 60 * 1000;
  const alertIntervalMs = (options.alertIntervalMinutes ?? 5) * 60 * 1000;
  let lastPurgeAt = Date.now();

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

  return {
    stop: () => {
      clearInterval(timer);
      if (alertTimer) clearInterval(alertTimer);
    },
  };
}
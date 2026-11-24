import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './lib/env.js';
import { startScheduler } from './lib/scheduler.js';
import { logger } from './lib/observability/logger.js';
import { metrics } from './lib/observability/metrics.js';

const app = createApp();
const port = env.PORT;

metrics.setGauge('wasit_build_info', 1, { version: '0.1.0', env: env.NODE_ENV });
metrics.setGauge('wasit_uptime_seconds', 0);
setInterval(() => metrics.setGauge('wasit_uptime_seconds', process.uptime()), 15000).unref();

serve({ fetch: app.fetch, port }, (info) => {
  logger.info('wasit api listening', {
    port: info.port,
    env: env.NODE_ENV,
    metricsEnabled: env.METRICS_ENABLED,
    alertsEnabled: env.OBS_ALERTS_ENABLED,
  });
});

if (env.SCHEDULER_ENABLED) {
  const handle = startScheduler({
    rolloverIntervalMinutes: env.SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES,
    rateLimitPurgeIntervalMinutes: env.RATE_LIMIT_PURGE_INTERVAL_MINUTES,
    alertsEnabled: env.OBS_ALERTS_ENABLED,
    alertIntervalMinutes: env.OBS_ALERT_INTERVAL_MINUTES,
    agentSchedulerEnabled: env.AI_AGENT_SCHEDULER_ENABLED,
    agentSchedulerIntervalMinutes: env.AI_AGENT_SCHEDULER_INTERVAL_MINUTES,
    agentScheduleLeaseSeconds: env.AI_AGENT_SCHEDULE_LEASE_SECONDS,
    agentRunsRecoveryEnabled: env.AI_AGENT_RUNS_RECOVERY_ENABLED,
    agentRunsRecoveryIntervalMinutes: env.AI_AGENT_RUNS_RECOVERY_INTERVAL_MINUTES,
    agentRunStepStuckSeconds: env.AI_AGENT_RUN_STEP_STUCK_SECONDS,
    agentRunsSupervisorEnabled: env.AI_AGENT_RUNS_SUPERVISOR_ENABLED,
    agentRunsSupervisorIntervalMinutes: env.AI_AGENT_RUNS_SUPERVISOR_INTERVAL_MINUTES,
    escalationsEnabled: env.AI_ESCALATIONS_ENABLED,
    escalationsIntervalMinutes: env.AI_ESCALATION_INTERVAL_MINUTES,
    disputeEscalationEnabled: env.DISPUTE_ESCALATION_ENABLED,
    disputeEscalationIntervalMinutes: env.DISPUTE_ESCALATION_INTERVAL_MINUTES,
    rfqExpiryEnabled: env.RFQ_EXPIRY_SWEEP_ENABLED,
    rfqExpiryIntervalMinutes: env.RFQ_EXPIRY_SWEEP_INTERVAL_MINUTES,
    rfqExpiryBatchSize: env.RFQ_EXPIRY_SWEEP_BATCH_SIZE,
  });
  const shutdown = (): void => {
    handle.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { app };
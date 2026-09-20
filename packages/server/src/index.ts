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
  });
  const shutdown = (): void => {
    handle.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { app };
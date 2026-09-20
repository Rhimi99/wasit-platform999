import { env } from '../env';
import type { AlertNotifier } from './alert-port';
import { LogAlertNotifier, WebhookAlertNotifier } from './notify';

/**
 * Resolves the active alert notifier from `OBS_ALERT_NOTIFY`:
 *   - `webhook` → POST to `OBS_ALERT_WEBHOOK_URL` (Slack/PagerDuty bridge/etc.)
 *   - `log`     → structured log line only (default, always works)
 *
 * A webhook without a URL degrades to `log` so a half-configured deployment
 * still records alerts instead of silently dropping them.
 */
let cached: AlertNotifier | null = null;

export function resolveAlertNotifier(): AlertNotifier {
  if (cached) return cached;
  if (env.OBS_ALERT_NOTIFY === 'webhook' && env.OBS_ALERT_WEBHOOK_URL) {
    cached = new WebhookAlertNotifier({
      url: env.OBS_ALERT_WEBHOOK_URL,
      token: env.OBS_ALERT_WEBHOOK_TOKEN || undefined,
    });
    return cached;
  }
  cached = new LogAlertNotifier();
  return cached;
}

/** Test seam: drop the memoized notifier. */
export function setAlertNotifier(next: AlertNotifier | null): void {
  cached = next;
}

export interface AlertChannelStatus {
  notifier: string;
  available: boolean;
}

export function alertStatus(): AlertChannelStatus {
  const notifier = resolveAlertNotifier();
  return { notifier: notifier.id, available: notifier.isAvailable() };
}
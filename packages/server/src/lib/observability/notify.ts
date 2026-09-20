import type { AlertNotification, AlertNotifier } from './alert-port';
import { logger } from './logger';

/**
 * No-network fallback: writes the alert as a structured log line. Always
 * available, so a deployment that has not configured a webhook still has the
 * alert in its log pipeline rather than losing it.
 */
export class LogAlertNotifier implements AlertNotifier {
  readonly id = 'log';

  isAvailable(): boolean {
    return true;
  }

  send(notification: AlertNotification): Promise<void> {
    logger.warn(`alert ${notification.status} [${notification.severity}] ${notification.rule}`, {
      alert: notification.rule,
      severity: notification.severity,
      status: notification.status,
      summary: notification.summary,
      details: notification.details,
    });
    return Promise.resolve();
  }
}

export interface WebhookAlertOptions {
  url: string;
  /** Optional bearer token for the receiving endpoint. */
  token?: string;
  timeoutMs?: number;
}

/**
 * Posts the alert as JSON to a configured webhook. This is intentionally a
 * plain POST: every common pager/chat product accepts an incoming webhook, and
 * a dedicated adapter can be added later behind the same port.
 */
export class WebhookAlertNotifier implements AlertNotifier {
  readonly id = 'webhook';

  constructor(private readonly options: WebhookAlertOptions) {}

  isAvailable(): boolean {
    return Boolean(this.options.url);
  }

  async send(notification: AlertNotification): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify({
          text: `[WASIT ${notification.severity}] ${notification.status} — ${notification.rule}: ${notification.summary}`,
          ...notification,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`webhook responded ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
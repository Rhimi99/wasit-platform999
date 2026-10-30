import { env } from '../env';
import { logger } from '../observability/logger';

export interface NotificationWebhookPayload {
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  recipientUserId: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  occurredAt: string;
}

/**
 * Outbound webhook sink for lifecycle notifications — an integration point for a
 * deployment's own systems (CRM, ERP, an operator's Slack bridge). Mirrors the
 * observability alert webhook: a plain POST of JSON to a configured URL, behind
 * a small interface so a dedicated adapter can replace it without touching the
 * engine.
 *
 * It is a real external integration: `isAvailable()` is false unless a URL is
 * configured, and the engine only calls it when the external-approval gate
 * allows real delivery. The URL/token come only from the environment.
 */
export interface NotificationWebhook {
  readonly id: string;
  isAvailable(): boolean;
  send(payload: NotificationWebhookPayload): Promise<void>;
}

export class HttpNotificationWebhook implements NotificationWebhook {
  readonly id = 'http';

  isAvailable(): boolean {
    return Boolean(env.NOTIFICATION_WEBHOOK_URL);
  }

  async send(payload: NotificationWebhookPayload): Promise<void> {
    if (!this.isAvailable()) throw new Error('NOTIFICATION_WEBHOOK_URL is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.NOTIFICATION_WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(env.NOTIFICATION_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.NOTIFICATION_WEBHOOK_TOKEN
            ? { Authorization: `Bearer ${env.NOTIFICATION_WEBHOOK_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`notification webhook responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No-network fallback used in dev/CI when no URL is configured. It logs a
 * redacted line so an operator sees the event was requested without leaking the
 * body into logs. Deliberately `available` so the engine records a SENT outcome
 * in a sandbox environment instead of a FAILED one.
 */
export class LogNotificationWebhook implements NotificationWebhook {
  readonly id = 'log';

  isAvailable(): boolean {
    return true;
  }

  async send(payload: NotificationWebhookPayload): Promise<void> {
    logger.info('notification webhook (log transport)', {
      eventType: payload.eventType,
      entityType: payload.entityType,
      entityId: payload.entityId,
      recipient: payload.recipientUserId,
    });
  }
}

let cached: NotificationWebhook | null = null;

export function resolveNotificationWebhook(): NotificationWebhook {
  if (cached) return cached;
  cached = env.NOTIFICATION_WEBHOOK_URL ? new HttpNotificationWebhook() : new LogNotificationWebhook();
  return cached;
}

/** Test seam: drop the memoized webhook (used when env changes between tests). */
export function resetNotificationWebhook(): void {
  cached = null;
}

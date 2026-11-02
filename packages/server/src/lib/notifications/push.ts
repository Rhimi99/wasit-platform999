import { env } from '../env';
import { logger } from '../observability/logger';

export interface PushMessage {
  /** Per-user topic the device subscribes to (FCM-style). */
  topic: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Device-push port. A concrete transport talks to a push gateway (FCM, an
 * APNs bridge, a self-hosted relay); nothing gateway-specific leaks past here,
 * matching the mail/SMS ports. Delivery is addressed by a per-user topic so the
 * engine needs no device-token registry.
 *
 * Like the mail/SMS ports, a transport must not throw on send when it cannot
 * deliver — it reports failure so the engine can record it — and it is only
 * used for real delivery when the external-approval gate allows it.
 */
export interface PushTransport {
  readonly id: string;
  isAvailable(): boolean;
  send(message: PushMessage): Promise<void>;
}

export class HttpPushTransport implements PushTransport {
  readonly id = 'http';

  isAvailable(): boolean {
    return Boolean(env.NOTIFICATION_PUSH_URL);
  }

  async send(message: PushMessage): Promise<void> {
    if (!this.isAvailable()) throw new Error('NOTIFICATION_PUSH_URL is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.NOTIFICATION_PUSH_TIMEOUT_MS);
    try {
      const res = await fetch(env.NOTIFICATION_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.NOTIFICATION_PUSH_TOKEN ? { Authorization: `Bearer ${env.NOTIFICATION_PUSH_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          topic: message.topic,
          notification: { title: message.title, body: message.body },
          data: message.data ?? {},
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`push gateway responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No-network fallback for dev/CI. Deliberately `available` so the engine records
 * a SENT outcome in a sandbox instead of a FAILED one; it logs a redacted line.
 */
export class LogPushTransport implements PushTransport {
  readonly id = 'log';

  isAvailable(): boolean {
    return true;
  }

  async send(message: PushMessage): Promise<void> {
    logger.info('push notification (log transport)', { topic: message.topic, title: message.title });
  }
}

let cached: PushTransport | null = null;

export function resolvePushTransport(): PushTransport {
  if (cached) return cached;
  cached = env.NOTIFICATION_PUSH_URL ? new HttpPushTransport() : new LogPushTransport();
  return cached;
}

/** Test seam: drop the memoized transport (used when env changes between tests). */
export function resetPushTransport(): void {
  cached = null;
}

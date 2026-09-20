import { env } from '../env';
import type { SmsTransport } from './port';
import { HttpSmsTransport } from './http';
import { LogSmsTransport } from './log';

/**
 * Resolves the active SMS transport from `SMS_TRANSPORT`:
 *   - `http` → real delivery via the configured HTTP gateway
 *   - `log`  → no-network fallback (local dev / CI)
 *
 * Unknown values fall back to `log` so a typo never blocks registration. The
 * active transport and availability are exposed through `smsStatus()` for the
 * health surface; credentials are never included.
 */
let cached: SmsTransport | null = null;

export function resolveSmsTransport(): SmsTransport {
  if (cached) return cached;
  switch (env.SMS_TRANSPORT) {
    case 'http':
      cached = new HttpSmsTransport({
        url: env.SMS_HTTP_URL,
        auth: {
          scheme: env.SMS_HTTP_AUTH_SCHEME,
          token: env.SMS_HTTP_TOKEN || undefined,
          username: env.SMS_HTTP_USERNAME || undefined,
          password: env.SMS_HTTP_PASSWORD || undefined,
        },
        sender: env.SMS_SENDER,
        toField: env.SMS_HTTP_TO_FIELD,
        textField: env.SMS_HTTP_TEXT_FIELD,
        senderField: env.SMS_HTTP_SENDER_FIELD,
      });
      return cached;
    default:
      cached = new LogSmsTransport();
      return cached;
  }
}

/** Test seam: drop the memoized transport (used when env changes between tests). */
export function resetSmsTransport(): void {
  cached = null;
}

export interface SmsStatus {
  transport: string;
  available: boolean;
  senderConfigured: boolean;
}

export function smsStatus(): SmsStatus {
  const transport = resolveSmsTransport();
  return {
    transport: transport.id,
    available: transport.isAvailable(),
    senderConfigured: Boolean(env.SMS_SENDER),
  };
}
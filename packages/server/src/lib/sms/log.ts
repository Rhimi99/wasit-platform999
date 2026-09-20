import type { SmsMessage, SmsTransport } from './port';

/**
 * Fallback transport used when no SMS gateway is configured (local dev, CI,
 * first boot). It never reaches the network; it logs a redacted line so the
 * operator can see that a message was requested, without leaking the code or
 * the full destination number into logs.
 *
 * It is deliberately `available` so verification flows still complete — the
 * developer completes verification through the explicit dev-only endpoint
 * (`/api/auth/dev/phone-code`), which is disabled in production.
 */
export class LogSmsTransport implements SmsTransport {
  readonly id = 'log';

  isAvailable(): boolean {
    return true;
  }

  async send(message: SmsMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[sms:log] to=${maskPhone(message.to)} (no SMS gateway configured)`);
  }
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 4) return '***';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
import type { MailMessage, MailTransport } from './port';

/**
 * Fallback transport used when no SMTP credentials are configured (local dev,
 * CI, first boot). It never reaches the network; it logs a redacted line so the
 * operator can see that mail was requested and which addresses were involved,
 * without leaking message bodies or links into logs.
 *
 * It is deliberately `available` so registration/reset flows still complete —
 * the developer completes verification through the explicit dev-only endpoints
 * (`/api/auth/dev/verification-link`), which are disabled in production.
 */
export class LogMailTransport implements MailTransport {
  readonly id = 'log';

  isAvailable(): boolean {
    return true;
  }

  async send(message: MailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[mail:log] to=${maskEmail(message.to)} subject="${message.subject}" (no SMTP configured)`);
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
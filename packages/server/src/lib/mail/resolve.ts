import { env } from '../env';
import type { MailTransport } from './port';
import { SmtpMailTransport } from './smtp';
import { LogMailTransport } from './log';

/**
 * Resolves the active mail transport from `MAIL_TRANSPORT`:
 *   - `smtp`  → real delivery via the configured SMTP server
 *   - `log`   → no-network fallback (local dev / CI)
 *
 * Unknown values fall back to `log` so a typo never blocks registration. The
 * active transport and availability are exposed through `mailStatus()` for the
 * admin health surface; credentials are never included.
 */
let cached: MailTransport | null = null;

export function resolveMailTransport(): MailTransport {
  if (cached) return cached;
  switch (env.MAIL_TRANSPORT) {
    case 'smtp':
      cached = new SmtpMailTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER || undefined,
        password: env.SMTP_PASSWORD || undefined,
        from: env.MAIL_FROM,
      });
      return cached;
    default:
      cached = new LogMailTransport();
      return cached;
  }
}

/** Test seam: drop the memoized transport (used when env changes between tests). */
export function resetMailTransport(): void {
  cached = null;
}

export interface MailStatus {
  transport: string;
  available: boolean;
  from: string;
}

export function mailStatus(): MailStatus {
  const transport = resolveMailTransport();
  return {
    transport: transport.id,
    available: transport.isAvailable(),
    from: env.MAIL_FROM,
  };
}
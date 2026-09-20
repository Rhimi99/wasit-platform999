import { env } from '../env';
import { newId } from '../ids';
import type { DB } from '../../db/client';
import { auditLogs } from '../../db/schema/audit';
import { resolveMailTransport } from './resolve';
import type { MailMessage } from './port';

/**
 * Sends a transactional email and records the attempt in the audit log.
 *
 * Delivery failures are logged and audited but never thrown: a transient SMTP
 * outage must not fail a registration or a password-reset request that has
 * already been persisted, otherwise the user is locked out with no recourse.
 * The audit row is the durable signal that a message needs to be re-sent.
 */
export async function sendMail(db: DB, message: MailMessage): Promise<void> {
  const transport = resolveMailTransport();
  try {
    await transport.send(message);
    await db.insert(auditLogs).values({
      id: newId(),
      actorId: null,
      action: 'MAIL.SENT',
      entityType: 'MAIL',
      entityId: null,
      before: null,
      after: { to: message.to, subject: message.subject },
      ipAddress: null,
      userAgent: null,
      metadata: { transport: transport.id, environment: env.NODE_ENV },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mail] delivery failed via ${transport.id}:`, (err as Error).message);
    await db.insert(auditLogs).values({
      id: newId(),
      actorId: null,
      action: 'MAIL.FAILED',
      entityType: 'MAIL',
      entityId: null,
      before: null,
      after: { to: message.to, subject: message.subject },
      ipAddress: null,
      userAgent: null,
      metadata: { transport: transport.id, error: (err as Error).message },
    });
  }
}
import { env } from '../env';
import { newId } from '../ids';
import type { DB } from '../../db/client';
import { auditLogs } from '../../db/schema/audit';
import { resolveSmsTransport } from './resolve';
import type { SmsMessage } from './port';
import { maskPhone } from './log';

export interface SmsSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Sends a transactional SMS and records the attempt in the audit log.
 *
 * Delivery failures are logged and audited but never thrown: a transient
 * gateway outage must not fail a verification request that has already been
 * persisted, otherwise the user is locked out with no recourse. The audit row
 * is the durable signal that a message needs to be re-sent.
 *
 * The message body (which contains the one-time code) is never written to the
 * audit trail — only the masked destination — so verification codes do not
 * accumulate in the audit log.
 *
 * The outcome is returned so a caller that owns its own delivery ledger (the
 * notifications engine) can record SENT/FAILED accurately.
 */
export async function sendSms(db: DB, message: SmsMessage): Promise<SmsSendResult> {
  const transport = resolveSmsTransport();
  try {
    await transport.send(message);
    await db.insert(auditLogs).values({
      id: newId(),
      actorId: null,
      action: 'SMS.SENT',
      entityType: 'SMS',
      entityId: null,
      before: null,
      after: { to: maskPhone(message.to) },
      ipAddress: null,
      userAgent: null,
      metadata: { transport: transport.id, environment: env.NODE_ENV },
    });
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[sms] delivery failed via ${transport.id}:`, (err as Error).message);
    await db.insert(auditLogs).values({
      id: newId(),
      actorId: null,
      action: 'SMS.FAILED',
      entityType: 'SMS',
      entityId: null,
      before: null,
      after: { to: maskPhone(message.to) },
      ipAddress: null,
      userAgent: null,
      metadata: { transport: transport.id, error: (err as Error).message },
    });
    return { ok: false, error: (err as Error).message };
  }
}
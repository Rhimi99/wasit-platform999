import type { DB } from '../db/client';
import { auditLogs } from '../db/schema/audit';
import { newId } from './ids';
import { metrics } from './observability/metrics';

export interface AuditContext {
  actorId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function writeAudit(
  db: DB,
  ctx: AuditContext,
  entry: {
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId(),
    actorId: ctx.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: entry.metadata ?? null,
  });
  metrics.incCounter('wasit_audit_writes_total', { action: entry.action });
}
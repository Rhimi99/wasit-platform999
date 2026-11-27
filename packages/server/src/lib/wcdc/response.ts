import { isIP } from 'node:net';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { securityActions, securityBlocks, securityIncidents } from '../../db/schema/security';
import { mediaAssets } from '../../db/schema/media';
import { users, userRoles, roles } from '../../db/schema/auth';
import { newId } from '../ids';
import { setAiExecutionEnabled } from '../ai/kill-switch';
import { createNotification } from '../notifications-service';
import { invalidateBlockedIps, tightenIp } from './enforcement';
import { revokeAllSessionsForUser } from '../../modules/auth/service';
import {
  isForbiddenAction,
  isResponseActionType,
  type ResponseActionType,
} from './types';
import type { WcdcPolicy } from './policy';

/**
 * Response & Containment.
 *
 * The allow-list below is the whole of WCDC's power. Three rules hold it:
 *
 * 1. An action exists only if it is named in `ResponseActionType`. There is no
 *    generic "execute" and no way to pass SQL, a role or a filter.
 * 2. Anything that changes an account, a file's availability, the AI fleet or
 *    money requires a second, different SUPER_ADMIN. The requester cannot
 *    approve their own action.
 * 3. Operations that would let the system change its own authority — grant a
 *    permission, edit RBAC, disable MFA, delete data or audit rows, migrate,
 *    stop a service, change payments, move money — are refused by name and the
 *    refusal is recorded, so an attempt is visible rather than silently ignored.
 */

export interface ActionSpec {
  requiresApproval: boolean;
  /** Only these may be applied without a human, and only when policy allows. */
  autoEligible: boolean;
  /** Where the target comes from, used to validate it before anything runs. */
  targetKind: 'ip' | 'user' | 'session' | 'asset' | 'incident' | 'none';
  label: string;
}

export const ACTION_SPECS: Record<ResponseActionType, ActionSpec> = {
  RATE_LIMIT_TIGHTEN: {
    requiresApproval: false,
    autoEligible: true,
    targetKind: 'ip',
    label: 'Tighten the request limit for one address',
  },
  BLOCK_IP: {
    requiresApproval: false,
    autoEligible: true,
    targetKind: 'ip',
    label: 'Block one address for a bounded time',
  },
  UNBLOCK_IP: {
    requiresApproval: false,
    autoEligible: false,
    targetKind: 'ip',
    label: 'Lift every active block on one address',
  },
  REVOKE_SESSION: {
    requiresApproval: true,
    autoEligible: false,
    targetKind: 'user',
    label: 'Revoke every session of one account',
  },
  QUARANTINE_ASSET: {
    requiresApproval: true,
    autoEligible: false,
    targetKind: 'asset',
    label: 'Quarantine one stored media asset',
  },
  ESCALATE: {
    requiresApproval: false,
    autoEligible: false,
    targetKind: 'incident',
    label: 'Escalate the incident to the GM',
  },
  NOTIFY_GM: {
    requiresApproval: false,
    autoEligible: false,
    targetKind: 'incident',
    label: 'Notify the GM without changing anything',
  },
  AI_KILL_SWITCH: {
    requiresApproval: true,
    autoEligible: false,
    targetKind: 'none',
    label: 'Pause all AI execution (existing kill switch)',
  },
};

export interface ActionRequest {
  action: string;
  incidentId?: string | null;
  target?: string | null;
  reason: string;
  actorId: string;
  mode?: 'AUTO' | 'MANUAL';
}

export interface ActionOutcome {
  id: string;
  actionType: string;
  status: 'EXECUTED' | 'REQUIRES_APPROVAL' | 'REFUSED' | 'FAILED';
  mode: 'AUTO' | 'MANUAL';
  target: string | null;
  detail: string;
  requiresApproval: boolean;
}

function validTarget(kind: ActionSpec['targetKind'], target: string | null): string | null {
  if (kind === 'none') return null;
  if (!target) throw ApiError.validation([{ field: 'target', message: 'A target is required for this action', code: 'VALIDATION_FAILED' }]);
  const value = target.trim();
  if (kind === 'ip') {
    if (isIP(value) === 0) {
      throw ApiError.validation([{ field: 'target', message: 'Target must be an IP address', code: 'VALIDATION_FAILED' }]);
    }
    return value;
  }
  if (value.length < 8 || value.length > 64) {
    throw ApiError.validation([{ field: 'target', message: 'Target identifier is not valid', code: 'VALIDATION_FAILED' }]);
  }
  return value;
}

async function recordAction(
  db: DB,
  input: {
    incidentId: string | null;
    actionType: string;
    status: ActionOutcome['status'];
    mode: 'AUTO' | 'MANUAL';
    target: string | null;
    reason: string;
    requestedById: string;
    approvedById?: string | null;
    approvedAt?: Date | null;
    result?: Record<string, unknown> | null;
  },
): Promise<string> {
  const id = newId();
  await db.insert(securityActions).values({
    id,
    incidentId: input.incidentId,
    actionType: input.actionType as ResponseActionType,
    status: input.status,
    mode: input.mode,
    target: input.target,
    reason: input.reason,
    requestedById: input.requestedById,
    approvedById: input.approvedById ?? null,
    approvedAt: input.approvedAt ?? null,
    result: input.result ?? null,
  });
  return id;
}

async function notifySuperAdmins(db: DB, title: string, body: string, data: Record<string, unknown>): Promise<number> {
  const rows = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.name, 'SUPER_ADMIN'), eq(users.isActive, true)));
  const targets = [...new Set(rows.map((r) => r.userId))];
  for (const userId of targets) {
    await createNotification(db, { userId, type: 'SECURITY_ALERT', title, body, data });
  }
  return targets.length;
}

/**
 * Applies one containment action, or parks it for approval.
 *
 * Throws `ApiError.forbidden` for a forbidden operation *after* writing the
 * refusal, so the attempt is both refused and recorded.
 */
export async function executeAction(
  db: DB,
  policy: WcdcPolicy,
  request: ActionRequest,
): Promise<ActionOutcome> {
  const mode = request.mode ?? 'MANUAL';
  const incident = request.incidentId
    ? (await db.select().from(securityIncidents).where(eq(securityIncidents.id, request.incidentId)).limit(1))[0] ?? null
    : null;
  if (request.incidentId && !incident) throw ApiError.notFound('Incident');

  if (isForbiddenAction(request.action)) {
    await recordAction(db, {
      incidentId: request.incidentId ?? null,
      actionType: 'FORBIDDEN_OPERATION',
      status: 'REFUSED',
      mode,
      target: request.target ?? null,
      reason: request.reason,
      requestedById: request.actorId,
      result: { requestedAction: request.action, refusedBecause: 'forbidden-operation' },
    });
    throw ApiError.forbidden(
      'This operation is outside WCDC authority and requires an explicit GM change, not a security action',
    );
  }

  if (!isResponseActionType(request.action)) {
    throw ApiError.validation([{ field: 'action', message: 'Unknown security action', code: 'VALIDATION_FAILED' }]);
  }

  const spec = ACTION_SPECS[request.action];
  const target = validTarget(spec.targetKind, request.target ?? null);

  if (spec.requiresApproval) {
    const id = await recordAction(db, {
      incidentId: request.incidentId ?? null,
      actionType: request.action,
      status: 'REQUIRES_APPROVAL',
      mode,
      target,
      reason: request.reason,
      requestedById: request.actorId,
    });
    await notifySuperAdmins(db, 'Security action awaiting approval', `${spec.label}: ${request.reason}`, {
      actionId: id,
      incidentId: request.incidentId ?? null,
      action: request.action,
    });
    return {
      id,
      actionType: request.action,
      status: 'REQUIRES_APPROVAL',
      mode,
      target,
      detail: 'A second GM approval is required before this runs',
      requiresApproval: true,
    };
  }

  const id = await recordAction(db, {
    incidentId: request.incidentId ?? null,
    actionType: request.action,
    status: 'EXECUTED',
    mode,
    target,
    reason: request.reason,
    requestedById: request.actorId,
  });
  let detail: string;
  try {
    detail = await applyAction(db, policy, request.action, target, request, id);
  } catch (error) {
    await db
      .update(securityActions)
      .set({
        status: 'FAILED',
        result: { error: error instanceof Error ? error.message : String(error) },
      })
      .where(eq(securityActions.id, id));
    throw error;
  }
  return {
    id,
    actionType: request.action,
    status: 'EXECUTED',
    mode,
    target,
    detail,
    requiresApproval: false,
  };
}

/** Runs the approved action. Shared by the immediate path and the approve path. */
export async function applyAction(
  db: DB,
  policy: WcdcPolicy,
  action: ResponseActionType,
  target: string | null,
  request: { incidentId?: string | null; reason: string; actorId: string },
  actionId: string,
): Promise<string> {
  switch (action) {
    case 'BLOCK_IP': {
      const expiresAt = new Date(Date.now() + policy.blockTtlMinutes * 60_000);
      await db.insert(securityBlocks).values({
        id: newId(),
        kind: 'IP',
        target: target as string,
        reason: request.reason,
        expiresAt,
        createdById: request.actorId,
        actionId,
      });
      invalidateBlockedIps();
      await appendContainment(db, request.incidentId ?? null, { blockIp: target, until: expiresAt.toISOString() });
      return `Address blocked until ${expiresAt.toISOString()}`;
    }
    case 'RATE_LIMIT_TIGHTEN': {
      const until = new Date(Date.now() + policy.tightenTtlMinutes * 60_000);
      tightenIp(target as string, policy.tightenTtlMinutes);
      await appendContainment(db, request.incidentId ?? null, {
        tightenedIp: target,
        until: until.toISOString(),
      });
      return `Limit tightened until ${until.toISOString()}`;
    }
    case 'UNBLOCK_IP': {
      const lifted = await db
        .update(securityBlocks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(securityBlocks.kind, 'IP'),
            eq(securityBlocks.target, target as string),
            isNull(securityBlocks.revokedAt),
          ),
        )
        .returning({ id: securityBlocks.id });
      if (lifted.length === 0) throw ApiError.notFound('Active block');
      invalidateBlockedIps();
      await appendContainment(db, request.incidentId ?? null, {
        unblockedIp: target,
        lifted: lifted.length,
      });
      return `${lifted.length} active block(s) lifted`;
    }
    case 'REVOKE_SESSION': {
      // A typo must not report "0 sessions revoked" as a success.
      const [account] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, target as string))
        .limit(1);
      if (!account) throw ApiError.notFound('User');
      const revoked = await revokeAllSessionsForUser(db, target as string);
      await appendContainment(db, request.incidentId ?? null, { revokedSessionsFor: target, count: revoked });
      return `${revoked} session(s) revoked`;
    }
    case 'QUARANTINE_ASSET': {
      const rows = await db
        .update(mediaAssets)
        .set({ status: 'QUARANTINED', updatedAt: new Date() })
        .where(and(eq(mediaAssets.id, target as string), ne(mediaAssets.status, 'DELETED')))
        .returning({ id: mediaAssets.id });
      if (rows.length === 0) throw ApiError.notFound('Media asset');
      await appendContainment(db, request.incidentId ?? null, { quarantinedAsset: target });
      return 'Asset quarantined; its download link now refuses';
    }
    case 'AI_KILL_SWITCH': {
      await setAiExecutionEnabled(db, false);
      await appendContainment(db, request.incidentId ?? null, { aiExecutionStopped: true });
      return 'AI execution paused through the existing kill switch';
    }
    case 'ESCALATE': {
      const notified = await notifySuperAdmins(db, 'Security incident escalated', request.reason, {
        incidentId: request.incidentId ?? null,
      });
      await appendContainment(db, request.incidentId ?? null, { escalatedTo: notified });
      return `Escalated to ${notified} GM account(s)`;
    }
    case 'NOTIFY_GM': {
      const notified = await notifySuperAdmins(db, 'Security notice', request.reason, {
        incidentId: request.incidentId ?? null,
      });
      return `Notified ${notified} GM account(s)`;
    }
    default:
      throw ApiError.validation([{ field: 'action', message: 'Unknown security action', code: 'VALIDATION_FAILED' }]);
  }
}

async function appendContainment(
  db: DB,
  incidentId: string | null,
  entry: Record<string, unknown>,
): Promise<void> {
  if (!incidentId) return;
  const [row] = await db
    .select({ containment: securityIncidents.containment })
    .from(securityIncidents)
    .where(eq(securityIncidents.id, incidentId))
    .limit(1);
  const current = (row?.containment as Record<string, unknown> | null) ?? {};
  const history = Array.isArray(current.history) ? (current.history as unknown[]) : [];
  await db
    .update(securityIncidents)
    .set({
      containment: { ...current, ...entry, history: [...history, { at: new Date().toISOString(), ...entry }] },
      updatedAt: new Date(),
    })
    .where(eq(securityIncidents.id, incidentId));
}

/** Second GM approves a parked action; the requester cannot approve their own. */
export async function approveAction(
  db: DB,
  policy: WcdcPolicy,
  input: { actionId: string; approverId: string },
): Promise<ActionOutcome> {
  const [row] = await db
    .select()
    .from(securityActions)
    .where(eq(securityActions.id, input.actionId))
    .limit(1);
  if (!row) throw ApiError.notFound('Security action');
  if (row.status !== 'REQUIRES_APPROVAL') {
    throw ApiError.conflict('This action is not awaiting approval');
  }
  if (row.requestedById && row.requestedById === input.approverId) {
    throw ApiError.forbidden('The requester cannot approve their own security action');
  }

  // Claim the row before acting: two GMs clicking approve at the same moment
  // must not both run the containment. The conditional update is the lock.
  const [claimed] = await db
    .update(securityActions)
    .set({ status: 'EXECUTED', approvedById: input.approverId, approvedAt: new Date() })
    .where(and(eq(securityActions.id, row.id), eq(securityActions.status, 'REQUIRES_APPROVAL')))
    .returning({ id: securityActions.id });
  if (!claimed) throw ApiError.conflict('This action is not awaiting approval');

  let detail: string;
  try {
    detail = await applyAction(
      db,
      policy,
      row.actionType as ResponseActionType,
      row.target,
      { incidentId: row.incidentId, reason: row.reason ?? 'approved', actorId: input.approverId },
      row.id,
    );
  } catch (error) {
    await db
      .update(securityActions)
      .set({
        status: 'FAILED',
        result: { error: error instanceof Error ? error.message : String(error) },
      })
      .where(eq(securityActions.id, row.id));
    throw error;
  }
  await db
    .update(securityActions)
    .set({ result: { detail } })
    .where(eq(securityActions.id, row.id));

  return {
    id: row.id,
    actionType: row.actionType,
    status: 'EXECUTED',
    mode: row.mode as 'AUTO' | 'MANUAL',
    target: row.target,
    detail,
    requiresApproval: false,
  };
}

/**
 * Automatic containment, only when policy explicitly allows it.
 *
 * Deliberately narrow: request floods from one address only. A brute force
 * against accounts is *recommended*, never applied — locking a real customer out
 * on a heuristic is a business decision, not a security default.
 */
export async function maybeAutoContain(
  db: DB,
  policy: WcdcPolicy,
  input: { ruleId: string; ipAddress: string | null; incidentId: string; reason: string },
): Promise<ActionOutcome | null> {
  if (policy.autoContainment !== 'limited') return null;
  if (!input.ipAddress) return null;
  if (input.ruleId !== 'RATE_BURST' && input.ruleId !== 'RATE_LIMIT_ABUSE') return null;

  const [existing] = await db
    .select({ id: securityBlocks.id })
    .from(securityBlocks)
    .where(
      and(
        eq(securityBlocks.kind, 'IP'),
        eq(securityBlocks.target, input.ipAddress),
        isNull(securityBlocks.revokedAt),
      ),
    )
    .limit(1);
  if (existing) return null;

  return executeAction(db, policy, {
    action: 'BLOCK_IP',
    incidentId: input.incidentId,
    target: input.ipAddress,
    reason: input.reason,
    actorId: 'wcdc-auto',
    mode: 'AUTO',
  });
}

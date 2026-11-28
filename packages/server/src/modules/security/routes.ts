import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { requireAuth, requirePermission, requireRole } from '../../middleware/auth.js';
import { getValidatedBody, getValidatedQuery, validateBody, validateQuery } from '../../middleware/validate.js';
import { getContext, getDb } from '../../lib/request-context.js';
import { users } from '../../db/schema/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { resolveWcdcPolicy } from '../../lib/wcdc/policy.js';
import { ACTION_SPECS, approveAction, executeAction } from '../../lib/wcdc/response.js';
import type { ResponseActionType } from '../../lib/wcdc/types.js';
import {
  FORBIDDEN_ACTIONS,
  INCIDENT_STATUSES,
  RESPONSE_ACTION_TYPES,
  SECURITY_RULES,
  isForbiddenAction,
} from '../../lib/wcdc/types.js';
import { auditContext, requireSecurityRead } from './guard.js';
import {
  SECURITY_READ_SCOPES,
  amendSecurityReadGrant,
  createSecurityReadGrant,
  findActiveSecurityReadGrant,
  listSecurityReadGrants,
  revokeSecurityReadGrant,
} from './delegations.js';
import {
  getIncident,
  listActions,
  listBlocks,
  listEvents,
  listIncidents,
  scanAuditSignals,
  securityOverview,
  sessionsAtRisk,
  updateIncidentStatus,
} from './service.js';

/**
 * GM Security Center API — `/api/admin/security`.
 *
 * Reads are gated by `requireSecurityRead(scope)`: `SUPER_ADMIN` holds
 * `SECURITY_READ`, and an `ADMIN` reads only through a live, scoped grant that a
 * named `SUPER_ADMIN` issued (WCDC-02). Everything that changes state needs
 * `SECURITY_RESPOND`, which no delegation can satisfy.
 */
export const securityRoutes = new Hono();

securityRoutes.use('*', requireAuth);

const severitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const eventsQuerySchema = z.object({
  ruleId: z.string().max(60).optional(),
  severity: severitySchema.optional(),
  source: z.enum(['HTTP', 'AUTH', 'AI', 'MEDIA', 'ADMIN', 'SYSTEM']).optional(),
  actorId: z.string().max(36).optional(),
  ipAddress: z.string().max(64).optional(),
  incidentId: z.string().max(36).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const incidentsQuerySchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED', 'CLOSED']).optional(),
  severity: severitySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const actionsQuerySchema = z.object({
  status: z.enum(['EXECUTED', 'REQUIRES_APPROVAL', 'REFUSED', 'FAILED']).optional(),
  incidentId: z.string().max(36).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const statusBodySchema = z.object({
  status: z.enum(INCIDENT_STATUSES as unknown as [string, ...string[]]),
  note: z.string().max(2000).optional(),
});

const respondBodySchema = z.object({
  action: z.string().min(3).max(40),
  target: z.string().max(120).optional(),
  reason: z.string().min(3).max(1000),
});

const scanBodySchema = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(24 * 60).optional(),
});

/** Rule catalogue, with the effective thresholds and the policy in force. */
securityRoutes.get('/rules', requireSecurityRead('rules'), async (c) => {
  const db = getDb(c);
  const policy = await resolveWcdcPolicy(db);
  return c.json({
    success: true,
    data: {
      rules: Object.values(SECURITY_RULES).map((rule) => ({
        ...rule,
        effectiveThreshold:
          rule.id === 'RATE_BURST' ? policy.burstMax : rule.threshold,
        effectiveWindowSeconds:
          rule.id === 'RATE_BURST' ? policy.burstWindowSeconds : rule.windowSeconds,
      })),
      actions: RESPONSE_ACTION_TYPES.map((action) => ({ action, ...ACTION_SPECS[action] })),
      forbiddenActions: FORBIDDEN_ACTIONS,
      policy: {
        autoContainment: policy.autoContainment,
        source: policy.source,
        policyId: policy.policyId,
        version: policy.policyVersion,
      },
    },
  });
});

securityRoutes.get('/overview', requireSecurityRead('overview'), async (c) => {
  const overview = await securityOverview(getDb(c));
  return c.json({ success: true, data: overview });
});

securityRoutes.get(
  '/events',
  requireSecurityRead('events'),
  validateQuery(eventsQuerySchema),
  async (c) => {
    const query = getValidatedQuery<z.infer<typeof eventsQuerySchema>>(c);
    const result = await listEvents(getDb(c), query);
    return c.json({ success: true, data: result });
  },
);

securityRoutes.get(
  '/incidents',
  requireSecurityRead('incidents'),
  validateQuery(incidentsQuerySchema),
  async (c) => {
    const query = getValidatedQuery<z.infer<typeof incidentsQuerySchema>>(c);
    const result = await listIncidents(getDb(c), query);
    return c.json({ success: true, data: result });
  },
);

securityRoutes.get('/incidents/:id', requireSecurityRead('incidents'), async (c) => {
  const detail = await getIncident(getDb(c), c.req.param('id')!);
  if (!detail) throw ApiError.notFound('Incident');
  return c.json({ success: true, data: detail });
});

securityRoutes.post(
  '/incidents/:id/status',
  requirePermission(PERMISSIONS.SECURITY_RESPOND),
  validateBody(statusBodySchema),
  async (c) => {
    const db = getDb(c);
    const body = getValidatedBody<z.infer<typeof statusBodySchema>>(c);
    const updated = await updateIncidentStatus(db, {
      id: c.req.param('id')!,
      status: body.status as (typeof INCIDENT_STATUSES)[number],
      note: body.note ?? null,
    });
    if (!updated) throw ApiError.notFound('Incident');
    await writeAudit(db, auditContext(c), {
      action: 'SECURITY.INCIDENT_STATUS',
      entityType: 'security_incident',
      entityId: updated.id,
      after: { status: updated.status, riskScore: updated.riskScore },
      metadata: { note: body.note ?? null },
    });
    return c.json({ success: true, data: updated });
  },
);

securityRoutes.post(
  '/incidents/:id/respond',
  requirePermission(PERMISSIONS.SECURITY_RESPOND),
  validateBody(respondBodySchema),
  async (c) => {
    const db = getDb(c);
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof respondBodySchema>>(c);
    const incidentId = c.req.param('id')!;
    const policy = await resolveWcdcPolicy(db);

    try {
      // An incident-scoped action already knows its target: the incident in the
      // URL. Asking the GM to paste that id again would only invite mistakes.
      const spec = ACTION_SPECS[body.action as ResponseActionType];
      const target =
        spec?.targetKind === 'incident' ? incidentId : (body.target ?? null);
      const outcome = await executeAction(db, policy, {
        action: body.action,
        incidentId,
        target,
        reason: body.reason,
        actorId: ctx?.user?.id ?? 'unknown',
      });
      await writeAudit(db, auditContext(c), {
        action: outcome.status === 'REQUIRES_APPROVAL' ? 'SECURITY.ACTION_PENDING' : 'SECURITY.ACTION_EXECUTED',
        entityType: 'security_action',
        entityId: outcome.id,
        after: { action: outcome.actionType, status: outcome.status, target: outcome.target },
        metadata: { incidentId, reason: body.reason },
      });
      return c.json({ success: true, data: outcome });
    } catch (error) {
      if (error instanceof ApiError && isForbiddenAction(body.action)) {
        await writeAudit(db, auditContext(c), {
          action: 'SECURITY.ACTION_REFUSED',
          entityType: 'security_action',
          entityId: null,
          after: { action: body.action, refused: true },
          metadata: { incidentId, reason: body.reason },
        });
      }
      throw error;
    }
  },
);

securityRoutes.get(
  '/actions',
  requireSecurityRead('actions'),
  validateQuery(actionsQuerySchema),
  async (c) => {
    const query = getValidatedQuery<z.infer<typeof actionsQuerySchema>>(c);
    const items = await listActions(getDb(c), query);
    return c.json({ success: true, data: { items } });
  },
);

securityRoutes.post('/actions/:id/approve', requirePermission(PERMISSIONS.SECURITY_RESPOND), async (c) => {
  const db = getDb(c);
  const ctx = getContext(c);
  const policy = await resolveWcdcPolicy(db);
  let outcome;
  try {
    outcome = await approveAction(db, policy, {
      actionId: c.req.param('id')!,
      approverId: ctx?.user?.id ?? 'unknown',
    });
  } catch (error) {
    // A refused approval (own request, already handled) is a decision too.
    if (error instanceof ApiError) {
      await writeAudit(db, auditContext(c), {
        action: 'SECURITY.APPROVAL_REFUSED',
        entityType: 'security_action',
        entityId: c.req.param('id')!,
        after: { refused: true, code: error.code },
      });
    }
    throw error;
  }
  await writeAudit(db, auditContext(c), {
    action: 'SECURITY.ACTION_APPROVED',
    entityType: 'security_action',
    entityId: outcome.id,
    after: { action: outcome.actionType, status: outcome.status, target: outcome.target },
  });
  return c.json({ success: true, data: outcome });
});

securityRoutes.get('/sessions/at-risk', requireSecurityRead('sessions'), async (c) => {
  const items = await sessionsAtRisk(getDb(c));
  return c.json({ success: true, data: { items } });
});

const blocksQuerySchema = z.object({
  activeOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** What is blocked right now, and until when. The GM must be able to see it. */
securityRoutes.get(
  '/blocks',
  requireSecurityRead('blocks'),
  validateQuery(blocksQuerySchema),
  async (c) => {
    const query = getValidatedQuery<z.infer<typeof blocksQuerySchema>>(c);
    const items = await listBlocks(getDb(c), {
      activeOnly: query.activeOnly !== 'false',
      limit: query.limit,
    });
    return c.json({ success: true, data: { items } });
  },
);

/** Lifts every active block on the address of one block row. */
securityRoutes.post('/blocks/:id/revoke', requirePermission(PERMISSIONS.SECURITY_RESPOND), async (c) => {
  const db = getDb(c);
  const ctx = getContext(c);
  const blockId = c.req.param('id')!;
  const [block] = await listBlocks(db, { activeOnly: false, limit: 200, id: blockId });
  if (!block) throw ApiError.notFound('Security block');
  const policy = await resolveWcdcPolicy(db);
  const outcome = await executeAction(db, policy, {
    action: 'UNBLOCK_IP',
    incidentId: null,
    target: block.target,
    reason: `Block lifted by the GM (block ${block.id})`,
    actorId: ctx?.user?.id ?? 'unknown',
  });
  await writeAudit(db, auditContext(c), {
    action: 'SECURITY.BLOCK_LIFTED',
    entityType: 'security_block',
    entityId: block.id,
    after: { target: block.target, status: outcome.status },
  });
  return c.json({ success: true, data: outcome });
});

securityRoutes.post(
  '/scan',
  requirePermission(PERMISSIONS.SECURITY_MANAGE),
  validateBody(scanBodySchema.optional().default({})),
  async (c) => {
    const db = getDb(c);
    const body = getValidatedBody<z.infer<typeof scanBodySchema>>(c) ?? {};
    const result = await scanAuditSignals(db, body.windowMinutes ?? 60);
    await writeAudit(db, auditContext(c), {
      action: 'SECURITY.SCAN_RUN',
      entityType: 'security_scan',
      entityId: null,
      after: { ...result },
    });
    return c.json({ success: true, data: result });
  },
);

/** Edge protection status. Reporting only — WCDC never calls the provider. */
securityRoutes.get('/external', requireSecurityRead('external'), async (c) => {
  const provider = env.WCDC_EDGE_PROVIDER;
  return c.json({
    success: true,
    data: {
      provider,
      configured: provider !== 'none',
      notes: env.WCDC_EDGE_NOTES ?? null,
      /**
       * Stated plainly: WCDC sees application-layer signals only. A volumetric
       * flood has to be absorbed before it reaches this process.
       */
      coversVolumetricDdos: false,
      recommendation:
        provider === 'none'
          ? 'Place the public host behind a CDN/WAF that offers DDoS absorption, then set WCDC_EDGE_PROVIDER.'
          : 'Edge provider recorded. Verify its DDoS protection level in the provider console; WCDC cannot verify it from here.',
      integrationMode: 'status-only',
    },
  });
});

/* ── Delegated read access (WCDC-02) ───────────────────────────────────────
 * Only a SUPER_ADMIN issues, amends or revokes these. There is no route that
 * lets the beneficiary — or any agent, or any other ADMIN — touch its own
 * grant: the delegation table is append-only from the outside, and the audit
 * trail records every change with the issuer's identity.
 */

const grantScopesBody = z.array(z.string().min(2).max(40)).min(1).max(SECURITY_READ_SCOPES.length);

const createGrantSchema = z
  .object({
    adminUserId: z.string().min(8).max(36).optional(),
    adminEmail: z.string().email().max(200).optional(),
    scopes: grantScopesBody,
    expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
    expiresAt: z.string().datetime().optional(),
    reason: z.string().min(8).max(500),
  })
  .refine((value) => Boolean(value.adminUserId) !== Boolean(value.adminEmail), {
    message: 'Give exactly one of adminUserId or adminEmail',
    path: ['adminUserId'],
  })
  .refine((value) => Boolean(value.expiresInDays) !== Boolean(value.expiresAt), {
    message: 'Give exactly one of expiresInDays or expiresAt',
    path: ['expiresAt'],
  });

const amendGrantSchema = z
  .object({
    scopes: grantScopesBody.optional(),
    expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
    expiresAt: z.string().datetime().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((value) => Boolean(value.scopes) || Boolean(value.expiresInDays) || Boolean(value.expiresAt), {
    message: 'Nothing to change',
    path: ['scopes'],
  });

async function resolveBeneficiaryId(
  db: ReturnType<typeof getDb>,
  body: { adminUserId?: string; adminEmail?: string },
): Promise<string> {
  if (body.adminUserId) return body.adminUserId;
  const email = (body.adminEmail ?? '').trim().toLowerCase();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw ApiError.notFound('Administrator account');
  return row.id;
}

function expiryFrom(body: { expiresInDays?: number; expiresAt?: string }): Date {
  if (body.expiresAt) return new Date(body.expiresAt);
  return new Date(Date.now() + (body.expiresInDays ?? 7) * 24 * 3600 * 1000);
}

/** The caller's own delegation, so an ADMIN can see what it may read. */
securityRoutes.get('/delegations/me', async (c) => {
  const ctx = getContext(c);
  const user = ctx?.user;
  if (!user) throw ApiError.unauthorized('Authentication required');
  const heldByRole = user.roles.includes('SUPER_ADMIN');
  const grant = heldByRole ? null : await findActiveSecurityReadGrant(getDb(c), user.id);
  return c.json({
    success: true,
    data: {
      heldByRole,
      grant: grant
        ? {
            id: grant.id,
            scopes: grant.scopes,
            expiresAt: grant.expiresAt,
            grantedById: grant.grantedById,
            reason: grant.reason,
          }
        : null,
    },
  });
});

securityRoutes.get('/delegations', requireRole('SUPER_ADMIN'), async (c) => {
  const includeClosed = c.req.query('includeClosed') === 'true';
  const items = await listSecurityReadGrants(getDb(c), { includeClosed });
  return c.json({
    success: true,
    data: {
      items,
      scopes: SECURITY_READ_SCOPES,
      maxDays: env.SECURITY_DELEGATION_MAX_DAYS,
    },
  });
});

securityRoutes.post(
  '/delegations',
  requireRole('SUPER_ADMIN'),
  validateBody(createGrantSchema),
  async (c) => {
    const db = getDb(c);
    const body = getValidatedBody<z.infer<typeof createGrantSchema>>(c);
    const grant = await createSecurityReadGrant(db, {
      adminUserId: await resolveBeneficiaryId(db, body),
      scopes: body.scopes,
      expiresAt: expiryFrom(body),
      reason: body.reason,
      actor: auditContext(c),
    });
    return c.json({ success: true, data: grant });
  },
);

securityRoutes.patch(
  '/delegations/:id',
  requireRole('SUPER_ADMIN'),
  validateBody(amendGrantSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof amendGrantSchema>>(c);
    const grant = await amendSecurityReadGrant(getDb(c), {
      id: c.req.param('id')!,
      scopes: body.scopes,
      expiresAt: body.expiresInDays || body.expiresAt ? expiryFrom(body) : undefined,
      reason: body.reason,
      actor: auditContext(c),
    });
    return c.json({ success: true, data: grant });
  },
);

securityRoutes.post(
  '/delegations/:id/revoke',
  requireRole('SUPER_ADMIN'),
  validateBody(z.object({ reason: z.string().max(500).optional() }).optional().default({})),
  async (c) => {
    const body = getValidatedBody<{ reason?: string }>(c) ?? {};
    const grant = await revokeSecurityReadGrant(getDb(c), {
      id: c.req.param('id')!,
      reason: body.reason,
      actor: auditContext(c),
    });
    return c.json({ success: true, data: grant });
  },
);

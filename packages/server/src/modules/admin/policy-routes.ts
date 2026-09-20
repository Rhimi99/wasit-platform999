import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { policies, countryPolicyGaps } from '../../db/schema/engine';
import { countries } from '../../db/schema/geo';
import { writeAudit } from '../../lib/audit';
import { upsertCountryPolicy, resolveMergedPolicy } from '../../lib/policy-engine';
import { resolveCountryPolicyGap } from '../../lib/country-policy-gaps';

const DISPUTE_CODE = 'DISPUTE_RESOLUTION';
const RETENTION_CODE = 'DATA_RETENTION';

/** Numeric rule fields the admin may edit; each is a positive whole number of days/count. */
const disputeRulesSchema = z.object({
  openWindowDays: z.number().int().positive().max(3650).optional(),
  evidenceDeadlineDays: z.number().int().positive().max(3650).optional(),
  decisionDeadlineDays: z.number().int().positive().max(3650).optional(),
  appealWindowDays: z.number().int().positive().max(3650).optional(),
  maxAppeals: z.number().int().positive().max(10).optional(),
  autoEscalateDays: z.number().int().positive().max(3650).optional(),
}).strict();

/** Data-retention rules. `preserves` lists extra record classes to keep. */
const retentionRulesSchema = z.object({
  defaultRetentionDays: z.number().int().positive().max(3650).optional(),
  legalHoldFinanciallyRequired: z.boolean().optional(),
  preserves: z.array(z.string().min(1).max(60)).max(20).optional(),
}).strict();

const updateSchema = z.object({
  countryId: z.string().min(1).max(36).nullable().optional(),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  rules: disputeRulesSchema,
  reason: z.string().min(5).max(1000),
});

const updateRetentionSchema = z.object({
  countryId: z.string().min(1).max(36).nullable().optional(),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  rules: retentionRulesSchema,
  reason: z.string().min(5).max(1000),
});

export const adminPolicyRoutes = new Hono();

adminPolicyRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.ADMIN_POLICIES));

/** Lists every dispute policy row: the global default plus per-country overrides. */
adminPolicyRoutes.get('/dispute', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: policies.id,
      name: policies.name,
      description: policies.description,
      rules: policies.rules,
      countryId: policies.countryId,
      countryCode: countries.code,
      version: policies.version,
      isActive: policies.isActive,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .leftJoin(countries, eq(countries.id, policies.countryId))
    .where(and(eq(policies.scope, 'DISPUTE'), eq(policies.code, DISPUTE_CODE)))
    .orderBy(desc(policies.updatedAt));

  const gaps = await ctx.db
    .select({
      id: countryPolicyGaps.id,
      countryId: countryPolicyGaps.countryId,
      countryCode: countries.code,
      status: countryPolicyGaps.status,
      reason: countryPolicyGaps.reason,
      detectedAt: countryPolicyGaps.detectedAt,
    })
    .from(countryPolicyGaps)
    .leftJoin(countries, eq(countries.id, countryPolicyGaps.countryId))
    .where(and(eq(countryPolicyGaps.scope, 'DISPUTE'), eq(countryPolicyGaps.code, DISPUTE_CODE)))
    .orderBy(desc(countryPolicyGaps.detectedAt));

  const countryList = await ctx.db
    .select({ id: countries.id, code: countries.code, name: countries.name, nameAr: countries.nameAr, isActive: countries.isActive })
    .from(countries)
    .orderBy(countries.name);

  return c.json({ success: true, data: { items: rows, gaps, countries: countryList } });
});

/**
 * Creates or updates the global policy (countryId null) or a country override.
 * Every change records who/what/old/new/when/reason in the audit log.
 */
adminPolicyRoutes.put('/dispute', validateBody(updateSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof updateSchema>>(c);
  const actorId = ctx.user!.id;
  const countryId = body.countryId ?? null;

  const [before] = await ctx.db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.scope, 'DISPUTE'),
        eq(policies.code, DISPUTE_CODE),
        countryId ? eq(policies.countryId, countryId) : isNull(policies.countryId),
      ),
    )
    .orderBy(desc(policies.version))
    .limit(1);

  if (!countryId) {
    if (!before) {
      // The global default must exist to anchor the fallback chain.
      const { newId } = await import('../../lib/ids');
      await ctx.db.insert(policies).values({
        id: newId(),
        scope: 'DISPUTE',
        code: DISPUTE_CODE,
        name: body.name,
        description: body.description ?? null,
        rules: body.rules,
        countryId: null,
        createdById: actorId,
        isActive: true,
        version: 1,
      });
      await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
        action: 'POLICY.DISPUTE.CREATED',
        entityType: 'POLICY',
        entityId: DISPUTE_CODE,
        after: { countryId: null, rules: body.rules, reason: body.reason },
      });
      return c.json({ success: true, data: { id: null, countryId: null, created: true } });
    }
    await ctx.db
      .update(policies)
      .set({ name: body.name, description: body.description ?? before.description, rules: body.rules, version: before.version + 1, updatedAt: new Date() })
      .where(eq(policies.id, before.id));
    await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'POLICY.DISPUTE.UPDATED',
      entityType: 'POLICY',
      entityId: before.id,
      before: { rules: before.rules, version: before.version },
      after: { rules: body.rules, version: before.version + 1, reason: body.reason },
    });
    return c.json({ success: true, data: { id: before.id, countryId: null, created: false } });
  }

  const { id, created } = await upsertCountryPolicy(ctx.db, {
    scope: 'DISPUTE',
    code: DISPUTE_CODE,
    countryId,
    name: body.name,
    description: body.description ?? null,
    rules: body.rules,
    actorId,
  });
  await resolveCountryPolicyGap(ctx.db, { countryId, scope: 'DISPUTE', code: DISPUTE_CODE });
  await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: created ? 'POLICY.DISPUTE.COUNTRY.CREATED' : 'POLICY.DISPUTE.COUNTRY.UPDATED',
    entityType: 'POLICY',
    entityId: id,
    before: before ? { rules: before.rules, version: before.version } : null,
    after: { countryId, rules: body.rules, reason: body.reason },
  });
  return c.json({ success: true, data: { id, countryId, created } });
});

/** Resolves the effective rules for a country (merged over the global default). */
adminPolicyRoutes.get('/dispute/resolved', async (c) => {
  const ctx = getContext(c);
  const countryId = c.req.query('countryId') ?? null;
  const resolved = await resolveMergedPolicy(ctx.db, {
    scope: 'DISPUTE',
    code: DISPUTE_CODE,
    countryId,
  });
  return c.json({ success: true, data: resolved });
});

// ---------------------------------------------------------------------------
// Data retention (Privacy): governs the deletion retention window per country.
// ---------------------------------------------------------------------------

/** Lists the global retention policy plus per-country overrides and open gaps. */
adminPolicyRoutes.get('/retention', async (c) => {
  const ctx = getContext(c);
  const rows = await ctx.db
    .select({
      id: policies.id,
      name: policies.name,
      description: policies.description,
      rules: policies.rules,
      countryId: policies.countryId,
      countryCode: countries.code,
      version: policies.version,
      isActive: policies.isActive,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .leftJoin(countries, eq(countries.id, policies.countryId))
    .where(and(eq(policies.scope, 'PRIVACY'), eq(policies.code, RETENTION_CODE)))
    .orderBy(desc(policies.updatedAt));

  const gaps = await ctx.db
    .select({
      id: countryPolicyGaps.id,
      countryId: countryPolicyGaps.countryId,
      countryCode: countries.code,
      status: countryPolicyGaps.status,
      reason: countryPolicyGaps.reason,
      detectedAt: countryPolicyGaps.detectedAt,
    })
    .from(countryPolicyGaps)
    .leftJoin(countries, eq(countries.id, countryPolicyGaps.countryId))
    .where(and(eq(countryPolicyGaps.scope, 'PRIVACY'), eq(countryPolicyGaps.code, RETENTION_CODE)))
    .orderBy(desc(countryPolicyGaps.detectedAt));

  const countryList = await ctx.db
    .select({ id: countries.id, code: countries.code, name: countries.name, nameAr: countries.nameAr, isActive: countries.isActive })
    .from(countries)
    .orderBy(countries.name);

  return c.json({ success: true, data: { items: rows, gaps, countries: countryList } });
});

/** Creates or updates the global retention policy or a country override. */
adminPolicyRoutes.put('/retention', validateBody(updateRetentionSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof updateRetentionSchema>>(c);
  const actorId = ctx.user!.id;
  const countryId = body.countryId ?? null;

  const [before] = await ctx.db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.scope, 'PRIVACY'),
        eq(policies.code, RETENTION_CODE),
        countryId ? eq(policies.countryId, countryId) : isNull(policies.countryId),
      ),
    )
    .orderBy(desc(policies.version))
    .limit(1);

  if (!countryId) {
    if (!before) {
      const { newId } = await import('../../lib/ids');
      await ctx.db.insert(policies).values({
        id: newId(),
        scope: 'PRIVACY',
        code: RETENTION_CODE,
        name: body.name,
        description: body.description ?? null,
        rules: body.rules,
        countryId: null,
        createdById: actorId,
        isActive: true,
        version: 1,
      });
      await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
        action: 'POLICY.RETENTION.CREATED',
        entityType: 'POLICY',
        entityId: RETENTION_CODE,
        after: { countryId: null, rules: body.rules, reason: body.reason },
      });
      return c.json({ success: true, data: { id: null, countryId: null, created: true } });
    }
    await ctx.db
      .update(policies)
      .set({ name: body.name, description: body.description ?? before.description, rules: body.rules, version: before.version + 1, updatedAt: new Date() })
      .where(eq(policies.id, before.id));
    await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'POLICY.RETENTION.UPDATED',
      entityType: 'POLICY',
      entityId: before.id,
      before: { rules: before.rules, version: before.version },
      after: { rules: body.rules, version: before.version + 1, reason: body.reason },
    });
    return c.json({ success: true, data: { id: before.id, countryId: null, created: false } });
  }

  const { id, created } = await upsertCountryPolicy(ctx.db, {
    scope: 'PRIVACY',
    code: RETENTION_CODE,
    countryId,
    name: body.name,
    description: body.description ?? null,
    rules: body.rules,
    actorId,
  });
  await resolveCountryPolicyGap(ctx.db, { countryId, scope: 'PRIVACY', code: RETENTION_CODE });
  await writeAudit(ctx.db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: created ? 'POLICY.RETENTION.COUNTRY.CREATED' : 'POLICY.RETENTION.COUNTRY.UPDATED',
    entityType: 'POLICY',
    entityId: id,
    before: before ? { rules: before.rules, version: before.version } : null,
    after: { countryId, rules: body.rules, reason: body.reason },
  });
  return c.json({ success: true, data: { id, countryId, created } });
});

/** Resolves the effective retention rules for a country (merged over global). */
adminPolicyRoutes.get('/retention/resolved', async (c) => {
  const ctx = getContext(c);
  const countryId = c.req.query('countryId') ?? null;
  const resolved = await resolveMergedPolicy(ctx.db, {
    scope: 'PRIVACY',
    code: RETENTION_CODE,
    countryId,
  });
  return c.json({ success: true, data: resolved });
});
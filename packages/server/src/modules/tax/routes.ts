import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { taxJurisdictions } from '../../db/schema/tax.js';
import { countries } from '../../db/schema/geo.js';
import {
  configureTaxRule,
  listCountryTaxRules,
  markTaxRuleDecisionRequired,
  resolveTaxForMarket,
} from './service.js';

/**
 * Tax routes (P1).
 *
 * Read + resolve are gated by `admin:reports`; configuring a jurisdiction is a
 * policy act gated by `admin:policies`. No customer/merchant/supplier role holds
 * either permission, so a trading party can never write a tax rule. Nothing here
 * computes a rate the platform was not explicitly given.
 */

const configureSchema = z
  .object({
    countryId: z.string().min(1).max(36),
    regionCode: z.string().min(1).max(50).nullable().optional(),
    taxType: z.string().min(1).max(50),
    /** Decimal fraction in [0,1): 0.19 means 19%. Supplied, never defaulted. */
    rate: z.string().regex(/^\d+(\.\d{1,6})?$/),
    priceIncludesTax: z.boolean().optional(),
    appliesTo: z.enum(['BUYER', 'SELLER']).optional(),
    providerRef: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    reason: z.string().min(5).max(1000),
  })
  .strict();

const decisionRequiredSchema = z
  .object({
    countryId: z.string().min(1).max(36),
    taxType: z.string().min(1).max(50),
    notes: z.string().max(2000).nullable().optional(),
    reason: z.string().min(5).max(1000),
  })
  .strict();

const resolveSchema = z
  .object({
    countryCode: z.string().length(2),
    regionCode: z.string().max(50).nullable().optional(),
    taxType: z.string().min(1).max(50),
    amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
    currencyCode: z.string().length(3),
  })
  .strict();

export const taxRoutes = new Hono();

taxRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.ADMIN_REPORTS));

/** Lists configured/undecided tax jurisdictions, optionally for one country. */
taxRoutes.get('/jurisdictions', async (c) => {
  const ctx = getContext(c);
  const countryId = c.req.query('countryId');
  const rows = await ctx.db
    .select({
      id: taxJurisdictions.id,
      countryId: taxJurisdictions.countryId,
      countryCode: countries.code,
      countryName: countries.name,
      regionCode: taxJurisdictions.regionCode,
      taxType: taxJurisdictions.taxType,
      status: taxJurisdictions.status,
      rate: taxJurisdictions.rate,
      priceIncludesTax: taxJurisdictions.priceIncludesTax,
      appliesTo: taxJurisdictions.appliesTo,
      providerRef: taxJurisdictions.providerRef,
      notes: taxJurisdictions.notes,
      updatedAt: taxJurisdictions.updatedAt,
    })
    .from(taxJurisdictions)
    .leftJoin(countries, eq(countries.id, taxJurisdictions.countryId))
    .where(countryId ? eq(taxJurisdictions.countryId, countryId) : undefined)
    .orderBy(desc(taxJurisdictions.updatedAt));
  return c.json({ success: true, data: { items: rows } });
});

/** Every tax type recorded for one country (configured or undecided). */
taxRoutes.get('/countries/:countryId/rules', async (c) => {
  const ctx = getContext(c);
  const items = await listCountryTaxRules(ctx.db, c.req.param('countryId')!);
  return c.json({ success: true, data: { items } });
});

/**
 * Resolves the tax decision for an amount. Returns `DECISION_REQUIRED` with a
 * null rate/amount when the jurisdiction has no configured rule — it never
 * returns a guessed percentage.
 */
taxRoutes.post('/resolve', validateBody(resolveSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof resolveSchema>>(c);
  const resolution = await resolveTaxForMarket(ctx.db, {
    countryCode: body.countryCode.toUpperCase(),
    regionCode: body.regionCode ?? null,
    taxType: body.taxType,
    amount: body.amount,
    currencyCode: body.currencyCode.toUpperCase(),
  });
  return c.json({ success: true, data: resolution });
});

/** Configures a rule. Requires `admin:policies` on top of the router guard. */
taxRoutes.put(
  '/jurisdictions',
  requirePermission(PERMISSIONS.ADMIN_POLICIES),
  validateBody(configureSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof configureSchema>>(c);
    const result = await configureTaxRule(ctx.db, {
      countryId: body.countryId,
      regionCode: body.regionCode ?? null,
      taxType: body.taxType,
      rate: body.rate,
      priceIncludesTax: body.priceIncludesTax,
      appliesTo: body.appliesTo,
      providerRef: body.providerRef ?? null,
      notes: body.notes ?? null,
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
    });
    return c.json({ success: true, data: result }, result.created ? (201 as never) : 200);
  },
);

/** Records that a jurisdiction's tax position is still undecided. */
taxRoutes.post(
  '/jurisdictions/decision-required',
  requirePermission(PERMISSIONS.ADMIN_POLICIES),
  validateBody(decisionRequiredSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof decisionRequiredSchema>>(c);
    const result = await markTaxRuleDecisionRequired(ctx.db, {
      countryId: body.countryId,
      taxType: body.taxType,
      notes: body.notes ?? null,
      actorId: ctx.user!.id,
      ipAddress: ctx.ipAddress,
    });
    return c.json({ success: true, data: result });
  },
);

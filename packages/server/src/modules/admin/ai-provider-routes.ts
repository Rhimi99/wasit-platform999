import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { env } from '../../lib/env.js';
import { secretStorageStatus } from '../../lib/ai/secret-box.js';
import {
  SUPPORTED_PROVIDERS,
  clearProviderSecret,
  configEnvironment,
  getProviderRow,
  keyState,
  listProviderRows,
  providerUsage,
  storeProviderSecret,
  testProviderConnection,
  updateProviderConfig,
  effectiveKey,
  isEnvSelected,
  maskProvider,
} from '../../lib/ai/provider-config.js';

/**
 * AI provider administration (AI-04).
 *
 * Read-only views return a masked state: whether a key exists, where it comes
 * from and when it changed. The key itself is never returned by any route.
 */
export const adminAiProviderRoutes = new Hono();

adminAiProviderRoutes.use('*', requireAuth, requirePermission(PERMISSIONS.AI_MANAGE, PERMISSIONS.ADMIN_AI));

adminAiProviderRoutes.get('/', async (c) => {
  const ctx = getContext(c);
  const rows = await listProviderRows(ctx.db);
  const storage = secretStorageStatus();
  return c.json({
    success: true,
    data: {
      environment: configEnvironment(),
      secretStorage: { available: storage.available, reason: storage.reason },
      liveTestAllowed: env.AI_PROVIDER_ALLOW_LIVE_TEST,
      items: rows.map(maskProvider),
    },
  });
});

/**
 * A deployment-wide readiness summary: which provider would run a call right
 * now, whether a key is present, and whether anything is configured at all.
 * Carries no credential material.
 */
adminAiProviderRoutes.get('/-readiness', async (c) => {
  const ctx = getContext(c);
  const rows = await listProviderRows(ctx.db);
  const usable = rows.filter((r) => r.enabled && (!SUPPORTED_PROVIDERS.find((p) => p.key === r.providerKey)?.requiresKey || effectiveKey(r)));
  return c.json({
    success: true,
    data: {
      environment: configEnvironment(),
      configured: usable.length > 0,
      defaultProvider: rows.find((r) => r.isDefault)?.providerKey ?? null,
      fallbackProvider: rows.find((r) => r.isFallback)?.providerKey ?? null,
      usable: usable.map((r) => r.providerKey),
      secretStorage: secretStorageStatus(),
    },
  });
});

adminAiProviderRoutes.get('/:key', async (c) => {
  const ctx = getContext(c);
  const row = await getProviderRow(ctx.db, c.req.param('key')!);
  const usage = await providerUsage(ctx.db, row.providerKey, 30);
  return c.json({ success: true, data: { ...maskProvider(row), usage } });
});

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).max(100).optional(),
    baseUrl: z.string().max(300).nullable().optional(),
    keyEnvVar: z.string().max(100).nullable().optional(),
    role: z.enum(['DEFAULT', 'FALLBACK', 'NONE']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

adminAiProviderRoutes.patch('/:key', validateBody(patchSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof patchSchema>>(c);
  const row = await updateProviderConfig(
    ctx.db,
    { actorId: ctx.user?.id ?? null, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    c.req.param('key')!,
    body,
  );
  return c.json({ success: true, data: maskProvider(row) });
});

const secretSchema = z.object({
  /**
   * Write-only. Never echoed, never logged, never readable back — the response
   * only reports presence and a short fingerprint.
   */
  secret: z.string().min(1).max(512),
});

adminAiProviderRoutes.put('/:key/secret', validateBody(secretSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof secretSchema>>(c);
  const row = await storeProviderSecret(
    ctx.db,
    { actorId: ctx.user?.id ?? null, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    c.req.param('key')!,
    body.secret,
  );
  return c.json({ success: true, data: maskProvider(row) });
});

adminAiProviderRoutes.delete('/:key/secret', async (c) => {
  const ctx = getContext(c);
  const row = await clearProviderSecret(
    ctx.db,
    { actorId: ctx.user?.id ?? null, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    c.req.param('key')!,
  );
  return c.json({ success: true, data: maskProvider(row) });
});

const testSchema = z.object({ mode: z.enum(['CONFIG', 'LIVE']).default('CONFIG') });

adminAiProviderRoutes.post('/:key/test', validateBody(testSchema), async (c) => {
  const ctx = getContext(c);
  const body = getValidatedBody<z.infer<typeof testSchema>>(c);
  if (body.mode === 'LIVE' && !env.AI_PROVIDER_ALLOW_LIVE_TEST) {
    // Fail closed and say why: a live probe is a paid outbound request.
    throw new ApiError(
      409,
      'CONFLICT',
      'Live provider probes are disabled on this server (AI_PROVIDER_ALLOW_LIVE_TEST)',
    );
  }
  const result = await testProviderConnection(
    ctx.db,
    { actorId: ctx.user?.id ?? null, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    c.req.param('key')!,
    body.mode,
  );
  return c.json({ success: true, data: result });
});

const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

adminAiProviderRoutes.get('/:key/usage', validateQuery(usageQuerySchema), async (c) => {
  const ctx = getContext(c);
  const row = await getProviderRow(ctx.db, c.req.param('key')!);
  const { days } = getValidatedQuery<z.infer<typeof usageQuerySchema>>(c);
  return c.json({ success: true, data: await providerUsage(ctx.db, row.providerKey, days) });
});

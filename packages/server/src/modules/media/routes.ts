import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, getValidatedBody } from '../../middleware/validate.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import {
  VIDEO_AUDIENCES,
  VIDEO_LANGUAGES,
  VIDEO_STYLES,
  deleteMediaAsset,
  generateMarketingVideo,
  getMediaAsset,
  listMyMedia,
  openAssetForDownload,
} from './service.js';

const generateSchema = z.object({
  productId: z.string().min(1).max(36),
  title: z.string().min(2).max(250).optional(),
  language: z.enum(VIDEO_LANGUAGES).optional(),
  audience: z.enum(VIDEO_AUDIENCES).optional(),
  style: z.enum(VIDEO_STYLES).optional(),
  durationSeconds: z.coerce.number().int().min(4).max(60).optional(),
  campaignId: z.string().max(36).optional().nullable(),
});

const listQuerySchema = z.object({
  kind: z.enum(['MARKETING_VIDEO', 'IMAGE', 'OTHER']).optional(),
  productId: z.string().max(36).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const mediaRoutes = new Hono();

/** Reads a required path param, failing with a structured validation error. */
function requireParam(c: { req: { param: (name: string) => string | undefined } }, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw ApiError.validation([{ field: name, message: `${name} is required`, code: 'REQUIRED' }]);
  }
  return value;
}

/** Parses a single-range `Range: bytes=start-end` header. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, s, e] = m;
  let start = s ? Number(s) : 0;
  let end = e ? Number(e) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start < 0) start = 0;
  if (end >= size) end = size - 1;
  if (start > end) return null;
  return { start, end };
}

// ----- Signed content streaming (token-authenticated, no session) ----------
// Declared before the blanket `requireAuth` below; it authorizes via the signed
// token binding the asset to its owner, and re-checks ownership in the service.
mediaRoutes.get('/assets/:id/content', async (c) => {
  const ctx = getContext(c);
  const token = c.req.query('token');
  if (!token) throw ApiError.unauthorized('A signed media link is required');
  const assetId = requireParam(c, 'id');

  const sizeProbe = await openAssetForDownload(ctx.db, assetId, token);
  const range = parseRange(c.req.header('range'), sizeProbe.size);
  const { asset, body, size, start, end } = range
    ? await openAssetForDownload(ctx.db, assetId, token, range)
    : sizeProbe;

  const headers: Record<string, string> = {
    'Content-Type': asset.mimeType,
    'Content-Length': String(body.length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (c.req.query('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="wasit-${asset.id}.${asset.extension}"`;
  } else {
    headers['Content-Disposition'] = `inline; filename="wasit-${asset.id}.${asset.extension}"`;
  }

  return new Response(new Uint8Array(body), { status: range ? 206 : 200, headers });
});

// Every remaining media endpoint requires an authenticated user.
mediaRoutes.use('*', requireAuth);

mediaRoutes.post(
  '/marketing-videos',
  requirePermission(PERMISSIONS.MEDIA_UPLOAD),
  validateBody(generateSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof generateSchema>>(c);
    const asset = await generateMarketingVideo(
      ctx.db,
      { userId: ctx.user!.id, roles: ctx.user!.roles, locale: undefined },
      body,
      { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    );
    return c.json({ success: true, data: asset }, 201);
  },
);

mediaRoutes.get('/assets', requirePermission(PERMISSIONS.MEDIA_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const q = listQuerySchema.safeParse({
    kind: c.req.query('kind'),
    productId: c.req.query('productId'),
    limit: c.req.query('limit'),
  });
  if (!q.success) {
    throw ApiError.validation(q.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: 'INVALID' })));
  }
  const items = await listMyMedia(ctx.db, ctx.user!.id, q.data);
  return c.json({ success: true, data: { items } });
});

mediaRoutes.get('/assets/:id', requirePermission(PERMISSIONS.MEDIA_READ_OWN), async (c) => {
  const ctx = getContext(c);
  const asset = await getMediaAsset(ctx.db, requireParam(c, 'id'), ctx.user!.id, ctx.user!.roles);
  return c.json({ success: true, data: asset });
});

mediaRoutes.delete('/assets/:id', requirePermission(PERMISSIONS.MEDIA_DELETE_OWN, PERMISSIONS.MEDIA_DELETE_ANY), async (c) => {
  const ctx = getContext(c);
  await deleteMediaAsset(ctx.db, requireParam(c, 'id'), ctx.user!.id, ctx.user!.roles, {
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return c.json({ success: true, data: { deleted: true } });
});
import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateQuery, getValidatedQuery } from '../../middleware/validate.js';
import { optionalAuth } from '../../middleware/auth.js';
import { runSearch } from './service.js';
import { recordSearch } from '../customer-library/service.js';

const searchSchema = z.object({
  q: z.string().max(200),
  type: z.enum(['products', 'suppliers', 'merchants', 'companies', 'categories', 'locations', 'all']).optional(),
  countryId: z.string().max(36).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(50).optional(),
});

export const searchRoutes = new Hono();

searchRoutes.get('/', optionalAuth, validateQuery(searchSchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof searchSchema>>(c);
  const ctx = getContext(c);
  const result = await runSearch(ctx.db, query);

  // Authenticated searches feed the customer's search history. Failure to
  // record must never break the search itself.
  if (ctx.user && query.q.trim()) {
    const count = result.results.reduce((sum, r) => sum + r.count, 0);
    try {
      await recordSearch(ctx.db, ctx.user.id, query.q, {
        filters: { type: query.type ?? 'all', countryId: query.countryId ?? null },
        resultsCount: count,
      });
    } catch {
      // best-effort: history is auxiliary
    }
  }

  return c.json({ success: true, data: result });
});
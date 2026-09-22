import { Hono } from 'hono';
import { z } from 'zod';
import { getContext } from '../../lib/request-context.js';
import { validateQuery, getValidatedQuery } from '../../middleware/validate.js';
import { comparePrices, listComparisonCategories } from './service.js';

const comparisonSchema = z.object({
  query: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  categoryId: z.string().max(36).optional(),
  countryId: z.string().max(36).optional(),
  currencyCode: z.string().length(3).optional(),
  comparableOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(50).optional(),
});

export const comparisonRoutes = new Hono();

/**
 * Public price comparison. Only published, active products from active-public
 * catalogues are exposed (the same visibility filter as the marketplace), and
 * no seller-private data (exact stock) leaves the service.
 */
comparisonRoutes.get('/', validateQuery(comparisonSchema), async (c) => {
  const query = getValidatedQuery<z.infer<typeof comparisonSchema>>(c);
  const ctx = getContext(c);
  const result = await comparePrices(ctx.db, {
    ...query,
    query: query.query ?? query.q,
  });
  return c.json({ success: true, data: result });
});

comparisonRoutes.get('/categories', async (c) => {
  const ctx = getContext(c);
  const rows = await listComparisonCategories(ctx.db);
  return c.json({ success: true, data: rows });
});

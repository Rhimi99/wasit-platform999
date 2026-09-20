import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@wasit/shared';
import { getContext } from '../../lib/request-context.js';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import {
  FAVORITE_ENTITY_TYPES,
  SAVED_ITEM_TYPES,
  addFavorite,
  clearSearchHistory,
  deleteSearchHistoryEntry,
  listFavorites,
  listSavedItems,
  listSearchHistory,
  recordSearch,
  removeFavorite,
  removeSavedItem,
  saveItem,
} from './service.js';

const favoriteEntity = z.enum(FAVORITE_ENTITY_TYPES);
const savedItemType = z.enum(SAVED_ITEM_TYPES);

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const favoriteBodySchema = z.object({
  entityType: favoriteEntity,
  entityId: z.string().min(1).max(36),
});

const savedBodySchema = z.object({
  itemType: savedItemType,
  itemId: z.string().min(1).max(36),
  notes: z.string().max(1000).nullable().optional(),
});

const searchHistoryBodySchema = z.object({
  query: z.string().min(1).max(400),
  filters: z.record(z.string(), z.unknown()).nullable().optional(),
  resultsCount: z.number().int().nonnegative().optional(),
});


export const customerLibraryRoutes = new Hono();

// ------------------------------------------------- favorites
customerLibraryRoutes.get(
  '/favorites',
  requirePermission(PERMISSIONS.FAVORITE_MANAGE),
  validateQuery(listQuerySchema.extend({ entityType: favoriteEntity.optional() })),
  async (c) => {
    const ctx = getContext(c);
    const query = getValidatedQuery<z.infer<typeof listQuerySchema> & { entityType?: z.infer<typeof favoriteEntity> }>(c);
    const result = await listFavorites(ctx.db, ctx.user!.id, query);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.post(
  '/favorites',
  requirePermission(PERMISSIONS.FAVORITE_MANAGE),
  validateBody(favoriteBodySchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof favoriteBodySchema>>(c);
    const result = await addFavorite(ctx.db, ctx.user!.id, body.entityType, body.entityId);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.delete(
  '/favorites/:entityType/:entityId',
  requirePermission(PERMISSIONS.FAVORITE_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const entityType = favoriteEntity.parse(c.req.param('entityType'));
    const entityId = c.req.param('entityId')!;
    const result = await removeFavorite(ctx.db, ctx.user!.id, entityType, entityId);
    return c.json({ success: true, data: result });
  },
);

// ------------------------------------------------- saved items
customerLibraryRoutes.get(
  '/saved',
  requirePermission(PERMISSIONS.SAVED_ITEM_MANAGE),
  validateQuery(listQuerySchema.extend({ itemType: savedItemType.optional() })),
  async (c) => {
    const ctx = getContext(c);
    const query = getValidatedQuery<z.infer<typeof listQuerySchema> & { itemType?: z.infer<typeof savedItemType> }>(c);
    const result = await listSavedItems(ctx.db, ctx.user!.id, query);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.post(
  '/saved',
  requirePermission(PERMISSIONS.SAVED_ITEM_MANAGE),
  validateBody(savedBodySchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof savedBodySchema>>(c);
    const result = await saveItem(ctx.db, ctx.user!.id, body.itemType, body.itemId, body.notes);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.delete(
  '/saved/:itemType/:itemId',
  requirePermission(PERMISSIONS.SAVED_ITEM_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const itemType = savedItemType.parse(c.req.param('itemType'));
    const itemId = c.req.param('itemId')!;
    const result = await removeSavedItem(ctx.db, ctx.user!.id, itemType, itemId);
    return c.json({ success: true, data: result });
  },
);

// ------------------------------------------------- search history
customerLibraryRoutes.get(
  '/search-history',
  requirePermission(PERMISSIONS.SEARCH_HISTORY_MANAGE),
  validateQuery(listQuerySchema),
  async (c) => {
    const ctx = getContext(c);
    const query = getValidatedQuery<z.infer<typeof listQuerySchema>>(c);
    const result = await listSearchHistory(ctx.db, ctx.user!.id, query);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.post(
  '/search-history',
  requirePermission(PERMISSIONS.SEARCH_HISTORY_MANAGE),
  validateBody(searchHistoryBodySchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof searchHistoryBodySchema>>(c);
    const result = await recordSearch(ctx.db, ctx.user!.id, body.query, {
      filters: body.filters,
      resultsCount: body.resultsCount,
    });
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.delete(
  '/search-history',
  requirePermission(PERMISSIONS.SEARCH_HISTORY_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const result = await clearSearchHistory(ctx.db, ctx.user!.id);
    return c.json({ success: true, data: result });
  },
);

customerLibraryRoutes.delete(
  '/search-history/:id',
  requirePermission(PERMISSIONS.SEARCH_HISTORY_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const result = await deleteSearchHistoryEntry(ctx.db, ctx.user!.id, c.req.param('id')!);
    return c.json({ success: true, data: result });
  },
);
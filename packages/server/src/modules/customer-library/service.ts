import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { favorites, savedItems, searchHistory } from '../../db/schema/audit';
import { products } from '../../db/schema/products';
import { companies, merchants, suppliers } from '../../db/schema/trade';
import { newId } from '../../lib/ids';

/**
 * Favorite / saved / search-history entity types. "PRODUCT" covers catalog
 * items; the rest cover the trade directories.
 */
export const FAVORITE_ENTITY_TYPES = ['PRODUCT', 'SUPPLIER', 'MERCHANT', 'COMPANY'] as const;
export const SAVED_ITEM_TYPES = ['PRODUCT', 'SUPPLIER', 'MERCHANT', 'COMPANY'] as const;

export type FavoriteEntityType = (typeof FAVORITE_ENTITY_TYPES)[number];
export type SavedItemType = (typeof SAVED_ITEM_TYPES)[number];

interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

function paginate(pageRaw?: number, pageSizeRaw?: number): Pagination {
  const page = Math.max(1, pageRaw ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Resolves the display fields of a favorited/saved entity, or null if it no longer exists. */
async function resolveEntity(
  db: DB,
  entityType: string,
  entityId: string,
): Promise<{ title: string; slug: string | null; subtitle: string | null } | null> {
  switch (entityType) {
    case 'PRODUCT': {
      const [p] = await db
        .select({ name: products.name, nameAr: products.nameAr, slug: products.slug, brand: products.brand })
        .from(products)
        .where(eq(products.id, entityId))
        .limit(1);
      return p ? { title: p.nameAr ?? p.name, slug: p.slug, subtitle: p.brand } : null;
    }
    case 'SUPPLIER': {
      const [s] = await db
        .select({ companyName: suppliers.companyName, slug: suppliers.slug })
        .from(suppliers)
        .where(eq(suppliers.id, entityId))
        .limit(1);
      return s ? { title: s.companyName, slug: s.slug, subtitle: null } : null;
    }
    case 'MERCHANT': {
      const [m] = await db
        .select({ storeName: merchants.storeName, slug: merchants.slug })
        .from(merchants)
        .where(eq(merchants.id, entityId))
        .limit(1);
      return m ? { title: m.storeName, slug: m.slug, subtitle: null } : null;
    }
    case 'COMPANY': {
      const [c] = await db
        .select({ legalName: companies.legalName, slug: companies.slug, industry: companies.industry })
        .from(companies)
        .where(eq(companies.id, entityId))
        .limit(1);
      return c ? { title: c.legalName, slug: c.slug, subtitle: c.industry } : null;
    }
    default:
      return null;
  }
}

async function assertEntityExists(db: DB, entityType: string, entityId: string): Promise<void> {
  const found = await resolveEntity(db, entityType, entityId);
  if (!found) throw new ApiError(404, 'NOT_FOUND', `${entityType} not found.`);
}

// ---------------------------------------------------------------- favorites
export async function addFavorite(db: DB, userId: string, entityType: FavoriteEntityType, entityId: string) {
  await assertEntityExists(db, entityType, entityId);
  const [existing] = await db
    .select()
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.entityType, entityType), eq(favorites.entityId, entityId)))
    .limit(1);
  if (existing) return { id: existing.id, created: false };

  const id = newId();
  await db.insert(favorites).values({ id, userId, entityType, entityId });
  return { id, created: true };
}

export async function removeFavorite(db: DB, userId: string, entityType: FavoriteEntityType, entityId: string) {
  const removed = await db
    .delete(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.entityType, entityType), eq(favorites.entityId, entityId)))
    .returning({ id: favorites.id });
  if (removed.length === 0) throw ApiError.notFound('Favorite not found');
  return { id: removed[0].id };
}

export async function listFavorites(
  db: DB,
  userId: string,
  query: { entityType?: FavoriteEntityType; page?: number; pageSize?: number } = {},
) {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions = [eq(favorites.userId, userId)];
  if (query.entityType) conditions.push(eq(favorites.entityType, query.entityType));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(favorites)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(favorites)
    .where(and(...conditions))
    .orderBy(desc(favorites.createdAt))
    .limit(pageSize)
    .offset(offset);

  const items = await Promise.all(
    rows.map(async (row) => {
      const resolved = await resolveEntity(db, row.entityType, row.entityId);
      return {
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt,
        title: resolved?.title ?? null,
        slug: resolved?.slug ?? null,
        subtitle: resolved?.subtitle ?? null,
        available: resolved !== null,
      };
    }),
  );

  return { items, pagination: { page, pageSize, total } };
}

// ---------------------------------------------------------------- saved items
export async function saveItem(db: DB, userId: string, itemType: SavedItemType, itemId: string, notes?: string | null) {
  await assertEntityExists(db, itemType, itemId);
  const [existing] = await db
    .select()
    .from(savedItems)
    .where(and(eq(savedItems.userId, userId), eq(savedItems.itemType, itemType), eq(savedItems.itemId, itemId)))
    .limit(1);
  if (existing) {
    if (notes !== undefined) {
      await db.update(savedItems).set({ notes: notes ?? null }).where(eq(savedItems.id, existing.id));
    }
    return { id: existing.id, created: false };
  }

  const id = newId();
  await db.insert(savedItems).values({ id, userId, itemType, itemId, notes: notes ?? null });
  return { id, created: true };
}

export async function removeSavedItem(db: DB, userId: string, itemType: SavedItemType, itemId: string) {
  const removed = await db
    .delete(savedItems)
    .where(and(eq(savedItems.userId, userId), eq(savedItems.itemType, itemType), eq(savedItems.itemId, itemId)))
    .returning({ id: savedItems.id });
  if (removed.length === 0) throw ApiError.notFound('Saved item not found');
  return { id: removed[0].id };
}

export async function listSavedItems(
  db: DB,
  userId: string,
  query: { itemType?: SavedItemType; page?: number; pageSize?: number } = {},
) {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const conditions = [eq(savedItems.userId, userId)];
  if (query.itemType) conditions.push(eq(savedItems.itemType, query.itemType));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(savedItems)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(savedItems)
    .where(and(...conditions))
    .orderBy(desc(savedItems.createdAt))
    .limit(pageSize)
    .offset(offset);

  const items = await Promise.all(
    rows.map(async (row) => {
      const resolved = await resolveEntity(db, row.itemType, row.itemId);
      return {
        id: row.id,
        itemType: row.itemType,
        itemId: row.itemId,
        notes: row.notes,
        createdAt: row.createdAt,
        title: resolved?.title ?? null,
        slug: resolved?.slug ?? null,
        available: resolved !== null,
      };
    }),
  );

  return { items, pagination: { page, pageSize, total } };
}

// ---------------------------------------------------------------- search history
const MAX_HISTORY_PER_USER = 200;

export async function recordSearch(
  db: DB,
  userId: string,
  query: string,
  options: { filters?: Record<string, unknown> | null; resultsCount?: number | null } = {},
) {
  const trimmed = query.trim();
  if (!trimmed) throw new ApiError(422, 'VALIDATION_ERROR', 'Search query must not be empty.');
  const id = newId();
  await db.insert(searchHistory).values({
    id,
    userId,
    query: trimmed.slice(0, 400),
    filters: options.filters ?? null,
    resultsCount: options.resultsCount != null ? String(options.resultsCount) : null,
  });

  // Trim oldest entries beyond the per-user cap.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId));
  if (total > MAX_HISTORY_PER_USER) {
    const oldest = await db
      .select({ id: searchHistory.id })
      .from(searchHistory)
      .where(eq(searchHistory.userId, userId))
      .orderBy(searchHistory.createdAt)
      .limit(total - MAX_HISTORY_PER_USER);
    for (const row of oldest) {
      await db.delete(searchHistory).where(eq(searchHistory.id, row.id));
    }
  }

  return { id };
}

export async function listSearchHistory(
  db: DB,
  userId: string,
  query: { page?: number; pageSize?: number } = {},
) {
  const { page, pageSize, offset } = paginate(query.page, query.pageSize);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId));

  const rows = await db
    .select()
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.createdAt))
    .limit(pageSize)
    .offset(offset);

  return { items: rows, pagination: { page, pageSize, total } };
}

export async function clearSearchHistory(db: DB, userId: string) {
  const removed = await db
    .delete(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .returning({ id: searchHistory.id });
  return { removed: removed.length };
}

export async function deleteSearchHistoryEntry(db: DB, userId: string, id: string) {
  const removed = await db
    .delete(searchHistory)
    .where(and(eq(searchHistory.id, id), eq(searchHistory.userId, userId)))
    .returning({ id: searchHistory.id });
  if (removed.length === 0) throw ApiError.notFound('Search history entry not found');
  return { id };
}
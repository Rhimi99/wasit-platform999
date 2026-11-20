import { describe, it, expect } from 'vitest';
import {
  enforceListingPolicy,
  createProduct,
  updateProduct,
  updateProductStatus,
  reviewRestrictedListing,
} from '../src/modules/products/service.js';
import { products, productImages, productVariants } from '../src/db/schema/products.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { auditLogs } from '../src/db/schema/audit.js';
import type { DB } from '../src/db/client.js';

/**
 * LC-03 — enforcement decisions in the products service, against an in-memory
 * fake `DB`. The *real* service code runs; only persistence is faked, so these
 * specs prove the service refuses prohibited listings, forces restricted ones to
 * an unpublished DRAFT, blocks publishing by status change, and lets only the
 * dedicated review path clear a restricted listing. No Postgres required.
 *
 * The fake is intentionally filter-free: every table returns all its rows, and
 * each spec seeds at most one product, so a lookup that the real DB would narrow
 * by `where(...).limit(1)` still resolves to the single row the spec created.
 */

type Row = Record<string, unknown>;

const TABLES = { products, productImages, productVariants, inventoryItems, auditLogs } as const;

function fakeDb() {
  const store: Record<string, Row[]> = {
    products: [],
    productImages: [],
    productVariants: [],
    inventoryItems: [],
    auditLogs: [],
  };
  const nameOf = new Map<unknown, string>(Object.entries(TABLES).map(([n, t]) => [t, n]));
  const tableName = (t: unknown): string => nameOf.get(t) ?? 'products';

  const db = {
    select() {
      const b = {
        _table: 'products' as string,
        from(t: unknown) { b._table = tableName(t); return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() { return b; },
        then(resolve: (rows: Row[]) => unknown) {
          return Promise.resolve([...store[b._table]]).then(resolve);
        },
      };
      return b;
    },
    insert(t: unknown) {
      const table = tableName(t);
      return {
        values(v: Row | Row[]) {
          store[table].push(...(Array.isArray(v) ? v : [v]));
          return Promise.resolve(undefined);
        },
      };
    },
    update(t: unknown) {
      const table = tableName(t);
      const b = {
        _patch: {} as Row,
        set(patch: Row) { b._patch = patch; return b; },
        where() {
          for (const row of store[table]) Object.assign(row, b._patch);
          return Promise.resolve(undefined);
        },
      };
      return b;
    },
    _store: store,
  };
  return db as unknown as DB & { _store: typeof store };
}

const baseInput = {
  sellerId: 'seller-1',
  sellerType: 'MERCHANT' as const,
  categoryId: 'cat-1',
  sku: 'SKU-1',
  currencyCode: 'TND',
  basePrice: '10.0000',
};

describe('LC-03 enforceListingPolicy', () => {
  it('throws PROHIBITED_GOODS and writes no product for a prohibited listing', async () => {
    const db = fakeDb();
    await expect(
      enforceListingPolicy(db, { name: 'AK-47 rifle' }, { actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'PROHIBITED_GOODS' });
    expect(db._store.products).toHaveLength(0);
  });

  it('records the rejection in the audit trail', async () => {
    const db = fakeDb();
    await expect(enforceListingPolicy(db, { name: 'wholesale cocaine' }, { actorId: 'u1' })).rejects.toThrow();
    expect(db._store.auditLogs.some((a) => a.action === 'PRODUCT.PROHIBITED_REJECTED')).toBe(true);
  });

  it('returns an unpublished DRAFT for a restricted listing', async () => {
    const db = fakeDb();
    const outcome = await enforceListingPolicy(db, { name: 'Imported French wine' }, { actorId: 'u1' });
    expect(outcome.classification.severity).toBe('RESTRICTED');
    expect(outcome.status).toBe('DRAFT');
    expect(outcome.isPublished).toBe(false);
  });

  it('returns ACTIVE/published for an allowed listing', async () => {
    const db = fakeDb();
    const outcome = await enforceListingPolicy(db, { name: 'Organic olive oil' }, { actorId: 'u1' });
    expect(outcome.status).toBe('ACTIVE');
    expect(outcome.isPublished).toBe(true);
  });
});

describe('LC-03 service integration (fake DB)', () => {
  it('rejects a prohibited product before inserting it', async () => {
    const db = fakeDb();
    await expect(
      createProduct(db, { ...baseInput, name: 'Bulk cocaine 1kg' }, { actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'PROHIBITED_GOODS' });
    expect(db._store.products).toHaveLength(0);
  });

  it('stores a restricted product as an unpublished DRAFT', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Vintage red wine case' }, { actorId: 'u1' });
    const row = db._store.products.find((p) => p.id === id)!;
    expect(row.status).toBe('DRAFT');
    expect(row.isPublished).toBe(false);
    expect((row.tags as { lc03: { severity: string } }).lc03.severity).toBe('RESTRICTED');
  });

  it('refuses to activate an unapproved restricted listing via a status change', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Tobacco cartons' }, { actorId: 'u1' });
    await expect(updateProductStatus(db, id, 'ACTIVE', { actorId: 'seller' })).rejects.toMatchObject({
      code: 'RESTRICTED_GOODS_REVIEW_REQUIRED',
    });
  });

  it('lets an authorised reviewer approve a restricted listing', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Tobacco cartons' }, { actorId: 'u1' });
    await reviewRestrictedListing(db, id, 'APPROVE', { actorId: 'reviewer' });
    const row = db._store.products.find((p) => p.id === id)!;
    expect(row.status).toBe('ACTIVE');
    expect(row.isPublished).toBe(true);
  });

  it('lets an authorised reviewer reject a restricted listing (archived)', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Tobacco cartons' }, { actorId: 'u1' });
    await reviewRestrictedListing(db, id, 'REJECT', { actorId: 'reviewer' });
    const row = db._store.products.find((p) => p.id === id)!;
    expect(row.status).toBe('ARCHIVED');
    expect(row.isPublished).toBe(false);
  });

  it('blocks renaming an existing listing into a prohibited one', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Ordinary notebook' }, { actorId: 'u1' });
    await expect(updateProduct(db, id, { name: '9mm ammunition' }, { actorId: 'u1' })).rejects.toMatchObject({
      code: 'PROHIBITED_GOODS',
    });
    expect(db._store.products.find((p) => p.id === id)!.name).toBe('Ordinary notebook');
  });

  it('demotes a published listing that is edited into a restricted one', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Beverage assortment' }, { actorId: 'u1' });
    await updateProduct(db, id, { description: 'now contains wine' }, { actorId: 'u1' });
    const row = db._store.products.find((p) => p.id === id)!;
    expect(row.status).toBe('DRAFT');
    expect(row.isPublished).toBe(false);
  });

  it('refuses to review a listing that is not awaiting a restricted review', async () => {
    const db = fakeDb();
    const { id } = await createProduct(db, { ...baseInput, name: 'Ordinary notebook' }, { actorId: 'u1' });
    await expect(reviewRestrictedListing(db, id, 'APPROVE', { actorId: 'reviewer' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

import { sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client.js';

/**
 * PR-02 slice 2 — the Categories Desk.
 *
 * The category tree is the platform's only real hierarchy: a category owns
 * sub-categories, and products hang off whichever node they were filed under.
 * The console had no view of it at all — the public `GET /api/categories` hides
 * inactive nodes and flattens the tree, so an admin could not see an empty
 * branch, a deactivated sub-tree, or how many products a branch really carries.
 *
 * This reader works on the existing `categories` table exactly as it is: the
 * self-referencing `parent_id`, the `is_active` flag and `sort_order`. No
 * parallel model, no denormalised depth column, no schema change — depth and
 * paths are derived at read time from a recursive closure, so they can never
 * drift from the parent pointers.
 *
 * Read-only: creating, renaming or deactivating a category changes how every
 * seller files their catalogue, and that decision needs its own permission and
 * audit trail. Nothing here writes.
 */

const MAX_DEPTH = 20;

export interface CategorySummary {
  total: number;
  active: number;
  inactive: number;
  roots: number;
  children: number;
  maxDepth: number;
  withProducts: number;
  empty: number;
  totalProducts: number;
  publishedProducts: number;
  newLast30Days: number;
}

export interface CategoryListRow {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  parentId: string | null;
  parentName: string | null;
  depth: number;
  path: string;
  childrenCount: number;
  productCount: number;
  publishedProductCount: number;
  subtreeProductCount: number;
}

export interface CategoryListQuery {
  q?: string;
  status?: 'all' | 'active' | 'inactive';
  level?: 'all' | 'root' | 'child' | 'leaf';
  parentId?: string;
  hasProducts?: 'all' | 'yes' | 'no';
  page?: number;
  pageSize?: number;
}

export interface CategoryDetail {
  category: {
    id: string;
    name: string;
    nameAr: string | null;
    nameFr: string | null;
    slug: string;
    description: string | null;
    icon: string | null;
    isActive: boolean;
    sortOrder: number;
    parentId: string | null;
    parentName: string | null;
    depth: number;
    path: string;
    createdAt: string;
    updatedAt: string;
  };
  ancestors: Array<{ id: string; name: string; depth: number }>;
  children: Array<{
    id: string;
    name: string;
    isActive: boolean;
    sortOrder: number;
    productCount: number;
    childrenCount: number;
  }>;
  metrics: {
    directProducts: number;
    publishedProducts: number;
    draftProducts: number;
    subtreeProducts: number;
    subtreePublishedProducts: number;
    children: number;
    descendants: number;
  };
  recentProducts: Array<{
    id: string;
    name: string;
    status: string;
    isPublished: boolean;
    basePrice: string;
    currencyCode: string;
    sellerType: string;
    createdAt: string;
  }>;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

/**
 * Descendant→ancestor closure, seeded with each node as its own ancestor at
 * hops 0. Seeding from every node (rather than from roots) also covers orphans —
 * rows whose parent was deleted — which would otherwise disappear from the tree
 * and silently take their product counts with them.
 */
const closure = sql`
  with recursive closure as (
    select id as descendant_id, id as ancestor_id, 0 as hops from categories
    union all
    select cl.descendant_id, c.parent_id, cl.hops + 1
    from closure cl
    join categories c on c.id = cl.ancestor_id
    where c.parent_id is not null and cl.hops < ${MAX_DEPTH}
  )
`;

export async function categorySummary(db: DB): Promise<CategorySummary> {
  const result = await db.execute(sql`
    ${closure},
    depth as (
      select descendant_id, max(hops)::int as depth from closure group by descendant_id
    )
    select
      (select count(*) from categories)::int as total,
      (select count(*) from categories where is_active)::int as active,
      (select count(*) from categories where not is_active)::int as inactive,
      (select count(*) from categories where parent_id is null)::int as roots,
      (select count(*) from categories where parent_id is not null)::int as children,
      (select coalesce(max(depth), 0) from depth)::int as max_depth,
      (select count(*) from categories c
        where exists (select 1 from products p where p.category_id = c.id))::int as with_products,
      (select count(*) from categories c
        where not exists (select 1 from products p where p.category_id = c.id))::int as empty,
      (select count(*) from products)::int as total_products,
      (select count(*) from products where is_published)::int as published_products,
      (select count(*) from categories
        where created_at >= now() - interval '30 days')::int as new_last_30
  `);

  const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    inactive: Number(row.inactive ?? 0),
    roots: Number(row.roots ?? 0),
    children: Number(row.children ?? 0),
    maxDepth: Number(row.max_depth ?? 0),
    withProducts: Number(row.with_products ?? 0),
    empty: Number(row.empty ?? 0),
    totalProducts: Number(row.total_products ?? 0),
    publishedProducts: Number(row.published_products ?? 0),
    newLast30Days: Number(row.new_last_30 ?? 0),
  };
}

export async function listCategories(
  db: DB,
  query: CategoryListQuery,
): Promise<{ items: CategoryListRow[]; page: number; pageSize: number; total: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));

  const filters = [sql`1 = 1`];
  if (query.q) {
    filters.push(
      sql`(c.name ilike ${`%${query.q}%`} or coalesce(c.name_ar, '') ilike ${`%${query.q}%`}
        or coalesce(c.name_fr, '') ilike ${`%${query.q}%`} or c.slug ilike ${`%${query.q}%`})`,
    );
  }
  if (query.status === 'active') filters.push(sql`c.is_active`);
  if (query.status === 'inactive') filters.push(sql`not c.is_active`);
  if (query.level === 'root') filters.push(sql`c.parent_id is null`);
  if (query.level === 'child') filters.push(sql`c.parent_id is not null`);
  if (query.level === 'leaf') {
    filters.push(sql`not exists (select 1 from categories ch where ch.parent_id = c.id)`);
  }
  if (query.parentId) filters.push(sql`c.parent_id = ${query.parentId}`);
  if (query.hasProducts === 'yes') {
    filters.push(sql`exists (select 1 from products p where p.category_id = c.id)`);
  }
  if (query.hasProducts === 'no') {
    filters.push(sql`not exists (select 1 from products p where p.category_id = c.id)`);
  }
  const where = sql.join(filters, sql` and `);

  const [countResult, listResult] = await Promise.all([
    db.execute(sql`select count(*)::int as total from categories c where ${where}`),
    db.execute(sql`
      ${closure},
      path as (
        select cl.descendant_id,
               string_agg(a.name, ' / ' order by cl.hops desc) as path,
               max(cl.hops)::int as depth
        from closure cl
        join categories a on a.id = cl.ancestor_id
        group by cl.descendant_id
      )
      select
        c.id, c.name, c.name_ar, c.name_fr, c.slug, c.is_active, c.sort_order, c.created_at,
        c.parent_id, par.name as parent_name,
        coalesce(p.path, c.name) as path,
        coalesce(p.depth, 0) as depth,
        (select count(*) from categories ch where ch.parent_id = c.id)::int as children_count,
        (select count(*) from products pr where pr.category_id = c.id)::int as product_count,
        (select count(*) from products pr where pr.category_id = c.id and pr.is_published)::int
          as published_product_count,
        (select count(*) from products pr
          where pr.category_id in (select descendant_id from closure where ancestor_id = c.id))::int
          as subtree_product_count
      from categories c
      left join path p on p.descendant_id = c.id
      left join categories par on par.id = c.parent_id
      where ${where}
      order by coalesce(p.path, c.name), c.sort_order, c.name
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `),
  ]);

  return {
    items: rowsOf<Record<string, unknown>>(listResult).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      nameAr: (r.name_ar as string | null) ?? null,
      nameFr: (r.name_fr as string | null) ?? null,
      slug: r.slug as string,
      isActive: Boolean(r.is_active),
      sortOrder: Number(r.sort_order ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
      parentId: (r.parent_id as string | null) ?? null,
      parentName: (r.parent_name as string | null) ?? null,
      depth: Number(r.depth ?? 0),
      path: String(r.path ?? ''),
      childrenCount: Number(r.children_count ?? 0),
      productCount: Number(r.product_count ?? 0),
      publishedProductCount: Number(r.published_product_count ?? 0),
      subtreeProductCount: Number(r.subtree_product_count ?? 0),
    })),
    page,
    pageSize,
    total: Number(rowsOf<{ total: number }>(countResult)[0]?.total ?? 0),
  };
}

export async function getCategoryDetail(db: DB, id: string): Promise<CategoryDetail> {
  const head = await db.execute(sql`
    ${closure},
    path as (
      select cl.descendant_id,
             string_agg(a.name, ' / ' order by cl.hops desc) as path,
             max(cl.hops)::int as depth
      from closure cl
      join categories a on a.id = cl.ancestor_id
      group by cl.descendant_id
    )
    select c.*, par.name as parent_name,
           coalesce(p.path, c.name) as path, coalesce(p.depth, 0) as depth
    from categories c
    left join path p on p.descendant_id = c.id
    left join categories par on par.id = c.parent_id
    where c.id = ${id}
    limit 1
  `);

  const category = rowsOf<Record<string, unknown>>(head)[0];
  if (!category) throw ApiError.notFound('Category not found');

  const [ancestors, children, metrics, products] = await Promise.all([
    db.execute(sql`
      ${closure},
      own as (select max(hops)::int as depth from closure where descendant_id = ${id})
      select a.id, a.name, (own.depth - cl.hops)::int as depth
      from closure cl
      join categories a on a.id = cl.ancestor_id
      cross join own
      where cl.descendant_id = ${id} and cl.hops > 0
      order by cl.hops desc
    `),
    db.execute(sql`
      select ch.id, ch.name, ch.is_active, ch.sort_order,
        (select count(*) from products pr where pr.category_id = ch.id)::int as product_count,
        (select count(*) from categories g where g.parent_id = ch.id)::int as children_count
      from categories ch
      where ch.parent_id = ${id}
      order by ch.sort_order, ch.name
    `),
    db.execute(sql`
      ${closure}
      select
        (select count(*) from products pr where pr.category_id = ${id})::int as direct_products,
        (select count(*) from products pr where pr.category_id = ${id} and pr.is_published)::int
          as published_products,
        (select count(*) from products pr where pr.category_id = ${id}
          and pr.status::text = 'DRAFT')::int as draft_products,
        (select count(*) from products pr
          where pr.category_id in (select descendant_id from closure where ancestor_id = ${id}))::int
          as subtree_products,
        (select count(*) from products pr
          where pr.is_published
            and pr.category_id in (select descendant_id from closure where ancestor_id = ${id}))::int
          as subtree_published_products,
        (select count(*) from categories ch where ch.parent_id = ${id})::int as children,
        (select count(*) from closure where ancestor_id = ${id} and hops > 0)::int as descendants
    `),
    db.execute(sql`
      select id, name, status, is_published, base_price, currency_code, seller_type, created_at
      from products
      where category_id = ${id}
      order by created_at desc, id
      limit 5
    `),
  ]);

  const m = rowsOf<Record<string, unknown>>(metrics)[0] ?? {};

  return {
    category: {
      id: category.id as string,
      name: category.name as string,
      nameAr: (category.name_ar as string | null) ?? null,
      nameFr: (category.name_fr as string | null) ?? null,
      slug: category.slug as string,
      description: (category.description as string | null) ?? null,
      icon: (category.icon as string | null) ?? null,
      isActive: Boolean(category.is_active),
      sortOrder: Number(category.sort_order ?? 0),
      parentId: (category.parent_id as string | null) ?? null,
      parentName: (category.parent_name as string | null) ?? null,
      depth: Number(category.depth ?? 0),
      path: String(category.path ?? ''),
      createdAt: new Date(category.created_at as string).toISOString(),
      updatedAt: new Date(category.updated_at as string).toISOString(),
    },
    ancestors: rowsOf<Record<string, unknown>>(ancestors).map((a) => ({
      id: a.id as string,
      name: a.name as string,
      depth: Number(a.depth ?? 0),
    })),
    children: rowsOf<Record<string, unknown>>(children).map((ch) => ({
      id: ch.id as string,
      name: ch.name as string,
      isActive: Boolean(ch.is_active),
      sortOrder: Number(ch.sort_order ?? 0),
      productCount: Number(ch.product_count ?? 0),
      childrenCount: Number(ch.children_count ?? 0),
    })),
    metrics: {
      directProducts: Number(m.direct_products ?? 0),
      publishedProducts: Number(m.published_products ?? 0),
      draftProducts: Number(m.draft_products ?? 0),
      subtreeProducts: Number(m.subtree_products ?? 0),
      subtreePublishedProducts: Number(m.subtree_published_products ?? 0),
      children: Number(m.children ?? 0),
      descendants: Number(m.descendants ?? 0),
    },
    recentProducts: rowsOf<Record<string, unknown>>(products).map((p) => ({
      id: p.id as string,
      name: p.name as string,
      status: String(p.status),
      isPublished: Boolean(p.is_published),
      basePrice: String(p.base_price),
      currencyCode: String(p.currency_code),
      sellerType: String(p.seller_type),
      createdAt: new Date(p.created_at as string).toISOString(),
    })),
  };
}

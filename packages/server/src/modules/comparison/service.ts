import { eq, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { categories } from '../../db/schema/products.js';

export interface PriceComparisonQuery {
  query?: string;
  categoryId?: string;
  countryId?: string;
  currencyCode?: string;
  /** Only return groups backed by 2+ distinct sellers — i.e. an actual comparison. */
  comparableOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export type AvailabilityBand = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

export interface ComparisonOffer {
  productId: string;
  productSlug: string;
  name: string;
  currencyCode: string;
  basePrice: string;
  moq: number;
  unit: string;
  availability: AvailabilityBand;
  seller: {
    id: string | null;
    type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
    name: string | null;
    slug: string | null;
    verified: boolean;
    countryId: string | null;
    logoUrl: string | null;
  };
  isLowestPrice: boolean;
  priceDeltaFromLowest: string;
}

export interface ComparisonGroup {
  /** Stable identity of the compared item, already scoped to one currency. */
  key: string;
  matchedBy: 'BARCODE' | 'NAME';
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  brand: string | null;
  barcode: string | null;
  categoryId: string;
  categoryName: string | null;
  categoryNameAr: string | null;
  currencyCode: string;
  offerCount: number;
  sellerCount: number;
  lowestPrice: string;
  highestPrice: string;
  priceSpread: string;
  offers: ComparisonOffer[];
}

const MAX_PAGE_SIZE = 50;
// Upper bound on offers scanned before grouping. Comparison groups are tiny
// (a handful of sellers per item) so this is far above any real catalogue page.
const MAX_OFFERS_SCANNED = 2000;

/**
 * Coarse availability only. Exact on-hand quantities are seller-private — the
 * inventory module gates them behind `inventory:read` — so this public surface
 * exposes a stock band derived from stock vs the low-stock threshold instead of
 * the raw number.
 */
const AVAILABILITY_SQL = sql`case
  when inv.quantity is null then 'UNKNOWN'
  when (inv.quantity - inv.reserved_quantity) <= 0 then 'OUT_OF_STOCK'
  when (inv.quantity - inv.reserved_quantity) <= inv.low_stock_threshold then 'LOW_STOCK'
  else 'IN_STOCK'
end`;

/**
 * Two offers are comparable when they identify the same real-world item. A
 * shared barcode (EAN/GTIN) is the only globally-scoped identifier in the
 * schema — `sku` is per-seller and can never join offers across sellers. Without
 * a barcode we fall back to a whitespace/case-normalized name. Currency is part
 * of the final grouping key so prices are never shown as directly comparable
 * across currencies.
 */
const GROUP_KEY_SQL = sql`case
  when p.barcode is not null and p.barcode <> '' then 'BARCODE:' || p.barcode
  else 'NAME:' || lower(trim(regexp_replace(p.name, '\\s+', ' ', 'g')))
end`;

interface OfferRow {
  group_key: string;
  matched_by: 'BARCODE' | 'NAME';
  product_id: string;
  product_slug: string;
  name: string;
  name_ar: string | null;
  name_fr: string | null;
  brand: string | null;
  barcode: string | null;
  category_id: string;
  category_name: string | null;
  category_name_ar: string | null;
  currency_code: string;
  base_price: string;
  moq: number;
  unit: string;
  availability: string;
  seller_id: string | null;
  seller_type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY';
  seller_name: string | null;
  seller_slug: string | null;
  seller_verified: boolean | null;
  seller_country_id: string | null;
  seller_logo_url: string | null;
}

export async function comparePrices(db: DB, query: PriceComparisonQuery) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 10));
  const comparableOnly = query.comparableOnly ?? true;

  const conditions: ReturnType<typeof sql>[] = [
    sql`p.is_published = true`,
    sql`p.status = 'ACTIVE'`,
  ];
  const q = query.query?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(sql`(
      p.name ilike ${like}
      or p.name_ar ilike ${like}
      or p.name_fr ilike ${like}
      or p.brand ilike ${like}
      or p.barcode ilike ${like}
      or p.description ilike ${like}
    )`);
  }
  if (query.categoryId) conditions.push(sql`p.category_id = ${query.categoryId}`);
  if (query.countryId) conditions.push(sql`p.country_id = ${query.countryId}`);
  if (query.currencyCode) conditions.push(sql`upper(p.currency_code) = ${query.currencyCode.toUpperCase()}`);

  const where = sql`${sql.join(conditions, sql` and `)}`;

  // One row per offer, enriched with seller identity and stock band, so
  // regrouping happens in TypeScript where the per-group price ranking is
  // computed. The seller joins are type-guarded: only the matching entity table
  // contributes a value for a given seller type.
  const result = (await db.execute(sql`
    select
      ${GROUP_KEY_SQL} as group_key,
      case when p.barcode is not null and p.barcode <> '' then 'BARCODE' else 'NAME' end as matched_by,
      p.id as product_id,
      p.slug as product_slug,
      p.name as name,
      p.name_ar as name_ar,
      p.name_fr as name_fr,
      p.brand as brand,
      p.barcode as barcode,
      p.category_id as category_id,
      c.name as category_name,
      c.name_ar as category_name_ar,
      upper(p.currency_code) as currency_code,
      p.base_price::text as base_price,
      p.moq as moq,
      p.unit as unit,
      ${AVAILABILITY_SQL} as availability,
      p.seller_id as seller_id,
      p.seller_type as seller_type,
      coalesce(s.company_name, m.store_name, co.legal_name) as seller_name,
      coalesce(s.slug, m.slug, co.slug) as seller_slug,
      coalesce(s.verified, m.verified, co.verified, false) as seller_verified,
      coalesce(s.country_id, m.country_id, co.country_id) as seller_country_id,
      coalesce(s.logo_url, m.logo_url, co.logo_url) as seller_logo_url
    from products p
    left join categories c on c.id = p.category_id
    left join suppliers s on s.id = p.seller_id and p.seller_type = 'SUPPLIER'
    left join merchants m on m.id = p.seller_id and p.seller_type = 'MERCHANT'
    left join companies co on co.id = p.seller_id and p.seller_type = 'COMPANY'
    left join inventory_items inv on inv.product_id = p.id and inv.product_variant_id is null
    where ${where}
    order by p.base_price asc
    limit ${MAX_OFFERS_SCANNED}
  `)) as unknown as { rows: OfferRow[] };

  const groupsByKey = new Map<string, ComparisonGroup>();

  for (const r of result.rows) {
    // Currency is part of the key: equal numbers in different currencies are
    // not comparable without an explicit conversion, which is out of scope.
    const key = `${r.group_key}::${r.currency_code}`;
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        matchedBy: r.matched_by,
        name: r.name,
        nameAr: r.name_ar,
        nameFr: r.name_fr,
        brand: r.brand,
        barcode: r.barcode,
        categoryId: r.category_id,
        categoryName: r.category_name,
        categoryNameAr: r.category_name_ar,
        currencyCode: r.currency_code,
        offerCount: 0,
        sellerCount: 0,
        lowestPrice: r.base_price,
        highestPrice: r.base_price,
        priceSpread: '0',
        offers: [],
      };
      groupsByKey.set(key, group);
    }
    group.offers.push({
      productId: r.product_id,
      productSlug: r.product_slug,
      name: r.name,
      currencyCode: r.currency_code,
      basePrice: r.base_price,
      moq: r.moq,
      unit: r.unit,
      availability: (r.availability as AvailabilityBand) ?? 'UNKNOWN',
      seller: {
        id: r.seller_id,
        type: r.seller_type,
        name: r.seller_name,
        slug: r.seller_slug,
        verified: Boolean(r.seller_verified),
        countryId: r.seller_country_id,
        logoUrl: r.seller_logo_url,
      },
      isLowestPrice: false,
      priceDeltaFromLowest: '0',
    });
  }

  for (const group of groupsByKey.values()) {
    group.offers.sort((a, b) => Number(a.basePrice) - Number(b.basePrice));
    const prices = group.offers.map((o) => Number(o.basePrice));
    const lowest = Math.min(...prices);
    const highest = Math.max(...prices);
    group.offerCount = group.offers.length;
    group.sellerCount = new Set(group.offers.map((o) => o.seller.id ?? o.productId)).size;
    group.lowestPrice = lowest.toFixed(4);
    group.highestPrice = highest.toFixed(4);
    group.priceSpread = (highest - lowest).toFixed(4);
    for (const offer of group.offers) {
      offer.isLowestPrice = Number(offer.basePrice) === lowest;
      offer.priceDeltaFromLowest = (Number(offer.basePrice) - lowest).toFixed(4);
    }
  }

  let groups = [...groupsByKey.values()];
  if (comparableOnly) groups = groups.filter((g) => g.sellerCount >= 2);
  // Widest seller choice first, then the biggest price spread.
  groups.sort((a, b) => b.sellerCount - a.sellerCount || Number(b.priceSpread) - Number(a.priceSpread));

  const total = groups.length;
  const items = groups.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  return { items, pagination: { page, pageSize, total } };
}

export async function listComparisonCategories(db: DB) {
  return db
    .select({ id: categories.id, name: categories.name, nameAr: categories.nameAr })
    .from(categories)
    .where(eq(categories.isActive, true));
}

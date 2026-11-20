import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';

/**
 * M2.5-TX-SELLER-ATTRIBUTION — counts a seller's transactions from the source
 * that actually knows who sold what, instead of the single `transactions.sellerId`.
 *
 * A `transactions` row is ONE buyer payment per parent order. A multi-seller
 * basket is stored on one row attributed to a single seller (`orders/service.ts`
 * writes `soleSeller ?? firstProduct.sellerId`), so counting that column both
 * over-credits the named seller with the whole basket and hides every other
 * seller. The per-seller truth lives in `seller_orders` (one suborder per seller),
 * so the count is derived from there.
 *
 * Rules (per seller id):
 *  - suborders: every `seller_orders` row for that seller counts once. Its
 *    "successful" state is the PARENT order's payment status — one payment, so a
 *    suborder is paid iff its parent order is paid.
 *  - legacy fallback: an `orders` row counts once ONLY when it has NO suborder at
 *    all (pre-0037 orders). This is what keeps old single-seller history alive.
 *    The `NOT EXISTS` guard is what prevents double counting: a post-0037 order
 *    (which always has suborders) is counted through its suborders and never
 *    through the parent.
 *  - a legacy MULTI-seller order has no suborders and a null `orders.seller_id`,
 *    so it matches no seller id and is simply never counted — it is NOT dumped on
 *    the first seller.
 *
 * Read-only: it writes nothing. Scoped strictly to `sellerIds`, so one seller's
 * activity can never leak into another's count.
 */
export interface SellerTransactionCounts {
  total: number;
  successful: number;
}

export async function countSellerTransactions(
  db: DB,
  sellerIds: string[],
): Promise<SellerTransactionCounts> {
  // Deduplicate and drop blank/invalid ids so a repeated or empty input can
  // never double count or widen the scope.
  const ids = [...new Set(sellerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return { total: 0, successful: 0 };

  const idsSql = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const rows = await db.execute<{ total: number; successful: number }>(sql`
    with suborder_stats as (
      select
        so.seller_id as seller_id,
        count(*)::int as total,
        count(*) filter (where o.payment_status = 'PAID')::int as successful
      from seller_orders so
      join orders o on o.id = so.parent_order_id
      where so.seller_id in (${idsSql})
      group by so.seller_id
    ),
    legacy_stats as (
      select
        o.seller_id as seller_id,
        count(*)::int as total,
        count(*) filter (where o.payment_status = 'PAID')::int as successful
      from orders o
      where o.seller_id in (${idsSql})
        and not exists (select 1 from seller_orders so where so.parent_order_id = o.id)
      group by o.seller_id
    )
    select
      coalesce(sum(total), 0)::int as total,
      coalesce(sum(successful), 0)::int as successful
    from (
      select total, successful from suborder_stats
      union all
      select total, successful from legacy_stats
    ) combined
  `) as never;
  const r = rows as unknown as { rows: { total: number | string; successful: number | string }[] };
  const row = r.rows?.[0];
  return {
    total: Number(row?.total ?? 0),
    successful: Number(row?.successful ?? 0),
  };
}

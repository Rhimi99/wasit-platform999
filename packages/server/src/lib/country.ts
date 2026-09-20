import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';

/**
 * Resolves the country a trade belongs to, without hardcoding any country code.
 *
 * Precedence: the selling entity's country (supplier/merchant/company), then the
 * buyer's profile country. Returns the ISO-2 `countries.code` alongside the row id
 * so callers can both key policies by id and compare by code (e.g. commission
 * conditions that are stored as country codes).
 */
export interface ResolvedCountry {
  id: string;
  code: string;
  isActive: boolean;
}

export async function resolveOrderCountry(db: DB, orderId: string): Promise<ResolvedCountry | null> {
  const rows = await db.execute<{ id: string; code: string; is_active: boolean }>(sql`
    with party as (
      select buyer_id as user_id, seller_id from orders where id = ${orderId}
    ),
    seller_entity as (
      select country_id from suppliers where id in (select seller_id from party)
      union all
      select country_id from merchants where id in (select seller_id from party)
      union all
      select country_id from companies where id in (select seller_id from party)
    ),
    candidates as (
      select country_id from seller_entity where country_id is not null
      union all
      select p.country_id from profiles p
        join party on party.user_id = p.user_id
        where p.country_id is not null
    )
    select c.id, c.code, c.is_active
    from candidates
    join countries c on c.id = candidates.country_id
    limit 1
  `) as never;
  const r = rows as unknown as { rows: { id: string; code: string; is_active: boolean }[] };
  const row = r.rows?.[0];
  if (!row) return null;
  return { id: row.id, code: row.code, isActive: row.is_active };
}

/** Looks a country up by ISO-2 code (used when a caller already has a code). */
export async function countryByCode(db: DB, code: string): Promise<ResolvedCountry | null> {
  const rows = await db.execute<{ id: string; code: string; is_active: boolean }>(sql`
    select id, code, is_active from countries where upper(code) = upper(${code}) limit 1
  `) as never;
  const r = rows as unknown as { rows: { id: string; code: string; is_active: boolean }[] };
  const row = r.rows?.[0];
  if (!row) return null;
  return { id: row.id, code: row.code, isActive: row.is_active };
}
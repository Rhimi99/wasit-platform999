/**
 * Reports the plan and execution time of the platform's hot queries.
 *
 *   npx tsx src/scripts/explain-hot-queries.ts            # plans on current data
 *   npx tsx src/scripts/explain-hot-queries.ts --synth=20000
 *
 * The seeded database is tiny, so at that size Postgres legitimately prefers a
 * sequential scan and the plan proves nothing about the indexes. `--synth=N`
 * inserts N synthetic rows *inside a transaction that is always rolled back*,
 * EXPLAINs against that realistic cardinality, and leaves the database exactly
 * as it found it. No reset, no drop, no leftover rows.
 */
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';

interface HotQuery {
  name: string;
  /** Runs as-is; the `--synth` fixture only has to satisfy its shape. */
  sql: string;
}

const HOT_QUERIES: HotQuery[] = [
  {
    name: 'products.public_list',
    sql: `select id, name, base_price from products
          where is_published = true and status = 'ACTIVE'
          order by created_at desc limit 20`,
  },
  {
    name: 'products.public_by_category',
    sql: `select id, name from products
          where is_published = true and status = 'ACTIVE' and category_id = 'cat-1'
          order by created_at desc limit 20`,
  },
  {
    name: 'orders.by_buyer',
    sql: `select id, status from orders where buyer_id = 'buyer-1' order by created_at desc limit 20`,
  },
  {
    name: 'orders.by_seller',
    sql: `select id, status from orders where seller_id = 'seller-1' order by created_at desc limit 20`,
  },
  {
    name: 'notifications.list',
    sql: `select id, title from notifications where user_id = 'user-1' order by created_at desc limit 20`,
  },
  {
    name: 'notifications.unread_count',
    sql: `select count(*) from notifications where user_id = 'user-1' and read_at is null`,
  },
  {
    name: 'messages.by_thread',
    sql: `select id, body from messages where thread_id = 'thread-1' order by created_at asc limit 50`,
  },
  {
    name: 'invoices.pending_due',
    sql: `select id from invoices where status = 'PENDING' order by due_at limit 50`,
  },
  {
    name: 'audit.recent',
    sql: `select id, action from audit_logs order by created_at desc limit 100`,
  },
];

interface PlanSummary {
  nodeTypes: string[];
  /** Index names the planner actually touched. */
  indexes: string[];
  execMs: number;
}

function summarisePlan(plan: Record<string, unknown>): PlanSummary {
  const nodeTypes: string[] = [];
  const indexes: string[] = [];
  const walk = (n: Record<string, unknown>): void => {
    nodeTypes.push(String(n['Node Type']));
    if (typeof n['Index Name'] === 'string') indexes.push(n['Index Name']);
    for (const child of (n['Plans'] ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(plan);
  return { nodeTypes, indexes, execMs: 0 };
}

async function explain(name: string, query: string): Promise<PlanSummary> {
  const res = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`));
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const plan = (rows[0] as { 'QUERY PLAN': Array<Record<string, unknown>> })['QUERY PLAN'][0];
  const summary = summarisePlan(plan['Plan'] as Record<string, unknown>);
  summary.execMs = Number(plan['Execution Time']);
  return summary;
}

/** Inserts synthetic rows for one "hot" key so the planner sees real cardinality. */
async function synthesise(rows: number): Promise<void> {
  await db.execute(sql.raw(`
    insert into products (id, name, slug, sku, seller_id, seller_type, category_id, base_price, status, is_published, created_at, updated_at)
    select 'synth-p-' || g, 'Synthetic ' || g, 'synth-slug-' || g, 'SYN-' || g, 'synth-seller', 'SUPPLIER', 'cat-1',
           (g % 500)::numeric, 'ACTIVE', true, now() - (g || ' seconds')::interval, now()
    from generate_series(1, ${rows}) g
  `));
  await db.execute(sql.raw(`
    insert into orders (id, order_number, buyer_id, buyer_type, seller_id, seller_type, items_total, commission, grand_total, status, created_at, updated_at)
    select 'synth-o-' || g, 'SYN-ORD-' || g, 'buyer-1', 'CUSTOMER', 'seller-1', 'SUPPLIER',
           '100'::numeric, '4'::numeric, '104'::numeric, 'PENDING', now() - (g || ' seconds')::interval, now()
    from generate_series(1, ${rows}) g
  `));
  await db.execute(sql.raw(`
    insert into notifications (id, user_id, type, title, read_at, created_at)
    select 'synth-n-' || g, 'user-1', 'SYSTEM', 'Notification ' || g,
           case when g % 10 = 0 then null else now() end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${rows}) g
  `));
  await db.execute(sql.raw(`
    insert into threads (id, subject, participant_ids, created_at, updated_at)
    select 'synth-t-' || g, 'Thread ' || g, '["user-1","user-2"]'::jsonb, now(), now()
    from generate_series(1, 50) g
  `));
  await db.execute(sql.raw(`
    insert into messages (id, thread_id, sender_id, body, created_at)
    select 'synth-m-' || g, 'thread-1', 'user-1', 'Message ' || g, now() - (g || ' seconds')::interval
    from generate_series(1, ${rows}) g
  `));
  await db.execute(sql.raw(`
    insert into invoices (id, subscription_id, invoice_number, amount, currency_code, status, due_at, created_at)
    select 'synth-i-' || g, 'synth-sub', 'SYN-INV-' || g, '10'::numeric, 'TND', 'PENDING',
           now() + (g || ' seconds')::interval, now() from generate_series(1, ${rows}) g
  `));
  await db.execute(sql.raw(`
    insert into audit_logs (id, action, entity_type, created_at)
    select 'synth-a-' || g, 'SYNTH', 'TEST', now() - (g || ' seconds')::interval
    from generate_series(1, ${rows}) g
  `));
}

async function main(): Promise<void> {
  const synthArg = process.argv.find((a) => a.startsWith('--synth='));
  const synthRows = synthArg ? Number(synthArg.split('=')[1]) : 0;

  if (synthRows > 0) {
    console.log(`Synthesising ${synthRows} rows per table inside a rolled-back transaction...\n`);
    await db.execute(sql.raw('BEGIN'));
    try {
      await synthesise(synthRows);
      await db.execute(sql.raw('ANALYZE'));
      await run(synthRows);
    } finally {
      // Always undo, whatever happened above.
      await db.execute(sql.raw('ROLLBACK'));
    }
    console.log('\nTransaction rolled back — the database is unchanged.');
    return;
  }

  await run(0);
}

async function run(synthRows: number): Promise<void> {
  console.log('query                          execMs   index(es)');
  for (const q of HOT_QUERIES) {
    const summary = await explain(q.name, q.sql);
    const idx = summary.indexes.length > 0 ? summary.indexes.join(', ') : '(none — sequential scan)';
    console.log(`${q.name.padEnd(30)} ${summary.execMs.toFixed(3).padStart(7)}   ${idx}`);
  }
  if (synthRows === 0) {
    console.log('\nNote: the seeded dataset is tiny, so sequential scans are expected.');
    console.log('Re-run with --synth=20000 to see the plans at realistic cardinality.');
  }
}

await main();
await closeDb();
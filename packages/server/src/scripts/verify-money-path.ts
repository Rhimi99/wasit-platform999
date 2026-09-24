/**
 * Read-only audit of the money-path invariants on the live database.
 *
 *   npx tsx src/scripts/verify-money-path.ts
 *
 * Answers the questions a fix like this one has to prove before it is trusted:
 *  - are there `PAID` transactions whose ledger entries are still `PENDING`
 *    (expected after the fix: payment is not settlement)?
 *  - are there rows stuck in the OLD, pre-fix shape — ledger `SETTLED` with no
 *    settlement evidence behind it, i.e. written by the removed
 *    payment-equals-settlement path?
 *  - which orders show `SETTLED` and can they be tied to a `SETTLEMENT.CONFIRMED`
 *    audit entry?
 *
 * It only SELECTs. It never writes, resets, drops or migrates anything, so it is
 * safe to run against any environment. Exits non-zero when it finds rows that
 * violate the invariants, so CI or an operator can gate on it.
 */
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';

interface CountRow {
  count: string;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as CountRow[];
  return Number(rows[0]?.count ?? 0);
}

const findings: { label: string; count: number; detail: string }[] = [];

// 1. Ledger entries marked SETTLED whose transaction was never paid. Settlement
//    without a payment is impossible, so any such row is bad data.
const settledWithoutPaid = await count(sql`
  select count(*)::text as count
  from transaction_ledger l
  join transactions t on t.id = l.transaction_id
  where l.status = 'SETTLED' and t.status <> 'PAID'
`);
findings.push({
  label: 'SETTLED ledger entries on a non-PAID transaction',
  count: settledWithoutPaid,
  detail: 'Settlement requires a confirmed payment; these rows are impossible.',
});

// 2. Orders claiming SETTLED with no SETTLEMENT.CONFIRMED audit evidence. This
//    is the fingerprint of the old payment-equals-settlement writer.
const settledWithoutEvidence = await count(sql`
  select count(*)::text as count
  from orders o
  where o.settlement_status = 'SETTLED'
    and not exists (
      select 1 from audit_logs a
      where a.entity_type = 'ORDER' and a.entity_id = o.id and a.action = 'SETTLEMENT.CONFIRMED'
    )
`);
findings.push({
  label: 'Orders SETTLED without SETTLEMENT.CONFIRMED audit evidence',
  count: settledWithoutEvidence,
  detail: 'Legacy rows written before settlement was gated on real evidence.',
});

// 3. Informational: the expected post-fix steady state — payments confirmed but
//    not yet settled. A non-zero number here is correct, not a failure.
const paidNotSettled = await count(sql`
  select count(distinct l.transaction_id)::text as count
  from transaction_ledger l
  join transactions t on t.id = l.transaction_id
  where t.status = 'PAID' and l.status = 'PENDING'
`);

// 4. Informational: transactions confirmed paid AND fully settled, with evidence.
const settledWithEvidence = await count(sql`
  select count(distinct l.transaction_id)::text as count
  from transaction_ledger l
  join transactions t on t.id = l.transaction_id
  where t.status = 'PAID' and l.status = 'SETTLED'
`);

console.log('Money-path invariant audit (read-only)');
console.log('--------------------------------------');
for (const f of findings) {
  const mark = f.count === 0 ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${f.label}: ${f.count}`);
  if (f.count > 0) console.log(`     ${f.detail}`);
}
console.log(`INFO  Transactions PAID but not yet SETTLED: ${paidNotSettled} (expected)`);
console.log(`INFO  Transactions with SETTLED ledger entries: ${settledWithEvidence}`);

await closeDb();

const violations = findings.reduce((acc, f) => acc + f.count, 0);
process.exit(violations === 0 ? 0 : 1);

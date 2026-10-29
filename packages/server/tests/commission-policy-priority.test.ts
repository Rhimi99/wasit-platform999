import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import type { DB } from '../src/db/client.js';
import { commissionPolicies } from '../src/db/schema/engine.js';
import { resolveCommission } from '../src/lib/commission.js';

/**
 * Commission policy resolution order (money path).
 *
 * The engine's documented contract is "priority order, lowest number first": the
 * most specific policy an Admin writes carries a lower number and must win. This
 * exercises the real resolver against a real database with several active
 * policies at once — the situation the base-only seed never reaches.
 *
 * The suite only ever adds/removes its own rows; the seeded base policy is left
 * exactly as it was found.
 */

const BASE_PRIORITY = 1000;

function ctxFor(currencyCode: string, transactionValue: string) {
  return {
    accountType: 'CUSTOMER' as const,
    b2bB2c: 'B2C' as const,
    transactionValue,
    currencyCode,
  };
}

const createdIds: string[] = [];

async function addPolicy(over: {
  name: string;
  rate: string;
  sellerRate: string;
  buyerRate: string;
  priority: number;
  currency: string;
}): Promise<string> {
  const id = randomUUID();
  createdIds.push(id);
  await db.insert(commissionPolicies).values({
    id,
    name: over.name,
    policyType: 'BASE',
    rate: over.rate,
    sellerRate: over.sellerRate,
    buyerRate: over.buyerRate,
    // A currency condition keeps each policy isolated to its own test, so the
    // seeded 4% base (currency-agnostic) never competes with them.
    conditions: { currency: over.currency },
    priority: over.priority,
    isActive: true,
  });
  return id;
}

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(commissionPolicies).where(eq(commissionPolicies.id, id));
  }
  await closeDb();
});

describe('Commission policy priority resolution', () => {
  it('selects the lowest priority number when several policies match', async () => {
    // The exact "add a second policy" scenario the base-only seed cannot reach.
    // A low number (5) is the more specific policy and must win over a high
    // number (9000); the resolver must not fall through to the base.
    const low = await addPolicy({
      name: 'Specific 1% (priority 5)',
      rate: '0.01',
      sellerRate: '0.005',
      buyerRate: '0.005',
      priority: 5,
      currency: 'PRIOA',
    });
    const high = await addPolicy({
      name: 'Broad 9% (priority 9000)',
      rate: '0.09',
      sellerRate: '0.09',
      buyerRate: '0',
      priority: 9000,
      currency: 'PRIOA',
    });

    const b = await resolveCommission(db, ctxFor('PRIOA', '100.0000'));

    expect(b.policyId).toBe(low);
    expect(b.policyId).not.toBe(high);
    expect(b.totalRate).toBe('0.01');
    expect(b.totalAmount).toBe('1.0000');
    expect(b.sellerAmount).toBe('0.5000');
    expect(b.buyerAmount).toBe('0.5000');
  });

  it('picks the same policy regardless of insertion order (priority, not row order)', async () => {
    // Insert the high number FIRST so a query that forgot to order would pick it.
    const high = await addPolicy({
      name: 'Broad 9% (priority 9000)',
      rate: '0.09',
      sellerRate: '0.09',
      buyerRate: '0',
      priority: 9000,
      currency: 'PRIOB',
    });
    const low = await addPolicy({
      name: 'Specific 1% (priority 5)',
      rate: '0.01',
      sellerRate: '0.005',
      buyerRate: '0.005',
      priority: 5,
      currency: 'PRIOB',
    });

    const b = await resolveCommission(db, ctxFor('PRIOB', '100.0000'));

    expect(b.policyId).toBe(low);
    expect(b.policyId).not.toBe(high);
    expect(b.totalRate).toBe('0.01');
  });

  it('is deterministic when two policies share a priority', async () => {
    await addPolicy({
      name: 'Tie A',
      rate: '0.02',
      sellerRate: '0.01',
      buyerRate: '0.01',
      priority: 42,
      currency: 'PRIOC',
    });
    await addPolicy({
      name: 'Tie B',
      rate: '0.03',
      sellerRate: '0.015',
      buyerRate: '0.015',
      priority: 42,
      currency: 'PRIOC',
    });

    const first = await resolveCommission(db, ctxFor('PRIOC', '100.0000'));
    const second = await resolveCommission(db, ctxFor('PRIOC', '100.0000'));

    // The `id` tie-break makes the winner stable; without it the row order is
    // whatever Postgres returns, which is not a contract.
    expect(first.policyId).toBe(second.policyId);
  });

  it('fails closed when no active policy matches (never invents a rate)', async () => {
    // The seeded base policy is currency-agnostic, so the only way to reach "no
    // match" without disturbing shared state is to deactivate everything inside a
    // transaction that is rolled back by the thrown error. The services in this
    // codebase take a `DB` and accept a transaction via the `tx as unknown as DB`
    // cast, so this exercises the real resolver.
    await expect(
      db.transaction(async (tx) => {
        await tx.update(commissionPolicies).set({ isActive: false });
        await resolveCommission(tx as unknown as DB, ctxFor('TND', '100.0000'));
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'COMMISSION_POLICY_MISSING' });
  });

  it('ignores an inactive policy even when its priority is the lowest', async () => {
    const id = randomUUID();
    createdIds.push(id);
    await db.insert(commissionPolicies).values({
      id,
      name: 'Disabled but lowest',
      policyType: 'BASE',
      rate: '0.5',
      sellerRate: '0.5',
      buyerRate: '0',
      conditions: {},
      priority: 1,
      isActive: false,
    });

    // The disabled row has the lowest number and matches every currency; if the
    // engine dropped the `is_active` filter it would pick 50%. It must not: the
    // active base policy wins.
    const b = await resolveCommission(db, ctxFor('TND', '100.0000'));

    expect(b.policyId).not.toBe(id);
    expect(b.totalRate).toBe('0.04');
  });

  it('keeps the seeded base policy resolving at 4% (2% + 2%)', async () => {
    // Guards the frozen base model against the ordering change.
    const b = await resolveCommission(db, ctxFor('TND', '420.0000'));

    expect(b.totalRate).toBe('0.04');
    expect(b.totalAmount).toBe('16.8000');
    expect(b.sellerAmount).toBe('8.4000');
    expect(b.buyerAmount).toBe('8.4000');
    expect(b.policyName).toContain('4%');

    const base = await db
      .select()
      .from(commissionPolicies)
      .where(eq(commissionPolicies.policyType, 'BASE'))
      .orderBy(asc(commissionPolicies.priority));
    expect(base.some((p) => p.priority === BASE_PRIORITY && Number(p.rate) === 0.04)).toBe(true);
  });
});

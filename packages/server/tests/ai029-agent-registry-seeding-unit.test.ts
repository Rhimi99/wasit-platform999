import { describe, it, expect } from 'vitest';
import { AGENT_CATALOGUE, ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import { agentRegistry } from '../src/db/schema/agents.js';
import type { DB } from '../src/db/client.js';

/**
 * AI-02.9 — `ensureAgentRegistrySeeded` error handling (fix C, M1.7.1).
 *
 * These are UNIT specs with a hand-built mock, not PostgreSQL integration
 * tests: they pin the contract that the seeding loop relies on `ON CONFLICT
 * (key) DO NOTHING` and does NOT wrap the insert in a catch-all. In particular a
 * `23505` raised by a *different* unique constraint (e.g. the `id` primary key)
 * must surface, not be swallowed by a blanket SQLSTATE check.
 *
 * The mock mirrors the exact drizzle builder chain the implementation uses:
 *   db.insert(table).values(row).onConflictDoNothing({ target })
 */

interface Outcome {
  reject?: unknown;
}

function makeMockDb(outcomes: Outcome[]) {
  const calls: { key: string; target: unknown; row: Record<string, unknown> }[] = [];
  let i = 0;
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: (opts: { target: unknown }) => {
          calls.push({ key: row.key as string, target: opts.target, row });
          const outcome = outcomes[i++] ?? {};
          if (outcome.reject !== undefined) return Promise.reject(outcome.reject);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  return { db: db as unknown as DB, calls };
}

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`pg error ${code} on ${constraint}`), { code, constraint });
}

describe('AI-02.9 (unit) — atomic agent-registry seeding error handling', () => {
  it('resolves when the target key conflicts (ON CONFLICT handles it, no throw)', async () => {
    const { db, calls } = makeMockDb(AGENT_CATALOGUE.map(() => ({})));
    await expect(ensureAgentRegistrySeeded(db)).resolves.toBeUndefined();

    // One insert attempt per catalogue agent, conflict target = the key column.
    expect(calls.length).toBe(AGENT_CATALOGUE.length);
    expect(calls[0].target).toBe(agentRegistry.key);
    for (const call of calls) expect(call.target).toBe(agentRegistry.key);
  });

  it('does not create duplicate rows: each catalogue key is inserted exactly once', async () => {
    const { db, calls } = makeMockDb(AGENT_CATALOGUE.map(() => ({})));
    await ensureAgentRegistrySeeded(db);

    const insertedKeys = calls.map((c) => c.key).sort();
    const catalogueKeys = AGENT_CATALOGUE.map((a) => a.key).sort();
    expect(insertedKeys).toEqual(catalogueKeys);
    expect(new Set(insertedKeys).size).toBe(insertedKeys.length);
  });

  it('propagates a 23505 raised by a DIFFERENT unique constraint (not swallowed)', async () => {
    // The primary-key constraint, not the key index the ON CONFLICT targets.
    const { db, calls } = makeMockDb([{ reject: pgError('23505', 'agent_registry_pkey') }]);
    await expect(ensureAgentRegistrySeeded(db)).rejects.toMatchObject({
      code: '23505',
      constraint: 'agent_registry_pkey',
    });
    // It failed on the first insert and did not keep going.
    expect(calls.length).toBe(1);
  });

  it('propagates a non-23505 database error', async () => {
    const { db } = makeMockDb([{ reject: pgError('42P01', 'agent_registry') }]);
    await expect(ensureAgentRegistrySeeded(db)).rejects.toMatchObject({ code: '42P01' });
  });

  it('propagates a connection-style failure with no SQLSTATE code', async () => {
    const { db } = makeMockDb([{ reject: new Error('ECONNREFUSED 127.0.0.1:1') }]);
    await expect(ensureAgentRegistrySeeded(db)).rejects.toThrow(/ECONNREFUSED/);
  });
});

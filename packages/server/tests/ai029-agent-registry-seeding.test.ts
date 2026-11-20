import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/db/schema/index.js';
import { db, closeDb } from '../src/db/client.js';
import { agentRegistry } from '../src/db/schema/agents.js';
import { AGENT_CATALOGUE, ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';

/**
 * AI-02.9 — atomic, idempotent agent-registry seeding (fix C).
 *
 * Proves that `ensureAgentRegistrySeeded` never creates duplicate catalogue
 * rows, whether it is called twice in sequence, from two independent
 * connections at once, or when a key already exists. The guarantee comes from a
 * single `INSERT … ON CONFLICT (key) DO NOTHING` backed by the unique index
 * `agent_registry_key_idx` (migration 0029), not from a read-then-insert check.
 *
 * These specs exercise the real database. They require a migrated, disposable
 * test database (name ending in `_test`) supplied via `TEST_DATABASE_URL`.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

/** A second, independent connection pool — the same shape used by AI-02.3.2. */
const poolB = new pg.Pool({ connectionString: CONNECTION_STRING, max: 5 });
const dbB = drizzle(poolB, { schema });

const createdKeys: string[] = [];

async function catalogueRows() {
  return db.select().from(agentRegistry);
}

function countKey(rows: { key: string }[], key: string): number {
  return rows.filter((r) => r.key === key).length;
}

afterAll(async () => {
  // Remove only rows this spec inserted under a synthetic key; catalogue rows
  // are shared infrastructure and are never deleted here.
  for (const key of createdKeys) {
    await db.delete(agentRegistry).where(eq(agentRegistry.key, key));
  }
  await poolB.end();
  await closeDb();
});

describe('AI-02.9 — atomic agent-registry seeding', () => {
  it('seeds every catalogue agent exactly once when called twice in sequence', async () => {
    await ensureAgentRegistrySeeded(db);
    await ensureAgentRegistrySeeded(db);

    const rows = await catalogueRows();
    for (const def of AGENT_CATALOGUE) {
      expect(countKey(rows, def.key)).toBe(1);
    }
  });

  it('does not create duplicates when two independent connections seed concurrently', async () => {
    await Promise.all([
      ensureAgentRegistrySeeded(db),
      ensureAgentRegistrySeeded(dbB),
      ensureAgentRegistrySeeded(db),
      ensureAgentRegistrySeeded(dbB),
    ]);

    const rows = await catalogueRows();
    for (const def of AGENT_CATALOGUE) {
      expect(countKey(rows, def.key)).toBe(1);
    }
    // Distinct keys == total rows: no key is represented twice.
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves a pre-existing key untouched instead of creating a second copy', async () => {
    const key = AGENT_CATALOGUE[0].key;
    await ensureAgentRegistrySeeded(db);
    const before = await db.select().from(agentRegistry).where(eq(agentRegistry.key, key));
    expect(before.length).toBe(1);

    await ensureAgentRegistrySeeded(db);

    const after = await db.select().from(agentRegistry).where(eq(agentRegistry.key, key));
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before[0].id);
  });

  it('rejects a duplicate insert at the database level (unique index is active)', async () => {
    const key = `it-ai029-uniq-${Date.now()}`;
    createdKeys.push(key);
    await db.insert(agentRegistry).values({
      id: 'it-ai029-uniq-1',
      key,
      name: 'Duplicate probe',
      capabilities: [] as never,
      permissionsRequired: [] as never,
    });

    await expect(
      db.insert(agentRegistry).values({
        id: 'it-ai029-uniq-2',
        key,
        name: 'Duplicate probe 2',
        capabilities: [] as never,
        permissionsRequired: [] as never,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('propagates a non-unique database error instead of swallowing it', async () => {
    // A connection that can never be established is a real, non-23505 failure.
    // The seeding loop must surface it — a `catch` that swallowed every error
    // would hide this and silently report success.
    const badPool = new pg.Pool({
      connectionString: 'postgresql://wasit:wasit_dev_password@127.0.0.1:1/wasit_test',
      connectionTimeoutMillis: 2000,
    });
    const badDb = drizzle(badPool, { schema });
    try {
      await expect(ensureAgentRegistrySeeded(badDb)).rejects.toBeDefined();
    } finally {
      await badPool.end().catch(() => undefined);
    }
  });
});

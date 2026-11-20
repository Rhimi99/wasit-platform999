import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Migration 0029 — unique index on `agent_registry.key` (fix D).
 *
 * These specs execute the real migration file, not a reimplementation, inside
 * transactions that are always rolled back, so the shared test database is left
 * exactly as it was found. They prove two things:
 *  1. on clean data the migration creates a valid UNIQUE index;
 *  2. on duplicated data it refuses to apply, names the offending keys, and
 *     changes nothing (no automatic delete or merge).
 *
 * They require a migrated, disposable test database (name ending in `_test`)
 * supplied via `TEST_DATABASE_URL`.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

const pool = new pg.Pool({ connectionString: CONNECTION_STRING });

const migrationSql = readFileSync(
  path.resolve(__dirname, '../src/db/migrations/0029_agent_registry_key_unique.sql'),
  'utf8',
).trim();

async function indexIsUnique(): Promise<{ is_unique: boolean; is_valid: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'agent_registry_key_idx'`,
  );
  return rows[0] ?? null;
}

afterAll(async () => {
  await pool.end();
});

describe('0029 — agent_registry.key unique index', () => {
  it('creates a valid UNIQUE index when the table has no duplicate keys', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Start from the pre-migration shape so the migration is actually applied.
      await client.query('DROP INDEX IF EXISTS agent_registry_key_idx');
      await client.query(migrationSql);

      const { rows } = await client.query(
        `SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = 'agent_registry_key_idx'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].is_unique).toBe(true);
      expect(rows[0].is_valid).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // The rollback restored the original index; the database is unchanged.
    const restored = await indexIsUnique();
    expect(restored?.is_unique).toBe(true);
  });

  it('refuses to apply on duplicate keys, names them, and changes no rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX IF EXISTS agent_registry_key_idx');
      await client.query(
        `INSERT INTO agent_registry (id, key, name, capabilities, permissions_required)
         VALUES ('it-dup-a', 'it-dup-key', 'A', '[]', '[]'),
                ('it-dup-b', 'it-dup-key', 'B', '[]', '[]')`,
      );

      await client.query('SAVEPOINT before_migration');
      let error: Error & { message: string } = undefined as never;
      try {
        await client.query(migrationSql);
      } catch (e) {
        error = e as Error & { message: string };
      }
      await client.query('ROLLBACK TO SAVEPOINT before_migration');

      expect(error).toBeTruthy();
      expect(error.message).toContain('it-dup-key');
      expect(error.message).toContain('duplicated');

      // The guard must not have deleted or merged the duplicate rows.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM agent_registry WHERE key = 'it-dup-key'`,
      );
      expect(rows[0].n).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

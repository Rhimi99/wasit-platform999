import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveTestDatabaseUrl } from './test-db-guard';
import { removeTestMediaDir, resetTestMediaDir } from './test-media-dir';

/**
 * Global setup for integration tests.
 *
 * The destructive steps below (DROP DATABASE / CREATE DATABASE) run only against
 * the single authorized isolated target. `resolveTestDatabaseUrl` refuses to
 * proceed unless `TEST_DATABASE_URL` is supplied explicitly and points at
 * PostgreSQL on 127.0.0.1:5434, database `wasit_test` — there is no fallback to
 * `DATABASE_URL`, `localhost`, or the default port. See `tests/test-db-guard.ts`.
 *
 * Test media is reset before the run and deleted afterwards. The target is the
 * dedicated `.wasit-media-test` store (pinned by vitest.config.ts); the real
 * `.wasit-media` store is never read, written or cleaned here.
 *
 * `SKIP_DB_SETUP=1` is for DB-free suites (e.g. media storage isolation): it
 * skips provisioning only. A spec that touches the database then fails loudly
 * instead of silently using an unexpected one.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await resetTestMediaDir();
  const teardown = async (): Promise<void> => {
    await removeTestMediaDir();
  };

  if (process.env.SKIP_DB_SETUP === '1') {
    return teardown;
  }

  try {
    const TEST_DB_URL = resolveTestDatabaseUrl().url;
    const { Client } = await import('pg');
    const url = new URL(TEST_DB_URL);
    const dbName = url.pathname.slice(1);
    const adminUrl = new URL(TEST_DB_URL);
    adminUrl.pathname = '/postgres';

    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await client.query(`CREATE DATABASE ${dbName}`);
    await client.end();

    const serverRoot = path.resolve(process.cwd(), 'src');
    execSync(`DATABASE_URL="${TEST_DB_URL}" npx drizzle-kit migrate`, {
      cwd: path.resolve(serverRoot, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    execSync(`DATABASE_URL="${TEST_DB_URL}" npx tsx src/scripts/seed.ts`, {
      cwd: path.resolve(serverRoot, '..'),
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    // A failed provisioning must not leave the test media store behind.
    await removeTestMediaDir();
    throw error;
  }

  return teardown;
}
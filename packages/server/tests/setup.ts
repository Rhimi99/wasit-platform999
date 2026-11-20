import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveTestDatabaseUrl } from './test-db-guard';

/**
 * Global setup for integration tests.
 *
 * The destructive steps below (DROP DATABASE / CREATE DATABASE) run only against
 * the single authorized isolated target. `resolveTestDatabaseUrl` refuses to
 * proceed unless `TEST_DATABASE_URL` is supplied explicitly and points at
 * PostgreSQL on 127.0.0.1:5434, database `wasit_test` — there is no fallback to
 * `DATABASE_URL`, `localhost`, or the default port. See `tests/test-db-guard.ts`.
 */
export default async function globalSetup(): Promise<void> {
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
}
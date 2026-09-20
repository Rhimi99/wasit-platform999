import { execSync } from 'node:child_process';
import path from 'node:path';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test';

/**
 * Global setup for integration tests.
 * 1. Recreate the test database.
 * 2. Run migrations.
 * 3. Seed reference data (roles, permissions, countries, currencies, categories, policies).
 */
export default async function globalSetup(): Promise<void> {
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
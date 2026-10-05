import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// Imported for its side effect: loads the environment (dotenv) before the
// connection string below is read. Without it, any entry point that reaches
// this module before `lib/env.js` runs builds the pool from `process.env` while
// it is still empty, silently ignoring the configured DATABASE_URL and falling
// back to the hardcoded development default.
import '../lib/env.js';
import * as schema from './schema/index';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev';

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

export type DB = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}

export async function pingDb(): Promise<boolean> {
  await db.execute(sql`SELECT 1`);
  return true;
}
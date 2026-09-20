import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
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
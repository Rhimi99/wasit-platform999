import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './client.js';

async function runMigrations(): Promise<void> {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations complete.');
}

runMigrations()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
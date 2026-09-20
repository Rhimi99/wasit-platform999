import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev',
  },
  strict: true,
  verbose: true,
});
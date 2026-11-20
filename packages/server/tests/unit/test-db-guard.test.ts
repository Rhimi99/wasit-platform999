import { describe, it, expect } from 'vitest';
import {
  assertTestDatabaseUrl,
  resolveTestDatabaseUrl,
  ALLOWED_TEST_DB_HOST,
  ALLOWED_TEST_DB_PORT,
  ALLOWED_TEST_DB_NAME,
} from '../test-db-guard.js';

/**
 * DB-free tests for the test-database guard. They exercise only the pure
 * validator, so no Postgres connection is made.
 */

const GOOD = `postgresql://wasit_test:secret@${ALLOWED_TEST_DB_HOST}:${ALLOWED_TEST_DB_PORT}/${ALLOWED_TEST_DB_NAME}`;

describe('test-db-guard', () => {
  it('accepts the authorized isolated target (127.0.0.1:5434/wasit_test)', () => {
    const target = assertTestDatabaseUrl(GOOD);
    expect(target.host).toBe(ALLOWED_TEST_DB_HOST);
    expect(target.port).toBe(ALLOWED_TEST_DB_PORT);
    expect(target.database).toBe(ALLOWED_TEST_DB_NAME);
    expect(target.url).toBe(GOOD);
  });

  it('rejects a missing TEST_DATABASE_URL (no fallback)', () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/not set/i);
    expect(() => assertTestDatabaseUrl('')).toThrow(/not set/i);
    expect(() => resolveTestDatabaseUrl({} as NodeJS.ProcessEnv)).toThrow(/not set/i);
  });

  it('rejects port 5432 (forbidden default/main port)', () => {
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@127.0.0.1:5432/wasit_test')).toThrow(
      /port must be 5434/i,
    );
  });

  it('rejects port 5433 (forbidden demo port)', () => {
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@127.0.0.1:5433/wasit_test')).toThrow(
      /port must be 5434/i,
    );
  });

  it('rejects a different host', () => {
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@localhost:5434/wasit_test')).toThrow(
      /host must be 127\.0\.0\.1/i,
    );
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@db.example.com:5434/wasit_test')).toThrow(
      /host must be 127\.0\.0\.1/i,
    );
  });

  it('rejects a different database name', () => {
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@127.0.0.1:5434/wasit_dev')).toThrow(
      /database must be wasit_test/i,
    );
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@127.0.0.1:5434/wasit_demo')).toThrow(
      /database must be wasit_test/i,
    );
  });

  it('does NOT fall back to DATABASE_URL when TEST_DATABASE_URL is absent', () => {
    const env = {
      DATABASE_URL: 'postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test',
    } as NodeJS.ProcessEnv;
    expect(() => resolveTestDatabaseUrl(env)).toThrow(/not set/i);
  });

  it('rejects a non-PostgreSQL / invalid URL', () => {
    expect(() => assertTestDatabaseUrl('mysql://wasit_test:secret@127.0.0.1:5434/wasit_test')).toThrow(
      /postgresql:\/\//i,
    );
    expect(() => assertTestDatabaseUrl('not-a-url')).toThrow(/valid URL/i);
    // A protocol with no host parses as a URL but has an empty hostname, so it
    // is refused by the host check (still never accepted).
    expect(() => assertTestDatabaseUrl('postgresql://')).toThrow(/host must be 127\.0\.0\.1/i);
  });

  it('treats an explicit empty port as the forbidden default 5432', () => {
    // `postgresql://host/db` has no port -> URL.port === '' -> defaults to 5432, which must be rejected.
    expect(() => assertTestDatabaseUrl('postgresql://wasit_test:secret@127.0.0.1/wasit_test')).toThrow(
      /port must be 5434/i,
    );
  });

  it('accepts the postgres:// alias protocol on the authorized target', () => {
    const target = assertTestDatabaseUrl('postgres://wasit_test:secret@127.0.0.1:5434/wasit_test');
    expect(target.port).toBe(5434);
  });
});

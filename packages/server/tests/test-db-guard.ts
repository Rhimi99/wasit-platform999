/**
 * Guard for the database-backed test suite.
 *
 * The integration suite drops and recreates whatever database
 * `TEST_DATABASE_URL` names (see `tests/setup.ts`). A mis-exported or missing
 * value previously fell back to a hard-coded `localhost:5432` default, which
 * could silently point the destructive path at a non-isolated server.
 *
 * This guard makes the target explicit and pins it to the single authorized
 * isolated test environment: PostgreSQL on `127.0.0.1:5434`, database
 * `wasit_test`. There is deliberately NO fallback to `DATABASE_URL`, to
 * `localhost`, or to the default port.
 */

export const ALLOWED_TEST_DB_HOST = '127.0.0.1';
export const ALLOWED_TEST_DB_PORT = 5434;
export const ALLOWED_TEST_DB_NAME = 'wasit_test';

export interface TestDbTarget {
  /** The original connection string, passed through unchanged. */
  url: string;
  host: string;
  port: number;
  database: string;
}

function reject(reason: string): never {
  throw new Error(
    `Refusing to run database tests: ${reason}. ` +
      `The test suite may only target PostgreSQL at ${ALLOWED_TEST_DB_HOST}:${ALLOWED_TEST_DB_PORT}/` +
      `${ALLOWED_TEST_DB_NAME}, supplied explicitly via TEST_DATABASE_URL. ` +
      'No fallback to DATABASE_URL, localhost, or the default port is allowed.',
  );
}

/**
 * Validates an explicit connection string against the authorized target.
 * Pure: performs no network I/O, so it can be unit-tested without a database.
 */
export function assertTestDatabaseUrl(raw: string | undefined | null): TestDbTarget {
  if (!raw || raw.trim() === '') {
    reject('TEST_DATABASE_URL is not set (there is no fallback target)');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw as string);
  } catch {
    reject('TEST_DATABASE_URL is not a valid URL');
  }

  const protocol = parsed.protocol;
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    reject(`TEST_DATABASE_URL must use the postgresql:// protocol (got "${protocol}")`);
  }

  const host = parsed.hostname;
  if (host !== ALLOWED_TEST_DB_HOST) {
    reject(`TEST_DATABASE_URL host must be ${ALLOWED_TEST_DB_HOST} (got "${host || '(empty)'}")`);
  }

  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port) || port !== ALLOWED_TEST_DB_PORT) {
    reject(`TEST_DATABASE_URL port must be ${ALLOWED_TEST_DB_PORT} (got "${parsed.port || '5432 (default)'}")`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database !== ALLOWED_TEST_DB_NAME) {
    reject(`TEST_DATABASE_URL database must be ${ALLOWED_TEST_DB_NAME} (got "${database || '(empty)'}")`);
  }

  return { url: raw as string, host, port, database };
}

/** Resolves and validates the target from an environment object. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): TestDbTarget {
  return assertTestDatabaseUrl(env.TEST_DATABASE_URL);
}

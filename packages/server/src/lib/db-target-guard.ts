import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';

/**
 * Which database the operator CLI is actually connected to.
 *
 * Read from the server, not from the connection string: `current_database()` is
 * what Postgres will write to, so a `DATABASE_URL` that disagrees with the
 * deployment cannot make the guard believe a friendlier name.
 */
export interface DatabaseIdentity {
  name: string;
  /** Server address, or `unix-socket` when the connection bypassed TCP. */
  host: string;
  port: number | null;
  user: string;
}

/**
 * Names that are never a production target, whatever the environment claims.
 *
 * Checked independently of the declared name, because the point of the guard is
 * to survive a misconfigured deployment — an operator who exports
 * `WASIT_PRODUCTION_DB_NAME=wasit_demo` is exactly the failure being prevented.
 */
const PROTECTED_EXACT = ['postgres', 'template0', 'template1', 'wasit_dev', 'wasit_staging', 'wasit_test', 'wasit_demo'];
const PROTECTED_PATTERNS = [/_test$/, /_demo$/, /_dev$/, /_staging$/, /^template\d+$/, /^_restore/, /^_drill/];

export function isProtectedDatabaseName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (PROTECTED_EXACT.includes(normalized)) return true;
  return PROTECTED_PATTERNS.some((re) => re.test(normalized));
}

export interface ProductionGateInput {
  identity: DatabaseIdentity;
  /** `process.env.NODE_ENV` as the deployment set it. */
  nodeEnv: string | undefined;
  /** `WASIT_PRODUCTION_DB_NAME`: the name this deployment declares as production. */
  declaredName: string | undefined;
  /** `WASIT_PRODUCTION_DB_HOST`: optional pin, for deployments that want one. */
  declaredHost: string | undefined;
}

export interface GateRefusal {
  allowed: false;
  code:
    | 'NOT_PRODUCTION_ENV'
    | 'PRODUCTION_NAME_UNDECLARED'
    | 'PROTECTED_DATABASE'
    | 'DATABASE_MISMATCH'
    | 'HOST_MISMATCH';
  message: string;
}

export type GateDecision = { allowed: true } | GateRefusal;

const SETUP_HINT =
  'Sensitive actions (set-password, reset-factor) run only on a deployment that declares itself production: ' +
  'NODE_ENV=production and WASIT_PRODUCTION_DB_NAME=<the database this deployment calls production>.';

/**
 * Decides whether a credential-changing action may touch this database.
 *
 * Three independent conditions, so no single one opens the gate:
 *  1. the deployment says it is production (`NODE_ENV=production`);
 *  2. the deployment names its production database, and that name is what the
 *     server reports — a name in the connection string is not evidence;
 *  3. the name is not on the protected list, which is checked after the match so
 *     a declaration of `wasit_demo` cannot legitimise itself.
 */
export function evaluateProductionGate(input: ProductionGateInput): GateDecision {
  const { identity } = input;
  const nodeEnv = (input.nodeEnv ?? '').trim().toLowerCase();

  if (nodeEnv !== 'production') {
    return {
      allowed: false,
      code: 'NOT_PRODUCTION_ENV',
      message: `Refusing: NODE_ENV is "${input.nodeEnv ?? '(unset)'}", not "production". ${SETUP_HINT}`,
    };
  }

  const declaredName = (input.declaredName ?? '').trim();
  if (declaredName.length === 0) {
    return {
      allowed: false,
      code: 'PRODUCTION_NAME_UNDECLARED',
      message: `Refusing: WASIT_PRODUCTION_DB_NAME is not set, so this deployment does not say which database is production. ${SETUP_HINT}`,
    };
  }

  if (isProtectedDatabaseName(identity.name)) {
    return {
      allowed: false,
      code: 'PROTECTED_DATABASE',
      message: `Refusing: "${identity.name}" is a test, demo, development, staging or system database. It is never a production target.`,
    };
  }

  if (declaredName.toLowerCase() !== identity.name.trim().toLowerCase()) {
    return {
      allowed: false,
      code: 'DATABASE_MISMATCH',
      message: `Refusing: the server reports database "${identity.name}" but this deployment declares "${declaredName}" as production.`,
    };
  }

  const declaredHost = (input.declaredHost ?? '').trim().toLowerCase();
  if (declaredHost.length > 0 && declaredHost !== identity.host.trim().toLowerCase()) {
    return {
      allowed: false,
      code: 'HOST_MISMATCH',
      message: `Refusing: the server reports host "${identity.host}" but WASIT_PRODUCTION_DB_HOST declares "${declaredHost}".`,
    };
  }

  return { allowed: true };
}

/** Reads the identity from the live session, never from the connection string. */
export async function readDatabaseIdentity(db: DB): Promise<DatabaseIdentity> {
  const result = await db.execute(sql`
    select
      current_database() as name,
      coalesce(host(inet_server_addr()), 'unix-socket') as host,
      inet_server_port() as port,
      current_user as db_user
  `);
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? (result as unknown as Record<string, unknown>[]);
  const row = rows[0] ?? {};
  return {
    name: String(row.name ?? ''),
    // `host()` drops the netmask `inet_server_addr()` prints, so a declared host
    // pin compares against `10.0.0.12`, not `10.0.0.12/32`.
    host: String(row.host ?? 'unknown'),
    port: row.port === null || row.port === undefined ? null : Number(row.port),
    user: String(row.db_user ?? ''),
  };
}

/** One line for the operator log: identity only, never credentials. */
export function describeIdentity(identity: DatabaseIdentity): string {
  return `database "${identity.name}" on ${identity.host}${identity.port ? `:${identity.port}` : ''} as ${identity.user}`;
}

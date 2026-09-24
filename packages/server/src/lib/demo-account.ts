/**
 * The official PUBLIC-DEMO test account.
 *
 * A single source of truth shared by the demo seeder (which provisions it) and
 * the `/api/auth/demo-session` route (which may only ever open a session for
 * this exact address). Keeping one constant means the route cannot drift to
 * another account, and the seeder cannot provision an account the route will not
 * recognise.
 *
 * The address is public and safe to commit. The credential never is: it lives in
 * the git-ignored demo env and is hashed through the normal auth path.
 */
export const DEMO_TEST_ACCOUNT_EMAIL = 'rhimiimed18@gmail.com';

/**
 * The password the four public demo accounts share. It is published (the demo is
 * open to anyone), so it must never open a staff account: the seeder hands the
 * two admin fixtures a separate credential, resolved by
 * {@link resolveStaffPassword}.
 */
export const DEMO_PUBLISHED_PASSWORD = 'Passw0rd!2026';

/**
 * Resolves the credential for the seeder's staff fixtures (`admin@`, `admin2@`).
 *
 * The published demo password only opens the four public demo accounts, so on the
 * public demo (`NODE_ENV=staging`) this must not fall back to it. An explicit
 * `DEMO_STAFF_PASSWORD` is honoured when present; otherwise a random secret is
 * generated per run and returned for the caller to log once, so a demo rebuilt
 * from scratch still cannot be entered as staff with the published password.
 * Everywhere else (development/test) the known password is kept so E2E can drive
 * the admin desks.
 *
 * Returning the generated value rather than reading process.env keeps this pure,
 * so the contract is unit-testable without touching the environment.
 */
export function resolveStaffPassword(options: {
  nodeEnv: string;
  configuredPassword?: string | null;
  generate: () => string;
}): string {
  const configured = options.configuredPassword?.trim();
  if (configured) return configured;
  if (options.nodeEnv === 'staging') return options.generate();
  return DEMO_PUBLISHED_PASSWORD;
}


/**
 * DEMO-SEC-03 — per-account credentials for the public demo fixtures.
 *
 * The demo publishes its account list, so a single shared password is a single
 * key to five doors (and, historically, to the staff desks as well). These
 * helpers are the one place that maps an account to its own env key, so the
 * seeder and the rotation script cannot drift apart.
 *
 * Resolution order, highest first:
 *   1. `DEMO_ACCOUNT_PASSWORD_<SLUG>` / `DEMO_STAFF_PASSWORD_<SLUG>` (rotated)
 *   2. `DEMO_ACCOUNT_PASSWORD` / `DEMO_STAFF_PASSWORD` (shared, dev/E2E)
 *   3. the published development fallback (never on a public demo)
 */
import { DEMO_PUBLISHED_PASSWORD } from './demo-account';

export type DemoAccountName = 'customer1' | 'suppliera' | 'merchanta' | 'companya' | 'demo';
export type DemoStaffName = 'admin' | 'admin2';

const ACCOUNT_SLUGS: Record<string, DemoAccountName> = {
  'customer1@wasit.tn': 'customer1',
  'suppliera@wasit.tn': 'suppliera',
  'merchanta@wasit.tn': 'merchanta',
  'companya@wasit.tn': 'companya',
  'demo@wasit.tn': 'demo',
};

const STAFF_SLUGS: Record<DemoStaffName, string> = {
  admin: 'admin@wasit.tn',
  admin2: 'admin2@wasit.tn',
};

export function demoAccountName(email: string): DemoAccountName | null {
  return ACCOUNT_SLUGS[email.trim().toLowerCase()] ?? null;
}

/** Env key holding this account's rotated secret, or null for a non-fixture address. */
export function demoAccountEnvKey(email: string): string | null {
  const name = demoAccountName(email);
  return name ? `DEMO_ACCOUNT_PASSWORD_${name.toUpperCase()}` : null;
}

export function demoStaffEnvKey(name: DemoStaffName): string {
  return `DEMO_STAFF_PASSWORD_${name.toUpperCase()}`;
}

export function demoStaffEmail(name: DemoStaffName): string {
  return STAFF_SLUGS[name];
}

function pick(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Password the seeder stores for a demo account. */
export function resolveDemoAccountPassword(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = demoAccountEnvKey(email);
  return pick(env, key ? [key, 'DEMO_ACCOUNT_PASSWORD'] : ['DEMO_ACCOUNT_PASSWORD']) ?? DEMO_PUBLISHED_PASSWORD;
}

/**
 * Whether a re-seed must rewrite this account's hash. False only when nothing is
 * configured, which is the dev/test case where the published fallback is expected.
 */
export function shouldRotateDemoPassword(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = demoAccountEnvKey(email);
  return Boolean(pick(env, key ? [key, 'DEMO_ACCOUNT_PASSWORD'] : ['DEMO_ACCOUNT_PASSWORD']));
}

/** Password the seeder stores for a staff fixture; `fallback` covers the random-per-run case. */
export function resolveDemoStaffPassword(
  name: DemoStaffName,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return pick(env, [demoStaffEnvKey(name), 'DEMO_STAFF_PASSWORD']) ?? fallback;
}

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

/**
 * The demo roster the Owner Audit Center may open, keyed by a stable id.
 *
 * These are the seeder's fixtures — the same accounts the public demo has always
 * published — listed once so the audit entry point can only ever open one of
 * them. The email is compiled in, so a caller chooses a *persona* (a whitelisted
 * id), never an arbitrary address: the request can select from this map and
 * nothing else.
 *
 * `role` records the role the seeder grants that fixture. The session opener
 * verifies the stored account actually holds it, so the audit center cannot
 * silently display a desk the account has no right to — a drift is a hard
 * failure, not a UI label.
 */
export const DEMO_AUDIT_PERSONAS = {
  'super-admin': { email: 'admin@wasit.tn', role: 'SUPER_ADMIN', fallbackEmail: null },
  admin: { email: 'admin2@wasit.tn', role: 'ADMIN', fallbackEmail: null },
  customer: { email: DEMO_TEST_ACCOUNT_EMAIL, role: 'CUSTOMER', fallbackEmail: null },
  // The trade fixtures are USERS, not entities: `seed.ts` alone provisions the
  // entity account `customer1@` with no role, while `seed-demo.ts` adds these
  // separate role-holding users. The fallback lets a demo built from the base
  // seed still open an auditable session instead of failing the entry point; it
  // always yields a plain CUSTOMER session, so it can never widen authority.
  merchant: { email: 'merchantA@wasit.tn', role: 'MERCHANT', fallbackEmail: 'customer1@wasit.tn' },
  supplier: { email: 'supplierA@wasit.tn', role: 'SUPPLIER', fallbackEmail: 'customer1@wasit.tn' },
  company: { email: 'companyA@wasit.tn', role: 'COMPANY', fallbackEmail: 'customer1@wasit.tn' },
} as const;

export type DemoAuditPersonaId = keyof typeof DEMO_AUDIT_PERSONAS;

/** Stable ordering for the audit UI: staff first, then the trade roles. */
export const DEMO_AUDIT_PERSONA_IDS = Object.keys(DEMO_AUDIT_PERSONAS) as DemoAuditPersonaId[];

/**
 * Resolves a requested persona id to its fixture, or `null` for anything not on
 * the roster. `null` is the security boundary: the opener must treat it as a
 * refusal, so a crafted id can never widen the demo beyond these six accounts.
 */
export function resolveDemoAuditPersona(id: unknown): {
  id: DemoAuditPersonaId;
  email: string;
  role: string;
  fallbackEmail: string | null;
} | null {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (!(key in DEMO_AUDIT_PERSONAS)) return null;
  const persona = DEMO_AUDIT_PERSONAS[key as DemoAuditPersonaId];
  return {
    id: key as DemoAuditPersonaId,
    email: persona.email,
    role: persona.role,
    fallbackEmail: persona.fallbackEmail,
  };
}


import { eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { roles, userRoles, users } from '../db/schema/auth';
import { newId } from './ids';
import { hashPassword } from './security';
import { writeAudit } from './audit';

/**
 * Out-of-band provisioning of the first SUPER_ADMIN.
 *
 * Why a dedicated path instead of extending registration: `registerUser` only
 * ever grants a role from `SELF_SELECTABLE_ROLES`, so no HTTP request — crafted
 * or otherwise — can mint a platform-owner account. The first SUPER_ADMIN is
 * therefore created by an operator with server access, running a one-shot CLI
 * that writes the user and the role grant directly.
 *
 * The invariants this module enforces:
 *
 *  * `SUPER_ADMIN` is the highest role. There is no PLATFORM_OWNER/OWNER above
 *    it, and this module never invents one.
 *  * The role must already exist in `roles` (seeded by `seed.ts`). The bootstrap
 *    never creates roles, so the RBAC matrix in `@wasit/shared` stays the single
 *    source of truth.
 *  * Exactly one SUPER_ADMIN exists unless an operator explicitly opts in to
 *    additional ones (`allowAdditional`). A second, silent bootstrap is refused.
 *  * The password is supplied by the operator (environment or interactive
 *    prompt). It is hashed with the same argon2id path as every other account and
 *    is never returned to, or logged by, this module — the caller owns the value.
 */

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/** Advisory-lock key that serialises concurrent bootstrap attempts. */
const BOOTSTRAP_LOCK_KEY = 0x57415349; // "WASI"

export interface BootstrapInput {
  email: string;
  password: string;
  /**
   * Permit provisioning when a SUPER_ADMIN already exists. Off by default: the
   * bootstrap is one-time, and widening the staff roster is a deliberate act
   * that must be named explicitly by the operator.
   */
  allowAdditional?: boolean;
  /** Free-form provenance recorded in the audit row (e.g. 'cli', 'ci'). */
  source?: string;
}

export interface BootstrapResult {
  status: 'created' | 'exists';
  userId: string;
  email: string;
  role: string;
  /** True when the account already existed and was granted the role. */
  grantedExisting?: boolean;
}

export class BootstrapError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

/**
 * Password policy for the platform-owner account. Deliberately stricter than the
 * 8-character floor public registration applies, because this credential opens
 * every admin surface.
 */
export const SUPER_ADMIN_PASSWORD_MIN_LENGTH = 12;

export function assertStrongBootstrapPassword(password: string): void {
  if (password.length < SUPER_ADMIN_PASSWORD_MIN_LENGTH) {
    throw new BootstrapError(
      'WEAK_PASSWORD',
      `Password must be at least ${SUPER_ADMIN_PASSWORD_MIN_LENGTH} characters`,
    );
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password));
  if (classes.length < 4) {
    throw new BootstrapError(
      'WEAK_PASSWORD',
      'Password must mix lowercase, uppercase, digits and symbols',
    );
  }
}

export function normalizeBootstrapEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new BootstrapError('INVALID_EMAIL', 'A valid email address is required');
  }
  return normalized;
}

/** Resolves the SUPER_ADMIN role id, or fails if the RBAC roles are not seeded. */
async function resolveSuperAdminRoleId(db: DB): Promise<string> {
  const rows = await db.select().from(roles).where(eq(roles.name, SUPER_ADMIN_ROLE)).limit(1);
  if (rows.length === 0) {
    throw new BootstrapError(
      'ROLE_NOT_SEEDED',
      `Role ${SUPER_ADMIN_ROLE} is not present. Run the reference seeder (npm run db:seed) first.`,
    );
  }
  return rows[0].id;
}

async function countSuperAdmins(db: DB, roleId: string): Promise<number> {
  const rows = await db
    .select({ v: sql<number>`count(*)::int` })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));
  return Number(rows[0]?.v ?? 0);
}

/**
 * Creates the first SUPER_ADMIN, or grants the role to an existing account.
 *
 * Idempotent in the sense that re-running with an already-provisioned roster is
 * refused rather than duplicated. Serialised by a transaction-scoped advisory
 * lock so two operators starting the command at the same moment cannot both pass
 * the "already exists?" check and each insert a grant.
 */
export async function bootstrapSuperAdmin(
  db: DB,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const email = normalizeBootstrapEmail(input.email);
  assertStrongBootstrapPassword(input.password);
  const source = input.source ?? 'cli';

  const roleId = await resolveSuperAdminRoleId(db);

  try {
    return await db.transaction(async (tx) => {
      // Serialise the whole check-then-write against a concurrent bootstrap.
      await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

      const existingSuperAdmins = await countSuperAdmins(tx as unknown as DB, roleId);
      if (existingSuperAdmins > 0 && !input.allowAdditional) {
        throw new BootstrapError(
          'ALREADY_PROVISIONED',
          `A SUPER_ADMIN already exists (${existingSuperAdmins}). ` +
            'Re-run with SUPER_ADMIN_ALLOW_ADDITIONAL=true only if an additional ' +
            'platform owner is genuinely intended.',
        );
      }

      const existingUser = await tx.select().from(users).where(eq(users.email, email)).limit(1);

      if (existingUser.length > 0) {
        const user = existingUser[0];
        const grants = await tx
          .select()
          .from(userRoles)
          .where(eq(userRoles.userId, user.id));
        const alreadyGranted = grants.some((g) => g.roleId === roleId);

        if (!alreadyGranted) {
          await tx.insert(userRoles).values({ id: newId(), userId: user.id, roleId });
        }
        // The operator owns the credential; never reset an existing account's
        // password from here, so a bootstrap cannot silently change a live login.
        await tx
          .update(users)
          .set({ isActive: true, isLocked: false, updatedAt: new Date() })
          .where(eq(users.id, user.id));

        await writeAudit(
          tx as unknown as DB,
          { actorId: null },
          {
            action: 'AUTH.SUPER_ADMIN_BOOTSTRAP',
            entityType: 'USER',
            entityId: user.id,
            before: { role: SUPER_ADMIN_ROLE, granted: alreadyGranted },
            after: { email, role: SUPER_ADMIN_ROLE, granted: true },
            metadata: { source, outcome: 'granted_existing', passwordChanged: false },
          },
        );

        return {
          status: 'created' as const,
          userId: user.id,
          email,
          role: SUPER_ADMIN_ROLE,
          grantedExisting: true,
        };
      }

      const userId = newId();
      const passwordHash = await hashPassword(input.password);

      await tx.insert(users).values({
        id: userId,
        email,
        passwordHash,
        firstName: 'Super',
        lastName: 'Admin',
        locale: 'ar',
        // Operator-provisioned out of band: there is no mailbox to click, and the
        // account is created by someone with server access. Every other account
        // still has to complete the normal email-verification flow.
        emailVerified: true,
      });

      await tx.insert(userRoles).values({ id: newId(), userId, roleId });

      await writeAudit(
        tx as unknown as DB,
        { actorId: null },
        {
          action: 'AUTH.SUPER_ADMIN_BOOTSTRAP',
          entityType: 'USER',
          entityId: userId,
          after: { email, role: SUPER_ADMIN_ROLE, emailVerified: true },
          metadata: { source, outcome: 'created', passwordChanged: true },
        },
      );

      return { status: 'created' as const, userId, email, role: SUPER_ADMIN_ROLE };
    });
  } catch (err) {
    // A refusal aborts the transaction, so its audit row would roll back with it.
    // Record the refusal on the outer connection instead � a blocked attempt to
    // mint a platform owner is exactly the event an operator needs to see.
    if (err instanceof BootstrapError && err.code === 'ALREADY_PROVISIONED') {
      await writeAudit(db, { actorId: null }, {
        action: 'AUTH.SUPER_ADMIN_BOOTSTRAP_REFUSED',
        entityType: 'USER',
        entityId: null,
        metadata: { source, outcome: 'refused', reason: 'SUPER_ADMIN_ALREADY_EXISTS', requestedEmail: email },
      });
    }
    throw err;
  }
}

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { ApiError, isSelfSelectableRole, isStaffRole, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import {
  emailVerificationTokens,
  mfaChallenges,
  passwordResetTokens,
  phoneVerificationTokens,
  roles,
  sessions,
  userRoles,
  users,
} from '../../db/schema/auth';
import { newId } from '../../lib/ids';
import {
  DUMMY_ARGON2_HASH,
  generateOtpCode,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../../lib/security';
import { verifyMfaChallenge, enrollMfa, confirmMfa } from '../../lib/mfa';
import { env, demoEmailVerificationSkipped, demoAutoLoginEnabled, staffMfaEnforced } from '../../lib/env';
import { isLoginBlocked, lockoutPolicy } from '../../lib/lockout';
import { DEMO_TEST_ACCOUNT_EMAIL, canOpenDemoPersona, resolveDemoAuditPersona } from '../../lib/demo-account';
import { writeAudit } from '../../lib/audit';
import { sendMail } from '../../lib/mail/send';
import { buildPasswordResetEmail, buildVerificationEmail } from '../../lib/mail/templates';
import { sendSms } from '../../lib/sms/send';
import { buildPhoneVerificationSms } from '../../lib/sms/templates';

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  locale?: string;
  role?: UserRole;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    roles: UserRole[];
  };
}

/**
 * Login outcome. When the account has MFA enabled the password step returns a
 * pending challenge instead of a session token — the session is only issued by
 * `completeMfaLogin` after a valid TOTP/recovery code.
 *
 * `staff_enrollment_required` is the LC-06 variant for an internal staff account
 * that has no second factor yet: the password step returns an enrollment
 * challenge instead of a session, and the session is only issued by
 * `completeStaffMfaEnrollment` after the staff member enrolls and confirms a TOTP.
 */
export type LoginOutcome =
  | { kind: 'session'; session: LoginResult }
  | { kind: 'mfa_required'; challengeToken: string; expiresAt: Date }
  | { kind: 'staff_enrollment_required'; challengeToken: string; expiresAt: Date };

/** Reads the role names held by a user. Used to decide staff MFA policy. */
async function getUserRoles(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

/** Creates a session, stamps last-login, and returns the login payload. */
async function issueSession(
  db: DB,
  user: { id: string; email: string; emailVerified: boolean },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const { token, tokenHash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86400_000);

  await db.insert(sessions).values({
    id: newId(),
    userId: user.id,
    tokenHash,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    expiresAt,
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  const roleRows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, user.id));

  return {
    token,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      roles: roleRows.map((r) => r.roleName as UserRole),
    },
  };
}

async function getRoleIdByName(db: DB, roleName: UserRole, fallbackRole: UserRole): Promise<string> {
  const rows = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (rows.length === 0) {
    const fb = await db.select().from(roles).where(eq(roles.name, fallbackRole)).limit(1);
    if (fb.length === 0) {
      throw ApiError.internal(`Role ${fallbackRole} not seeded`);
    }
    return fb[0].id;
  }
  return rows[0].id;
}

export async function registerUser(
  db: DB,
  input: RegisterInput,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ userId: string; requiresEmailVerification: boolean }> {
  const email = input.email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw ApiError.validation([{ field: 'email', message: 'Invalid email address', code: 'VALIDATION_FAILED' }]);
  }
  if (input.password.length < 8) {
    throw ApiError.validation([{ field: 'password', message: 'Password must be at least 8 characters', code: 'VALIDATION_FAILED' }]);
  }

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with this email already exists');
  }

  // Resolve the role BEFORE writing any user row so a missing/unseeded role
  // fails before a partial (orphaned) user can be created.
  //
  // Self-service registration may only ever grant a role from the shared
  // allow-list. Anything else — a privileged role (ADMIN/SUPER_ADMIN/SUPPORT/…),
  // an unknown string, or a missing value — falls back to CUSTOMER. The rule
  // lives here as well as in the route schema so a direct service caller cannot
  // bypass the HTTP validation to mint a staff account.
  const requestedRole = input.role;
  const roleName: UserRole = isSelfSelectableRole(requestedRole) ? requestedRole : 'CUSTOMER';
  const roleId = await getRoleIdByName(db, roleName, 'CUSTOMER');

  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  const phone = normalizePhone(input.phone);

  // Public demo only (never production — see `demoEmailVerificationSkipped`): the
  // visitor has no mailbox to click, so the account is stored already verified
  // and no verification token is minted. Every other environment leaves this
  // false and keeps the full verification flow.
  const skipEmailVerification = demoEmailVerificationSkipped();

  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    phone,
    locale: input.locale ?? 'ar',
    emailVerified: skipEmailVerification,
  });

  await db.insert(userRoles).values({
    id: newId(),
    userId,
    roleId,
  });

  await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.REGISTER',
    entityType: 'USER',
    entityId: userId,
    after: { email, role: roleName, emailVerified: skipEmailVerification },
  });

  if (skipEmailVerification) {
    await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'AUTH.EMAIL_VERIFICATION_SKIPPED',
      entityType: 'USER',
      entityId: userId,
      metadata: { reason: 'DEMO_SKIP_EMAIL_VERIFICATION' },
    });
    return { userId, requiresEmailVerification: false };
  }

  // Email verification token. The link is delivered by the active mail
  // transport; a transport failure must not abort registration (the account is
  // already persisted and the audit row records the delivery attempt).
  const token = await issueEmailVerificationToken(db, userId);

  const verifyLink = `${env.APP_URL}/verify-email?token=${token}`;
  await sendMail(
    db,
    buildVerificationEmail({ to: email, link: verifyLink, locale: input.locale, ttlHours: env.EMAIL_VERIFY_TTL_HOURS }),
  );

  return { userId, requiresEmailVerification: true };
}

/**
 * Issues a fresh email-verification token, invalidating any outstanding ones so
 * only the newest link works. Shared by registration and the resend/dev paths.
 */
export async function issueEmailVerificationToken(db: DB, userId: string): Promise<string> {
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await db.insert(emailVerificationTokens).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.EMAIL_VERIFY_TTL_HOURS * 3600_000),
  });
  return token;
}

export async function devVerificationLink(db: DB, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const row = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (row.length === 0) {
    throw ApiError.notFound('No such account');
  }
  if (row[0].emailVerified) {
    throw ApiError.validation([{ field: 'email', message: 'Email already verified', code: 'ALREADY_VERIFIED' }]);
  }
  return issueEmailVerificationToken(db, row[0].id);
}

// ---------------------------------------------------------------------------
// Phone (SMS) verification
// ---------------------------------------------------------------------------

const PHONE_REGEX = /^\+?[0-9]{6,20}$/;

/** Trims/validates an optional phone number; returns null when absent. */
export function normalizePhone(phone: string | undefined | null): string | null {
  if (phone === undefined || phone === null) return null;
  const trimmed = phone.trim();
  if (trimmed.length === 0) return null;
  const compact = trimmed.replace(/[\s()-]/g, '');
  if (!PHONE_REGEX.test(compact)) {
    throw ApiError.validation([
      { field: 'phone', message: 'Invalid phone number', code: 'VALIDATION_FAILED' },
    ]);
  }
  return compact;
}

/**
 * Issues a fresh 6-digit phone-verification code, invalidating any outstanding
 * one so only the newest code works, and delivers it via the active SMS
 * transport. Only a hash of the code is persisted. A transport failure must not
 * abort the request (the audit row records the delivery attempt).
 *
 * Returns the plaintext code so the dev-only seam can hand it to a developer;
 * production callers ignore the return value and the code never leaves here.
 */
async function createPhoneCode(
  db: DB,
  userId: string,
  localeOverride: string | null | undefined,
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw ApiError.notFound('User');
  if (!user.phone) {
    throw ApiError.validation([
      { field: 'phone', message: 'No phone number on file', code: 'PHONE_REQUIRED' },
    ]);
  }
  if (user.phoneVerified) {
    throw ApiError.validation([
      { field: 'phone', message: 'Phone already verified', code: 'ALREADY_VERIFIED' },
    ]);
  }

  await db
    .update(phoneVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)));

  const code = generateOtpCode();
  await db.insert(phoneVerificationTokens).values({
    id: newId(),
    userId,
    tokenHash: hashToken(code),
    expiresAt: new Date(Date.now() + env.PHONE_VERIFY_TTL_MINUTES * 60_000),
  });

  await sendSms(
    db,
    buildPhoneVerificationSms({
      to: user.phone,
      code,
      locale: localeOverride ?? user.locale,
      ttlMinutes: env.PHONE_VERIFY_TTL_MINUTES,
    }),
  );

  await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.PHONE_CODE_SENT',
    entityType: 'USER',
    entityId: userId,
  });

  return code;
}

/** Sends a fresh phone-verification code to the authenticated user's phone. */
export async function issuePhoneVerificationCode(
  db: DB,
  userId: string,
  locale: string | null | undefined,
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await createPhoneCode(db, userId, locale, ctx);
}

/**
 * Verifies a submitted code, marking the phone verified on success. A wrong
 * code increments the attempt counter and the code is rejected once the cap is
 * exceeded — so a guessed code cannot be brute-forced within its lifetime.
 */
export async function verifyPhoneCode(db: DB, userId: string, code: string): Promise<void> {
  const tokenHash = hashToken(code);
  const rows = await db
    .select()
    .from(phoneVerificationTokens)
    .where(and(
      eq(phoneVerificationTokens.userId, userId),
      eq(phoneVerificationTokens.tokenHash, tokenHash),
      isNull(phoneVerificationTokens.usedAt),
      gt(phoneVerificationTokens.expiresAt, new Date()),
    ))
    .limit(1);

  if (rows.length === 0) {
    await db
      .update(phoneVerificationTokens)
      .set({ attempts: sql`${phoneVerificationTokens.attempts} + 1` })
      .where(and(
        eq(phoneVerificationTokens.userId, userId),
        isNull(phoneVerificationTokens.usedAt),
      ));
    throw ApiError.unauthorized('Invalid or expired verification code');
  }

  const token = rows[0];
  if (token.attempts >= env.PHONE_VERIFY_MAX_ATTEMPTS) {
    throw ApiError.unauthorized('Too many attempts. Request a new code.');
  }

  await db
    .update(phoneVerificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(phoneVerificationTokens.id, token.id));

  await db
    .update(users)
    .set({ phoneVerified: true, updatedAt: new Date() })
    .where(eq(users.id, userId));

  await writeAudit(db, { actorId: userId }, {
    action: 'AUTH.PHONE_VERIFIED',
    entityType: 'USER',
    entityId: userId,
  });
}

/**
 * Dev/test seam: issues a fresh code for the account and returns its plaintext
 * (the production path only ever stores the hash). Mirrors
 * `devVerificationLink` and is refused in production by the route.
 */
export async function devPhoneCode(db: DB, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const row = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (row.length === 0) throw ApiError.notFound('No such account');
  const user = row[0];
  if (!user.phone) {
    throw ApiError.validation([
      { field: 'phone', message: 'No phone number on file', code: 'PHONE_REQUIRED' },
    ]);
  }
  return createPhoneCode(db, user.id, user.locale);
}

export async function loginUser(
  db: DB,
  input: { email: string; password: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null; allowUnverifiedEmail?: boolean },
): Promise<LoginOutcome> {
  const email = input.email.trim().toLowerCase();
  const row = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // The three "no session" early paths — unknown account, locked account, disabled
  // account — all run one password verification against the parameter-matched
  // dummy hash and then throw the same 401 body. Without it, a locked or unknown
  // address would answer in ~0ms (no argon2 work) while a wrong password costs a
  // full hash, which is a response-time oracle for account existence/state. The
  // 403 below is intentional and documented: it is the historical contract for a
  // disabled account, and the dummy verify keeps its *timing* indistinguishable.
  if (row.length === 0) {
    await verifyPassword(input.password, DUMMY_ARGON2_HASH);
    throw ApiError.unauthorized('Invalid credentials');
  }

  const user = row[0];

  // LC-07: an active temporary brute-force lock is refused *before* the password
  // is checked, so a locked account leaks nothing about whether the password was
  // right. A permanent administrative lock (`isLocked` with no `lockedUntil`)
  // keeps its historical 403. A lapsed temporary lock is cleared lazily below,
  // on the next wrong password, rather than here.
  if (isLoginBlocked(user)) {
    await verifyPassword(input.password, DUMMY_ARGON2_HASH);
    throw ApiError.unauthorized('Invalid credentials');
  }
  if (!user.isActive) {
    await verifyPassword(input.password, DUMMY_ARGON2_HASH);
    throw ApiError.forbidden('Account disabled');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    await registerFailedLogin(db, user);
    throw ApiError.unauthorized('Invalid credentials');
  }

  if (!user.emailVerified && !ctx.allowUnverifiedEmail) {
    if (!demoEmailVerificationSkipped()) {
      throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', {
        details: { or: 'Check your inbox' },
      });
    }
    // Public demo only (never production — see `demoEmailVerificationSkipped`):
    // the visitor has no mailbox, so an account left unverified — one created
    // before this waiver existed, or seeded without it — must still be able to
    // sign in. Mirror registration (which stores demo accounts verified) so the
    // rest of the app sees one consistent state instead of a half-verified user.
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
    user.emailVerified = true;
  }

  // Second factor: a correct password is not enough when MFA is enabled. Issue a
  // short-lived single-use challenge and defer the session to completeMfaLogin.
  if (user.mfaEnabled) {
    const { token, tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + env.MFA_CHALLENGE_TTL_MINUTES * 60_000);
    await db.insert(mfaChallenges).values({
      id: newId(),
      userId: user.id,
      tokenHash,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      expiresAt,
    });
    await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'AUTH.MFA_CHALLENGE_ISSUED',
      entityType: 'USER',
      entityId: user.id,
    });
    return { kind: 'mfa_required', challengeToken: token, expiresAt };
  }

  // Mandatory MFA for internal staff (LC-06). A staff account without an enabled
  // second factor gets no session: the password step yields a short-lived,
  // single-use *enrollment* challenge, and the session is only issued by
  // `completeStaffMfaEnrollment` once the staff member has enrolled and confirmed
  // a TOTP. Staff roles are read from the database, never from the request, and
  // only when enforcement is on — so a deployment with it off pays no extra query.
  if (staffMfaEnforced()) {
    const staffRoles = await getUserRoles(db, user.id);
    if (isStaffRole(staffRoles)) {
      const { token, tokenHash } = generateSessionToken();
      const expiresAt = new Date(Date.now() + env.MFA_ENROLLMENT_TOKEN_TTL_MINUTES * 60_000);
      await db.insert(mfaChallenges).values({
        id: newId(),
        userId: user.id,
        tokenHash,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        expiresAt,
      });
      await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
        action: 'AUTH.MFA_ENROLLMENT_REQUIRED',
        entityType: 'USER',
        entityId: user.id,
      });
      return { kind: 'staff_enrollment_required', challengeToken: token, expiresAt };
    }
  }

  // Authentication is now complete (password valid and no second factor pending):
  // only here does the failure streak reset. Resetting it earlier — on the password
  // alone — would let an attacker who knows the password clear a near-threshold
  // counter and then keep guessing TOTP codes; and it would erase a lock the user
  // had not yet cleared at the second factor.
  await clearFailedLogin(db, user, ctx);

  const session = await issueSession(db, user, ctx);

  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.LOGIN',
    entityType: 'USER',
    entityId: user.id,
  });

  return { kind: 'session', session };
}

/**
 * Applies one wrong-password result atomically (LC-07).
 *
 * A single conditional `UPDATE` both increments the streak and, on reaching the
 * configured maximum, stamps `lockedUntil`. The increment reads the current
 * column value in the database (`failed_login_attempts + 1`), so two concurrent
 * failures cannot lose a count the way a read-modify-write in JavaScript would.
 * The `WHERE` matches a lapsed temporary lock back to zero, so the counter never
 * carries over from a previous lock once it has expired.
 *
 * A lock is logged once — at the moment it is set — with the attempt count and
 * duration, never the password or any secret.
 */
async function registerFailedLogin(db: DB, user: typeof users.$inferSelect): Promise<void> {
  const { maxAttempts, lockMinutes } = lockoutPolicy();

  const res = (await db.execute(sql`
    update users
    set
      failed_login_attempts = case
        when locked_until is not null and locked_until <= now() then 1
        else failed_login_attempts + 1
      end,
      locked_until = case
        when (case
          when locked_until is not null and locked_until <= now() then 1
          else failed_login_attempts + 1
        end) >= ${maxAttempts} then now() + (${lockMinutes}::int * interval '1 minute')
        else null
      end,
      updated_at = now()
    where id = ${user.id}
    returning failed_login_attempts, locked_until
  `)) as unknown as { rows: { failed_login_attempts: number; locked_until: Date | null }[] };

  const row = res.rows?.[0];
  if (row?.locked_until) {
    await writeAudit(db, { actorId: user.id }, {
      action: 'AUTH.ACCOUNT_LOCKED',
      entityType: 'USER',
      entityId: user.id,
      metadata: { attempts: row.failed_login_attempts, lockMinutes },
    });
  }
}

/**
 * Resets the failure streak after a correct password (LC-07), and logs the
 * automatic release of a temporary lock that had lapsed. A no-op when the streak
 * and lock are already clear, so an ordinary login writes nothing extra.
 */
async function clearFailedLogin(
  db: DB,
  user: typeof users.$inferSelect,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  if (user.failedLoginAttempts === 0 && user.lockedUntil === null) return;

  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Reaching here means the password was correct and no active lock was in force
  // (an active lock throws before the password check). So a non-null `lockedUntil`
  // can only be a lapsed temporary lock: log its automatic release.
  if (user.lockedUntil !== null) {
    await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'AUTH.ACCOUNT_UNLOCKED',
      entityType: 'USER',
      entityId: user.id,
      metadata: { reason: 'expired' },
    });
  }
}

/**
 * Opens a session for the one seeded demo account, without a password.
 *
 * This is the backend half of the public `/demo/customer` entry point. It is
 * deliberately narrow so it cannot become a general authentication bypass:
 *
 *  * it only runs where `demoAutoLoginEnabled()` is true (never production, and
 *    the process refuses to boot there with the flag set);
 *  * the address is the single compiled-in demo constant — it is never taken
 *    from the request, so a caller cannot choose whose session to mint;
 *  * the account must exist (provisioned by the demo seeder), be active, and not
 *    be locked; a missing account is an explicit 404 rather than a silent create;
 *  * the session itself is issued through the ordinary {@link issueSession}, so
 *    the cookie and TTL match a normal login.
 *
 * It grants no role: the account keeps whatever roles the seeder gave it (an
 * ordinary CUSTOMER), so the staff surface stays forbidden.
 */
export async function demoAutoLogin(
  db: DB,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  return openDemoSession(db, DEMO_TEST_ACCOUNT_EMAIL, null, 'AUTH.DEMO_AUTO_LOGIN', ctx);
}

/**
 * Opens a session for one of the whitelisted demo fixtures, by persona id.
 *
 * This is the backend half of the Owner Audit Center (`/demo/owner`). It is an
 * **operator** tool, not a public entry point: the caller must already hold a
 * staff session, and {@link canOpenDemoPersona} refuses any persona that
 * outranks the caller. Without that check an anonymous visitor — or an ADMIN —
 * could mint a SUPER_ADMIN session through the UI.
 *
 * Within those bounds it reuses the rules of {@link demoAutoLogin} — demo-only,
 * real session via {@link issueSession}, no role granted — and adds a whitelist:
 *
 *  * the requested id is resolved through `resolveDemoAuditPersona`, so a caller
 *    can only pick one of the six compiled-in fixtures, never an arbitrary
 *    address;
 *  * the account's stored roles are read and must include the fixture's declared
 *    role; a mismatch is a 409, so a seeded account that drifted from its roster
 *    entry cannot silently open a desk it has no right to;
 *  * the session keeps whatever roles the database holds, so switching persona is
 *    a real, separate login — an admin session is still an admin session and a
 *    customer session is refused by the staff API exactly as any customer is.
 */
export async function demoAuditLogin(
  db: DB,
  input: { persona: unknown },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
  callerRoles: readonly string[],
): Promise<LoginResult & { persona: string }> {
  const persona = resolveDemoAuditPersona(input.persona);
  if (!persona) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown demo persona');
  }
  if (!canOpenDemoPersona(callerRoles, persona.role)) {
    throw ApiError.forbidden('Demo audit sessions require a staff account that outranks the persona');
  }

  const session = await openDemoSession(
    db,
    persona.email,
    persona.role,
    'AUTH.DEMO_AUDIT_LOGIN',
    ctx,
    { persona: persona.id },
    persona.fallbackEmail,
  );

  return { ...session, persona: persona.id };
}

/**
 * Shared opener for the demo session endpoints. `requiredRole` adds the
 * role-consistency check for the audit roster (`null` for the single customer
 * entry, which grants no role at all — the account keeps whatever it has).
 * `fallbackEmail`, when set, is substituted only if the fixture itself is not
 * provisioned; the role check then fails unless that fallback already holds the
 * role, so the fallback cannot become a privilege-granting shortcut.
 */
async function openDemoSession(
  db: DB,
  email: string,
  requiredRole: string | null,
  auditAction: string,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
  auditMeta: Record<string, unknown> = {},
  fallbackEmail: string | null = null,
): Promise<LoginResult> {
  if (!demoAutoLoginEnabled()) {
    // Same shape as an unknown route: on a real deployment this path does not exist.
    throw ApiError.notFound('Demo auto-login is not available');
  }

  let row = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (row.length === 0 && fallbackEmail) {
    row = await db.select().from(users).where(eq(users.email, fallbackEmail)).limit(1);
  }
  if (row.length === 0) {
    throw ApiError.notFound('Demo account is not provisioned');
  }

  const user = row[0];
  if (isLoginBlocked(user)) {
    throw ApiError.forbidden('Account locked. Please reset your password or contact support.');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('Account disabled');
  }

  if (requiredRole) {
    const roleRows = await db
      .select({ roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, user.id));
    const held = roleRows.map((r) => r.roleName);
    if (!held.includes(requiredRole)) {
      throw new ApiError(
        409,
        'CONFLICT',
        `Demo fixture ${email} does not hold the expected role ${requiredRole}`,
      );
    }
  }

  // The demo accounts are seeded verified, but a demo rebuild or an older row
  // could predate that. Mirror the demo login waiver so the app sees one
  // consistent state, and never relax this outside the demo (the resolver above
  // guarantees it).
  if (!user.emailVerified) {
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
    user.emailVerified = true;
  }

  const session = await issueSession(db, user, ctx);

  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: auditAction,
    entityType: 'USER',
    entityId: user.id,
    metadata: Object.keys(auditMeta).length ? auditMeta : undefined,
  });

  return session;
}

/**
 * Completes an MFA-protected login: validates the challenge token and a TOTP or
 * recovery code, consumes the challenge, and issues the session. The challenge
 * is invalidated after too many wrong codes.
 */
export async function completeMfaLogin(
  db: DB,
  input: { challengeToken: string; code: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const tokenHash = hashToken(input.challengeToken);
  const rows = await db
    .select()
    .from(mfaChallenges)
    .where(eq(mfaChallenges.tokenHash, tokenHash))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }
  const challenge = rows[0];
  if (challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }
  if (challenge.attempts >= env.MFA_CHALLENGE_MAX_ATTEMPTS) {
    throw ApiError.unauthorized('Too many attempts. Please sign in again.');
  }

  const userRows = await db.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
  if (userRows.length === 0 || !userRows[0].isActive || isLoginBlocked(userRows[0]) || !userRows[0].mfaEnabled) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }
  const user = userRows[0];

  let result: { valid: boolean; recoveryCodeUsed?: boolean };
  try {
    result = await verifyMfaChallenge(db, user.id, input.code);
  } catch {
    result = { valid: false };
  }

  if (!result.valid) {
    // Atomic increment (LC-07 review): `attempts = attempts + 1` in SQL, so
    // parallel wrong codes cannot lose updates and slip past the cap the way a
    // read-modify-write (`set({ attempts: challenge.attempts + 1 })`) would. This
    // per-challenge cap is the *independent* MFA brute-force protection; a wrong
    // code never touches the password streak.
    await db
      .update(mfaChallenges)
      .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
      .where(eq(mfaChallenges.id, challenge.id));
    await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'AUTH.MFA_CHALLENGE_FAILED',
      entityType: 'USER',
      entityId: user.id,
    });
    throw ApiError.unauthorized('Invalid verification code');
  }

  await db
    .update(mfaChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(mfaChallenges.id, challenge.id));

  // Full authentication now complete (password + second factor): reset the
  // password failure streak here, not at the password step.
  await clearFailedLogin(db, user, ctx);

  const session = await issueSession(db, user, ctx);

  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.LOGIN',
    entityType: 'USER',
    entityId: user.id,
  });

  return session;
}

/**
 * Loads and validates a pending staff MFA *enrollment* challenge, returning the
 * challenge row and the account. Shared by the enroll and confirm steps so both
 * apply the same single-use/expiry/attempt and staff-policy rules.
 *
 * The challenge is NOT consumed here; only the confirm step consumes it.
 */
async function loadStaffEnrollmentChallenge(db: DB, challengeToken: string) {
  const tokenHash = hashToken(challengeToken);
  const rows = await db
    .select()
    .from(mfaChallenges)
    .where(eq(mfaChallenges.tokenHash, tokenHash))
    .limit(1);
  if (rows.length === 0) throw ApiError.unauthorized('Invalid or expired challenge');
  const challenge = rows[0];
  if (challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }
  if (challenge.attempts >= env.MFA_CHALLENGE_MAX_ATTEMPTS) {
    throw ApiError.unauthorized('Too many attempts. Please sign in again.');
  }

  const userRows = await db.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
  if (userRows.length === 0 || !userRows[0].isActive || isLoginBlocked(userRows[0])) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }
  const user = userRows[0];

  const staffRoles = await getUserRoles(db, user.id);
  // Refuse when enrollment is no longer the correct step (already enrolled, or no
  // longer staff) — the challenge must not be usable to replace an existing factor.
  if (user.mfaEnabled || !staffMfaEnforced() || !isStaffRole(staffRoles)) {
    throw ApiError.unauthorized('Invalid or expired challenge');
  }

  return { challenge, user };
}

/**
 * Begins the mandatory staff MFA enrollment (LC-06).
 *
 * Validates the enrollment challenge issued at login and creates a pending
 * authenticator for the account, returning the TOTP secret, the otpauth URI and
 * the one-time recovery codes. No session is issued here — the staff member must
 * confirm a code at {@link completeStaffMfaEnrollment}, which enables the factor
 * and opens the session. The challenge is not consumed yet, so a failed confirm
 * can be retried with the same secret.
 */
export async function beginStaffMfaEnrollment(
  db: DB,
  input: { challengeToken: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ secretBase32: string; qrUri: string; recoveryCodes: string[] }> {
  const { user } = await loadStaffEnrollmentChallenge(db, input.challengeToken);
  const enrollment = await enrollMfa(db, user.id, user.email);
  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.MFA_ENROLLMENT_STARTED',
    entityType: 'USER',
    entityId: user.id,
  });
  return {
    secretBase32: enrollment.secretBase32,
    qrUri: enrollment.qrUri,
    recoveryCodes: enrollment.recoveryCodes,
  };
}

/**
 * Completes the mandatory staff MFA enrollment challenge (LC-06).
 *
 * Used when an internal staff account has no second factor: the login step
 * returned a `staff_enrollment_required` challenge instead of a session. This
 * validates the challenge token and the TOTP for the secret the staff member
 * enrolled at `/mfa/staff-enroll`, enables the factor, and only then issues the
 * session. The staff member therefore cannot obtain a staff session without a
 * working second factor.
 *
 * The challenge is single-use and invalidated after too many wrong codes. It is
 * refused outright if MFA is no longer required for the account (already enabled,
 * or the role set changed), so it cannot be replayed to re-enroll over an
 * existing factor.
 */
export async function completeStaffMfaEnrollment(
  db: DB,
  input: { challengeToken: string; code: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const { challenge, user } = await loadStaffEnrollmentChallenge(db, input.challengeToken);

  // Confirms against the pending authenticator created by `/mfa/staff-enroll`
  // (never re-enrolls here, or the code the staff member generated from the
  // displayed secret would no longer match). A missing pending row is a failure.
  let enrolled = false;
  try {
    await confirmMfa(db, user.id, input.code);
    enrolled = true;
  } catch {
    enrolled = false;
  }

  if (!enrolled) {
    // Atomic increment, same rationale as `completeMfaLogin`: parallel wrong
    // codes must not lose attempts and outrun the per-challenge cap. A wrong code
    // does not touch the password streak.
    await db
      .update(mfaChallenges)
      .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
      .where(eq(mfaChallenges.id, challenge.id));
    await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
      action: 'AUTH.MFA_ENROLLMENT_FAILED',
      entityType: 'USER',
      entityId: user.id,
    });
    throw ApiError.unauthorized('Invalid verification code');
  }

  await db
    .update(mfaChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(mfaChallenges.id, challenge.id));

  // Full authentication now complete (password + enrollment TOTP): reset the
  // password failure streak here, not at the password step.
  await clearFailedLogin(db, user, ctx);

  const session = await issueSession(db, user, ctx);

  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.MFA_ENROLLED_AT_LOGIN',
    entityType: 'USER',
    entityId: user.id,
  });
  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.LOGIN',
    entityType: 'USER',
    entityId: user.id,
  });

  return session;
}

export async function logoutUser(db: DB, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}

export async function verifyEmail(db: DB, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(emailVerificationTokens)
    .where(and(eq(emailVerificationTokens.tokenHash, tokenHash), gt(emailVerificationTokens.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) {
    throw ApiError.unauthorized('Invalid or expired verification token');
  }

  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, rows[0].userId));

  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokens.id, rows[0].id));

  await writeAudit(db, { actorId: rows[0].userId }, {
    action: 'AUTH.EMAIL_VERIFIED',
    entityType: 'USER',
    entityId: rows[0].userId,
  });
}

export async function requestPasswordReset(
  db: DB,
  email: string,
): Promise<{ resetToken: string; userExists: boolean }> {
  const normalized = email.trim().toLowerCase();
  const row = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (row.length === 0) {
    return { resetToken: '', userExists: false };
  }
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = hashToken(token);
  await db.insert(passwordResetTokens).values({
    id: newId(),
    userId: row[0].id,
    tokenHash,
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_HOURS * 3600_000),
  });

  const resetLink = `${env.APP_URL}/reset-password?token=${token}`;
  await sendMail(
    db,
    buildPasswordResetEmail({
      to: row[0].email,
      link: resetLink,
      locale: row[0].locale,
      ttlHours: env.PASSWORD_RESET_TTL_HOURS,
    }),
  );

  return { resetToken: token, userExists: true };
}

export async function resetPassword(db: DB, token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.tokenHash, tokenHash), gt(passwordResetTokens.expiresAt, new Date())))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.unauthorized('Invalid or expired reset token');
  }
  if (newPassword.length < 8) {
    throw ApiError.validation([{ field: 'password', message: 'Password must be at least 8 characters', code: 'VALIDATION_FAILED' }]);
  }
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, rows[0].userId));
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, rows[0].id));
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, rows[0].userId));
  await writeAudit(db, { actorId: rows[0].userId }, {
    action: 'AUTH.PASSWORD_RESET',
    entityType: 'USER',
    entityId: rows[0].userId,
  });
}

export async function listSessions(db: DB, userId: string, currentTokenHash?: string) {
  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      tokenHash: sessions.tokenHash,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(sql`created_at desc`);

  return rows.map(({ tokenHash, ...s }) => ({
    ...s,
    isCurrent: currentTokenHash ? tokenHash === currentTokenHash : false,
  }));
}

/**
 * Revokes one of the caller's own sessions. Returns the revoked session's token
 * hash so the route can tell whether the caller just revoked the session it is
 * authenticated with (and clear its cookie); `null` means no such session.
 */
export async function revokeSession(db: DB, userId: string, sessionId: string): Promise<string | null> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ tokenHash: sessions.tokenHash });
  return rows.length > 0 ? rows[0].tokenHash : null;
}
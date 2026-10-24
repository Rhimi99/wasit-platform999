import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { ApiError, isSelfSelectableRole, type UserRole } from '@wasit/shared';
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
  generateOtpCode,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../../lib/security';
import { verifyMfaChallenge } from '../../lib/mfa';
import { env, demoEmailVerificationSkipped, demoAutoLoginEnabled } from '../../lib/env';
import { DEMO_TEST_ACCOUNT_EMAIL, resolveDemoAuditPersona } from '../../lib/demo-account';
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
 */
export type LoginOutcome =
  | { kind: 'session'; session: LoginResult }
  | { kind: 'mfa_required'; challengeToken: string; expiresAt: Date };

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

  if (row.length === 0) {
    await verifyPassword('dummy-password-for-timing', '$argon2id$v=19$m=65536,t=2,p=1$S97ew0ZM2fLFdTUgS5/+bA$Y7Y9w4UBJh7rqfFIhaWf7vO3X0Zxnh0I2m1l6vMCzXM');
    throw ApiError.unauthorized('Invalid credentials');
  }

  const user = row[0];
  if (user.isLocked) {
    throw ApiError.forbidden('Account locked. Please reset your password or contact support.');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('Account disabled');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
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

  const session = await issueSession(db, user, ctx);

  await writeAudit(db, { actorId: user.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'AUTH.LOGIN',
    entityType: 'USER',
    entityId: user.id,
  });

  return { kind: 'session', session };
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
 * This is the backend half of the Owner Audit Center (`/demo/owner`). It reuses
 * the exact rules of {@link demoAutoLogin} — demo-only, real session via
 * {@link issueSession}, no role granted — and adds a whitelist:
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
): Promise<LoginResult & { persona: string }> {
  const persona = resolveDemoAuditPersona(input.persona);
  if (!persona) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown demo persona');
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
  if (user.isLocked) {
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
  if (userRows.length === 0 || !userRows[0].isActive || userRows[0].isLocked || !userRows[0].mfaEnabled) {
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
    await db
      .update(mfaChallenges)
      .set({ attempts: challenge.attempts + 1 })
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

  const session = await issueSession(db, user, ctx);

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

  await db.transaction(async (tx) => {
    // Claim the token with one conditional UPDATE. `used_at IS NULL` and the expiry
    // predicate are part of the statement, so Postgres locks the row and serialises
    // concurrent callers: exactly one sees a returned row, and a replay — or the
    // loser of a race — matches nothing and is refused. A separate SELECT followed
    // by an UPDATE would let two requests both pass the check before either write.
    // The claim and the confirmation share a transaction, so a later failure rolls
    // the claim back and leaves the link usable instead of burning it.
    const claimed = await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, new Date()),
      ))
      .returning({ userId: emailVerificationTokens.userId });

    if (claimed.length === 0) {
      throw ApiError.unauthorized('Invalid or expired verification token');
    }
    const { userId } = claimed[0];

    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, userId));

    await writeAudit(tx as unknown as DB, { actorId: userId }, {
      action: 'AUTH.EMAIL_VERIFIED',
      entityType: 'USER',
      entityId: userId,
    });
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

  await db.transaction(async (tx) => {
    // Atomic single-use claim: `used_at IS NULL` and the expiry check are part of the
    // UPDATE, so Postgres serialises concurrent callers on the row lock. Exactly one
    // request returns a row; a replay, an expired token, or the loser of a race
    // matches nothing and is refused. Doing this before the password write is what
    // makes the whole flow one-time — a prior SELECT could be interleaved so two
    // requests both changed the password.
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ))
      .returning({ userId: passwordResetTokens.userId });

    if (claimed.length === 0) {
      throw ApiError.unauthorized('Invalid or expired reset token');
    }
    const { userId } = claimed[0];

    if (newPassword.length < 8) {
      // Thrown inside the transaction, so the claim above is rolled back and the
      // token stays usable — an invalid request must not consume it.
      throw ApiError.validation([{ field: 'password', message: 'Password must be at least 8 characters', code: 'VALIDATION_FAILED' }]);
    }

    const passwordHash = await hashPassword(newPassword);
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId));
    await writeAudit(tx as unknown as DB, { actorId: userId }, {
      action: 'AUTH.PASSWORD_RESET',
      entityType: 'USER',
      entityId: userId,
    });
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
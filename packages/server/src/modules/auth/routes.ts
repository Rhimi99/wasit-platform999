import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/auth';
import { SESSION_COOKIE } from '../../middleware/auth';
import { writeAudit } from '../../lib/audit';
import {
  enrollMfa,
  confirmMfa,
  disableMfa,
  regenerateRecoveryCodes,
  verifyMfaChallenge,
  getMfaStatus,
  generateTotp,
} from '../../lib/mfa';
import {
  loginUser,
  completeMfaLogin,
  logoutUser,
  registerUser,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  listSessions,
  revokeSession,
  devVerificationLink,
  issuePhoneVerificationCode,
  verifyPhoneCode,
  devPhoneCode,
} from './service';
import { ApiError } from '@wasit/shared';
import { env, devToolingActive, cookieSecure } from '../../lib/env';
import { hashToken } from '../../lib/security';

const mfaEnrollSchema = z.object({});
const mfaConfirmSchema = z.object({ code: z.string().length(6).regex(/^\d{6}$/) });
const mfaDisableSchema = z.object({ code: z.string().length(6).regex(/^\d{6}$/) });
const mfaVerifySchema = z.object({ code: z.string().min(1).max(20) }); // TOTP or recovery code
const mfaRegenSchema = z.object({ code: z.string().length(6).regex(/^\d{6}$/) });
const mfaChallengeSchema = z.object({
  challengeToken: z.string().min(16).max(200),
  code: z.string().min(1).max(20),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  locale: z.enum(['ar', 'fr', 'en']).default('ar'),
  role: z.enum(['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * Dev/test convenience so an integration suite can reach the code under test
   * without a mailbox. It is only honoured where the dev tooling itself is
   * enabled (development, test, or a staging stack that opted in), never in
   * production — otherwise a caller could skip the email-verification gate by
   * simply sending `true`.
   */
  allowUnverifiedEmail: z.boolean().optional().default(false),
});

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(8).max(200) });
const verifyEmailSchema = z.object({ token: z.string().min(1) });
const devVerificationSchema = z.object({ email: z.string().email() });
const revokeSessionSchema = z.object({ sessionId: z.string().min(1) });
const phoneVerifySchema = z.object({ code: z.string().length(6).regex(/^\d{6}$/) });

const registerRateMax = Number(process.env.RATE_LIMIT_REGISTER_MAX ?? 10);
const loginRateMax = Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 15);
const forgotRateMax = Number(process.env.RATE_LIMIT_FORGOT_MAX ?? 5);

export const authRoutes = new Hono();

authRoutes.post(
  '/register',
  rateLimit({ windowSeconds: 60, max: registerRateMax, keyPrefix: 'auth-register' }),
  validateBody(registerSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof registerSchema>>(c);
    const ctx = getContext(c);
    const result = await registerUser(ctx.db, body, {
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true, data: result }, 201 as never);
  },
);

authRoutes.post(
  '/login',
  rateLimit({ windowSeconds: 60, max: loginRateMax, keyPrefix: 'auth-login' }),
  validateBody(loginSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof loginSchema>>(c);
    const ctx = getContext(c);
    const result = await loginUser(ctx.db, body, {
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      // The request flag is honoured only where the dev tooling is enabled.
      // Production never enables it, so the verification gate cannot be skipped
      // by a caller that simply sends `allowUnverifiedEmail: true`.
      allowUnverifiedEmail: body.allowUnverifiedEmail && devToolingActive(),
    });

    if (result.kind === 'mfa_required') {
      // No session cookie yet — the password step only produced a challenge.
      return c.json({
        success: true,
        data: { mfaRequired: true, challengeToken: result.challengeToken, expiresAt: result.expiresAt },
      });
    }

    setCookie(c, SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: cookieSecure,
      maxAge: 30 * 86400,
    });
    return c.json({ success: true, data: { ...result.session.user, mfaRequired: false } });
  },
);

// POST /api/auth/mfa/challenge — complete a login that returned mfaRequired
authRoutes.post(
  '/mfa/challenge',
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'auth-mfa-challenge' }),
  validateBody(mfaChallengeSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof mfaChallengeSchema>>(c);
    const ctx = getContext(c);
    const session = await completeMfaLogin(
      ctx.db,
      { challengeToken: body.challengeToken, code: body.code },
      { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    );
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: cookieSecure,
      maxAge: 30 * 86400,
    });
    return c.json({ success: true, data: { ...session.user, mfaRequired: false } });
  },
);

authRoutes.post('/logout', async (c) => {
  const ctx = getContext(c);
  const token = c.req.header('cookie')?.match(/wasit_session=([^;]+)/)?.[1];
  if (token) {
    await logoutUser(ctx.db, token);
  }
  deleteCookie(c, SESSION_COOKIE);
  return c.json({ success: true });
});

// Dev/test helper: returns the most recent outstanding verification link for an
// address, generated through the real token path. Disabled in production, and
// gated by the same rate limit as registration so it cannot be used to harvest
// links. The mail transport still records a real send; this only surfaces the
// link because no developer mailbox is reachable locally.
authRoutes.post(
  '/dev/verification-link',
  rateLimit({ windowSeconds: 60, max: registerRateMax, keyPrefix: 'auth-dev-verify' }),
  validateBody(devVerificationSchema),
  async (c) => {
    if (!devToolingActive()) {
      throw new ApiError(404, 'NOT_FOUND', 'Not available in this environment');
    }
    const body = getValidatedBody<z.infer<typeof devVerificationSchema>>(c);
    const ctx = getContext(c);
    const token = await devVerificationLink(ctx.db, body.email);
    return c.json({ success: true, data: { token, link: `${env.APP_URL}/verify-email?token=${token}` } });
  },
);

// ---------------------------------------------------------------------------
// Phone (SMS) verification
// ---------------------------------------------------------------------------

// POST /api/auth/phone/send — send a code to the authenticated user's phone
authRoutes.post(
  '/phone/send',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 5, keyPrefix: 'auth-phone-send' }),
  async (c) => {
    const ctx = getContext(c);
    await issuePhoneVerificationCode(ctx.db, ctx.user!.id, undefined, {
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json({ success: true });
  },
);

// POST /api/auth/phone/verify — confirm the code and mark the phone verified
authRoutes.post(
  '/phone/verify',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'auth-phone-verify' }),
  validateBody(phoneVerifySchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof phoneVerifySchema>>(c);
    const ctx = getContext(c);
    await verifyPhoneCode(ctx.db, ctx.user!.id, body.code);
    return c.json({ success: true });
  },
);

// Dev/test helper: issue a fresh phone code and return it (disabled in production).
authRoutes.post(
  '/dev/phone-code',
  rateLimit({ windowSeconds: 60, max: registerRateMax, keyPrefix: 'auth-dev-phone' }),
  validateBody(devVerificationSchema),
  async (c) => {
    if (!devToolingActive()) {
      throw new ApiError(404, 'NOT_FOUND', 'Not available in this environment');
    }
    const body = getValidatedBody<z.infer<typeof devVerificationSchema>>(c);
    const ctx = getContext(c);
    const code = await devPhoneCode(ctx.db, body.email);
    return c.json({ success: true, data: { code } });
  },
);

authRoutes.post(
  '/verify-email',
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'auth-verify-email' }),
  validateBody(verifyEmailSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof verifyEmailSchema>>(c);
    const ctx = getContext(c);
    await verifyEmail(ctx.db, body.token);
    return c.json({ success: true });
  },
);

authRoutes.post(
  '/forgot-password',
  rateLimit({ windowSeconds: 300, max: forgotRateMax, keyPrefix: 'auth-forgot' }),
  validateBody(forgotSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof forgotSchema>>(c);
    const ctx = getContext(c);
    const { resetToken } = await requestPasswordReset(ctx.db, body.email);
    return c.json({
      success: true,
      // Dev convenience only: surface the token so E2E can finish the flow. In
      // production the token is delivered by email and never returned. An empty
      // token (unknown address) is omitted so the response stays uniform.
      data:
        !devToolingActive() || !resetToken ? undefined : { devResetToken: resetToken },
    });
  },
);

authRoutes.post(
  '/reset-password',
  validateBody(resetSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof resetSchema>>(c);
    const ctx = getContext(c);
    await resetPassword(ctx.db, body.token, body.newPassword);
    return c.json({ success: true });
  },
);

authRoutes.get('/me', requireAuth, async (c) => {
  const ctx = getContext(c);
  return c.json({ success: true, data: ctx.user });
});

authRoutes.get('/sessions', requireAuth, async (c) => {
  const ctx = getContext(c);
  const cookie = getCookie(c, SESSION_COOKIE);
  const sessions = await listSessions(ctx.db, ctx.user!.id, cookie ? hashToken(cookie) : undefined);
  return c.json({ success: true, data: sessions });
});

authRoutes.post('/sessions/revoke', requireAuth, validateBody(revokeSessionSchema), async (c) => {
  const body = getValidatedBody<z.infer<typeof revokeSessionSchema>>(c);
  const ctx = getContext(c);
  const revokedHash = await revokeSession(ctx.db, ctx.user!.id, body.sessionId);
  if (revokedHash === null) {
    throw ApiError.notFound('Session not found');
  }
  // Revoking the session you are signed in with must also clear the cookie, so
  // the caller is not left holding a token the middleware will reject.
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie && hashToken(cookie) === revokedHash) {
    deleteCookie(c, SESSION_COOKIE);
  }
  return c.json({ success: true, data: { revokedCurrent: Boolean(cookie && hashToken(cookie) === revokedHash) } });
});

// ---------------------------------------------------------------------------
// MFA (authenticator app, RFC 6238 TOTP)
// ---------------------------------------------------------------------------

// GET /api/auth/mfa/status — current MFA state
authRoutes.get('/mfa/status', requireAuth, async (c) => {
  const ctx = getContext(c);
  const status = await getMfaStatus(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: status });
});

// POST /api/auth/mfa/enroll — begin enrollment (returns secret + QR URI + one-time codes)
authRoutes.post(
  '/mfa/enroll',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 5, keyPrefix: 'auth-mfa-enroll' }),
  validateBody(mfaEnrollSchema),
  async (c) => {
    const ctx = getContext(c);
    const result = await enrollMfa(ctx.db, ctx.user!.id, ctx.user!.email);
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      { action: 'AUTH.MFA_ENROLL', entityType: 'USER', entityId: ctx.user!.id },
    );
    return c.json({
      success: true,
      data: { secretBase32: result.secretBase32, qrUri: result.qrUri, recoveryCodes: result.recoveryCodes },
    });
  },
);

// POST /api/auth/mfa/confirm — verify a TOTP code to complete enrollment
authRoutes.post(
  '/mfa/confirm',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'auth-mfa-confirm' }),
  validateBody(mfaConfirmSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof mfaConfirmSchema>>(c);
    const ctx = getContext(c);
    await confirmMfa(ctx.db, ctx.user!.id, body.code);
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      { action: 'AUTH.MFA_ENABLE', entityType: 'USER', entityId: ctx.user!.id },
    );
    return c.json({ success: true });
  },
);

// POST /api/auth/mfa/disable — disable MFA (requires valid TOTP)
authRoutes.post(
  '/mfa/disable',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'auth-mfa-disable' }),
  validateBody(mfaDisableSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof mfaDisableSchema>>(c);
    const ctx = getContext(c);
    await disableMfa(ctx.db, ctx.user!.id, body.code);
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      { action: 'AUTH.MFA_DISABLE', entityType: 'USER', entityId: ctx.user!.id },
    );
    return c.json({ success: true });
  },
);

// POST /api/auth/mfa/recovery-codes — regenerate one-time recovery codes (requires TOTP)
authRoutes.post(
  '/mfa/recovery-codes',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 5, keyPrefix: 'auth-mfa-recovery' }),
  validateBody(mfaRegenSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof mfaRegenSchema>>(c);
    const ctx = getContext(c);
    const { recoveryCodes } = await regenerateRecoveryCodes(ctx.db, ctx.user!.id, body.code);
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      { action: 'AUTH.MFA_RECOVERY_REGEN', entityType: 'USER', entityId: ctx.user!.id },
    );
    return c.json({ success: true, data: { recoveryCodes } });
  },
);

// POST /api/auth/mfa/verify — challenge a TOTP or recovery code (used by sensitive ops)
authRoutes.post(
  '/mfa/verify',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 20, keyPrefix: 'auth-mfa-verify' }),
  validateBody(mfaVerifySchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof mfaVerifySchema>>(c);
    const ctx = getContext(c);
    const result = await verifyMfaChallenge(ctx.db, ctx.user!.id, body.code);
    if (!result.valid) {
      await writeAudit(
        ctx.db,
        { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
        { action: 'AUTH.MFA_VERIFY_FAILED', entityType: 'USER', entityId: ctx.user!.id },
      );
      return c.json({ success: false, data: { valid: false } }, 401 as never);
    }
    await writeAudit(
      ctx.db,
      { actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
      { action: 'AUTH.MFA_VERIFY_OK', entityType: 'USER', entityId: ctx.user!.id },
    );
    return c.json({ success: true, data: { valid: true, recoveryCodeUsed: result.recoveryCodeUsed ?? false } });
  },
);

// Dev/test helper: generate a TOTP for a given base32 secret at the current time.
// Not exposed in deployed environments.
authRoutes.post(
  '/mfa/dev-totp',
  requireAuth,
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'auth-mfa-devtotp' }),
  async (c) => {
    const ctx = getContext(c);
    if (!devToolingActive()) {
      return c.json({ success: false, message: 'Not available in this environment' }, 403 as never);
    }
    const body = (await c.req.json().catch(() => ({}))) as { secretBase32?: string };
    if (!body.secretBase32) return c.json({ success: false, message: 'secretBase32 required' }, 400 as never);
    return c.json({ success: true, data: { code: generateTotp(body.secretBase32) } });
  },
);
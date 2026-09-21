import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-not-for-production-please-change-me-1234567890'),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().default(5),
  LOCKOUT_MINUTES: z.coerce.number().default(15),
  EMAIL_VERIFY_TTL_HOURS: z.coerce.number().default(24),
  PASSWORD_RESET_TTL_HOURS: z.coerce.number().default(1),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3000'),
  AI_PROVIDER: z.string().default('none'),
  AI_MODEL: z.string().default(''),
  AI_DEFAULT_MODEL: z.string().default('openai-gpt-4o-mini'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_ANTHROPIC_BASE_URL: z.string().optional(),
  AI_BUDGET_MONTHLY_USD: z.coerce.number().default(100),
  // Payments — provider-agnostic. `PAYMENT_PROVIDER=noop` keeps the platform
  // from taking money until an acquirer is contracted and configured.
  // `flouci` and `clictopay` are online adapters; `manual` is the offline desk
  // used for development and testing (no network, no real money).
  PAYMENT_PROVIDER: z.enum(['noop', 'manual', 'open-checkout', 'flouci', 'clictopay']).default('noop'),
  PAYMENT_API_KEY: z.string().optional(),
  PAYMENT_BASE_URL: z.string().optional(),
  /** HMAC secret used to sign/verify provider webhooks (manual / open-checkout). */
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  // Flouci Payment Gateway — keys are issued per application (test app is
  // available immediately after uploading the RNE; production needs KYB).
  // Amounts are sent in minor units (millimes for TND).
  FLOUCI_BASE_URL: z.string().default('https://developers.flouci.com'),
  FLOUCI_PUBLIC_KEY: z.string().optional(),
  FLOUCI_PRIVATE_KEY: z.string().optional(),
  // ClicToPay (SPS Monétique Tunisie) — sandbox/production hosts differ and are
  // supplied by SPS/the acquiring bank together with the integration kit.
  CLICTOPAY_BASE_URL: z.string().default('https://test.clictopay.com/payment/rest'),
  CLICTOPAY_USERNAME: z.string().optional(),
  CLICTOPAY_PASSWORD: z.string().optional(),
  // Mail. `log` is the no-network fallback for local dev/CI; `smtp` delivers
  // for real. Credentials come only from the environment, never the repository.
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('WASIT BUSINESS GLOBAL <no-reply@wasit.tn>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // SMS. `log` is the no-network fallback for local dev/CI; `http` delivers for
  // real through a configurable JSON gateway. Credentials come only from the
  // environment, never the repository. Field names are configurable so the same
  // transport fits the common `{ to, text }` providers.
  SMS_TRANSPORT: z.enum(['log', 'http']).default('log'),
  SMS_SENDER: z.string().default('WASIT'),
  SMS_HTTP_URL: z.string().default(''),
  SMS_HTTP_AUTH_SCHEME: z.enum(['none', 'bearer', 'basic']).default('none'),
  SMS_HTTP_TOKEN: z.string().optional(),
  SMS_HTTP_USERNAME: z.string().optional(),
  SMS_HTTP_PASSWORD: z.string().optional(),
  SMS_HTTP_TO_FIELD: z.string().default('to'),
  SMS_HTTP_TEXT_FIELD: z.string().default('text'),
  SMS_HTTP_SENDER_FIELD: z.string().default('from'),
  /** Lifetime of a phone-verification code, in minutes. */
  PHONE_VERIFY_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  /** Max wrong-code attempts before the code is dead and a new one is required. */
  PHONE_VERIFY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Lifetime of a pending MFA login challenge, in minutes. */
  MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  /** Max wrong TOTP/recovery attempts before a login challenge is invalidated. */
  MFA_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Rate-limit store. `memory` keeps counters in-process (dev / tests / a
  // single instance). `postgres` shares counters across instances so limits
  // hold when the API is scaled out — no extra infrastructure required.
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
  /** How often expired rate-limit buckets are purged, in minutes. */
  RATE_LIMIT_PURGE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  // In-process scheduler. Off by default so tests and one-off commands never
  // start background jobs; a single production instance (or a cron hitting the
  // admin route) enables it. Rollover itself is idempotent across workers.
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Observability. Structured logs go to stdout (single JSON line per record)
  // and a bounded in-process buffer is exposed to admins. `pretty` is for
  // reading along in a terminal; JSON is what a log pipeline should ingest.
  OBS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OBS_LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  // Alert evaluation. Off by default so tests never run background work; the
  // scheduler drives it in a deployment. Delivery defaults to a log line and
  // can POST to a webhook (Slack/PagerDuty bridge) without code changes.
  OBS_ALERTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  OBS_ALERT_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  OBS_ALERT_NOTIFY: z.enum(['log', 'webhook']).default('log'),
  OBS_ALERT_WEBHOOK_URL: z.string().default(''),
  OBS_ALERT_WEBHOOK_TOKEN: z.string().optional(),
  // Prometheus scrape endpoint. A bearer token is optional; without one the
  // endpoint is intended to be reachable only from the scraping network.
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  METRICS_TOKEN: z.string().optional(),
  // Read cache for hot, rarely-changing reference reads (geo catalogue,
  // categories, SEO sitemap). Disabled by default so tests and one-off commands
  // always see the source; each deployment enables it with a TTL it is happy to
  // serve stale. Values are invalidated by prefix on the writes that change them.
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Lifetime of a cached read, in seconds. */
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** Upper bound on cached entries; the LRU evicts beyond this. */
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  // Media storage. Assets (product marketing videos) are written to private
  // storage and served only through authenticated/owned API routes — never as
  // static files. `local` is the on-disk driver; the port is pluggable so an
  // object-store driver can replace it without touching callers.
  MEDIA_STORAGE: z.enum(['local']).default('local'),
  MEDIA_STORAGE_DIR: z.string().default('.wasit-media'),
  /** Public origin used to build asset preview URLs returned in JSON payloads. */
  PUBLIC_API_URL: z.string().optional(),
  /** Marketing video renderer. `structural` is a real local MP4 renderer. */
  VIDEO_PROVIDER: z.enum(['structural', 'noop']).default('structural'),
  /** Explicit ffmpeg binary path; falls back to the bundled ffmpeg-static. */
  VIDEO_FFMPEG_PATH: z.string().optional(),
  VIDEO_WIDTH: z.coerce.number().int().positive().default(720),
  VIDEO_HEIGHT: z.coerce.number().int().positive().default(1280),
  VIDEO_FPS: z.coerce.number().int().positive().default(25),
  /** Font family used for Latin/CJK on-screen text. */
  VIDEO_FONT: z.string().default('DejaVu Sans'),
  /** Font family used for Arabic on-screen text (must support Arabic shaping). */
  VIDEO_ARABIC_FONT: z.string().default('Noto Sans Arabic'),
  /** Directory of bundled fonts passed to libass; autodetected when unset. */
  VIDEO_FONTS_DIR: z.string().optional(),
  /** Lifetime of a signed media download link, in seconds. */
  MEDIA_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MEDIA_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(52_428_800),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  /**
   * The database name this deployment declares as production. The operator CLI
   * compares it with what the server reports before any credential change, so a
   * connection string alone can never unlock a sensitive action.
   */
  WASIT_PRODUCTION_DB_NAME: z.string().optional(),
  /** Optional pin: when set, the reported server host must match it too. */
  WASIT_PRODUCTION_DB_HOST: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-not-for-production-please-change-me-1234567890'),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().default(5),
  LOCKOUT_MINUTES: z.coerce.number().default(15),
  EMAIL_VERIFY_TTL_HOURS: z.coerce.number().default(24),
  PASSWORD_RESET_TTL_HOURS: z.coerce.number().default(1),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3000'),
  /**
   * Comma-separated allow-list of browser origins for credentialed CORS. Empty
   * keeps the permissive reflect-any-origin behavior used by local development
   * and tests; a deployed environment sets it so a foreign origin cannot read
   * authenticated responses.
   */
  CORS_ORIGIN: z.string().default(''),
  /**
   * CSRF enforcement for cookie-authenticated state-changing requests. `auto`
   * (default) enforces it in production/staging and leaves local development
   * and tests frictionless; `on`/`off` force it. See `middleware/csrf.ts`.
   */
  CSRF_PROTECTION: z.enum(['auto', 'on', 'off']).default('auto'),
  /**
   * Mandatory MFA enforcement for internal staff roles (LC-06). `auto` (default)
   * enforces it in **production only** — staging is the public demo and must not
   * be locked out; `on`/`off` force it. See `middleware/mfa.ts`.
   */
  STAFF_MFA_ENFORCEMENT: z.enum(['auto', 'on', 'off']).default('auto'),
  /** TTL of a pending staff MFA enrollment challenge (minutes). */
  MFA_ENROLLMENT_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  /**
   * Mandatory acceptance of published legal documents (LC-01). `off` (default)
   * keeps the gate inert: the platform never blocks sign-in or normal use on an
   * unapproved draft. It is switched to `on` only *after* qualified counsel
   * approves texts and they are published with a version and an effective date —
   * a deliberate two-key action (publish the document *and* enable the flag).
   * Even when `on`, a request is only gated once a document is actually
   * published-and-in-force, so enabling the flag against drafts changes nothing.
   */
  LEGAL_ACCEPTANCE_ENFORCEMENT: z.enum(['off', 'on']).default('off'),
  AI_PROVIDER: z.string().default('none'),
  // Optional deployment-wide model override. It is only consulted when a caller
  // does not name a model; a capability route or explicit request model always
  // wins, because the DB catalogue is the source of truth for routing.
  AI_MODEL: z.string().default(''),
  AI_DEFAULT_MODEL: z.string().default('openai-gpt-4o-mini'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_ANTHROPIC_BASE_URL: z.string().optional(),
  AI_BUDGET_MONTHLY_USD: z.coerce.number().default(100),
  /** Hard ceiling on a single outbound provider call, so a hung vendor cannot pin a request. */
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * AI provider configuration scope. Settings written for one environment are
   * never read by another, so a demo key can never serve production traffic.
   * Defaults to NODE_ENV.
   */
  AI_CONFIG_ENVIRONMENT: z.enum(['production', 'staging', 'development', 'test']).optional(),
  /**
   * Master key for secrets stored in the database (32 bytes, base64). It lives
   * outside the database on purpose: without it, stored provider keys cannot be
   * decrypted. Absent → the admin API refuses to store keys and only
   * environment-referenced keys are usable.
   */
  AI_SECRET_ENCRYPTION_KEY: z.string().optional(),
  /** Live provider probes are opt-in: they cost money and leave the platform. */
  AI_PROVIDER_ALLOW_LIVE_TEST: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Comma-separated host:port allowlist for provider base URLs (SSRF guard). */
  AI_PROVIDER_ALLOWED_HOSTS: z.string().optional(),
  // Payments — provider-agnostic. `PAYMENT_PROVIDER=noop` keeps the platform
  // from taking money until an acquirer is contracted and configured.
  // `flouci` and `clictopay` are online adapters; `manual` is the offline desk
  // used for development and testing (no network, no real money).
  PAYMENT_PROVIDER: z.enum(['noop', 'manual', 'open-checkout', 'flouci', 'clictopay', 'sandbox']).default('noop'),
  PAYMENT_API_KEY: z.string().optional(),
  PAYMENT_BASE_URL: z.string().optional(),
  /** HMAC secret used to sign/verify provider webhooks (manual / open-checkout). */
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  /**
   * OBS-01 — bounded webhook retry. The provider drives retries (WASIT never
   * re-applies a financial side effect on its own timer); these bounds decide
   * whether an incoming delivery may retry a failed event, how long it must
   * wait (exponential backoff), how long one processing claim stays exclusive,
   * and how many operator replays a dead-lettered event gets.
   */
  WEBHOOK_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().max(50).default(5),
  WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(30_000),
  WEBHOOK_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
  WEBHOOK_CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  WEBHOOK_REPLAY_MAX: z.coerce.number().int().nonnegative().max(50).default(3),
  /**
   * Explicitly marks this deployment as a public demo. The offline `manual`
   * provider and the offline refund path move no real money, so they are only
   * accepted where this is `true`. Default off: an unspecified environment is
   * treated as real money and refuses them, so a missing flag fails closed
   * rather than quietly running a demo rail on a live deployment.
   */
  DEMO_PAYMENT_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Payouts — a separate rail from payments. `PAYOUT_PROVIDER=noop` keeps the
  // platform from claiming a seller was paid until a payout rail is contracted
  // and configured. `open-checkout` is a generic HTTP contract, NOT a bank or a
  // licensed institution; `manual` is the offline desk; `sandbox` is a
  // controllable test harness (refused outside demo mode).
  PAYOUT_PROVIDER: z.enum(['noop', 'manual', 'open-checkout', 'sandbox']).default('noop'),
  PAYOUT_API_KEY: z.string().optional(),
  PAYOUT_BASE_URL: z.string().optional(),
  /**
   * Currency used to aggregate platform-wide financial reporting when a caller
   * does not name one. Reporting sums across orders must never mix currencies,
   * so there is exactly one configured reporting currency per deployment rather
   * than a per-query guess. Defaults to TND for continuity with existing
   * deployments; set it to the deployment's actual booking currency.
   */
  REPORTING_CURRENCY: z.string().length(3).default('TND'),
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
  /**
   * Re-exposes the dev-only token-surfacing routes on a deployed environment so
   * a pre-production stack can be exercised without a real mailbox or SMS
   * gateway. Off by default and refused in production: enabling it lets anyone
   * who can reach the API mint verification links, phone codes, reset tokens and
   * TOTP codes for any address. Staging-only, deliberately opt-in, never used
   * with real user data.
   */
  ALLOW_DEV_TOOLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Public-demo convenience: a registration is stored already email-verified, so
   * a visitor can sign in immediately instead of waiting for a mailbox that a
   * throwaway demo does not have. Off by default, so every other environment
   * keeps verification mandatory. Refused outright in production (see below) —
   * the flag can never relax the gate on a real deployment, even if it is set.
   */
  DEMO_SKIP_EMAIL_VERIFICATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Public-demo convenience: allow the one-off `/demo/customer` entry point to
   * open a session for the seeded demo account without a login form. Off by
   * default, so no other environment can mint a session this way. Refused
   * outright in production (see below) — the route can never exist on a real
   * deployment, even if the flag is set. It is an explicit opt-in, separate from
   * DEMO_SKIP_EMAIL_VERIFICATION, so enabling one never silently enables the other.
   */
  DEMO_AUTO_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Rate-limit store. `memory` keeps counters in-process (dev / tests / a
  // single instance). `postgres` shares counters across instances so limits
  // hold when the API is scaled out — no extra infrastructure required.
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
  /** How often expired rate-limit buckets are purged, in minutes. */
  RATE_LIMIT_PURGE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  /**
   * General API rate limit (LC-08/011.4): requests per window per subject
   * (authenticated user id, else trusted client IP) applied to `/api/*` as a
   * backstop against resource exhaustion. Deliberately generous so ordinary
   * bursts are unaffected; the per-route limits below are the tight ones.
   * `/api/auth` and `/api/health` are exempt (they carry their own limits /
   * are cheap operational probes).
   */
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_API_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // ── WCDC-01 — Cyber Defence Centre ────────────────────────────────────────
  /** Turns request-side collection and block enforcement on or off. */
  WCDC_ENABLED: z.enum(['on', 'off']).default('on'),
  /**
   * Automatic containment. `off` (default) means WCDC observes and recommends,
   * and every containment action needs a GM. `limited` lets only a request
   * flood from one address be tightened/blocked automatically; nothing that
   * touches accounts, files, RBAC, MFA or money is ever automatic.
   */
  WCDC_AUTO_CONTAINMENT: z.enum(['off', 'limited']).default('off'),
  /** How long an automatic or manual IP block lasts, in minutes. */
  WCDC_BLOCK_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** How long a tightened rate limit lasts, in minutes. */
  WCDC_TIGHTEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /** Requests per window from one address before a flood is recorded. */
  // 120 requests in 10s clears a busy shared NAT and still catches a flood.
  WCDC_BURST_MAX: z.coerce.number().int().positive().default(120),
  WCDC_BURST_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  /** How long security events are kept before the scheduler prunes them. */
  WCDC_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * External edge protection (CDN/WAF/DDoS). WCDC never calls it: the value is
   * reported so the GM screen can say whether the platform sits behind an edge
   * that can absorb a volumetric flood. Configuring a provider here does not
   * create an account, change DNS or spend money.
   */
  WCDC_EDGE_PROVIDER: z.enum(['none', 'cloudflare', 'fastly', 'aws-shield', 'other']).default('none'),
  WCDC_EDGE_NOTES: z.string().optional(),
  /**
   * AI endpoints (`/api/ai/*`, `/api/admin/ai/*`) are the only surfaces where a
   * request can cost money, so each is assigned a class in
   * `lib/rate-limit/ai-policy.ts` with its own ceiling. The knobs below are the
   * per-class defaults; `RATE_LIMIT_AI_MAX`, when set, overrides every class
   * (the pre-AI-RATE-LIMIT-01 behaviour, kept for operators and existing tests).
   *
   * A per-user limit bounds one account; the per-IP backstop below bounds an
   * attacker rotating accounts from one host. Auth and RBAC still run — these
   * limits are an addition, never a replacement.
   */
  RATE_LIMIT_AI_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AI_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AI_IP_MAX: z.coerce.number().int().positive().default(300),
  /** Read-only AI surfaces (status, listings, activity). */
  AI_RATE_LIMIT_READ_MAX: z.coerce.number().int().positive().default(120),
  /** Vendor-backed feature calls — each may reach a paid provider. */
  AI_RATE_LIMIT_FEATURE_MAX: z.coerce.number().int().positive().default(30),
  /** Agent task creation and approval decisions. */
  AI_RATE_LIMIT_AGENT_MAX: z.coerce.number().int().positive().default(15),
  /** Local agent-memory writes (DB only). */
  AI_RATE_LIMIT_MEMORY_MAX: z.coerce.number().int().positive().default(60),
  /** Admin AI dashboards (reads). */
  AI_RATE_LIMIT_ADMIN_READ_MAX: z.coerce.number().int().positive().default(120),
  /** Admin AI writes: budgets, models, spend limits, kill switch, runs. */
  AI_RATE_LIMIT_ADMIN_CONTROL_MAX: z.coerce.number().int().positive().default(30),
  /** Provider configuration and live probes — the closest thing to a spend. */
  AI_RATE_LIMIT_PROVIDER_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Bounded staff allowance on admin classes. A multiplier, never an exemption:
   * a compromised admin account is still rate-limited.
   */
  AI_RATE_LIMIT_ADMIN_MULTIPLIER: z.coerce.number().int().positive().default(3),
  /**
   * Require a shared counter store for paid AI classes. Only meaningful locally:
   * production and staging always require one, and setting this to `false` there
   * is refused at boot (AI-RATE-LIMIT-HARDENING-01).
   */
  AI_RATE_LIMIT_REQUIRE_DURABLE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Local-development escape hatch for single-process runs. Refused at boot in
   * production and staging — it cannot be used to relax a deployment.
   */
  AI_RATE_LIMIT_ALLOW_MEMORY_STORE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Search (`/api/search`) is public and relatively costly (multi-entity
   * queries), so it is limited per trusted client IP.
   */
  RATE_LIMIT_SEARCH_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_SEARCH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * Marketing-video generation renders synchronously with ffmpeg, so it gets the
   * tightest per-user limit. It is a backstop in addition to the concurrency cap
   * (`MEDIA_VIDEO_MAX_CONCURRENCY`) and the AI budget checks the route already
   * performs.
   */
  RATE_LIMIT_VIDEO_MAX: z.coerce.number().int().positive().default(6),
  RATE_LIMIT_VIDEO_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * Application-level request body cap (011.4). A request whose body exceeds
   * this is rejected with HTTP 413 before any handler reads it, so a large
   * payload cannot be buffered into memory by an expensive route. Sized above
   * the largest legitimate JSON body (long AI prompts); the one upload route
   * (product images) declares its own larger cap in `app.ts`, still bounded.
   */
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /**
   * Maximum number of marketing-video renders running at once in a process
   * (011.4). ffmpeg renders are CPU/memory heavy and synchronous; without a cap
   * a burst of requests would spawn unbounded concurrent renders. Excess
   * requests wait briefly for a slot and are shed with 503 if none frees up, so
   * a legitimate render is never killed mid-flight.
   */
  MEDIA_VIDEO_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** How long a video request waits for a render slot before being shed, in ms. */
  MEDIA_VIDEO_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Maximum number of non-terminal agent tasks a single user may hold at once
   * (011.4). Creating agent tasks is unbounded otherwise; this caps per-user
   * concurrent work without touching the agent RBAC/approval gates.
   */
  AI_AGENT_MAX_ACTIVE_TASKS_PER_USER: z.coerce.number().int().positive().default(25),
  /**
   * AI-MEM-01 — bounds of the institutional agent memory layer. Every memory is
   * a short operational note, so the text cap is small on purpose: a row that
   * needs more space belongs in a business table, not in memory.
   */
  AI_MEMORY_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(2000),
  /** Maximum live memories per (owner, agent) pair; expired rows are evicted first. */
  AI_MEMORY_MAX_PER_AGENT: z.coerce.number().int().positive().default(200),
  /** Maximum live memories per owner across every agent. */
  AI_MEMORY_MAX_PER_OWNER: z.coerce.number().int().positive().default(1000),
  /** Retention used when a caller does not ask for a specific TTL. */
  AI_MEMORY_DEFAULT_TTL_DAYS: z.coerce.number().int().positive().default(90),
  /** Upper bound on a caller-requested TTL. */
  AI_MEMORY_MAX_TTL_DAYS: z.coerce.number().int().positive().default(365),
  /** Character budget of the per-run recall injected into an agent run context. */
  AI_MEMORY_RUN_CONTEXT_CHARS: z.coerce.number().int().positive().default(600),
  /**
   * AI-MET-01 — persistent agent metrics. The log is append-only in the existing
   * `agent_metrics` table; these bounds decide when an open task is considered
   * stalled, how much a backfill may do in one call, and how many log rows a
   * single report may scan for percentile maths.
   */
  AI_METRICS_AUTO_RECORD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** An open task older than this is reported as stalled (not "timed out"). */
  AI_METRICS_STALL_AFTER_MINUTES: z.coerce.number().int().positive().default(30),
  /** Maximum tasks a single backfill call reconstructs. */
  AI_METRICS_BACKFILL_BATCH: z.coerce.number().int().positive().default(500),
  /** Cap on metric rows read by one report; exceeding it sets `truncated`. */
  AI_METRICS_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  /**
   * AI-SUP-02 — supervisor escalation to the General Manager. Detection runs on
   * the scheduler cadence below; every threshold is here so an operator can tune
   * sensitivity without touching code. The central kill switch stops detection
   * and automatic notification regardless of these values.
   */
  AI_ESCALATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** How often the escalation sweep runs. */
  AI_ESCALATION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  /** Detection window; the comparison window is the one before it. */
  AI_ESCALATION_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  /** Share of settled runs that must fail before an agent is escalated. */
  AI_ESCALATION_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.5),
  /** Settled runs needed before a failure rate is treated as signal. */
  AI_ESCALATION_MIN_SAMPLES: z.coerce.number().int().positive().default(3),
  /** Success-rate drop between windows that counts as degradation. */
  AI_ESCALATION_DEGRADATION_DELTA: z.coerce.number().min(0).max(1).default(0.25),
  /** An open task older than this is escalated as stalled. */
  AI_ESCALATION_STALL_MINUTES: z.coerce.number().int().positive().default(120),
  /** An approval waiting longer than this is escalated as pending. */
  AI_ESCALATION_PENDING_APPROVAL_MINUTES: z.coerce.number().int().positive().default(240),
  /** Tool failures per agent in the window that warrant a look. */
  AI_ESCALATION_TOOL_FAILURES: z.coerce.number().int().positive().default(3),
  /** Refusals per agent in the window that suggest a boundary being pushed. */
  AI_ESCALATION_REFUSALS: z.coerce.number().int().positive().default(3),
  /** Supervisor cycle failures in the window that warrant a look. */
  AI_ESCALATION_CYCLE_FAILURES: z.coerce.number().int().positive().default(1),
  /** Per-scan cap on cases written; the most severe findings win. */
  AI_ESCALATION_MAX_CASES: z.coerce.number().int().positive().default(200),
  /**
   * Record one deterministic `task_result` memory per terminal agent task. It
   * carries status/latency/code only — never a model guess, never task output.
   */
  AI_MEMORY_AUTO_RECORD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Number of reverse proxies we operate in front of the API (LC-08). `0`
   * (default) means the API is reached directly, so `X-Forwarded-For`/`X-Real-IP`
   * are attacker-controlled and ignored: the client is the real TCP peer. Set it
   * to the exact count of our own proxies (e.g. `1` behind a single nginx) so the
   * client is read from the forwarded chain instead — but only when the peer
   * matches `TRUSTED_PROXY_CIDRS`. Setting it higher than the real number of
   * proxies would trust a client-supplied hop. See `lib/net/client-ip.ts`.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(20).default(0),
  /**
   * Explicit allowlist of proxy networks whose `X-Forwarded-For` is trusted
   * (LC-08), comma/space-separated CIDRs, e.g. `10.20.0.0/24,2001:db8::/32`.
   * Empty by default: **no** proxy is trusted, and loopback/RFC1918/ULA are
   * never trusted implicitly. Trust is honoured only for a peer whose socket
   * address matches an entry here, and only in combination with
   * `TRUSTED_PROXY_HOPS`. Invalid entries are ignored (with a warning), never
   * treated as a trust-all. Keep this to your real proxy addresses; it must be
   * set from the actual network layout, never guessed.
   */
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  // In-process scheduler. Off by default so tests and one-off commands never
  // start background jobs; a single production instance (or a cron hitting the
  // admin route) enables it. Rollover itself is idempotent across workers.
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Scheduled AI agent execution (AI-01). Off by default: automatic agent runs
  // make provider calls and must be an explicit operator choice. `interval` is
  // the sweep cadence; `min interval` is the shortest cadence a schedule may
  // have (guards against resource-draining configurations); `lease seconds`
  // bounds how long a claimed schedule stays reserved before another worker may
  // reclaim it after a crash.
  AI_AGENT_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AI_AGENT_SCHEDULER_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  AI_AGENT_SCHEDULE_MIN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  AI_AGENT_SCHEDULE_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  // Agent-run execution reliability (AI-02.3.1). `recovery enabled` runs the
  // stuck-step reconciliation sweep; off by default so tests and one-off commands
  // never start background work. `stuck seconds` is how long a step may stay
  // RUNNING before recovery considers it abandoned; `lease seconds` bounds how
  // long a recovery claim on a step is held (defaults to `stuck seconds`, floored
  // at 60s). There is deliberately no auto-dispatch flag: recovery only ever
  // reconciles; dispatching a step is always an explicit, authorised action.
  AI_AGENT_RUNS_RECOVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AI_AGENT_RUNS_RECOVERY_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  AI_AGENT_RUN_STEP_STUCK_SECONDS: z.coerce.number().int().positive().default(300),
  // AI-02.S1 — Agent Supervisor cycle. Off by default so tests and one-off
  // commands never start background work; a deployment turns it on. The cycle is
  // bounded, idempotent and conditional-write guarded across instances.
  AI_AGENT_RUNS_SUPERVISOR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Central AI Kill Switch seed (A1). The initial state of the process-global
   * execution gate: `false` disables ALL AI execution at boot (new tasks,
   * dispatch, schedules, supervisor, recovery) until an authorised operator
   * re-enables it. Defaults to `true` so existing behaviour is unchanged; a
   * deployment under review can boot with it off. Runtime enable/disable is the
   * admin control and does not persist across restarts.
   */
  AI_AGENT_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  AI_AGENT_RUNS_SUPERVISOR_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  // Dispute auto-escalation sweep. Off by default so tests and one-off commands
  // never start background work; a deployment (or a cron hitting the admin
  // trigger route) turns it on. The sweep is idempotent across instances.
  DISPUTE_ESCALATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISPUTE_ESCALATION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  // RFQ expiry sweep (B2B-01 phase 3). Off by default so tests and one-off
  // commands never start background work. The sweep only moves rows whose
  // deadline has already passed and every transition is a guarded UPDATE, so a
  // duplicate run — another instance or a manual cron — writes nothing twice.
  RFQ_EXPIRY_SWEEP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RFQ_EXPIRY_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  RFQ_EXPIRY_SWEEP_BATCH_SIZE: z.coerce.number().int().positive().default(100),
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
  // Backup heartbeat. The nightly backup writes a small JSON file after each
  // successful run; the `backup_stale` alert rule reads it and fires when the
  // schedule silently stops. Empty path = the rule is disabled, because a
  // deployment without scheduled backups must not page about missing ones.
  BACKUP_HEARTBEAT_FILE: z.string().default(''),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().positive().default(26),
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
  /**
   * Voiceover engine for marketing videos (AFC-06). `piper` is a local neural
   * TTS (MIT) that runs offline; `none` disables voiceover, which the quality
   * gate then reports as a hard failure instead of shipping a silent advert.
   */
  TTS_ENGINE: z.enum(['piper', 'none']).default('piper'),
  /** Explicit piper binary path; autodetected when unset. */
  TTS_PIPER_PATH: z.string().optional(),
  /** Directory holding the piper `.onnx` voices (never committed). */
  TTS_VOICES_DIR: z.string().optional(),
  /** Explicit ffmpeg for audio work; falls back to VIDEO_FFMPEG_PATH, then ffmpeg-static. */
  TTS_FFMPEG_PATH: z.string().optional(),
  /** Explicit ffprobe for audio duration checks; falls back to PATH. */
  TTS_FFPROBE_PATH: z.string().optional(),
  /** Explicit ffprobe for the video quality gate; falls back to PATH. */
  FFPROBE_PATH: z.string().optional(),
  /**
   * Root of the recorded voice packs (`<dir>/<language>/manifest.json`).
   * A licensed human pack takes precedence over a synthetic voice.
   */
  VOICE_PACK_DIR: z.string().optional(),
  /** Music bed level relative to the voiceover, in dB (negative = quieter). */
  VIDEO_MUSIC_GAIN_DB: z.coerce.number().default(-21),
  /** Ceiling for the mixed programme loudness target (EBU R128, LUFS). */
  VIDEO_LOUDNESS_TARGET_LUFS: z.coerce.number().default(-16),
  /** Lifetime of a signed media download link, in seconds. */
  MEDIA_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MEDIA_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(52_428_800),
  /** Ceiling for one uploaded product image (bytes). */
  MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5_242_880),
  /** How many images one product may carry. */
  MEDIA_MAX_IMAGES_PER_PRODUCT: z.coerce.number().int().positive().default(8),
  /**
   * Longest side of the display copy produced at upload. `0` stores the
   * validated original untouched (useful for debugging or a slim build).
   */
  MEDIA_IMAGE_MAX_DIMENSION: z.coerce.number().int().nonnegative().default(1600),
  /**
   * Retention for agent-rendered videos (AFC-05). Retention is per class:
   * temporary test renders (7d) and drafts (30d) expire; approved videos are
   * never removed automatically. Reads never delete.
   */
  AGENT_VIDEO_TEST_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  AGENT_VIDEO_DRAFT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;


/**
 * Dev-only convenience routes (surfacing verification links, phone codes and
 * reset tokens) exist so an environment without a reachable mailbox or SMS
 * gateway can finish those flows. They are on for local development and tests.
 * A deployed environment must opt in explicitly with `ALLOW_DEV_TOOLING=true`
 * (staging only — production is refused below), because anyone who can reach the
 * API could otherwise mint tokens for any address.
 *
 * Read at call time by {@link devToolingActive} rather than frozen into a
 * constant, so the gate follows the parsed env and stays testable over HTTP.
 */
export function devToolingActive(): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || env.ALLOW_DEV_TOOLING;
}

if (env.NODE_ENV === 'production' && env.ALLOW_DEV_TOOLING) {
  // eslint-disable-next-line no-console
  console.error('Refusing to start: ALLOW_DEV_TOOLING cannot be enabled in production.');
  process.exit(1);
}

/**
 * Whether registration marks the account email-verified so the visitor can sign
 * in immediately (public demo only). Production is excluded twice over: the
 * deployment refuses to boot with the flag set, and the resolver ignores it, so
 * a stray `DEMO_SKIP_EMAIL_VERIFICATION=true` in a production secret store can
 * neither start the process nor relax the gate. Read at call time by
 * {@link demoEmailVerificationSkipped}.
 */
if (env.NODE_ENV === 'production' && env.DEMO_SKIP_EMAIL_VERIFICATION) {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to start: DEMO_SKIP_EMAIL_VERIFICATION cannot be enabled in production. ' +
      'Email verification is mandatory on a real deployment.',
  );
  process.exit(1);
}

export function demoEmailVerificationSkipped(): boolean {
  return env.NODE_ENV !== 'production' && env.DEMO_SKIP_EMAIL_VERIFICATION;
}

/**
 * Whether the `/demo/customer` auto-login entry point may mint a session for the
 * seeded demo account. Production is excluded twice over, exactly like
 * {@link demoEmailVerificationSkipped}: the deployment refuses to boot with the
 * flag set, and this resolver ignores it, so a stray `DEMO_AUTO_LOGIN=true` in a
 * production secret store can neither start the process nor open the route.
 */
if (env.NODE_ENV === 'production' && env.DEMO_AUTO_LOGIN) {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to start: DEMO_AUTO_LOGIN cannot be enabled in production. ' +
      'Demo auto-login mints a real session without credentials.',
  );
  process.exit(1);
}

export function demoAutoLoginEnabled(): boolean {
  return env.NODE_ENV !== 'production' && env.DEMO_AUTO_LOGIN;
}

/**
 * Whether this deployment may run a demonstration payment rail (the offline
 * `manual` provider, whose "confirmation" is self-attested rather than observed
 * at a bank). Production is excluded twice over, like the other demo flags: the
 * deployment refuses to boot with it, and this resolver ignores it, so a stray
 * `DEMO_PAYMENT_MODE=true` in a production secret store can neither start the
 * process nor admit a self-attested payment on real money.
 */
if (env.NODE_ENV === 'production' && env.DEMO_PAYMENT_MODE) {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to start: DEMO_PAYMENT_MODE cannot be enabled in production. ' +
      'The offline payment provider proves nothing about real money.',
  );
  process.exit(1);
}

export function demoPaymentMode(): boolean {
  return env.NODE_ENV !== 'production' && env.DEMO_PAYMENT_MODE;
}

/**
 * The currency platform-wide reporting aggregates are expressed in when a caller
 * does not name one. Aggregating across orders of different currencies would sum
 * incomparable amounts, so reporting is pinned to this single configured value
 * instead of defaulting per query site.
 */
export function reportingCurrency(): string {
  return env.REPORTING_CURRENCY;
}

/**
 * The committed development secret must never sign sessions on a deployed
 * environment. `staging` is reachable over the network just like production, so
 * a forgotten `JWT_SECRET` there would let anyone forge a session. Fail closed at
 * boot rather than start with a publicly known signing key.
 */
const DEV_JWT_SECRET = 'dev-only-secret-not-for-production-please-change-me-1234567890';
if ((env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') && env.JWT_SECRET === DEV_JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error(
    `Refusing to start: JWT_SECRET is the committed development default in ${env.NODE_ENV}. ` +
      'Set JWT_SECRET (>=32 chars) from the environment or a secret store.',
  );
  process.exit(1);
}

/**
 * Whether the session cookie is marked `Secure`. Production keeps its previous
 * always-secure behavior. Staging is decided by the public URL scheme: a staging
 * stack served over plain HTTP on localhost must not set `Secure`, or the browser
 * drops the cookie and login fails silently, while an HTTPS staging deployment
 * must set it.
 */
export const cookieSecure =
  env.NODE_ENV === 'production' ||
  (env.NODE_ENV === 'staging' && env.APP_URL.startsWith('https://'));

/**
 * Whether mandatory MFA for internal staff is enforced (LC-06).
 *
 * `auto` (default) enforces it in **production only**. Staging is deliberately
 * excluded because WASIT's staging stack is the *public demo* (published staff
 * credentials, no real data) — enforcing there would lock the demo out. A real
 * pre-production staging that is not a public demo must set
 * `STAFF_MFA_ENFORCEMENT=on`. `off` disables enforcement entirely.
 */
export function staffMfaEnforced(): boolean {
  if (env.STAFF_MFA_ENFORCEMENT === 'off') return false;
  if (env.STAFF_MFA_ENFORCEMENT === 'on') return true;
  return env.NODE_ENV === 'production';
}

/**
 * Whether mandatory acceptance of *published* legal documents is enforced
 * (LC-01). Default `off`: the platform must never block sign-in or normal use on
 * an unapproved draft, and it must never record a consent to a text that is not
 * in force. It is turned `on` only after qualified counsel approves texts and
 * they are published with a version and an effective date.
 *
 * This is intentionally independent of `NODE_ENV`: enabling enforcement is an
 * explicit, reviewed act, never inferred from the environment. Even when `on`,
 * the guard only blocks when a document is actually published-and-in-force
 * (`isAcceptable`), so the flag against drafts is a no-op.
 */
export function legalAcceptanceEnforced(): boolean {
  return env.LEGAL_ACCEPTANCE_ENFORCEMENT === 'on';
}

/**
 * Resolves the CORS origin option. When `CORS_ORIGIN` is unset the platform
 * keeps reflecting whatever origin sends the request (the existing dev/test
 * behavior); when it is configured, only listed origins — plus the app's own
 * origin — are echoed back, so a foreign site cannot read credentialed
 * responses from a deployed environment.
 */
export function resolveCorsOrigin(origin: string | undefined): string | null {
  const allowed = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.length === 0) return origin ?? '*';
  if (!origin) return null;
  const normalized = origin.replace(/\/$/, '');
  const selfOrigin = env.APP_URL.replace(/\/$/, '');
  return allowed.includes(normalized) || normalized === selfOrigin ? origin : null;
}
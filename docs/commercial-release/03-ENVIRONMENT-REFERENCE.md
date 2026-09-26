# Environment Reference

Every runtime variable the platform reads. **Copy the template, never commit a
filled-in file.**

| Template | Used by | Copy to |
| --- | --- | --- |
| `packages/server/.env.example` | API (`@wasit/server`) | `packages/server/.env` |
| `.env.staging.example` | full staging stack | `.env.staging` |

The API loads its environment with `dotenv` from the **process working
directory**, so the file must be at the root the process is started from (see
[`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md)).

> **Secrets rule.** No value below that is marked *secret* may be committed,
> baked into an image, or pasted into a chat. Inject them from the platform's
> secret store at deploy time.

---

## 1. Core

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | One of `development`, `test`, `staging`, `production`. Drives the fail-closed guards in §9. |
| `PORT` | `3000` | API listen port. |
| `DATABASE_URL` | *(none)* | **secret.** PostgreSQL connection string. Required in every deployed environment. |

## 2. Security

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | dev placeholder | **secret.** ≥32 chars. The process **refuses to start** in `staging`/`production` if this is still the committed dev value. |
| `SESSION_SECRET` | *(none)* | **secret.** Session-cookie signing. |
| `SESSION_TTL_DAYS` | `30` | Session lifetime. |
| `MAX_LOGIN_ATTEMPTS` | `5` | Failed logins before lockout. |
| `LOCKOUT_MINUTES` | `15` | Lockout duration. |
| `EMAIL_VERIFY_TTL_HOURS` | `24` | Email-verification token lifetime. |

## 3. Rate limiting

| Variable | Default | Notes |
| --- | --- | --- |
| `RATE_LIMIT_REGISTER_MAX` | `10` | Registrations per window. Raise for CI/tests. |
| `RATE_LIMIT_LOGIN_MAX` | `15` | Logins per window. |
| `RATE_LIMIT_STORE` | `memory` | `memory` (single instance) or `postgres` (**required when running more than one API instance** — counters must be shared). |
| `RATE_LIMIT_PURGE_INTERVAL_MINUTES` | `15` | Scheduler interval to drop expired buckets. |

## 4. App URLs / CORS

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_URL` | `http://localhost:5173` | Public SPA origin; used to build links in email. |
| `API_URL` | `http://localhost:3000` | Public API origin. |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed browser origin for credentialed requests. |
| `PUBLIC_API_URL` | *(empty)* | Origin used to build absolute preview URLs in JSON. Empty = relative. |

## 5. AI

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | `noop` | `none` / `local-heuristic` (real local engine, no cost) / `openai` / `anthropic` / `noop`. |
| `AI_API_KEY` | *(empty)* | **secret.** Required only for external providers. |
| `AI_MODEL` | *(empty)* | Optional model override; falls back to capability policy then `AI_DEFAULT_MODEL`. |
| `AI_DEFAULT_MODEL` | `openai-gpt-4o-mini` | Catalogue key of the default model. |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Hard per-call timeout for external providers. |
| `AI_BUDGET_MONTHLY_USD` | *(see code)* | Monthly AI spend ceiling per user/role. |

## 6. Payments

Only **one** provider is active, selected by `PAYMENT_PROVIDER`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PAYMENT_PROVIDER` | `noop` | `noop` / `manual` / `open-checkout` / `flouci` / `clictopay`. |
| `PAYMENT_WEBHOOK_SECRET` | *(empty)* | **secret.** HMAC verification for `manual`/`open-checkout` only. Flouci/ClicToPay are verified by querying provider status, not by signature. |
| `DEMO_PAYMENT_MODE` | *(false)* | Opt-in harness for the offline provider. Never enable in production. |
| `FLOUCI_BASE_URL` | `https://developers.flouci.com` | Flouci API base. |
| `FLOUCI_PUBLIC_KEY` | *(empty)* | **secret.** |
| `FLOUCI_PRIVATE_KEY` | *(empty)* | **secret.** |
| `CLICTOPAY_BASE_URL` | `https://test.clictopay.com/payment/rest` | Sandbox default; production is `https://ipay.clictopay.com/payment/rest`. |
| `CLICTOPAY_USERNAME` | *(empty)* | **secret.** Granted by SPS/banque. |
| `CLICTOPAY_PASSWORD` | *(empty)* | **secret.** |

## 7. Mail & SMS

| Variable | Default | Notes |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `log` | `log` = no-network (prints a redacted line + writes a `MAIL.SENT` audit row). `smtp` = real delivery. |
| `MAIL_FROM` | `WASIT BUSINESS GLOBAL <no-reply@wasit.tn>` | Envelope sender. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | *(empty)* / `587` / `false` | SMTP endpoint. |
| `SMTP_USER` / `SMTP_PASSWORD` | *(empty)* | **secret.** |
| `SMS_TRANSPORT` | `log` | `log` or `http`. |
| `SMS_SENDER` | `WASIT` | Sender id. |
| `SMS_HTTP_URL` | *(empty)* | Gateway endpoint for `http`. |
| `SMS_HTTP_AUTH_SCHEME` | `none` | `none` / `bearer` / `basic`. |
| `SMS_HTTP_TOKEN` | *(empty)* | **secret.** For bearer. |
| `SMS_HTTP_USERNAME` / `SMS_HTTP_PASSWORD` | *(empty)* | **secret.** For basic. |
| `SMS_HTTP_TO_FIELD` | `to` | JSON field names for the gateway body. |
| `SMS_HTTP_TEXT_FIELD` | `text` | |
| `SMS_HTTP_SENDER_FIELD` | `from` | |
| `PHONE_VERIFY_TTL_MINUTES` | `10` | |
| `PHONE_VERIFY_MAX_ATTEMPTS` | `5` | |

## 8. Media & marketing video

| Variable | Default | Notes |
| --- | --- | --- |
| `MEDIA_STORAGE` | `local` | On-disk driver. Assets are private, written under opaque keys and served only via signed short-lived links. |
| `MEDIA_STORAGE_DIR` | `.wasit-media` | Storage root. Must be a persistent volume in production. |
| `VIDEO_PROVIDER` | `structural` | `structural` = real MP4 render via bundled ffmpeg + libass (Arabic shaping). `noop` fails loudly. |
| `VIDEO_FFMPEG_PATH` | *(empty)* | Override the bundled `ffmpeg-static` binary. |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `720` / `1280` | Portrait output. |
| `VIDEO_FPS` | `25` | |
| `VIDEO_FONT` | `DejaVu Sans` | Latin fallback. |
| `VIDEO_ARABIC_FONT` | `Noto Sans Arabic` | Arabic shaping font (bundled in `packages/server/assets/fonts/`). |
| `VIDEO_FONTS_DIR` | *(empty)* | Extra font directory. |
| `MEDIA_DOWNLOAD_TTL_SECONDS` | `900` | Signed download-link lifetime. |
| `MEDIA_MAX_VIDEO_BYTES` | `52428800` | 50 MiB output ceiling. |

> The **35–120 second** duration window is a business rule held in
> `@wasit/shared` (`MARKETING_VIDEO_DURATION`), not an env var — the UI and the
> API guard read the same constant so they cannot drift.

## 9. Dev tooling & safety guards

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOW_DEV_TOOLING` | `false` | Surfaces token-minting routes (verification links, phone codes, reset tokens, TOTP). On automatically in `development`/`test`. **Refused in `production` regardless of value** (the process exits). Only enable on a pre-production QA host. |
| `DEMO_SKIP_EMAIL_VERIFICATION` | `false` | Marks registrations email-verified so a public-demo visitor can sign in immediately. **Refused in `production`** (process exits). |
| `DEMO_AUTO_LOGIN` | `false` | Public-demo auto-login. Refused in production. |
| `DEMO_STAFF_PASSWORD` | *(empty)* | **secret.** Credential for the seeder's `admin@`/`admin2@` fixtures. If unset on `NODE_ENV=staging`, a random per-run secret is generated instead of falling back to the published demo password. |
| `DEMO_TEST_ACCOUNT_PASSWORD` | *(empty)* | **secret.** Overrides the published password for the public demo account. |

## 10. Scheduler & observability

| Variable | Default | Notes |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `false` | In-process background jobs (subscription rollover). Idempotent across workers. Leave `false` in tests and one-off commands. |
| `SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES` | `60` | |
| `OBS_LOG_LEVEL` | `info` | Also the floor for the in-process buffer behind the admin logs route. |
| `OBS_LOG_FORMAT` | `json` | `json` for collectors; `pretty` for a terminal. |
| `OBS_ALERTS_ENABLED` | `false` | Requires the scheduler for interval evaluation; also triggerable from the admin route. |
| `OBS_ALERT_INTERVAL_MINUTES` | `5` | |
| `OBS_ALERT_NOTIFY` | `log` | `log` always works; `webhook` POSTs to `OBS_ALERT_WEBHOOK_URL`. |
| `OBS_ALERT_WEBHOOK_URL` | *(empty)* | Slack/PagerDuty bridge. |
| `OBS_ALERT_WEBHOOK_TOKEN` | *(empty)* | **secret.** |
| `METRICS_ENABLED` | `true` | Prometheus endpoint at `/metrics`. |
| `METRICS_TOKEN` | *(empty)* | **secret.** When set, `/metrics` requires `Authorization: Bearer …`. Otherwise restrict it at the network layer. |

## 11. Cache

| Variable | Default | Notes |
| --- | --- | --- |
| `CACHE_ENABLED` | `false` | Read cache for hot reference reads (geo, categories, sitemap). Writes invalidate their namespace, so the TTL bounds only *unwritten* change lag. |
| `CACHE_TTL_SECONDS` | `60` | |
| `CACHE_MAX_ENTRIES` | `500` | |

## 12. Backup tooling (scripts only)

| Variable | Default | Notes |
| --- | --- | --- |
| `BACKUP_ROOT` | `<repo>/backups` | Output root for `scripts/backup-db.sh`. |
| `BACKUP_INCLUDE_TEST_DB` | `false` | Also dump `TEST_DATABASE_URL`. |
| `BACKUP_RETENTION_COUNT` | `7` | Recent folders to keep; `0` = keep all. |
| `PG_BIN` | *(PATH)* | Postgres client bin dir if not on `PATH`. |

## 13. Test-only variables

Set by `packages/server/vitest.config.ts`; you normally never export these.

| Variable | Purpose |
| --- | --- |
| `TEST_DATABASE_URL` | Database the suite drops/recreates. |
| `DOTENV_CONFIG_PATH` | Points `dotenv` at a non-existent file so an untracked local `.env` cannot leak dev flags into the suite. |
| `ALLOW_DEV_TOOLING` | Pinned `false` so a shell that exports it cannot make `devToolingActive()` true under the suite's `NODE_ENV=production` overrides. |
| `PAYMENT_PROVIDER` / `DEMO_PAYMENT_MODE` / `PAYMENT_WEBHOOK_SECRET` | Drive the offline provider with a real HMAC secret — no network, no mocks. |

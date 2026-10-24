# COMMERCIAL RELEASE MANIFEST — WASIT BUSINESS GLOBAL / LE WASSIT

> **Release name:** WASIT BUSINESS GLOBAL — Commercial Release 2026-09-26
> **Archive:** `WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip`
> **Date:** 2026-09-26
> **Audited commit:** `f3a730c` (branch `master`) · **Packaging:** docs-only commit on top of it
> **Previous release commit:** `6f7a029`

---

## 1. Release summary

| Item | Value |
| --- | --- |
| Release name | WASIT BUSINESS GLOBAL — Commercial Release 2026-09-26 |
| Date | 2026-09-26 |
| Audited commit | `f3a730c` |
| Packaging commit | docs-only commit on top of `f3a730c` (no product code) |
| Server tests | 645 / 645 PASS (60 files) |
| E2E | 204 passed / 0 failed / 8 conditional skipped (32 files) |
| Browser functional smoke | 57 / 57 PASS, zero 5xx |
| Typecheck | PASS (server + web) |
| Build | PASS (server `build:prod` + web `build`) |
| Git tree at packaging | clean |
| Commission policy | 4% total = 2% seller + 2% buyer (unchanged) |

---

## 2. Components included in the archive

Everything below is tracked in git and exported from the packaging commit.

### Source code

| Component | Path |
| --- | --- |
| Monorepo root (workspaces, scripts, lockfile) | `package.json`, `package-lock.json` |
| API server | `packages/server/` |
| Web client (React + Vite + TS) | `packages/web/` |
| Shared types / packages | `packages/*` |

### Database

| Component | Path |
| --- | --- |
| Schema definitions (Drizzle) | `packages/server/src/db/schema/` |
| Migrations | `packages/server/src/db/migrations/` (48 SQL files) |
| Seeders | `packages/server/src/scripts/seed.ts`, `seed-demo.ts` |
| Verification tooling | `packages/server/src/scripts/verify-money-path.ts`, `explain-hot-queries.ts`, `load-smoke.ts` |
| Backup / restore scripts | `scripts/backup-db.sh`, `scripts/restore-db.sh`, `scripts/backup-restore.test.sh` |

### Domain modules

AI agents · payments · commission · subscriptions · advertising · trust · risk ·
verification · disputes · reconciliation · settlements · payouts · revenue ·
inventory · orders · products · search · media (Marketing Video) · messaging ·
notifications · privacy · observability · admin · analytics · i18n
(`packages/web/src/lib/i18n.ts`, `i18n-context.tsx`).

### Tests

| Suite | Path |
| --- | --- |
| Unit / integration (60 files) | `packages/server/tests/` |
| E2E (32 files) | `e2e/` |
| Playwright config | `playwright.config.ts` |
| Browser functional smoke suites | `customer-smoke.mjs`, `merchant-smoke.mjs`, `purchase-smoke.mjs`, `video-smoke.mjs`, `preview-smoke.mjs` |

### Operations & packaging

| Component | Path |
| --- | --- |
| Container images | `Dockerfile`, `Dockerfile.web` |
| Compose stack | `docker-compose.yml`, `.dockerignore` |
| CI/CD | `.github/workflows/ci.yml` |
| Reverse proxy | `deploy/nginx.conf` |
| Backup units / cron | `scripts/deploy/` |
| Staging smoke | `scripts/staging-smoke.sh`, `scripts/demo-security-smoke.sh` |

### Configuration templates (safe, no real values)

`packages/server/.env.example`, `.env.staging.example`

### Documentation

| Document | Path |
| --- | --- |
| Checkpoint (project state) | `CHECKPOINT.md` |
| Agent / contributor guide | `AGENTS.md` |
| Final audit | `docs/commercial-release/FINAL-AUDIT.md` |
| This manifest | `docs/commercial-release/COMMERCIAL-RELEASE-MANIFEST.md` |
| Release overview & runbooks | `docs/commercial-release/00-RELEASE-OVERVIEW.md`, `04-DEPLOYMENT-GUIDE.md`, `05-RUNBOOK-DEV.md`, `06-VERIFICATION-EVIDENCE.md`, `07-BUSINESS-INVARIANTS.md`, `08-OPERATIONS-RUNBOOK.md`, `09-TESTING-GUIDE.md`, `03-ENVIRONMENT-REFERENCE.md` |
| Architecture / API / DB / security / payments | `docs/ARCHITECTURE.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/SECURITY_MODEL.md`, `docs/PAYMENT_PROVIDERS.md`, and the rest of `docs/` |

---

## 3. Files excluded from the archive

| Excluded | Reason |
| --- | --- |
| `node_modules/` | Reproducible from `package-lock.json` |
| `.env`, `.env.demo`, `.env.staging`, `.env.e2e-local` | Real/working credentials — never shipped |
| Any API key, password, token, private credential, production secret | Security |
| `dist/`, `dist-bundle/`, `build/`, `coverage/` | Build artifacts, regenerable |
| `.wasit-media*`, `.e2e/`, `test-results/`, `backups/` | Runtime state, generated media, test output |
| Logs, caches, editor/OS files | Non-essential |
| `.git/` | History is not part of the source distribution (the commit hash is recorded here instead) |

The archive contains **no** secret values. All configuration files shipped are
templates with placeholder or empty values.

---

## 4. Runtime requirements

| Requirement | Version / notes |
| --- | --- |
| Node.js | >= 20 (LTS) |
| npm | >= 10 (workspaces) |
| PostgreSQL | >= 15 |
| Playwright browsers | Installed via `npx playwright install --with-deps` (tests / smoke only) |
| OS | Linux (x64) for the documented flow; macOS/Windows work for development |

---

## 5. Local run steps

```bash
# 1. Extract
unzip WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip
cd wasit-business-global   # (archive root)

# 2. Install dependencies (from the lockfile)
npm ci

# 3. Configure environment
cp packages/server/.env.example packages/server/.env
#    then edit .env: set DATABASE_URL and a JWT_SECRET of >= 32 chars
#    generate one with: openssl rand -hex 32

# 4. Create the database and apply migrations
createdb wasit_dev
npm run db:migrate

# 5. Seed reference data (and, optionally, demo data)
npm run db:seed
npx tsx packages/server/src/scripts/seed-demo.ts   # optional demo accounts

# 6. Run
npm run dev        # API  -> http://localhost:3000
npm run web        # web  -> http://localhost:5173   (separate terminal)

# 7. Verify
npm run typecheck
npm test
npm run test:e2e
```

> The API and web run as two processes. The web dev server proxies `/api` to the
> API, so no CORS configuration is needed locally.

---

## 6. Production requirements (must be provided externally)

The archive is self-contained for **code**, but a production deployment needs the
following supplied by the operator. None of these ship in the archive.

| # | Requirement | Notes |
| --- | --- | --- |
| 1 | Production VM / server | Linux host with Node 20+ and PostgreSQL 15+, sized for expected load |
| 2 | DNS | An A/AAAA record for the public hostname pointing at the server |
| 3 | TLS / HTTPS | Certificate for the public hostname (e.g. Let's Encrypt); `deploy/nginx.conf` terminates TLS |
| 4 | PostgreSQL (production) | A managed or self-hosted instance; the app never provisions one |
| 5 | Payment provider / account | Live merchant account and its credentials for the chosen provider |
| 6 | AI provider / API keys | Key for the configured AI provider (external mode) |
| 7 | Object / file storage | Durable storage for uploaded and generated media |
| 8 | Backup destination | Off-host target for `scripts/backup-db.sh` (see `scripts/deploy/`) |
| 9 | Centralized alert webhook | Endpoint for observability alerts (`OBS_ALERT_WEBHOOK_URL`) |
| 10 | Production secrets | `JWT_SECRET` (>= 32 chars), DB password, payment and AI credentials, `PAYMENT_WEBHOOK_SECRET`, `METRICS_TOKEN` — stored in a secret manager, never in the repo |
| 11 | Email provider (SMTP) | Required for verification, password recovery and notifications |
| 12 | SMS provider (optional) | Only if SMS notifications are enabled |
| 13 | Domain configuration | `APP_URL` / `API_URL` / `CORS_ORIGIN` set to the real hostnames |

---

## 7. Required environment variables (names only, no secret values)

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` / `staging` / `development` |
| `PORT` | API listen port |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Session signing secret (>= 32 chars) |
| `SESSION_SECRET` | Session cookie secret |
| `APP_URL` | Public web origin |
| `API_URL` | Public API origin |
| `CORS_ORIGIN` | Allowed browser origin |
| `PAYMENT_PROVIDER` | Active payment provider |
| `PAYMENT_WEBHOOK_SECRET` | Provider webhook signature secret |
| `AI_PROVIDER` / `AI_API_KEY` | AI provider selection and key |
| `METRICS_ENABLED` / `METRICS_TOKEN` | Prometheus scrape endpoint and its bearer token |
| `OBS_ALERT_WEBHOOK_URL` / `OBS_ALERT_WEBHOOK_TOKEN` | Alert delivery |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | Email delivery |
| `BACKUP_HEARTBEAT_FILE` / `BACKUP_MAX_AGE_HOURS` | Backup freshness monitoring |
| `CACHE_ENABLED` | Read cache toggle |

The full annotated list is in `packages/server/.env.example` and
`.env.staging.example`. Both contain placeholders only.

---

## 8. External services required

| Service | Required? | Used for |
| --- | --- | --- |
| PostgreSQL | **Yes** | Primary datastore |
| Payment provider | **Yes** (live commerce) | Card/wallet acquiring and webhooks |
| AI provider | **Yes** for external mode | Marketing Video and AI agents |
| SMTP email | **Yes** | Verification, recovery, notifications |
| Object storage | Recommended | Durable media storage |
| Backup target | **Yes** for production | Off-host database backups |
| Alert webhook | Recommended | Observability alert delivery |
| SMS gateway | Optional | SMS notifications |

---

## 9. Reproducibility statement

The archive was verified to rebuild and run from source without any secret that
lives outside the repository. The check was performed on a **fresh extraction**
of the shipped archive, against a PostgreSQL instance created for the test:

| Step | Command | Result |
| --- | --- | --- |
| Install from lockfile | `npm ci` | PASS |
| Typecheck | `npm run typecheck` | PASS (server + web) |
| Server build | `npm run build:prod` | PASS |
| Web build | `npm run build -w @wasit/web` | PASS |
| Migrate | `npm run db:migrate` | PASS — migrations applied |
| Seed | `npm run db:seed` | PASS |
| Demo seed | `npx tsx packages/server/src/scripts/seed-demo.ts` | PASS |
| Full server test suite | `npm test` | **PASS — 645 / 645, 60 files** |
| Boot the built server | `node dist-bundle/index.cjs` | PASS — `wasit api listening` |
| Health probe | `GET /api/health/ready` | **200** |
| Real login | `POST /api/auth/login` (demo customer) | **200, `success: true`** |
| Product catalog | `GET /api/products` | **200 — 13 products** |

No step required a credential that is not documented in
`packages/server/.env.example`. The verification database and role were created
by the operator, exactly as a new user would.

- Dependencies install from the committed `package-lock.json` (`npm ci`).
- The schema is reproduced from the committed Drizzle migrations; no `push` and
  no manual DDL is required.
- All configuration is supplied through environment variables documented above;
  the shipped examples contain placeholders, not working credentials.
- Tests, E2E and the browser smoke suites run against a database the operator
  creates, with the operator's own credentials.

### Environment-specific defaults to review before production

Two source files still carry defaults tied to the sandbox this platform was
developed in. They are **not secrets** and they do not affect production, but a
deployer should be aware of them:

| File | Default | Effect |
| --- | --- | --- |
| `packages/web/vite.config.ts` | `ALLOWED_HOSTS` lists four `*.prod-runtime.all-hands.dev` hosts | Only the Vite dev/preview server enforces this list; production serves through `deploy/nginx.conf`, which is unaffected. Extend the list (or set your own) if you use `vite preview` behind a different hostname. |
| `preview-smoke.mjs` | `BASE_URL` defaults to a sandbox preview URL | Smoke script only. Pass `BASE_URL=https://your-host` to point it anywhere. |

Neither was changed in this release: the instructions for this task were to
package the audited commit, and editing product code after the audit would
invalidate it.

---

## 10. Integrity

| Item | Value |
| --- | --- |
| Archive name | `WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip` |
| Entries | 483 files |
| Integrity check | `unzip -t <archive>` — exit 0, no errors detected |
| SHA-256 | recorded in `WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip.sha256`, shipped alongside the archive |

The digest lives in a sidecar file rather than in this document: a hash written
inside the archive cannot describe the archive that contains it, because adding
the hash changes the very bytes being hashed.

Verify after transfer:

```bash
unzip -t WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip
sha256sum -c WASIT-BUSINESS-GLOBAL-COMMERCIAL-RELEASE-2026-09-26.zip.sha256
```

---

## 11. Admin Trust empty state — resolved

When the Trust table is empty, the desk used to show a message telling the
operator to recompute scores, but the recompute button was only rendered inside
existing rows, so the instruction could not be followed from that screen. The
empty state now renders a user picker and a recompute control that call the same
`POST /api/admin/trust/:userId/recompute` endpoint (permission `TRUST_READ_ALL`)
as a row action, so the first score can be created from the desk. Covered by the
E2E test "trust desk creates the first score from an empty table (picker path)"
in `e2e/functional-audit.spec.ts`; recorded in `FINAL-AUDIT.md`.

---

## 12. Manual/offline payment completion — resolved

The `manual` (offline desk) rail produces no signed provider callback, so an
offline order could never leave `PENDING`: only the webhook handler set
`paymentStatus = PAID`. The desk now has an operator-only completion path,
`POST /api/payments/orders/:orderId/complete-manual`, surfaced on `/admin/orders`
when the active rail is `manual` and the order is `PENDING`. It reuses the same
internal `applyPaymentSucceeded` transition as the webhook, inside a transaction
with a row lock so concurrent completions yield exactly one transition. It is
refused server-side for anyone without `REFUND_MANAGE`, for a non-offline rail,
for an order with no payment in progress, and outside demo mode (the `manual`
harness is a demo provider, so this is a demonstration path, not a production
payment integration). It records the **payment only** — never a settlement.
Covered by `packages/server/tests/manual-payment-completion.test.ts` and the E2E
`e2e/manual-payment.spec.ts`; recorded in `FINAL-AUDIT.md`.

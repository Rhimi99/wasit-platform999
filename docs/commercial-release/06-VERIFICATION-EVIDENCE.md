# Verification Evidence

> **Release commit:** `d9edeb8` (branch `master`)
> **Date:** 2026-09-26
> **Method:** every gate below was executed against this commit; the exact
> commands and observed results are reproduced here.

This file exists so a receiving team can judge the release on evidence rather
than on assurance. Every claim is a command anyone can re-run.

---

## 1. Gate summary

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | PASS — server + web, 0 errors |
| Unit / integration | `npm test` | PASS — **645 / 645** tests, 60 files |
| End-to-end | `npx playwright test` | PASS — **204 / 204** tests, 32 files, 0 failures |
| Server production build | `npm run build:prod -w @wasit/server` | PASS |
| Web production build | `npm run build -w @wasit/web` | PASS |
| Fresh-environment rebuild | migrate → seed → boot → login → order | PASS (see §4) |

---

## 2. Unit / integration

```
$ npm test
 Test Files  60 passed (60)
      Tests  645 passed (645)
   Duration  72.15s
```

The suite runs against a real PostgreSQL database, dropped and recreated per
run, with the shipping migrations applied — no mocks. See
[`09-TESTING-GUIDE.md`](./09-TESTING-GUIDE.md) §1 for the hermeticity guarantees
and the known shared-database concurrency rule.

---

## 3. End-to-end

```
$ PORT=3104 E2E_API_URL=http://localhost:3104 API_URL=http://localhost:3104 npx playwright test
  8 skipped
  204 passed (7.2m)
```

Chromium, one worker, serial by design (the specs share one seeded database).
The browser talks only to the web origin; Vite proxies `/api` to the API, so the
session cookie stays same-origin.

### Why the API port is verified before the suite starts

`reuseExistingServer` adopts whatever already answers on the API port. During
this release that behaviour was observed to adopt a **different** server — a
staging build against a different database and a different
`PAYMENT_WEBHOOK_SECRET` — and the resulting failures (payments, financial
audit, privacy desk) looked like product bugs but were an artifact of the run.

The same specs all pass when the suite starts its own server. `playwright.config.ts`
now reads the listener's environment from `/proc/<pid>/environ` and refuses to
run against a server whose environment does not match the suite's, naming the
pid and the mismatched variable.

### Coverage

Real UI flows across all actor groups: auth and session guards, i18n direction
switching, registration, public-demo entry points, marketplace browse, search,
product detail, cart and order placement, payments, merchant product/inventory
flows, ads and targeting, messaging, notifications, admin desks (users,
products, orders, transactions, ledger, audit, verification, trust, risk,
disputes, policies, ads, AI governance, subscriptions, observability, privacy),
reports, unit economics, settlement integrity, and the **marketing-video
studio**.

The marketing-video spec is the newest addition and covers the whole journey:
generate from the UI (product + language + audience + style + duration) → asset
reaches `READY` as a real `video/mp4` with a non-zero size → preview renders →
download returns real bytes → delete removes the card from the library. It also
asserts the two refusals: generating with no product selected, and a customer
calling the endpoint without the `media:upload` permission (403).

---

## 4. Fresh-environment rebuild

This is the gate that proves the package is self-contained: the tree was
extracted into an empty directory, dependencies installed from the lockfile, a
brand-new empty PostgreSQL database created, all 25 migrations applied, the
seeders run, the production bundle built and started — then exercised over HTTP.

The observed sequence:

1. `npm ci` — installs from the lockfile, no network surprises.
2. `createdb` a new empty database; `npm run migrate` applies all 25 migrations.
3. Seeders run (idempotent).
4. `npm run build:prod -w @wasit/server`, then start the bundle.
5. `GET /api/health/ready` → `200 {"status":"ready","db":"connected"}`.
6. `POST /api/auth/login` with a seeded account → `200`, session cookie issued.
7. `GET /api/products` → real listings from the fresh database.
8. Place an order → `201`, order persisted.
9. `GET /api/admin/stats` with an admin session → `200` with real KPIs.

Reproduction steps are in [`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md).

---

## 5. Invariants re-confirmed

| Invariant | Evidence |
| --- | --- |
| Commission policy **4% = 2% seller + 2% buyer** | The admin ledger shows the paired `COMMISSION` and `PAYMENT_FEE` entries at 2% each of transaction value. |
| Marketing Video Agent intact | Generation through the real UI and API produces a real MP4; `MEDIA.MARKETING_VIDEO_GENERATED` appears in the audit log. |
| Payments refuse unverified settlement evidence | `SETTLEMENT_CONFIRMED` is rejected for a provider that declares no `settlementEvidence` capability (unit + E2E). |
| Production never serves dev tooling | `ALLOW_DEV_TOOLING` is pinned `false` in the test config; specs that need it flip `env` at call time. |
| No destructive database operations | Migrations are additive; the test suite only drops its own `TEST_DATABASE_URL`. |

---

## 6. Known limitations

- **Bundle size.** The web bundle is ~718 kB (~187 kB gzipped) in one chunk;
  the build warns about it. Functional, but code-splitting is the next win.
- **Concurrency.** Vitest runs spec files in parallel against one database, so a
  spec asserting a *global* row count of a shared table (e.g. `audit_logs`) will
  be intermittently flaky. Scope such assertions to the row's own id.
- **E2E is serial.** `workers: 1` is deliberate; parallelising it would require
  per-worker databases.

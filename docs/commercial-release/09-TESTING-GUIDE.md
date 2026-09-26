# Testing Guide

Three layers, all real — **no mocks** anywhere in the suite. Every layer talks to
a real PostgreSQL database and real services.

| Layer | Tool | Scope | Command |
| --- | --- | --- | --- |
| Unit / Integration | Vitest | API modules, money path, guards | `npm test` |
| End-to-End | Playwright | real browser → real SPA → real API → real DB | `npm run test:e2e` |
| Static gates | tsc | server + web typecheck, prod build | `npm run typecheck`, `npm run build:prod` |

---

## 1. Unit / Integration (Vitest)

```bash
export TEST_DATABASE_URL=postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test
npm test
```

- **60 spec files, 645 tests.**
- The suite **drops and recreates** `TEST_DATABASE_URL` per run, then applies the
  real migrations — so it exercises the same schema that ships.
- **Never point `TEST_DATABASE_URL` at `wasit_dev` or any database you care
  about.** It is destructive by design.

### Hermeticity guarantees

`packages/server/vitest.config.ts` deliberately isolates the suite from your
shell and from any untracked `.env`:

- `DOTENV_CONFIG_PATH` points `dotenv` at a **non-existent** file, so an
  untracked `packages/server/.env` cannot leak dev flags (e.g.
  `DEMO_SKIP_EMAIL_VERIFICATION=true`) into the run.
- `ALLOW_DEV_TOOLING` is pinned to `false`, so a shell that exports it (the
  demo/staging envs set it to `true`) cannot make `devToolingActive()` true under
  a spec that overrides `NODE_ENV=production` — which would wrongly report that
  production serves dev tooling.
- Rate limits are raised so the many-registrations specs don't trip anti-abuse.

Specs that need a dev flag flip the parsed `env` **at call time** through a
`withEnv` helper and drive the real HTTP surface — they never mock the service.

### Known concurrency behaviour

Vitest runs spec **files in parallel** against **one** shared database. Specs
must therefore not assert on **global** row counts of tables other files also
write to (e.g. `audit_logs`); scope such assertions to the row's own id. The
`persistence-invariants` provenance spec does exactly this. If you add a spec
that counts a shared table globally, it will be intermittently flaky.

## 2. End-to-End (Playwright)

```bash
npm run test:e2e
```

- **32 spec files**, Chromium, `workers: 1`, `fullyParallel: false` — serial by
  design because specs share one seeded database.
- `e2e/global-setup.ts` runs the project's **own idempotent demo seeder**
  (`seed-demo.ts`) and then performs a **real `POST /api/auth/login`** for each
  demo role, storing the resulting session cookie as Playwright `storageState`.
  The login **form** itself is still exercised by `auth.spec.ts`.
- The config starts **both** real servers: the API (`npm run dev -w @wasit/server`)
  and the Vite SPA. The browser only ever talks to the web origin; Vite proxies
  `/api` to the API, keeping the session cookie same-origin.
- Because `reuseExistingServer` is on outside CI, `playwright.config.ts` first
  **proves the listener on the API port was started by this suite**: it reads the
  listener's own environment from `/proc/<pid>/environ` and compares it with the
  env the config sets (rate limits, `PAYMENT_WEBHOOK_SECRET`,
  `DEMO_SKIP_EMAIL_VERIFICATION`, …). A mismatch is a hard stop naming the
  offending pid and variable, rather than a silent run against foreign code and a
  foreign database — which otherwise surfaces as failures that look like product
  bugs. `E2E_ALLOW_FOREIGN_SERVER=true` opts out when reusing a server is
  genuinely intended.

### Prerequisites

The E2E stack runs against `wasit_dev` (see `playwright.config.ts`), which must
exist, be migrated, and be reachable with the credentials the config's
`DATABASE_URL` uses. See [`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md) §2–§4.

### What E2E covers

Real UI flows across the actor groups — auth and session guards, i18n direction
switching, registration, the public-demo entry points, marketplace browse,
product detail, cart and order placement, merchant product/inventory flows,
ads and placement targeting, messaging, notifications, admin desks, disputes,
trust/risk, verification, subscriptions, and the marketing-video studio.

### Environment knobs

| Variable | Effect |
| --- | --- |
| `DEMO_SKIP_EMAIL_VERIFICATION` | `true` exercises the public-demo register-then-sign-in contract. Default `false` proves verification is mandatory. |
| `DEMO_AUTO_LOGIN` | Default `false` proves the auto-login endpoint is **refused** rather than merely untested. |
| `E2E_WEB_URL` / `E2E_API_URL` | Point at an already-running stack instead of starting one. |

## 3. Static gates

```bash
npm run typecheck          # tsc --noEmit, server + web
npm run build:prod -w @wasit/server
npm run build -w @wasit/web
```

CI (`.github/workflows/ci.yml`) gates on **typecheck + build** on Node 22.

## 4. Backups of the test database

`scripts/backup-db.sh` also dumps `TEST_DATABASE_URL` when
`BACKUP_INCLUDE_TEST_DB=true`. It is off by default because the test database is
disposable.

## 5. Interpreting a failure

| Symptom | Likely cause |
| --- | --- |
| `password authentication failed` | `TEST_DATABASE_URL` not exported; the built-in default was used |
| A count assertion off by one, only in a full run | A spec asserting a **global** table count while sibling files write in parallel |
| `devToolingActive` expected `false`, got `true` | A shell exported `ALLOW_DEV_TOOLING=true`; the release pins it in the config |
| E2E cannot reach the API | `wasit_dev` missing/unmigrated, or port 3000 already in use |
| A demo login returns 401 in E2E | A previously interrupted run left the account on a temporary password; `global-setup` repairs this through the real reset flow |

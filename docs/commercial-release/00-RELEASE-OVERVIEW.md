# WASIT BUSINESS GLOBAL — Commercial Release Overview

> **Product:** WASIT BUSINESS GLOBAL (LE WASSIT)
> **Release version:** 0.1.0
> **Release commit:** `d9edeb8` (branch `master`)
> **Audience:** receiving Engineering + DevOps team
> **Status:** source-complete, verified on a fresh environment (see §Verification)

---

## 1. What this package is

This is the **commercial release package** for the WASIT BUSINESS GLOBAL
platform — a multi-sided B2B/B2C trade platform (marketplace, orders,
payments, settlement ledger, messaging, ads, AI agents and marketing-video
generation) with four actor groups: **Customer**, **Merchant/Supplier/Company**,
**Admin/Staff**, and the platform's automated **AI agents**.

It is **not just source code**. It contains:

- the full verified source tree at a single commit,
- all 25 database migrations and both seeders,
- the complete unit/integration and Playwright E2E suites,
- Docker build and Compose orchestration assets,
- the nginx reverse-proxy configuration,
- environment templates with every variable documented,
- backup/restore tooling and a CI pipeline,
- and this `docs/commercial-release/` runbook set for a new Dev/DevOps team.

## 2. What "verified" means in this package

Every gate below was re-run against release commit `d9edeb8` before the package
was assembled. The exact commands and observed results are recorded in
[`06-VERIFICATION-EVIDENCE.md`](./06-VERIFICATION-EVIDENCE.md).

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | PASS (server + web) |
| Unit/Integration | `npm test` | PASS |
| E2E | `npm run test:e2e` | PASS |
| Production build | `npm run build:prod -w @wasit/server` | PASS |
| Fresh-env rebuild | migrate → seed → boot → login → order | PASS |

The **fresh-environment rebuild** is the important one: the package was
extracted from git into an empty directory, dependencies installed from the
lockfile, a brand-new empty PostgreSQL database created, migrations applied,
seeders run, the production server bundle built and started, and then a real
customer login, marketplace browse, order creation and admin KPI read were
performed against it. See
[`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md) for the exact reproduction steps.

## 3. Repository layout

```
.
├── packages/
│   ├── server/          @wasit/server — Express + Drizzle API
│   │   ├── src/
│   │   │   ├── modules/     feature modules (auth, orders, payments, …)
│   │   │   ├── db/          schema + 25 migrations + seeds
│   │   │   ├── lib/         security, media, payments, observability
│   │   │   └── scripts/     migrate / seed / seed-demo entry points
│   │   ├── tests/           Vitest unit + integration suite
│   │   └── assets/fonts/    Noto Sans Arabic (video renderer shaping)
│   ├── web/             @wasit/web — React + Vite SPA
│   └── shared/          @wasit/shared — cross-package types + constants
├── e2e/                 Playwright end-to-end specs
├── deploy/              nginx reverse-proxy config
├── scripts/             backup/restore + staging smoke tooling
├── docs/                architecture, product, and this release runbook
├── Dockerfile           API image
├── Dockerfile.web       SPA + nginx image
├── docker-compose.yml   local/staging orchestration
└── .github/workflows/   CI pipeline
```

## 4. Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22 (LTS) |
| Language | TypeScript 5 |
| API | Express |
| ORM / Migrations | Drizzle ORM `^0.36` + drizzle-kit |
| Database | PostgreSQL 16 (17 client compatible) |
| Auth | JWT (`jose`) + argon2 password hashing, session cookies |
| Frontend | React + Vite SPA, i18n (ar/fr/en/zh) with RTL |
| Validation | Zod `^3.23` |
| Media | `ffmpeg-static` + libass + Noto Sans Arabic |
| Tests | Vitest (unit/integration), Playwright (E2E) |
| Container | Docker + Docker Compose, nginx reverse proxy |

## 5. Scope boundaries (read before promising features)

These items are **deliberately not implemented** and must not be sold as
present without a new work order:

- **WASIT AI COPILOT** — specified only, in
  `docs/AI_ARCHITECTURE.md` §6.5 and `docs/ARCHITECTURE_DECISIONS.md` (AD-043).
  It is an *orchestration layer*, not one of the 11 shipped agents. It is not
  coded and not scheduled in any phase.
- **Recommendations, Offers**, and some admin country/currency/language
  management screens — planned, not built (`docs/PROJECT_BASELINE.md`).
- Some display-only dashboard screens (`/dashboard/finance`, `/dashboard/reports`,
  `/dashboard/sales`) render placeholders where they intersect admin data,
  because no backing entity is defined yet. These are documented, not broken.

The **11 shipped AI agents** (Sales, Marketing, Ads, Product, Support,
Analytics, Market Research, B2B, Risk, Dispute Assistant, Development) are real
and implemented under `packages/server/src/modules/ai/`.

## 6. Business invariants that must be preserved

Anyone modifying this platform must keep these intact:

1. **Commission policy is DB-driven**, not hardcoded. The base policy is
   **4% of transaction value = 2% seller + 2% buyer**
   (`rate=0.04, seller_rate=0.02, buyer_rate=0.02`). The engine reads the policy
   from the database; there is no hardcoded fallback. See
   [`07-BUSINESS-INVARIANTS.md`](./07-BUSINESS-INVARIANTS.md).
2. **Payment ≠ Settlement ≠ Commission Earned ≠ Commission Received.** These are
   distinct states with independent transitions; do not collapse them.
3. **The marketing-video duration policy is 35–120 seconds inclusive**, enforced
   in one shared constant used by both API and UI.
4. **Arabic-first identity** — RTL is the default direction, Arabic is the
   default locale, and the marketing-video renderer must produce real Arabic
   glyphs via the bundled shaping font.

## 7. Where to go next

| If you want to… | Read |
| --- | --- |
| understand the architecture | `docs/ARCHITECTURE.md`, `docs/AI_ARCHITECTURE.md` |
| run it locally | [`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md) |
| deploy it | [`04-DEPLOYMENT-GUIDE.md`](./04-DEPLOYMENT-GUIDE.md) |
| know every env var | [`03-ENVIRONMENT-REFERENCE.md`](./03-ENVIRONMENT-REFERENCE.md) |
| run the test suites | [`09-TESTING-GUIDE.md`](./09-TESTING-GUIDE.md) |
| see what was verified | [`06-VERIFICATION-EVIDENCE.md`](./06-VERIFICATION-EVIDENCE.md) |
| prepare for production | [`10-PRODUCTION-READINESS.md`](./10-PRODUCTION-READINESS.md) |
| survive an incident | [`08-OPERATIONS-RUNBOOK.md`](./08-OPERATIONS-RUNBOOK.md) |
| understand the data model | [`11-DATA-MODEL.md`](./11-DATA-MODEL.md) |
| understand security posture | [`12-SECURITY-NOTES.md`](./12-SECURITY-NOTES.md) |

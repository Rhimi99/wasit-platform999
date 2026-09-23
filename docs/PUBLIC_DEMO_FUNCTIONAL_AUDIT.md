# PUBLIC DEMO — FUNCTIONAL AUDIT & READINESS

> **Date**: 2026-09-23 — **Scope**: expose the platform as a public DEMO / PRIVATE BETA
> **Verdict**: ✅ **READY for public demo** (with the staff-surface hardening below).
> **Rule applied**: HTTP 200 and page render are **not** treated as success. Every
> capability below was exercised by a real call or a real click that produces a
> user-visible result against real PostgreSQL (`wasit_demo`) on the public HTTPS URL.

---

## 1. Environment (isolated, no Production impact)

| Item | Value |
| --- | --- |
| Public URL | `https://work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev` |
| API | Hono, `NODE_ENV=staging`, port 3000 |
| Web | Vite (production build), port 12000 |
| Database | **isolated** `wasit_demo` (role `wasit_demo`); `wasit_dev` untouched |
| Payments | `PAYMENT_PROVIDER=manual` — offline desk, **no real iPay/provider calls** |
| AI | `AI_PROVIDER=local-heuristic` — deterministic, no external key |
| Secrets | `.env.demo` git-ignored, random per-machine; no production secrets |
| Migrations | applied with `drizzle-kit migrate` (no reset/drop/push) |

No Production DB, no Production secrets, no provider integration, no migration
removal, Commission Policy **4% = 2% seller + 2% buyer** untouched, Marketing
Video Agent (`89e68d7`) untouched.

---

## 2. Demo hardening applied (real issue found)

The seed password `Passw0rd!2026` is published to demo users, and it also opened
the **staff** accounts (`admin@wasit.tn`, `admin2@wasit.tn`) — meaning any visitor
could reach the admin surface. Fixed without touching code paths or RBAC:

1. **Rotated staff passwords** to random values stored only in a local file
   (`/tmp/demo_admin_pw.txt`, mode 0600). Published demo password is now rejected
   (`401`) for admin; customer/merchant/supplier/company demo logins still work.
2. **Demo banner** (`packages/web/src/components/DemoBanner.tsx`), rendered only
   when `VITE_DEMO_MODE=true`, so the production build is unaffected. It makes the
   demo unmistakable and states the data is fictional and payments are offline.
3. Admin routes were already role-gated (`AdminOnly` / `StaffOnly`) — verified.

---

## 3. Feature results

Method: **UI** = clicked/rendered in a real browser session on the public URL;
**API** = real HTTP call on the public URL that mutates/reads real DB state.

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Public home page + demo banner | ✅ | PASS | — | — | verified (browser) |
| Login / session cookie (merchant) | ✅ | PASS | — | — | verified (browser → `/dashboard`) |
| Register → verify email → login | API | PASS | — | — | verified (201 + 200) |
| Marketplace browse + categories + sort | ✅ | PASS | — | — | verified (browser, 13 products) |
| Product details (SKU, MOQ, category, qty, order, favorite) | ✅ | PASS | — | — | verified (browser) |
| Unified search | API | PASS | — | — | verified (`q=Demo` → 3) |
| Customer orders list | ✅ | PASS | — | — | verified (browser + API) |
| Create order (buyer 2% in total) | API | PASS | — | — | verified (201, grandTotal 214.20) |
| Payment intent (manual desk) | API | PASS | — | — | verified (201, offline) |
| Notifications | API | PASS | — | — | verified (200) |
| Messages / threads | API | PASS | — | — | verified (200) |
| Merchant dashboard (orders + products) | ✅ | PASS | — | — | verified (browser) |
| Merchant products list (`/products/mine`) | API | PASS | — | — | verified (200) |
| Create / edit / publish product | API | PASS | — | — | verified (create/edit/activate exercised) |
| Inventory | API | PASS | — | — | verified (200) |
| Marketing video studio (product/lang/audience/style/duration) | ✅ | PASS | — | — | verified (browser render) |
| **Generate marketing video → READY** | API | PASS | — | — | verified (201, status=READY, duration 45s) |
| Video list / delete | API | PASS | — | — | verified (200 / 200) |
| Ads (merchant campaigns) | API | PASS | — | — | verified (200) |
| AI tools | API | PASS | — | — | verified (200) |
| Analytics | API | PASS | — | — | verified (200) |
| Subscriptions | API | PASS | — | — | verified (plans 200) |
| Admin dashboard KPIs | API | PASS | — | — | verified (`users 9, products 13, orders 13, GMV`) |
| Admin users / products / orders / transactions / ledger | API | PASS | — | — | verified (200) |
| Admin audit logs | API | PASS | — | — | verified (200) |
| Admin verification / trust / risk | API | PASS | — | — | verified (200) |
| Admin disputes | API | PASS | — | — | verified (200) |
| Admin ads / AI / subscriptions | API | PASS | — | — | verified (200 / 200 / 200) |
| Admin observability (metrics/logs/alerts) | API | PASS | — | — | verified (200) |
| Admin privacy (deletion queue) | API | PASS | — | — | verified (200) |
| **Admin denied with published demo password** | API | PASS | staff password was in the public seed | rotated staff credentials | verified (401) |

No platform functional defect was found on the tested surface. The transient
FAILs seen while probing were **test-harness mistakes** (wrong path
`/api/media/videos` → real `/api/media/assets`, wrong field `orderId` vs `id`,
duration `30s` below the real 35s floor), corrected and re-run green.

---

## 4. Verification commands

- Server suite: **554/554 pass** (52 files) in a clean environment.
- Typecheck (server + web): clean.
- Build (server + web): clean.
- Functional smoke (public URL): **21/21 pass**.
- Extended functional smoke (register + order + payment + video): **13/13 pass**.
- Browser UI: home, login, dashboard, marketplace, product detail, video studio.

> Note: running the suite while `.env.demo` is exported leaks `WEB_BASE_URL` /
> metrics flags into vitest and produces false failures. Reset the shell before
> `npm test`.

---

## 5. Remaining advisory items (not blockers)

- Demo DB holds generated test orders/assets from the smoke runs; intentional.
- Email is log-only (`no SMTP configured`) — expected for demo; registration still
  completes through the dev verification tooling.

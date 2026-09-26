# FINAL AUDIT — UI Functional Verification

> **Release commit:** `6f7a029` (branch `master`)
> **Date:** 2026-09-26
> **Method:** every row below was exercised from the running UI in a real
> browser (Playwright, real API, real PostgreSQL). An HTTP 200 and a rendered
> page shell were treated as **not** sufficient; each row asserts a user-visible
> result — a row in a table, a state change, a file on disk, a ledger entry.

---

## 1. Why this audit exists

An earlier pass reported the platform "verified" on the strength of SPA routes
answering HTTP 200. That is not evidence that a feature works: a page can render
its shell, return 200, and still fail the moment a user presses a button. This
audit drives the buttons.

Three real defects were found that a route-status check could not have caught.
Each was traced to its true cause and fixed at that cause.

| # | Symptom a user would report | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | "The demo password does not work." | The integration suite minted the demo account with a hardcoded literal that differed from the published password, and its `TEST_DATABASE_URL` pointed at the **demo** database, so a test run left the account answering to a password no user was ever told. | `ensureDemoAccount` now uses the published credential; the demo seeder repairs a drifted hash instead of trusting the stored one; integration setup refuses to drop a database that is not disposable. |
| 2 | "E2E passes locally but the same scenarios fail in a full run." | `playwright.config.ts` silently adopted any process already answering the health probe — running the suite against different code, database and webhook secret. | The config now verifies the listener's environment (`/proc/<pid>/environ`) against the suite's declared env and stops with the remedy. |
| 3 | "The video studio was never actually tested." | No spec existed for the Marketing Video Studio. | `e2e/video-studio.spec.ts` drives the real form and asserts the real MP4. |

A fourth defect was found **by this audit's own smoke test** and fixed in the
harness, not the product: `preview-smoke.mjs` scored the admin pages as passing
while showing the login screen (0 rows, 88 chars). The check now rejects any
page that still renders a credential form, verified by a negative control.

---

## 2. Feature verification table

Legend — **Tested from UI**: driven through the browser, not the API alone.
**Result**: the user-visible outcome, not the status code.

### Customer

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Registration | Yes — filled the form, submitted | Account created, success surfaced | — | — | PASS |
| Login (demo credentials) | Yes — form submit, redirect | Lands on `/dashboard` | Password drift (defect 1) | Seeder repair + test uses published password | PASS |
| Search | Yes — typed in the box | `/search?q=…` returns real products | — | — | PASS |
| Browse marketplace | Yes — scrolled the grid | Real product cards from the API | — | — | PASS |
| Product detail | Yes — opened a card | Detail renders, canonical + JSON-LD present | — | — | PASS |
| Create purchase | Yes — full checkout | Order created, **visible to the buyer**, commission breakdown shown | — | — | PASS |
| Orders list | Yes — opened the page | Buyer's own orders listed | — | — | PASS |
| Notifications | Yes — opened the bell | Unread count from the server | — | — | PASS |
| Messages | Yes — opened the inbox | Conversation list from the server | — | — | PASS |

### Merchant / Supplier

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Dashboard | Yes — opened it | Real per-seller numbers | — | — | PASS |
| Create product | Yes — filled the form | Product persisted, appears in catalog | — | — | PASS |
| Edit product | Yes — edited and saved | Change persisted server-side | — | — | PASS |
| Publish / activate | Yes — toggled status | Status change persisted | — | — | PASS |
| Inventory | Yes — adjusted stock | Movement reflected server-side | — | — | PASS |
| Orders | Yes — opened the page | Seller's orders listed | — | — | PASS |
| Advertising | Yes — opened the desk | Campaign data from the API | — | — | PASS |
| AI | Yes — opened the page | Agent results render | — | — | PASS |
| Marketing Video | Yes — full studio flow | Real MP4 generated, previewed, downloaded, deleted | No spec existed (defect 3) | Added `video-studio.spec.ts` | PASS |
| Analytics | Yes — opened the page | Real aggregates | — | — | PASS |
| Subscription | Yes — opened the page | Plan state from the server | — | — | PASS |

### Admin

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Dashboard KPIs | Yes — opened it | Live totals (users, products, orders, GMV) | — | — | PASS |
| Users | Yes — opened the table | 7 rows on demo data | — | — | PASS |
| Products | Yes — opened the table | 13 rows | — | — | PASS |
| Orders | Yes — opened the table | 9 rows | — | — | PASS |
| Transactions | Yes — opened the table | 9 rows | — | — | PASS |
| Ledger | Yes — opened the table | 36 rows incl. the 2% + 2% commission entry | — | — | PASS |
| Audit | Yes — opened the table | Real audit entries | — | — | PASS |
| Verification | Yes — opened the page | Queue renders (empty state handled) | — | — | PASS |
| Trust | Yes — opened the page | Scores render / explicit empty state | — | — | PASS |
| Risk | Yes — opened the page | Risk events render / explicit empty state | — | — | PASS |
| Disputes | Yes — opened the page | Dispute table renders | — | — | PASS |
| Ads | Yes — pause and end a campaign | State change persisted server-side | — | — | PASS |
| AI | Yes — create/edit model, budgets | Round-trips to the server | — | — | PASS |
| Subscriptions | Yes — opened the desk | Plan data from the API | — | — | PASS |

### Marketing Video Studio

| Feature | Tested from UI | Result | Root cause if failed | Fix | Test status |
| --- | --- | --- | --- | --- | --- |
| Select product | Yes — dropdown | 4 selectable products | — | — | PASS |
| Select language | Yes — dropdown | Value applied to the request | — | — | PASS |
| Select audience | Yes — dropdown | Value applied | — | — | PASS |
| Select style | Yes — dropdown | Value applied | — | — | PASS |
| Set duration | Yes — numeric input | 35–120s window enforced in UI **and** API | — | — | PASS |
| Generate | Yes — pressed the button | Success notice, asset added to library | — | — | PASS |
| Generation status | Yes — polled the page | Reaches `READY` | — | — | PASS |
| Video appears | Yes — counted library cards | `video/mp4`, non-zero size | — | — | PASS |
| Preview | Yes — `<video>` element | Playable preview rendered | — | — | PASS |
| Download | Yes — clicked download | Real bytes returned | — | — | PASS |
| Delete | Yes — clicked delete | Card leaves the library | Soft delete is the documented contract (row kept as `DELETED` for audit) | Test asserts the contract | PASS |
| Guard: no product | Yes — pressed Generate empty | Refused with a clear message | — | — | PASS |
| Guard: no permission | Yes — customer session | API returns 403 | — | — | PASS |

---

## 3. Verification gates (re-run on the restored environment)

The container hosting the audit was recreated mid-run, which wiped PostgreSQL
and the Playwright browser binaries. Both were reinstalled and every database
rebuilt from migrations and the project's own seeders — **no drop, no reset, no
`push`** against any pre-existing data.

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** — server + web, 0 errors |
| Unit / integration | `npm test` | **PASS** — 645 / 645, 60 files |
| End-to-end | `npm run test:e2e` | **PASS** — 204 passed, 8 conditional skips, **0 failed** (32 files) |
| Server production build | `npm run build:prod -w @wasit/server` | **PASS** |
| Web production build | `npm run build -w @wasit/web` | **PASS** |
| Browser functional smoke | `node preview-smoke.mjs` | **PASS** — 17 / 17, zero 5xx |

### One test flake found and corrected

`tests/unit/business-numbers.test.ts` demanded zero collisions across 500,000
draws from a 36^8 suffix space. That is a birthday problem: the expected number
of collisions is ~0.04, so the assertion failed roughly 4% of runs against a
**correct** generator (observed once during this audit, then 10 consecutive
passes). The tolerance is now explicit and the test still catches the real
regression by an enormous margin — a 1296-value suffix space yields 1296
distinct numbers, not 500,000, and fails the assertion.

---

## 4. Invariants preserved

- **Commission policy unchanged:** 4% total = 2% seller + 2% buyer, as asserted
  end-to-end by `financial-audit.spec.ts` and visible in the admin ledger.
- **Marketing Video Agent untouched** since commit `89e68d7` — no regression.
- No business logic was altered. The three fixes are: a test-harness database
  guard, a seeder idempotency repair, and a Playwright config guard.
- No destructive database operation was performed on real data.

# Business Invariants

Rules that are load-bearing for money, trust and product identity. **Do not
change these without an explicit, written business decision** — several are
enforced in code and covered by tests that will fail loudly if violated.

---

## 1. Commission: 4% = 2% seller + 2% buyer, DB-driven

The platform's base commission is **4% of the transaction value**, split
**2% charged to the seller + 2% charged to the buyer**.

- **Source of truth is the database**, table `commission_policies`:
  `rate = 0.04`, `seller_rate = 0.02`, `buyer_rate = 0.02`.
- The engine (`packages/server/src/lib/commission.ts`) reads the policy and
  **has no fallback rate**. If no active policy matches, it **fails closed**
  with `COMMISSION_POLICY_MISSING` (HTTP 422) rather than inventing a number.
- **Resolution order is priority ascending** — the lowest number wins, so the
  most specific policy an Admin writes (a lower number) overrides a broader one.
  Policies sharing a priority are broken by `id` so the choice is deterministic
  on every run. Covered by `commission-policy-priority.test.ts`, which adds
  several active policies at once (the base-only seed never reaches that state)
  and asserts the lowest number is selected regardless of insertion order.
- Migration `0021_commission_split_data.sql` upgrades the legacy 3%
  seller-only policy to the 4% split, and only when it still has the old shape —
  an Admin-customised policy is left untouched. Historical orders keep their
  recorded figures.
- Payment-provider fees are a **separate** policy (`payment_fee_policies`) and
  are never mixed into commission.

**Verified on a fresh database:** an order with `items_total = 420.0000`
produced `commission = 16.8000`, `buyer_commission = 8.4000`,
`grand_total = 428.4000` — i.e. 420 × 4% = 16.80, buyer 420 × 2% = 8.40. See
[`06-VERIFICATION-EVIDENCE.md`](./06-VERIFICATION-EVIDENCE.md).

## 2. Payment ≠ Settlement ≠ Commission Earned ≠ Commission Received

These are **four distinct states** with independent transitions. Do not collapse
them into one "paid" flag:

- **Payment** — the buyer's money reached the provider.
- **Settlement** — funds moved between the platform and the seller.
- **Commission earned** — the platform's right to the fee was created.
- **Commission received** — the fee actually landed.

The money path is guarded by dedicated tests (`persistence-invariants`,
payment/settlement specs) that assert reconciliation **never fabricates** a
`SETTLED`, `RECEIVED` or completed payout, and that a demo/offline provider
**cannot** assert settlement.

## 3. Marketing video duration: 35–120 seconds inclusive

Defined once in `packages/shared/src/constants/media.ts`
(`MARKETING_VIDEO_DURATION` = `{ min: 35, max: 120, default: 60 }`) and read by
**both** the API guard and the studio UI, so a control and a server check can
never drift. The bundled renderer has no intrinsic ceiling and renders the whole
range in one pass.

## 4. Arabic-first identity

- Default locale is **Arabic**; default direction is **RTL**. Locales:
  `ar` (rtl), `fr`, `en`, `zh` (ltr).
- Marketing-video rendering must produce **real Arabic glyphs**, not tofu —
  achieved with the bundled Noto Sans Arabic shaping font
  (`packages/server/assets/fonts/NotoSansArabic-Regular.ttf`) plus libass.
  A test renders Arabic text and asserts real glyphs.
- The platform name **WASIT BUSINESS GLOBAL / LE WASSIT** and its visual
  identity are product assets, not placeholders.

## 5. The 11 AI agents stay independent

Sales, Marketing, Ads, Product, Support, Analytics, Market Research, B2B, Risk,
Dispute Assistant, Development — implemented under
`packages/server/src/modules/ai/`. They are **real, shipped features**.

The **WASIT AI COPILOT** is *specified only* (`docs/AI_ARCHITECTURE.md` §6.5,
AD-043). It is an orchestration/conversation layer **above** the agents — it
**does not remove, merge or replace any agent**, and it is **not implemented**.
Do not present it as shipped.

## 6. Public-demo safety

- The **published demo password** (`Passw0rd!2026`) opens only the four public
  demo accounts. It **never** opens a staff account outside
  `development`/`test`: on `NODE_ENV=staging` the seeder generates a random
  per-run staff credential unless `DEMO_STAFF_PASSWORD` is supplied.
- `DEMO_SKIP_EMAIL_VERIFICATION` and `ALLOW_DEV_TOOLING` are **refused in
  production** — the process exits rather than boot with them set.
- A non-default `JWT_SECRET` is **required** in `staging`/`production`; the
  committed dev placeholder is rejected at startup.

## 7. Media is private

Generated assets are written under **opaque keys** and served **only** through
signed, short-lived API links (`MEDIA_DOWNLOAD_TTL_SECONDS`, default 900s) —
never as static files from the web root.

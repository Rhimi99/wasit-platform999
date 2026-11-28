# WCDC-02 — Delegated read access to the security centre

The GM's policy, implemented and tested: `SECURITY_READ` belongs to
`SUPER_ADMIN` alone. An `ADMIN` may read the security centre only through an
explicit, scoped, expiring grant that a named `SUPER_ADMIN` issued — and that he
can revoke at once. Delegation is **read only**: it never satisfies a containment,
policy or approval permission.

## The policy, in the code

| Rule | Where it lives |
| --- | --- |
| `SECURITY_READ` is SUPER_ADMIN-only | `packages/shared/src/constants/rbac.ts` — `ADMIN` no longer lists it |
| ADMIN reads only through a live grant | `modules/security/guard.ts` — `requireSecurityRead(scope)` |
| Grant names the beneficiary, the scope, the end | `db/schema/security-delegations.ts` + `modules/security/delegations.ts` |
| Grant names the issuing SUPER_ADMIN | `security_read_grants.granted_by_id` |
| Issuing, amending, revoking are SUPER_ADMIN-only | `requireRole('SUPER_ADMIN')` on every `/delegations` route |
| Revocation applies to the next request | the grant is read from the database per request; it is never a session claim |
| A grant cannot grant, widen or extend itself | the beneficiary has no write route; only the GM amends |
| Reads only | containment, status, approval, scan and block-lift still require `SECURITY_RESPOND` / `SECURITY_MANAGE` |

`ADMIN` losing the role also closes the door: the guard re-checks
`roles.includes('ADMIN')` on every request, so an orphaned grant is inert.

## Scopes

A grant carries one or more of these read surfaces:

`overview`, `incidents`, `events`, `actions`, `blocks`, `rules`, `sessions`,
`external`.

Each route names exactly one scope (`requireSecurityRead('incidents')`, …). A
request outside the grant is refused with 403 and recorded as
`SECURITY.READ_SCOPE_REFUSED`.

## Routes

| Method + path | Who | What |
| --- | --- | --- |
| `GET /api/admin/security/delegations/me` | any authenticated staff | the caller's own live grant (or `heldByRole` for the GM) |
| `GET /api/admin/security/delegations` | SUPER_ADMIN | live grants (`?includeClosed=true` for history) |
| `POST /api/admin/security/delegations` | SUPER_ADMIN | `{ adminEmail or adminUserId, scopes[], expiresInDays or expiresAt, reason }` |
| `PATCH /api/admin/security/delegations/:id` | SUPER_ADMIN | change scopes and/or expiry (amendment) |
| `POST /api/admin/security/delegations/:id/revoke` | SUPER_ADMIN | immediate revocation |

Creation refuses: a non-ADMIN beneficiary (409), a SUPER_ADMIN beneficiary (409,
it already holds the permission), an inactive account (409), the issuer itself
(409), an unknown scope (422), an expiry in the past or beyond
`SECURITY_DELEGATION_MAX_DAYS` (422), a reason shorter than 8 characters (422),
and a second live grant for the same admin (409 — amend or revoke first).

## Audit trail

| Action | When |
| --- | --- |
| `SECURITY.DELEGATION_GRANTED` | grant issued (issuer id, beneficiary, scopes, expiry, reason) |
| `SECURITY.DELEGATION_UPDATED` | scopes or expiry amended (before/after) |
| `SECURITY.DELEGATION_REVOKED` | revoked (who, when, reason) |
| `SECURITY.DELEGATION_EXPIRED` | the sweep passed the expiry (`actorType = SYSTEM`) |
| `SECURITY.READ_REFUSED` | an ADMIN with no live grant, or without the ADMIN role, tried to read |
| `SECURITY.READ_SCOPE_REFUSED` | a live grant that does not cover the requested scope |
| `SECURITY.DELEGATED_READ` | a delegated read of a sensitive surface (`incidents`, `events`, `sessions`, `actions`) |

There is no route that updates or deletes an audit row, for anyone — including
the GM. `tests/wcdc-02-delegation.test.ts` asserts both the absence of a write
path for the beneficiary and that the audit row survives the attempt.

## Expiry

Two independent mechanisms:

1. The guard compares `expires_at` with the clock on every request, so an expired
   grant is refused even before the sweep has run.
2. `sweepWcdcData()` (daily scheduler) sets `expired_at` and writes
   `SECURITY.DELEGATION_EXPIRED`, so the record never looks live.

`create()` closes any already-expired row for that admin first, so the unique
partial index (`one live grant per admin`) never blocks a re-issue.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECURITY_DELEGATION_MAX_DAYS` | `30` | furthest expiry the GM may set |

## Proof

- `packages/server/tests/wcdc-02-delegation.test.ts` — 12 integration tests
  against real PostgreSQL and a real HTTP listener: GM reads; ADMIN without a
  grant is refused (403 + audit); a grant opens only its scopes; sensitive
  delegated reads are audited; self-issue / issue-to-another-ADMIN / issue-to-a-
  CUSTOMER are refused; validation; amendment applies on the next request;
  revocation applies on the same session; expiry is refused immediately and
  recorded; a full-scope grant still cannot contain, approve or scan; the
  beneficiary cannot edit or erase the grant or the trail; removing the ADMIN
  role kills a live grant.
- `e2e/wcdc-security.spec.ts` — 4 Playwright tests against the real UI and API:
  the GM sees live counts, the tabs open real lists, a grant issued on the GM
  screen opens the centre for `admin2@` (verified in a second browser context
  with its own session, and a containment call still 403s), revoking from the GM
  screen closes that same session immediately, and an undelegated ADMIN is shown
  the policy notice instead of an error.

## Migration

`0051_amused_tattoo.sql` — `security_read_grants` (+ two indexes, one unique
partial index) and an idempotent `ALTER TYPE ... ADD VALUE IF NOT EXISTS
'UNBLOCK_IP'` that repairs a snapshot drift from 0050. Applied locally to
`wasit_test` and to a disposable `wasit_dev`; **not** applied to any shared or
production database.

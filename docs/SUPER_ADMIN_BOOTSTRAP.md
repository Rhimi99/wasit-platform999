# SUPER_ADMIN bootstrap

How to create the first platform-owner account on a real deployment, without
opening a public path to it and without weakening RBAC.

## Why this exists

`SUPER_ADMIN` is the highest role in the platform. It sits at the top of
`ROLE_HIERARCHY` (value `100`) and holds every permission in
`ROLE_PERMISSIONS.SUPER_ADMIN`. There is no `PLATFORM_OWNER`, `OWNER` or any role
above it — `SUPER_ADMIN` *is* the platform owner.

Because that role can reach every admin surface, it must never be obtainable
through the public API. Public registration accepts only the roles a visitor may
choose for themselves:

```
CUSTOMER | MERCHANT | SUPPLIER | COMPANY | MARKETER
```

That list is `SELF_SELECTABLE_ROLES` in `@wasit/shared`. It is an allow-list, so
adding a new privileged role later cannot make it self-grantable by omission.
`ADMIN`, `SUPPORT`, `RISK`, `DISPUTE` and `SUPER_ADMIN` are all rejected at
registration with HTTP 422.

The first `SUPER_ADMIN` is therefore provisioned **out of band** by an operator
with server access, using a one-shot CLI.

## The command

```bash
# From the repository root, with DATABASE_URL pointing at the target database.

# 1. Check whether a platform owner already exists (safe, read-only).
SUPER_ADMIN_ACTION=status npm run bootstrap:super-admin

# 2. Create the first one. The password is prompted and hidden.
SUPER_ADMIN_EMAIL=owner@example.com npm run bootstrap:super-admin
```

Non-interactive (CI / a provisioning script) — pipe the password on stdin so it
never lands in the environment or in a process listing:

```bash
printf '%s\n' "$THE_PASSWORD" | \
  SUPER_ADMIN_EMAIL=owner@example.com npm run bootstrap:super-admin
```

On a production build, the bundled entry point is:

```bash
SUPER_ADMIN_ACTION=status node dist-bundle/bootstrap-super-admin.cjs
SUPER_ADMIN_EMAIL=owner@example.com node dist-bundle/bootstrap-super-admin.cjs
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPER_ADMIN_EMAIL` | yes (non-interactive) | The owner's email. Prompted when absent and a TTY is attached. |
| `SUPER_ADMIN_PASSWORD` | no | The password. Prompted (hidden) when absent. |
| `SUPER_ADMIN_ALLOW_ADDITIONAL` | no | `true` permits an additional owner when one already exists. Default `false`. |
| `SUPER_ADMIN_ACTION` | no | `status` reports the current owners and exits without writing. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Provisioned, or `status` reported successfully. |
| `1` | Unexpected failure. |
| `2` | Refused: already provisioned, weak password, or invalid input. |

## What it does, exactly

1. Validates the email and enforces a strong password (≥ 12 characters mixing
   lower, upper, digit and symbol — stricter than the 8-character floor public
   registration applies).
2. Confirms the `SUPER_ADMIN` role row exists (seeded by `npm run db:seed`). It
   never creates roles, so the RBAC matrix stays the single source of truth.
3. Takes a transaction-scoped advisory lock, so two operators running the command
   at the same moment cannot both pass the "already exists?" check.
4. If an owner already exists and `SUPER_ADMIN_ALLOW_ADDITIONAL` is not `true`,
   refuses with exit code 2 and writes an `AUTH.SUPER_ADMIN_BOOTSTRAP_REFUSED`
   audit row.
5. Otherwise creates the account (email pre-verified, active) with an argon2id
   password hash, and grants `SUPER_ADMIN`.

If the email already belongs to an account, the role is granted to that account
and its password is **not** changed — a bootstrap can never silently alter a live
login.

## Audit

Both outcomes are recorded in `audit_logs`:

| Action | When |
| --- | --- |
| `AUTH.SUPER_ADMIN_BOOTSTRAP` | An account was created, or the role was granted to an existing one. |
| `AUTH.SUPER_ADMIN_BOOTSTRAP_REFUSED` | A second owner was attempted without the explicit opt-in. |

`actor_id` is `null` — the bootstrap is a system action performed by whoever has
server access, not an authenticated user. The metadata carries `source`
(`cli`), the outcome, and whether a password was set. The credential itself is
never written to the audit row, to stdout, or to the logs.

## Verification after provisioning

```bash
SUPER_ADMIN_ACTION=status npm run bootstrap:super-admin
```

Then sign in at `/login` with the email and password you supplied. The login
response should report `roles: ["SUPER_ADMIN"]`, and the admin dashboard
(`/api/admin/stats`, `/api/admin/users`, …) should return `200`.

## Security properties

| Property | How it holds |
| --- | --- |
| No public `SUPER_ADMIN` registration | `registerUser` and the registration schema both accept only `SELF_SELECTABLE_ROLES`. |
| No self-promotion | There is no role-mutation endpoint; a crafted `PATCH` returns 404. |
| No `ADMIN`-to-`SUPER_ADMIN` path | The admin surface exposes no role-grant endpoint. |
| One owner by default | A second bootstrap is refused unless explicitly opted in. |
| No credential leakage | The password is prompted or piped, hashed with argon2id, and never logged. |
| Fail closed | A missing role row aborts before any user is written. |

## Tests

`packages/server/tests/super-admin-bootstrap.test.ts` proves the above:
bootstrap creation, login and admin access, duplicate refusal plus its audit row,
weak-password rejection, no plaintext storage, the grant-to-existing path, and
the rejection of `SUPER_ADMIN`/`ADMIN`/`SUPPORT`/`RISK`/`DISPUTE` from public
registration and of every self-promotion attempt.

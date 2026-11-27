# GM-ACCESS-05 — Production recovery deployment package

Status: implemented and tested in isolation. **Not executed against production.**
Owner approval is required before step 3 of the runbook below.

This document is the runbook. `deploy/gm-recovery/` is the package it describes.
Read together with [GM-ACCESS-02](./GM-ACCESS-02.md) (what the CLI does) and
[GM-ACCESS-04](./GM-ACCESS-04.md) (why the target must be proven production).

---

## 1. What the operator receives

`./deploy/gm-recovery/package.sh --out <dir>` produces
`wasit-gm-recovery-<stamp>.tar.gz` (≈160 KB):

| Path | Purpose |
| --- | --- |
| `scripts/gm-access.cjs` | the whole CLI as one file, built by `npm run build:prod` |
| `scripts/node_modules/argon2` | the only native dependency, with prebuilds for linux-x64/arm64 |
| `scripts/check-runtime.sh` | step 0 — prove Node and the native addon load here |
| `scripts/precheck.sh` | step 1 — prove the target, write a baseline, change nothing |
| `scripts/generate-password.sh` | step 2a — generate the new password on the host |
| `scripts/rotate.sh` | step 3 — replace the password, with a typed confirmation |
| `scripts/verify.sh` | step 4 — prove the rotation kept every promise |
| `scripts/login-check.sh` | step 5 — prove the new password signs in, MFA still asked |
| `scripts/package.sh` | rebuild the tarball (needs the repository) |
| `docs/`, `README.md` | this runbook and its two predecessors |
| `SHA256SUMS` | checksums of every file above |

The packager refuses to produce a tarball if any file in the staged tree looks
like a secret (`.env*`, `*.pem`, `*.key`, `*password*.txt`), so the package can
never be the reason a credential leaves its vault.

### Requirements on the production host

| | |
| --- | --- |
| Node.js | **20 or newer** — `node -v` |
| Platform | linux-x64 or linux-arm64 (the argon2 prebuilds shipped here); elsewhere run from the deployed `packages/server` |
| Database | the deployment's own `DATABASE_URL`, already present in its environment |
| Network | the host can reach its own database; nothing else is needed |
| Disk | ~2 MB for the package; a writable `~/.wasit-secrets` (0700) for the secret |

No `npm install`, no build tools, no repository checkout: the bundle carries its
dependencies, and the package carries the one native addon it cannot bundle
(`argon2`, which ships prebuilt binaries). `psql` is not required.

The CLI loads the application's configuration, so it needs the deployment's own
environment — at minimum `DATABASE_URL` and `JWT_SECRET` (the app refuses to run
in production with the committed development secret). That is the same file the
API reads; see step 2.

---

## 2. Preparing the production environment without printing it

The three signals the guard needs come from the deployment's own configuration,
not from the operator's memory:

```bash
export NODE_ENV=production
export WASIT_PRODUCTION_DB_NAME=<the database name this deployment serves>
# export WASIT_PRODUCTION_DB_HOST=<host>      # optional, compared with inet_server_addr()
export DATABASE_URL=<already set by the deployment>
```

Rules for handling them:

- Set them by sourcing the deployment's existing env file, never by retyping a
  connection string into a shell that is being recorded:
  `set -a; . /etc/wasit/production.env; set +a`.
- Never `echo "$DATABASE_URL"`, never `set -x` around these commands.
- `precheck.sh` prints the database **name, host and port** — not the URL, not
  the password. If you need to know where you are, that output is the answer.
- If the deployment has no `WASIT_PRODUCTION_DB_NAME` yet, add it to its env file
  and restart the API; the value must equal the database the API actually uses
  (the guard compares it with `current_database()`).

---

## 3. The runbook

### Step 0 — prove the package runs here (connects to nothing)

```bash
./scripts/check-runtime.sh
# node:    v22.x
# cli:     node …/scripts/gm-access.cjs
# argon2:  loaded, hashing works
```

If this fails, stop: the host cannot run the bundled native module. Use the
deployed `packages/server` checkout instead (`npm run gm:access -- …`).

### Step 1 — prove the target (writes nothing but a baseline)

```bash
./scripts/precheck.sh --email <gm-address> --baseline-out ~/.wasit-secrets/baseline.json
```

Expected output:

```
identity:    database "…" on …:… as …
environment: NODE_ENV=production, declared production database …
gate:        ALLOWED — this is a declared production target
account:     o***r@example.com (id …)
roles:       SUPER_ADMIN
active:      true · email verified: true · MFA enabled: true · confirmed factor: true
password:    argon2 hash
targets:     1 account(s) at that address, 1 of them SUPER_ADMIN (N SUPER_ADMIN in total)
sessions:    N live session(s) will be revoked
baseline:    written to … (0600)
```

Stop if any of these is not true: the gate is `REFUSED`, the account count is not
1, the account is not `SUPER_ADMIN`, or the database is not the one you meant.

The baseline records: database identity, account id, masked email, whether email
is verified, whether MFA is on and whether a confirmed factor exists, roles, the
hash algorithm (never the hash), the number of live sessions, and the timestamp.
`verify` compares against it later.

### Step 2 — obtain the new password

Two options. The first is the default.

**2a. Generate it on the host (recommended — the secret never travels):**

```bash
./scripts/generate-password.sh --email <gm-address>
# password written to /home/<user>/.wasit-secrets/gm-super-admin-password-<stamp>.txt (0600)
```

The file is created 0600 in a 0700 directory, outside any Git tree, and the value
is never printed. `--dry-run` shows what would happen without creating anything.

**2b. Use a password that already exists elsewhere** (for example the one
generated during GM-ACCESS-03): transfer it over a channel you control — an
encrypted vault, not chat or email — land it as a 0600 file, and use
`--password-file` in step 3. Do not paste it into a shell.

### Step 3 — replace the password (owner approval required)

> **This is the only step that changes production.** Do not run it until the
> platform owner has approved the recovery, in writing, naming the account.

```bash
./scripts/rotate.sh --email <gm-address> --password-file <path> --reason "GM recovery — owner approved <date>"
```

`rotate.sh` prints the account, the database and what will change, then asks you
to **retype the database name**. Anything else aborts with exit 2 before a
connection is made.

What the CLI does, in order: proves the target again (guard), reads the password
from the 0600 file, validates its strength, writes the argon2 hash, revokes every
session of that account, and writes one audit row
(`GM_ACCESS.PASSWORD_RESET`) with the operator name and the reason — no secret,
no hash.

What it does **not** do: change roles, touch `email_verified`, remove a second
factor, create sessions, or write any other account.

### Step 4 — verify the rotation

```bash
./scripts/verify.sh --email <gm-address> --baseline ~/.wasit-secrets/baseline.json
```

Ten checks, each printed `PASS`/`FAIL`:

| Check | Meaning |
| --- | --- |
| same database | the operator did not drift to another database mid-procedure |
| same account | the same account id as the baseline |
| password hash is argon2 | the stored hash is a real argon2 hash |
| email verification unchanged | the promise that recovery does not re-verify email |
| second factor unchanged | MFA is still enabled and the factor still confirmed |
| roles unchanged | no privilege was added or removed |
| account still active | the account was not disabled by the rotation |
| previous sessions revoked | zero live sessions remain |
| rotation audit row written | exactly the audit trail the CLI promises |
| audit row carries no secret | no password, hash or token field in that row |

Exit code 2 if any check fails.

### Step 5 — prove the credential works

```bash
./scripts/login-check.sh --email <gm-address> --password-file <path> --api-url https://<api-host>
```

Performs one real `POST /api/auth/login` and prints only the status code and two
booleans. `PASS` means the password was accepted; if the account has a confirmed
factor, the response must ask for it (`mfaRequired: true`) — a login that
succeeds without the factor would mean the rotation weakened the account, and
must be treated as an incident.

### Step 6 — hand over and clean up

- Put the password into the owner's password manager; confirm they can sign in.
- `shred -u <password-file>` on the host once the owner holds it.
- Keep the baseline and the audit row; delete nothing else.
- If MFA is lost as well, `reset-factor` is a separate, equally guarded action —
  it is **not** part of this package's default path.

---

## 4. What refuses to run, and why

Three independent layers, all of which must agree:

1. **Shell layer** (`_common.sh`): `NODE_ENV` must be exactly `production`,
   `DATABASE_URL` must be set, `WASIT_PRODUCTION_DB_NAME` must be set and must
   not be a test/demo/dev/staging/system name. This fails before any connection.
2. **Guard layer** (`db-target-guard.ts`): the live server is asked
   `current_database()`, `host(inet_server_addr())`, `inet_server_port()`; the
   answer must match the declaration, and the name must not be protected.
3. **Target layer** (`gm-recovery.ts`): the address must resolve to exactly one
   account, and that account must carry `SUPER_ADMIN`.

A wrong `DATABASE_URL` therefore cannot be talked into passing, and a correct
`DATABASE_URL` pointed at `wasit_demo` is refused even if the deployment
declares `wasit_demo` as its production database.

---

## 5. What still requires the owner's decision

| Decision | Why it cannot be made here |
| --- | --- |
| **Approval to rotate** | the change is visible to the account holder and to every auditor; it is an owner act |
| **Which address is the general manager** | the tool refuses anything that is not exactly one `SUPER_ADMIN`; choosing that account is a governance question |
| **Where the new password is kept** | owner's vault vs. host vault; this package defaults to host-only generation |
| **Whether MFA is reset too** | if the factor device is also lost, `reset-factor` is a second decision with its own risk |
| **Whether to notify users/auditors** | the audit row records the change; announcing it is a policy choice |
| **`WASIT_PRODUCTION_DB_NAME` value** | it must match the real deployment; only the owner/operator of that deployment knows it |

---

## 6. Limits of the testing done here

Everything below was executed in this environment. Nothing was executed against
a production host, because none is reachable from here.

**Proven**

- 33 automated tests (`tests/gm-access-05.test.ts`): masking, hash
  classification, audit-payload inspection, target resolution (including
  refusal for a non-`SUPER_ADMIN` and for an unknown address), every
  `compareBaseline` failure mode, audit-row lookup by timestamp, and the CLI as a
  real subprocess.
- CLI subprocess: `precheck` refuses `wasit_test` **even when the deployment
  declares it production**, refuses a non-production `NODE_ENV`, and writes no
  baseline when refused.
- CLI subprocess: `generate-password` refuses without `--confirm`, refuses a path
  inside a Git tree, and when it succeeds writes a 0600 file of 32 characters,
  never prints the value, and leaves the account's hash byte-identical.
- Package scripts: `precheck.sh` refuses `wasit_test`, refuses
  `NODE_ENV=development`, refuses `WASIT_PRODUCTION_DB_NAME=wasit_demo` **before
  connecting**, and never prints the URL; `rotate.sh` refuses without
  `--reason`; `verify.sh` refuses without `--baseline`;
  `generate-password.sh --dry-run` creates nothing.
- The packaged tarball (488 KB) was extracted in a clean directory, all 59
  checksums verified, and `scripts/check-runtime.sh` loaded the bundled CLI and
  the bundled `argon2` with no repository present.
- From that extracted package: `precheck.sh` refused `wasit_test` (exit 2, no
  baseline written), `rotate.sh` refused `wasit_test` (exit 2, nothing changed),
  and `generate-password.sh` wrote a 0600, 33-byte file without printing it.
- The **guard layer alone** was exercised with the shell checks bypassed:
  `node scripts/gm-access.cjs set-password …` against `wasit_test` refused with
  exit 2 both when the deployment declared `wasit_test` and when it declared
  `wasit_prod` — the live `current_database()` decides, not the declaration.

**Not proven here**

- The acceptance path end to end: a real `precheck → rotate → verify →
  login-check` against a production database. It requires the production host,
  its credentials and the owner's approval.
- `login-check.sh` against a live API (no production API reachable; the login
  contract it relies on is the same one exercised by the existing auth suites).
- Behaviour on a host whose Node.js is older than 20 — the scripts refuse
  explicitly rather than degrade.

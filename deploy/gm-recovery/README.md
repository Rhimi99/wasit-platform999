# GM recovery package — operator entry point

Self-contained procedure to restore access to the general manager
(`SUPER_ADMIN`) account on a production host.

> **Read `docs/GM-ACCESS-05.md` first.** It states what the owner must approve,
> what each step proves, and what this package deliberately cannot do.

## What the operator needs

| | |
| --- | --- |
| Node.js | 20 or newer (`node -v`) |
| Database access | the deployment's own `DATABASE_URL` (already on the host) |
| Declaration | `NODE_ENV=production` and `WASIT_PRODUCTION_DB_NAME` set in that shell |
| Account | the general manager's address |
| Owner approval | explicit, before `rotate.sh` |

No npm install is needed: `scripts/gm-access.cjs` is a single-file bundle, and
the one native dependency it needs (`argon2`) ships with prebuilt binaries for
linux-x64 and linux-arm64. On any other platform, run the tool from the deployed
`packages/server` instead (`npm run gm:access -- …`).

The CLI reads the deployment's configuration, so the shell must carry the same
environment the API uses — `DATABASE_URL` and `JWT_SECRET` at minimum.

## Order of operations

```bash
# 0. unpack, verify, and prove the native module loads
tar -xzf wasit-gm-recovery-<stamp>.tar.gz
cd wasit-gm-recovery-<stamp>
sha256sum -c SHA256SUMS
./scripts/check-runtime.sh

# 1. declare the production environment (already set on a correct host)
#    better: set -a; . /etc/wasit/production.env; set +a
export NODE_ENV=production
export WASIT_PRODUCTION_DB_NAME=wasit_prod     # the name this deployment uses

# 2. prove the target — writes nothing but a baseline
./precheck.sh --email <address> --baseline-out ~/.wasit-secrets/baseline.json

# 3a. preferred: generate the password on this host
./generate-password.sh --email <address>
# 3b. or use a password that arrived over a channel you trust, as a 0600 file
./rotate.sh --email <address> --password-file <path> --reason "GM recovery (owner approved)"

# 4. prove the rotation
./verify.sh --email <address> --baseline ~/.wasit-secrets/baseline.json
./login-check.sh --email <address> --password-file <path> --api-url https://<api-host>
```

## What each step refuses

- All steps refuse when `NODE_ENV` is not `production`, when
  `WASIT_PRODUCTION_DB_NAME` is unset, or when it names a test, demo, dev,
  staging or system database.
- The CLI additionally asks the live server which database it is connected to and
  compares the answer with the declaration, so a wrong `DATABASE_URL` cannot be
  talked into passing.
- `rotate.sh` requires the operator to retype the database name.
- `verify.sh` fails when any promise of the rotation was broken: email
  verification, second factor or roles changed, a session survived, the hash is
  not argon2, no audit row was written, or that row carries a secret.

## What this package never does

- It never prints a password, and never accepts one on the command line.
- It never creates a SUPER_ADMIN account, never grants a role, and never
  bypasses a second factor.
- It never runs a migration and never changes any account other than the one
  named with `--email`.
- It cannot be run against `wasit_demo` or `wasit_test`, by construction.

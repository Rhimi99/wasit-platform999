# Developer Runbook — from clone to running stack

This is the exact procedure used to verify the release. It was executed on an
empty directory extracted from release commit `d9edeb8`, so following it
reproduces a known-good environment.

**Prerequisites:** Node.js 22, npm 10+, PostgreSQL 16 (a 17 client also works),
and — only if you want to run E2E — a Chromium-capable host.

---

## 0. Unpack

If you received a ZIP:

```bash
unzip wasit-business-global-<version>.zip -d wasit
cd wasit
```

If you are working from the repository:

```bash
git clone <repo-url> wasit && cd wasit
git checkout d9edeb8
```

## 1. Install dependencies

```bash
npm ci --ignore-scripts
npm rebuild argon2
```

`--ignore-scripts` skips lifecycle scripts (supply-chain hygiene); `argon2` is a
native module and must be rebuilt explicitly for your platform. Both steps are
what CI does, so a successful `npm ci` here means the lockfile is sound.

> **Expected:** a few `npm audit` advisories are printed. They are known and
> listed in [`12-SECURITY-NOTES.md`](./12-SECURITY-NOTES.md); do **not** run
> `npm audit fix --force`, which applies breaking major upgrades.

## 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE wasit WITH LOGIN PASSWORD 'wasit_dev_password';
CREATE DATABASE wasit_dev OWNER wasit;
CREATE DATABASE wasit_test OWNER wasit;
SQL
```

`wasit_dev` is the application database; `wasit_test` is dropped and recreated
by the test suite on every run.

## 3. Configure the environment

```bash
cp packages/server/.env.example packages/server/.env
```

Then set at minimum:

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev
JWT_SECRET=<a long random string, >= 32 chars>
```

Everything else has a working default for local development. See
[`03-ENVIRONMENT-REFERENCE.md`](./03-ENVIRONMENT-REFERENCE.md) for the full
list.

> The API reads its env file with `dotenv` **from the process working
> directory**. When you run the server from `packages/server` (as the npm
> scripts do), the file is `packages/server/.env`. If you start the bundled
> server from the repo root, place the file at the repo root instead.

## 4. Migrate and seed

```bash
export DATABASE_URL=postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev

npm run db:migrate     # applies all 25 migrations
npm run db:seed        # reference data: roles, permissions, countries,
                       # currencies, categories, commission policies
```

The reference seed creates **no user accounts** — that is deliberate. To get the
demo logins described below you also run the demo seeder:

```bash
npm run db:seed:demo -w @wasit/server
```

`db:seed:demo` provisions the demo users, one supplier/merchant/company entity,
published products, a demo order and a demo conversation, all through the real
service layer so they pass the same validation, commission and ledger rules as
production data.

## 5. Run it

Two terminals:

```bash
# terminal 1 — API on :3000
npm run dev

# terminal 2 — SPA on :5173 (Vite proxies /api to the API)
npm run web
```

Open <http://localhost:5173>. The Vite dev proxy forwards `/api/*` to the API so
the session cookie stays same-origin, exactly as nginx does in production.

### Production-mode build (what actually ships)

```bash
npm run build:prod -w @wasit/server     # -> packages/server/dist-bundle/index.cjs
node packages/server/dist-bundle/index.cjs
```

The production bundle is a single esbuild CJS file with `argon2` kept external.
The server **must be started from a directory whose `.env` resolves correctly**
(see the note in §3).

## 6. Demo logins

After `db:seed:demo`, in `development`/`test` these are available:

| Account | Password | Role |
| --- | --- | --- |
| `customer1@wasit.tn` | `Passw0rd!2026` | CUSTOMER |
| `supplierA@wasit.tn` | `Passw0rd!2026` | SUPPLIER |
| `merchantA@wasit.tn` | `Passw0rd!2026` | MERCHANT |
| `companyA@wasit.tn` | `Passw0rd!2026` | COMPANY |
| `admin@wasit.tn` | `Passw0rd!2026` *(dev/test only)* | SUPER_ADMIN |
| `admin2@wasit.tn` | `Passw0rd!2026` *(dev/test only)* | ADMIN |

> **The published password never opens a staff account outside dev/test.** On
> `NODE_ENV=staging` the seeder generates a random per-run staff credential
> unless you supply `DEMO_STAFF_PASSWORD`. This is enforced in
> `src/lib/demo-account.ts` and covered by tests — do not "fix" it.

## 7. Verify your install

```bash
curl -s http://localhost:3000/api/health/live     # {"status":"ok"...}
curl -s http://localhost:3000/api/health/ready    # checks the database
```

A real login round-trip:

```bash
curl -s -c /tmp/cj -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer1@wasit.tn","password":"Passw0rd!2026"}'
curl -s -b /tmp/cj http://localhost:3000/api/auth/me
```

## 8. Run the tests

```bash
export TEST_DATABASE_URL=postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test
npm test
```

> **Important:** export `TEST_DATABASE_URL` yourself. The suite falls back to a
> `wasit:wasit_dev_password` default, so if your local Postgres uses different
> credentials the run fails at connect time with `28P01`. The suite drops and
> recreates `TEST_DATABASE_URL`, so never point it at `wasit_dev`.

See [`09-TESTING-GUIDE.md`](./09-TESTING-GUIDE.md) for E2E and the full gate set.

## 9. Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| `password authentication failed for user "wasit"` | `TEST_DATABASE_URL`/`DATABASE_URL` not exported, so the built-in default was used | Export both, or create a `wasit` role matching the default |
| `Cannot find module '.../dist-bundle/index.cjs'` | Started the bundle from the repo root instead of `packages/server` | `cd packages/server && node dist-bundle/index.cjs` |
| `Refusing to start: JWT_SECRET is the committed development default` | `NODE_ENV=staging`/`production` with the placeholder secret | Set a real `JWT_SECRET` (≥32 chars) |
| Migrations fail with `auth_failed` | `drizzle-kit` reads `process.env.DATABASE_URL` directly and ignores a differently-located `.env` | `export DATABASE_URL=...` before `npm run db:migrate` |
| Video generation returns 502 | `ffmpeg-static` binary missing (installed with `--ignore-scripts` and not rebuilt) | `npm rebuild` in the repo root, or set `VIDEO_FFMPEG_PATH` |
| Tests fail on `devToolingActive` | A shell exported `ALLOW_DEV_TOOLING=true` | The suite now pins this itself; update to the release commit |

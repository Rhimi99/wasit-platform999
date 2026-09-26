# Deployment Guide

Three supported ways to run the platform. Choose one; do not mix them.

| Option | Use for | Isolation |
| --- | --- | --- |
| A. Docker Compose | local, demo, small staging | containers |
| B. Bare metal + nginx | production with an existing fleet | systemd + Postgres |
| C. Managed platform | production with PaaS | platform-managed |

All options share the same prerequisites and the same **pre-flight checklist**
at the end.

---

## 0. Prerequisites

- **Node.js 22** and npm 10+ (options B and C, and for building).
- **PostgreSQL 16** (17 client compatible).
- **Docker + Docker Compose** (option A).
- A **persistent volume** for `MEDIA_STORAGE_DIR` — generated marketing videos
  must survive container replacement.
- TLS termination in front of the app (nginx, ALB, or the platform's).

## 1. Build artifacts

The API ships as a single bundled CJS file; the SPA ships as static assets.

```bash
npm ci --ignore-scripts
npm rebuild argon2
npm run build:prod -w @wasit/server     # -> packages/server/dist-bundle/index.cjs
npm run build -w @wasit/web             # -> packages/web/dist/
```

`argon2` is a **native** module kept external from the bundle, so the image (or
host) must have it built for its own platform — hence `npm rebuild argon2`.

---

## Option A — Docker Compose

`docker-compose.yml` orchestrates `db` (Postgres), `api` (the bundled server)
and `web` (nginx serving the SPA and proxying `/api` to the API).

```bash
cp .env.staging.example .env.staging
# edit .env.staging: set JWT_SECRET, SESSION_SECRET, DATABASE_URL, provider keys
docker compose --env-file .env.staging up -d --build
docker compose ps
```

Then apply schema and reference data **inside the api container**:

```bash
docker compose exec api node dist-bundle/seed.cjs      # reference data
# optional, public demo only:
docker compose exec api node dist-bundle/seed-demo.cjs
```

Health:

```bash
curl -fsS http://localhost/api/health/ready
```

### The nginx layer

`deploy/nginx.conf` does two jobs and both matter:

1. Serves the SPA and falls back to `index.html` for client routes.
2. **Proxies `/api/` to the API on the same origin**, so the session cookie stays
   same-origin (mirrors the Vite dev proxy).

It sets `proxy_read_timeout 180s` for the API because **marketing-video
generation renders synchronously with ffmpeg** and can exceed nginx's 60s
default — shortening this will cut off long renders.

Security headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`) are set on the served SPA.

### Volumes

| Path | Purpose |
| --- | --- |
| `MEDIA_STORAGE_DIR` (`.wasit-media`) | generated videos; **must persist** |
| Postgres data dir | the database |

### Scaling note

If you run **more than one API replica**, set `RATE_LIMIT_STORE=postgres`.
With the default `memory` store, each replica counts separately and the effective
limit multiplies by the replica count.

---

## Option B — Bare metal + nginx

1. Install Node 22, PostgreSQL 16, nginx.
2. Create the database and a least-privilege role (see
   [`05-RUNBOOK-DEV.md`](./05-RUNBOOK-DEV.md) §2).
3. Put the environment in a file readable only by the service user, e.g.
   `/etc/wasit/api.env`, with `NODE_ENV=production` and **real secrets**.
4. Build (see §1) and run the bundle under systemd, started from the directory
   whose `.env` resolves correctly — or pass the env file explicitly:

```ini
# /etc/systemd/system/wasit-api.service
[Unit]
Description=WASIT API
After=network.target postgresql.service

[Service]
Type=simple
User=wasit
WorkingDirectory=/opt/wasit/packages/server
EnvironmentFile=/etc/wasit/api.env
ExecStart=/usr/bin/node dist-bundle/index.cjs
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/wasit-media

[Install]
WantedBy=multi-user.target
```

5. Serve the SPA with nginx using `deploy/nginx.conf` as the template: point
   `root` at `packages/web/dist`, set `proxy_pass` at the API's real address,
   and terminate TLS.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wasit-api
curl -fsS http://127.0.0.1:3000/api/health/ready
```

---

## Option C — Managed platform

- Deploy the API bundle as a service with the env from §3 of
  [`03-ENVIRONMENT-REFERENCE.md`](./03-ENVIRONMENT-REFERENCE.md).
- Deploy `packages/web/dist` as a static site.
- Route `/api/*` to the API **on the same public origin** so the session cookie
  remains same-origin.
- Mount a persistent disk at `MEDIA_STORAGE_DIR`.
- Run `seed.cjs` once as a release step (and `seed-demo.cjs` only on a public
  demo, never on production).

---

## Migrations

Migrations are **forward-only** and idempotent per the Drizzle journal. Apply
them before starting the new app version:

```bash
export DATABASE_URL=postgresql://…
npm run db:migrate
```

> `drizzle-kit` reads `process.env.DATABASE_URL` **directly** and will ignore a
> differently-located `.env`. Always export it in the migration step.

There are **25 migrations** (`0000`–`0024`). Do **not** run
`drizzle-kit push` against production — it diffs and mutates schema
destructively. `db:push` exists for throwaway local databases only.

**Rollback:** there are no down-migrations. Take a backup first (see
[`08-OPERATIONS-RUNBOOK.md`](./08-OPERATIONS-RUNBOOK.md)) and restore it to roll
back a schema change.

---

## Pre-flight checklist

Before pointing real traffic at a deployment:

- [ ] `NODE_ENV=production` (or `staging`) set.
- [ ] `JWT_SECRET` and `SESSION_SECRET` are real, random, ≥32 chars, from a
      secret store — **not** the committed dev placeholder.
- [ ] `DATABASE_URL` uses a least-privilege role, not the Postgres superuser.
- [ ] `ALLOW_DEV_TOOLING=false` and `DEMO_SKIP_EMAIL_VERIFICATION=false`.
      (The app refuses to boot with either set in production — confirm anyway.)
- [ ] `PAYMENT_PROVIDER` set to the real gateway, with its keys injected; the
      gateway's **production** base URL (not sandbox).
- [ ] `MAIL_TRANSPORT=smtp` with real SMTP credentials (otherwise verification
      and reset emails are only logged).
- [ ] `MEDIA_STORAGE_DIR` on a **persistent** volume with enough space.
- [ ] `RATE_LIMIT_STORE=postgres` if running more than one API replica.
- [ ] `METRICS_TOKEN` set, or `/metrics` restricted to the scrape network.
- [ ] TLS terminating in front; security headers present.
- [ ] `CORS_ORIGIN` / `APP_URL` / `API_URL` set to the real public origins.
- [ ] A verified **backup and restore** performed against this environment.
- [ ] `/api/health/ready` returns healthy from outside the network.

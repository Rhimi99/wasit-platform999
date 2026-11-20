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

### Trusted client IP (reverse proxy)

The API attributes anonymous rate limits (and audit records) to the **real TCP
peer** by default. Forwarded headers are attacker-controlled, so they are
ignored until you explicitly allowlist the proxy networks you operate. Trust is
**per network and never inferred**: loopback, RFC1918 and IPv6 ULA are not
trusted automatically, because on a shared host or a flat private network they
would let a co-tenant forge client addresses.

Behind this nginx:

1. Set `TRUSTED_PROXY_CIDRS` to the network(s) nginx connects from, e.g.
   `10.20.0.0/24` (or `127.0.0.1/32` when nginx and the API share a host and you
   accept that trust). Keep it to the **real** proxy addresses — never guess.
2. Set `TRUSTED_PROXY_HOPS=1` (one proxy). With `TRUSTED_PROXY_HOPS=0` the chain
   is never read, so every request looks like it came from nginx and the per-IP
   limit is meaningless; with an empty `TRUSTED_PROXY_CIDRS` nothing is trusted
   even if hops are set, and the socket peer is used.
3. Make nginx **append** the peer to `X-Forwarded-For` (the shipped
   `deploy/nginx.conf` does: `proxy_set_header X-Forwarded-For
   $proxy_add_x_forwarded_for;`). Do **not** replace the header with a
   client-supplied value.
4. **Do not expose the API port directly.** The allowlist is matched against the
   socket peer, so if the API is reachable from the internet a direct client
   could present a source address inside an allowlisted range. Bind the API to a
   private interface (or a firewall/security group) so only the proxy can reach
   it.

If you add another proxy (CDN, load balancer) in front of nginx, raise
`TRUSTED_PROXY_HOPS` to the **exact** new count and add that layer's network to
`TRUSTED_PROXY_CIDRS`. Raising the hop count above the real number lets a
client-supplied hop be trusted, which reopens the spoofing hole.

**Production readiness:** these values depend on the deployed network topology
and are therefore **not** pre-filled. The production setting is pending the
actual proxy addresses; until then the defaults (no trusted proxy) apply and the
API ignores all forwarded headers.

### Volumes

| Path | Purpose |
| --- | --- |
| `MEDIA_STORAGE_DIR` (`.wasit-media`) | generated videos; **must persist** |
| Postgres data dir | the database |

### Scaling note

If you run **more than one API replica**, set `RATE_LIMIT_STORE=postgres`.
With the default `memory` store, each replica counts separately and the effective
limit multiplies by the replica count.

### API resource protection (011.4)

The API applies, in order, a request-body cap, a general `/api/*` rate limit, and
tighter limits on the expensive surfaces. All are configurable by env (see
`03-ENVIRONMENT-REFERENCE.md` §3); the values read here are per request, so a
change takes effect without a rebuild.

| Layer | Default | Behaviour |
| --- | --- | --- |
| `MAX_REQUEST_BODY_BYTES` | `1 MiB` | A larger body is refused with **413** before any handler runs. nginx's `client_max_body_size` (20m in `deploy/nginx.conf`) is the outer guard; keep the app cap below it, or a body that nginx accepts is still refused by the app. |
| General `/api/*` | `300`/60s | Keyed on the authenticated user, else the trusted client IP. `/api/auth` and `/api/health` are exempt. |
| `/api/ai/*` | `60`/60s per user + `300`/60s per IP | Two limits: a per-user cap and a per-IP backstop for account-rotating floods. |
| `/api/search/*` | `120`/60s per IP | Public and relatively costly. |
| `/api/media/marketing-videos` | `6`/60s per user | The tightest limit; on top of the render-concurrency cap. |
| Video render concurrency | `2` per process | `MEDIA_VIDEO_MAX_CONCURRENCY` bounds simultaneous ffmpeg renders; a request that cannot get a slot within `MEDIA_VIDEO_QUEUE_TIMEOUT_MS` is shed with **503**. |

Notes:

- The client IP used for keying is the trusted client IP only (see *Trusted
  client IP* above). A forged `X-Forwarded-For` never moves the bucket.
- When the rate-limit store is unreachable the API **fails closed** (503) rather
  than letting requests through unguarded — a shared-store outage does not
  silently disable the limits. Alert on 503s from the API.
- The render-concurrency cap is **per process**. It bounds load within one
  replica; it is not a global cap across replicas.
- **No file uploads:** media assets are generated server-side, and no route
  accepts a multipart upload, so the 1 MiB body cap never truncates an upload.

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
   `root` at `packages/web/dist` and set `proxy_pass` at the API's real address.
   The shipped template is **HTTP-only** (`listen 80;`, no `ssl_*` directives) —
   add a `listen 443 ssl` server block (or terminate TLS at a load balancer/CDN)
   and mount the certificate there before going live.

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

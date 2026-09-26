# Operations Runbook

> **Audience:** the operator on call.
> **Scope:** how to tell whether the platform is healthy, what each alert means,
> and what to do about it.

Everything here is a real endpoint or a real script in this repository — nothing
is aspirational.

---

## 1. Health endpoints

| Endpoint | Meaning | Expected |
| --- | --- | --- |
| `GET /api/health/live` | The process is up. Does **not** touch the database. | `200 {"status":"ok"}` |
| `GET /api/health/ready` | The process can serve traffic: the database answers. | `200 {"status":"ready","db":"connected"}`; `503` when the DB is unreachable |
| `GET /api/health/channels` | Outbound configuration, **without credentials**: mail, SMS, rate-limit store, cache, media providers, backup freshness, alert notifier. | `200` with one object per channel |

`/live` is the liveness probe (restart on failure). `/ready` is the readiness
probe (remove from rotation on failure). Do not point a restart policy at
`/ready`: a database blip would then restart a healthy process.

### Reading `/channels`

Use it to confirm a deployment can actually deliver before you rely on it:

- `mail` / `sms` — is a real transport configured, or is the deployment silently
  writing to the log? A verification email that never arrives is usually this.
- `rateLimit.store` — `memory` is per-process and resets on restart; a
  multi-instance deployment needs the shared store.
- `media.providers` — confirms the marketing-video pipeline has a provider.
- `backup.configured` / `lastSuccessAt` / `ageHours` vs `maxAgeHours` — whether
  the backup schedule is alive. This is the operator-visible half of
  `backup_stale`.
- `observability.alerts` — which alert notifier is active.

---

## 2. Alerts

The alert rules live in `packages/server/src/lib/observability/alerts.ts` and are
evaluated by the in-process scheduler every `OBS_ALERT_INTERVAL_MINUTES` (default 5).
Read them at `GET /api/admin/observability/alerts`; force a pass with
`POST /api/admin/observability/alerts/evaluate`.

| Alert | Fires when | First response |
| --- | --- | --- |
| `database_down` | The database does not answer. | Check `GET /api/health/ready` and the database host. This is the only alert that means "the product is down". |
| `http_error_ratio` | 5xx responses exceed the configured ratio over the window. | Read `GET /api/admin/observability/metrics`, then `GET /api/admin/observability/logs` and group by `route`. A single route dominating points at a real bug; a flat rise across routes points at a dependency. |
| `rate_limit_rejections` | Rejections spike — a client is being throttled hard. | Check whether it is one actor (abuse or a stuck client) or many (limit too tight). Rejections are per-actor. |
| `alert_scheduler_stale` | The alert scheduler itself stopped ticking. | The alerts you are *not* seeing cannot be trusted. Restart the process; verify `GET /api/admin/observability/alerts` updates again. |
| `backup_stale` | The backup heartbeat is older than `BACKUP_MAX_AGE_HOURS`. | Check the timer, then run a backup by hand (§4) and confirm the heartbeat moves. |

`alert_scheduler_stale` is the one to take most seriously: while it is firing,
silence from every other alert proves nothing.

---

## 3. Background jobs

An in-process scheduler (`packages/server/src/lib/scheduler.ts`) runs:

- **subscription auto-renew rollover** — every `SUBSCRIPTION_ROLLOVER_INTERVAL_MINUTES`
- **subscription expiry** — same tick
- **privacy data-retention sweep** — same tick
- **rate-limit bucket purge** — every `RATE_LIMIT_PURGE_INTERVAL_MINUTES` (default 15)
- **alert evaluation** — every `OBS_ALERT_INTERVAL_MINUTES` (default 5)

Rollover and the retention sweep are **idempotent**, so a second instance
running them is a no-op rather than double-billing. A failed job logs and is
retried on the next tick; it never takes the process down.

Caveat: because the scheduler is in-process, **every** API instance runs it. That
is safe today only because those jobs are idempotent. A future job that is not
idempotent must move to the platform scheduler hitting the authenticated admin
route, or be guarded by a database lock.

---

## 4. Backup and restore

```bash
# Backup (safe under cron: no password prompt, flock-serialised)
./scripts/backup-db.sh

# Restore into a SCRATCH database and verify row counts against the manifest
./scripts/restore-db.sh ./backups/<UTC-stamp>
```

A backup folder contains the custom-format dump, the globals, and a
`manifest.json` with sizes and SHA-256 so a restore can verify before it starts.
Retention defaults to the 7 most recent folders (`BACKUP_RETENTION_COUNT`).

**The restore target defaults to a scratch database named `<db>_restore`, never
the live one.** Restoring over live requires an explicit `--allow-live`. A
restore that exits 0 without verification is not evidence, so verification is on
by default and reports the comparison explicitly.

`backup_stale` fires from the heartbeat file (`BACKUP_HEARTBEAT_FILE`) the backup
script writes on success.

---

## 5. Incident: the product looks broken but nothing alerts

Check, in order:

1. `GET /api/health/ready` — is the database reachable?
2. `GET /api/health/channels` — did a transport (mail/SMS/AI/media) silently
   fall back to the log?
3. `GET /api/admin/observability/logs` — group by `route`. A 4xx cluster is
   usually a client or permission problem, not an outage; a 5xx cluster is a bug.
4. `GET /api/admin/audit` — did the action the user attempted actually run? The
   audit log records the real actor, action and entity, so it distinguishes "the
   user says it failed" from "it never happened".

A frequent false alarm: a stale process on the API port serving old code. Before
you debug the product, confirm the listener is the build you think it is — read
its environment from `/proc/<pid>/environ` and check `NODE_ENV`, `DATABASE_URL`
and the app version.

---

## 6. Rollback

The release is a single commit; roll back by redeploying the previous commit's
bundle. Migrations in this release are **additive**, so a code rollback does not
require a schema rollback. If a migration did need reverting, restore the
pre-deploy backup (§4) into a scratch database, verify it, and only then decide
whether to promote it.

---

## 7. Escalation data to collect

Before escalating, gather: the trace id from the failing response, the matching
`GET /api/admin/observability/logs` entries, the audit rows for the attempted
action, and the output of `GET /api/health/channels`. Those four cover almost
every "it doesn't work" report without a second round trip.

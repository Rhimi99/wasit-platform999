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
The backup tree is created `0700` explicitly (not via umask), so database
contents and role password hashes are not world-readable.

**The restore refuses to start unless `checksums.sha256` is present, non-empty,
and every listed file matches its digest — and every entry must resolve inside
the backup directory (no `../` or symlink escape).** There is no "warn and
continue" path.

**The restore target defaults to a scratch database named `<db>_restore`, never
the live one.** Restoring over live requires an explicit `--allow-live`. A
restore that exits 0 without verification is not evidence, so verification is on
by default and reports the comparison explicitly. The target name must be a
valid identifier (a-z, 0-9, `_`) — a name with spaces or SQL is refused, not
escaped. **DEMO (`wasit_demo`), Staging (`wasit_staging`), Production
(`wasit_prod`) and the system databases (`postgres`, `template0`, `template1`)
can never be a restore target, and neither `--force` nor `--allow-live` bypasses
that.** Add extra protected names with `WASIT_PROTECTED_DB_NAMES` (comma or
space separated).

`backup_stale` fires from the heartbeat file (`BACKUP_HEARTBEAT_FILE`) the backup
script writes on success.

### Encrypting backups at rest (optional, `age`)

`BACKUP_ENCRYPTION=off` is the default and changes nothing. Set
`BACKUP_ENCRYPTION=age` to encrypt every payload file (`*.dump`,
`pg_globals.sql`, `table-counts.tsv`) to one or more recipients:

```bash
# One-time, off the server: create the keypair; keep the identity offline.
age-keygen -o /secure/offline/wasit-backup-identity.txt   # prints the public key
# On the backup host, only the public recipient is needed:
BACKUP_ENCRYPTION=age \
BACKUP_AGE_RECIPIENTS=age1... \
  ./scripts/backup-db.sh
```

The manifest and `checksums.sha256` switch to the encrypted layout and record a
`plaintextSha256` per file. The plaintext originals are kept by default
(`BACKUP_PLAINTEXT_RETENTION=keep`); set it to `drop` only after an encrypted
restore drill has passed. Multiple recipients are supported (one `-r` each), so
a new key can be added before an old one is retired.

When `drop` is used, the plaintext is removed only after the whole run has
succeeded in order: every file is encrypted, the manifest is written with the
plaintext digests, `checksums.sha256` is written **and re-verified** against the
files on disk, and only then is each plaintext file removed. Every removal is
guarded: a symlink is refused rather than followed, and the canonical path must
resolve inside the current backup folder, so a drop can never reach a previous
backup folder or anything outside it. If any step fails, the run stops with the
plaintext still present and the incomplete folder is removed.

To restore an encrypted backup, supply the private identity by **path**:

```bash
BACKUP_AGE_IDENTITY_FILE=/secure/offline/wasit-backup-identity.txt \
  ./scripts/restore-db.sh ./backups/<UTC-stamp>
```

A missing or wrong identity, or a corrupted ciphertext, fails **before** any
database is touched. The identity is never passed as a command argument (it
would be visible in `ps`) and never written to the logs; the decrypted payload
goes to a `0700` scratch directory that is removed on exit, success or failure.
A key stored inside the backup directory is refused — key and data stay
separate.

**Integrity, confidentiality — and what neither proves.** These are three
different properties, and the backup format provides only the first two:

- `checksums.sha256` and the per-file `plaintextSha256` are **integrity** checks:
  they detect corruption or an altered payload by comparing it against a recorded
  reference value.
- `age` recipient encryption is **confidentiality**: it keeps the payload secret
  and makes it decryptable only by the holders of the listed recipients' private
  identities. It also lets a restore confirm the ciphertext decrypted to the
  intended plaintext.

Neither one proves **who created the backup**. A checksum is recomputable by
anyone who can rewrite the folder, and anyone can encrypt to a public recipient —
so a valid checksum or a readable ciphertext says nothing about the source's
identity or authenticity. Proving the origin requires a **trusted digital
signature** made with a **separate signing key** held only by the producer; that
mechanism is **out of scope for 013.1** and is not implemented here. Until it
exists, treat the provenance of a backup as coming from how it was transported
and stored, not from the backup files themselves.

### Key rotation and retention

Recipients can be rotated without breaking history:

```bash
# Add a new recipient while keeping the old one, then re-verify with both.
BACKUP_AGE_RECIPIENTS="$NEW_RECIPIENT $OLD_RECIPIENT" ./scripts/backup-db.sh
```

- A new backup is written only to the recipients configured at that time. Old
  backups keep the recipients they were written with, so they stay readable with
  their original identities — rotation never invalidates existing archives.
- **Keep every private identity for as long as any backup encrypted to it still
  exists** (including archives held offsite or in cold storage). Retiring a key
  means losing the ability to restore every backup that used it.
- **A lost private identity makes its backups permanently unrecoverable.** There
  is no recovery path: age has no backdoor. Store identities offline, separate
  from the backup host, with a tested, documented recovery copy.
- Rotate when a key may have been exposed, and on a schedule; re-run a restore
  drill with the new key before retiring the old one.

**Out of scope (unchanged by this feature):** offsite/replicated storage,
WAL/PITR continuous archiving, and making encryption the default
(`BACKUP_ENCRYPTION` stays `off` unless set). These remain operator decisions
and are not provided here.

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

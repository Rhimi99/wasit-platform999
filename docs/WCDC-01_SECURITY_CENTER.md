# WCDC-01 — Cyber Defence Centre (مركز الأمن السيبراني)

Status: implemented, tested, **not merged**. Branch `feat/wcdc-01-security-center`.
Owner of containment actions: the GM (`SUPER_ADMIN`). Admins may read.

---

## 1. What this is

An in-application security centre. It watches the requests the platform already
serves, records what looks like an attack, groups signals into incidents, and
gives the GM a small, explicit set of containment actions.

It is **not** a WAF, an IDS appliance or a DDoS scrubbing service. It sees the
application layer only, after the request has reached this Node process.

```
request ──▶ securityHeaders ──▶ wcdcGuard ──────────────────────────────▶ route
                                   │ 1. blocked address?  → 403 SECURITY_BLOCKED
                                   │ 2. tightened address? → 429 SECURITY_THROTTLED
                                   │ 3. burst counter      → event + incident
                                   │ 4. payload scan (path, query, body)
                                   │ 5. next()
                                   ▼
                              observeOutcome (401/403/404/415/429/422)
                                   │ → counters → recordSecurityEvent → incident
                                   ▼
                        security_events / security_incidents
                                   ▲
                     /api/admin/security (GM screen, RBAC + audit)
```

## 2. Data model (migration `0050_wcdc_security_center.sql`)

| Table | Holds | Never holds |
| --- | --- | --- |
| `security_events` | one row per observation: rule, severity, actor, address, route, status, fingerprint, incident id | payload text, passwords, tokens, request bodies |
| `security_incidents` | grouping per `(rule, subject)`: count, first/last seen, risk score, containment history | — |
| `security_actions` | every decision: type, mode (`AUTO`/`MANUAL`), status, target, requester, approver, result | — |
| `security_blocks` | active/past address blocks with TTL and revocation time | — |

Two additive enum values are added to existing types: `media_asset_status` gains
`QUARANTINED`, `policy_scope` gains `SECURITY`.

The session token is stored only as `session_hash` (SHA-256). The login address is
never stored; only the *count* of distinct accounts tried from one source.

## 3. Detection rules

Rules live in `packages/server/src/lib/wcdc/types.ts` (`SECURITY_RULES`), with
thresholds that a `SECURITY`/`WCDC_RESPONSE` policy row can tighten at runtime.

| Rule | Category | Severity | Threshold | Auto-containable |
| --- | --- | --- | --- | --- |
| `RATE_BURST` | DDOS | HIGH | 120 / 10 s | yes |
| `RATE_LIMIT_ABUSE` | DDOS | MEDIUM | 10 / 60 s | yes |
| `SQL_INJECTION` | INJECTION | CRITICAL | 1 / 300 s | no |
| `XSS` | XSS | HIGH | 1 / 300 s | no |
| `PATH_TRAVERSAL` | INJECTION | HIGH | 1 / 300 s | no |
| `AUTH_BRUTEFORCE` | AUTH | HIGH | 5 / 300 s | yes (recommended only) |
| `CREDENTIAL_STUFFING` | AUTH | CRITICAL | 6 / 600 s | no |
| `PRIVILEGE_PROBE` | RBAC | HIGH | 3 / 300 s | no |
| `RBAC_TAMPER_ATTEMPT` | RBAC | CRITICAL | 1 / 600 s | no |
| `CROSS_TENANT_PROBE` | TENANT | HIGH | 2 / 600 s | no |
| `SESSION_ANOMALY` | SESSION | HIGH | 1 / 900 s | no |
| `CSRF_VIOLATION` | CSRF | MEDIUM | 1 / 600 s | no |
| `UPLOAD_REJECTED` | UPLOAD | MEDIUM | 3 / 600 s | no |
| `MEDIA_LINK_TAMPER` | MEDIA | MEDIUM | 3 / 600 s | no |
| `AGENT_SCOPE_VIOLATION` | AGENT | HIGH | 1 / 900 s | no |
| `AUDIT_TAMPER_ATTEMPT` | AUDIT | CRITICAL | 1 / 600 s | no |
| `INTEGRITY_FAILURE` | INTEGRITY | HIGH | 1 / 900 s | no |

Payload scanning covers the path, the query string, JSON bodies and
`application/x-www-form-urlencoded` bodies (`+` normalised to a space first).
Multipart uploads are **not** scanned: reading binary parts as text is expensive
and produces false positives; the upload routes validate their own input. Bodies
without a declared `content-length` (chunked) and bodies above 64 KB are skipped
for the same reason — the inspector must not become a memory amplifier.

A hit is a *signal*, never a block. The route's validation and the parameterised
queries remain the actual defence.

## 4. Response actions — the whole of WCDC's power

`ACTION_SPECS` in `lib/wcdc/response.ts` is an allow-list. There is no generic
"execute", no SQL, no role and no filter parameter.

| Action | Target | Second GM approval | Effect |
| --- | --- | --- | --- |
| `BLOCK_IP` | IP | no | bounded block (`WCDC_BLOCK_TTL_MINUTES`) |
| `UNBLOCK_IP` | IP | no | lifts every active block on that address |
| `RATE_LIMIT_TIGHTEN` | IP | no | per-instance tight limit for `WCDC_TIGHTEN_TTL_MINUTES` |
| `REVOKE_SESSION` | user id | **yes** | revokes every session of that account |
| `QUARANTINE_ASSET` | media asset id | **yes** | asset leaves `READY`; every download and public link refuses |
| `ESCALATE` | incident | no | notifies every GM |
| `NOTIFY_GM` | incident | no | notifies every GM, changes nothing |
| `AI_KILL_SWITCH` | — | **yes** | pauses AI execution through the existing kill switch |

Four-eyes: `REQUIRES_APPROVAL` actions can only be approved by a **different**
`SUPER_ADMIN`. The approval is claimed with a conditional update before the
action runs, so two simultaneous approvals cannot execute it twice.

### What WCDC can never do

`FORBIDDEN_ACTIONS` names them and the refusal is recorded (`REFUSED` +
`FORBIDDEN_OPERATION` + audit `SECURITY.ACTION_REFUSED`):

`GRANT_PERMISSION`, `MODIFY_RBAC`, `DISABLE_MFA`, `DELETE_DATA`, `DELETE_AUDIT`,
`RUN_MIGRATION`, `DISABLE_SERVICE`, `CHANGE_PAYMENT_CONFIG`, `MOVE_MONEY`.

Nothing in the module writes `user_roles`, changes a permission, edits or deletes
audit rows, or moves money. The test `refuses an operation that would change its
own authority` asserts the actor's role rows are byte-identical before and after.

## 5. Permissions

| Permission | Granted to | Used by |
| --- | --- | --- |
| `SECURITY_READ` | `ADMIN`, `SUPER_ADMIN` | overview, incidents, events, actions, blocks, rules, sessions, external |
| `SECURITY_RESPOND` | `SUPER_ADMIN` only | respond, approve, incident status, block revoke |
| `SECURITY_MANAGE` | `SUPER_ADMIN` only | audit-trail scan |

The web page hides GM-only controls for an ADMIN, but the boundary is the server
guard; hiding a button is not a permission.

## 6. Automatic containment

Off unless a `SECURITY`/`WCDC_RESPONSE` policy row says `autoContainment:
"limited"`. Even then it applies **only** to `RATE_BURST` and `RATE_LIMIT_ABUSE`
from a known address, never to an account-level rule: locking a real customer out
on a heuristic is a business decision, not a security default.

`WCDC_AUTO_CONTAINMENT` (env) is the fallback when no policy row exists.

## 7. Honest limits

- **Volumetric DDoS is not absorbed here.** A flood has to be absorbed upstream
  (CDN/WAF). `WCDC_EDGE_PROVIDER` only *records* which provider is in front;
  `/external` and the overview always report `coversVolumetric: false` because
  WCDC cannot verify the provider from inside the process.
- **Counters and tightened limits are per process.** With N instances, a burst is
  counted per instance and a tightened limit applies to one node. Blocks are in
  the database and apply everywhere (2 s cache).
- **Address-based controls need a client address.** Behind nginx set
  `TRUSTED_PROXY_HOPS` and `TRUSTED_PROXY_CIDRS`; the overview reports
  `addressControls: "forwarded" | "socket"`.
- **Multipart bodies are not scanned** (see §3).
- **The audit-trail scan is heuristic**: it reads existing `audit_logs` for
  refusals and integrity signals; it cannot prove the trail was not tampered with
  outside the database.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WCDC_ENABLED` | `on` | master switch; `off` leaves the centre read-only and inert |
| `WCDC_AUTO_CONTAINMENT` | `off` | `off` \| `limited` (fallback when no policy row) |
| `WCDC_BLOCK_TTL_MINUTES` | 60 | block duration |
| `WCDC_TIGHTEN_TTL_MINUTES` | 30 | tightened-limit duration |
| `WCDC_BURST_MAX` / `WCDC_BURST_WINDOW_SECONDS` | 120 / 10 | burst rule |
| `WCDC_EDGE_PROVIDER` / `WCDC_EDGE_NOTES` | `none` / — | recorded edge provider, for the status card |
| `WCDC_EVENT_RETENTION_DAYS` | 30 | retention applied by the scheduler sweep |

## 9. Runbook — an incident fires

1. Open `/admin/security` (GM) or the overview tab (ADMIN, read-only).
2. Read the incident: rule, severity, risk score, actor, address, route, count.
3. Decide: `ACKNOWLEDGE` if you are working on it, `CONTAINED` when the effect is
   stopped, `RESOLVED` with a note when it is over.
4. Contain if needed — `BLOCK_IP` for a hostile address, `REVOKE_SESSION` for a
   taken-over account, `QUARANTINE_ASSET` for a malicious upload,
   `AI_KILL_SWITCH` if an agent is misbehaving. Each of the last three needs a
   second GM.
5. Check **Blocked addresses** to see what is in force, and lift a block that
   caught a legitimate customer.
6. Verify the trail: `/admin/audit-logs` holds `SECURITY.*` entries with who,
   what, why and when.
7. If AI was paused, resume it from the AI desk once the cause is fixed.

## 10. Tests

- `packages/server/tests/wcdc-01-rules.test.ts` — the detector and scanner in
  isolation (thresholds, patterns, no false positive on ordinary prose).
- `packages/server/tests/wcdc-01.test.ts` — end to end against a real database
  and a real HTTP listener: RBAC (anonymous/customer/ADMIN/GM), every rule
  producing an incident, block → 403 → lift → 200, tightening, four-eyes,
  double-approval, quarantine, kill switch, forbidden operations, tenant
  isolation, no secrets in the tables, retention sweep, form-encoded scanning.

## 11. Deliberate decisions to confirm with the GM

- `SECURITY_READ` is granted to `ADMIN` so the desk can triage read-only. If the
  GM wants the centre visible to `SUPER_ADMIN` only, remove one line in
  `packages/shared/src/constants/rbac.ts`.
- Retention (30 days, `WCDC_EVENT_RETENTION_DAYS`) is a default, not a legal
  requirement. Change it through the scheduler configuration, not in code.

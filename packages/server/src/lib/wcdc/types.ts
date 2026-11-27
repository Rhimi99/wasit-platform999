/**
 * WCDC — WASIT Cyber Defence Center (WCDC-01).
 *
 * Vocabulary shared by the collector, the detector, the response layer and the
 * GM screen. Everything here is descriptive data: no rule executes anything on
 * its own, and no severity grants access.
 */

export type SecuritySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const SEVERITY_ORDER: readonly SecuritySeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Base weight used by the risk score; a severity is not a decision by itself. */
export const SEVERITY_WEIGHT: Record<SecuritySeverity, number> = {
  LOW: 10,
  MEDIUM: 30,
  HIGH: 60,
  CRITICAL: 90,
};

export type SecurityCategory =
  | 'DDOS'
  | 'INJECTION'
  | 'XSS'
  | 'CSRF'
  | 'AUTH'
  | 'SESSION'
  | 'RBAC'
  | 'TENANT'
  | 'UPLOAD'
  | 'MEDIA'
  | 'AGENT'
  | 'AUDIT'
  | 'INTEGRITY';

export type SecuritySource = 'HTTP' | 'AUTH' | 'AI' | 'MEDIA' | 'ADMIN' | 'SYSTEM';

/** Rules produced by the payload scanner (see `signatures.ts`). */
export type PayloadRule = 'SQL_INJECTION' | 'XSS' | 'PATH_TRAVERSAL';

export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'CONTAINED' | 'RESOLVED' | 'CLOSED';

export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'CONTAINED',
  'RESOLVED',
  'CLOSED',
];

export type ResponseActionType =
  | 'RATE_LIMIT_TIGHTEN'
  | 'BLOCK_IP'
  | 'UNBLOCK_IP'
  | 'REVOKE_SESSION'
  | 'QUARANTINE_ASSET'
  | 'ESCALATE'
  | 'NOTIFY_GM'
  | 'AI_KILL_SWITCH';

export const RESPONSE_ACTION_TYPES: readonly ResponseActionType[] = [
  'RATE_LIMIT_TIGHTEN',
  'BLOCK_IP',
  'UNBLOCK_IP',
  'REVOKE_SESSION',
  'QUARANTINE_ASSET',
  'ESCALATE',
  'NOTIFY_GM',
  'AI_KILL_SWITCH',
];

/**
 * Operations WCDC is never allowed to perform, whatever the incident says.
 *
 * They are named here — rather than simply left out of the action enum — so a
 * request for one is refused explicitly and audited, instead of failing as an
 * "unknown action" that looks like a typo. Nothing in this module can grant a
 * permission, touch RBAC/MFA, delete data or audit rows, run a migration, stop a
 * service, change payment configuration or move money.
 */
export const FORBIDDEN_ACTIONS = [
  'GRANT_PERMISSION',
  'MODIFY_RBAC',
  'DISABLE_MFA',
  'DELETE_DATA',
  'DELETE_AUDIT',
  'RUN_MIGRATION',
  'DISABLE_SERVICE',
  'CHANGE_PAYMENT_CONFIG',
  'MOVE_MONEY',
] as const;

export type ForbiddenAction = (typeof FORBIDDEN_ACTIONS)[number];

export function isForbiddenAction(value: string): value is ForbiddenAction {
  return (FORBIDDEN_ACTIONS as readonly string[]).includes(value);
}

export function isResponseActionType(value: string): value is ResponseActionType {
  return (RESPONSE_ACTION_TYPES as readonly string[]).includes(value);
}

export interface DetectionRule {
  id: string;
  category: SecurityCategory;
  /** Stable English title; the UI translates by `id` and falls back to this. */
  title: string;
  severity: SecuritySeverity;
  /** How many matching signals inside the window make an incident. */
  threshold: number;
  windowSeconds: number;
  /** Never applied without an operator: WCDC does not decide containment alone. */
  autoEligible: boolean;
}

/**
 * The rule catalogue. Thresholds are deliberately conservative: one 403 is a
 * mistake, a pattern of them is an attempt. They are defaults, not policy — a
 * `SECURITY`/`WCDC_RESPONSE` policy row can tighten them at runtime.
 */
export const SECURITY_RULES: Record<string, DetectionRule> = {
  RATE_BURST: {
    id: 'RATE_BURST',
    category: 'DDOS',
    title: 'Request flood from one source',
    severity: 'HIGH',
    // 120 requests in 10s is above what a busy shared NAT produces and well
    // below a flood, so a whole office does not open an incident.
    threshold: 120,
    windowSeconds: 10,
    autoEligible: true,
  },
  RATE_LIMIT_ABUSE: {
    id: 'RATE_LIMIT_ABUSE',
    category: 'DDOS',
    title: 'Repeated rate-limit rejections',
    severity: 'MEDIUM',
    threshold: 10,
    windowSeconds: 60,
    autoEligible: true,
  },
  SQL_INJECTION: {
    id: 'SQL_INJECTION',
    category: 'INJECTION',
    title: 'SQL injection payload',
    severity: 'CRITICAL',
    threshold: 1,
    windowSeconds: 300,
    autoEligible: false,
  },
  XSS: {
    id: 'XSS',
    category: 'XSS',
    title: 'Cross-site scripting payload',
    severity: 'HIGH',
    threshold: 1,
    windowSeconds: 300,
    autoEligible: false,
  },
  PATH_TRAVERSAL: {
    id: 'PATH_TRAVERSAL',
    category: 'INJECTION',
    title: 'Path traversal or command injection',
    severity: 'HIGH',
    threshold: 1,
    windowSeconds: 300,
    autoEligible: false,
  },
  AUTH_BRUTEFORCE: {
    id: 'AUTH_BRUTEFORCE',
    category: 'AUTH',
    title: 'Repeated sign-in failures',
    severity: 'HIGH',
    threshold: 5,
    windowSeconds: 300,
    autoEligible: true,
  },
  CREDENTIAL_STUFFING: {
    id: 'CREDENTIAL_STUFFING',
    category: 'AUTH',
    title: 'Many accounts tried from one source',
    severity: 'CRITICAL',
    threshold: 6,
    windowSeconds: 600,
    autoEligible: true,
  },
  PRIVILEGE_PROBE: {
    id: 'PRIVILEGE_PROBE',
    category: 'RBAC',
    title: 'Privilege probing on staff routes',
    severity: 'HIGH',
    threshold: 3,
    windowSeconds: 300,
    autoEligible: false,
  },
  RBAC_TAMPER_ATTEMPT: {
    id: 'RBAC_TAMPER_ATTEMPT',
    category: 'RBAC',
    title: 'Attempt to change roles or permissions',
    severity: 'CRITICAL',
    threshold: 1,
    windowSeconds: 600,
    autoEligible: false,
  },
  CROSS_TENANT_PROBE: {
    id: 'CROSS_TENANT_PROBE',
    category: 'TENANT',
    title: 'Access to another tenant’s records',
    severity: 'HIGH',
    threshold: 2,
    windowSeconds: 600,
    autoEligible: false,
  },
  SESSION_ANOMALY: {
    id: 'SESSION_ANOMALY',
    category: 'SESSION',
    title: 'Staff session used from a new address',
    severity: 'HIGH',
    threshold: 1,
    windowSeconds: 900,
    autoEligible: false,
  },
  CSRF_VIOLATION: {
    id: 'CSRF_VIOLATION',
    category: 'CSRF',
    title: 'Cross-site request forgery attempt',
    severity: 'MEDIUM',
    threshold: 1,
    windowSeconds: 600,
    autoEligible: false,
  },
  UPLOAD_REJECTED: {
    id: 'UPLOAD_REJECTED',
    category: 'UPLOAD',
    title: 'Rejected file upload',
    severity: 'MEDIUM',
    threshold: 3,
    windowSeconds: 600,
    autoEligible: false,
  },
  MEDIA_LINK_TAMPER: {
    id: 'MEDIA_LINK_TAMPER',
    category: 'MEDIA',
    title: 'Invalid or forged media link',
    severity: 'MEDIUM',
    threshold: 3,
    windowSeconds: 600,
    autoEligible: false,
  },
  AGENT_SCOPE_VIOLATION: {
    id: 'AGENT_SCOPE_VIOLATION',
    category: 'AGENT',
    title: 'Agent attempted an out-of-scope action',
    severity: 'HIGH',
    threshold: 1,
    windowSeconds: 900,
    autoEligible: false,
  },
  AUDIT_TAMPER_ATTEMPT: {
    id: 'AUDIT_TAMPER_ATTEMPT',
    category: 'AUDIT',
    title: 'Attempt to modify or erase the audit trail',
    severity: 'CRITICAL',
    threshold: 1,
    windowSeconds: 600,
    autoEligible: false,
  },
  INTEGRITY_FAILURE: {
    id: 'INTEGRITY_FAILURE',
    category: 'INTEGRITY',
    title: 'Integrity check failed',
    severity: 'HIGH',
    threshold: 1,
    windowSeconds: 900,
    autoEligible: false,
  },
};

export function ruleById(id: string): DetectionRule | null {
  return SECURITY_RULES[id] ?? null;
}

/**
 * Risk score for one incident (0–100).
 *
 * Severity sets the floor, repetition adds weight with diminishing returns, and
 * an incident that keeps firing while still open is pushed up — an attempt that
 * ignores a warning is worse than the same attempt once.
 */
export function riskScore(input: {
  severity: SecuritySeverity;
  eventCount: number;
  status: IncidentStatus;
}): number {
  const base = SEVERITY_WEIGHT[input.severity];
  const repetition = Math.min(25, Math.round(Math.log2(Math.max(1, input.eventCount)) * 8));
  const persistence = input.status === 'OPEN' ? 5 : 0;
  return Math.max(0, Math.min(100, base + repetition + persistence));
}

export type PostureLevel = 'CALM' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

export function postureLevel(score: number): PostureLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 25) return 'ELEVATED';
  return 'CALM';
}

/** Stable, non-reversible fingerprint used to group identical observations. */
export function fingerprintOf(parts: ReadonlyArray<string | null | undefined>): string {
  const joined = parts.map((p) => p ?? '').join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < joined.length; i += 1) {
    const code = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

import { and, eq } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { auditLogs } from '../../db/schema/audit.js';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/observability/logger';
import type { AgentDefinition, ResolvedAgentTask } from '../../lib/ai/types.js';
import { findAgentSpec } from './catalogue.js';
import { callerMayUseAgent, createAgentTask, getRegistryAgent } from './runner.js';
import { userHasPlatformScope } from './scope.js';

/**
 * GM Orchestrator — the central command and coordination layer for the General
 * Manager (AI-05.0).
 *
 * It is deliberately NOT a new agent and NOT a second execution engine. The
 * orchestrator receives a management goal, analyses it, selects the specialised
 * agents that own the work, coordinates their execution, aggregates and reviews
 * their results, and returns one management report with proposed actions.
 *
 * Every step it delegates goes through {@link createAgentTask} — the platform's
 * single execution gate. That means the orchestrator inherits, unchanged and
 * un-bypassed:
 *   - the caller's REAL roles (never a fabricated `SUPER_ADMIN`),
 *   - per-agent RBAC and data scope ({@link callerMayUseAgent} + `assertAgentScope`),
 *   - the kill switch (a PAUSED/DISABLED agent is skipped, never run),
 *   - the human-approval gate (sensitive agents queue for approval),
 *   - the per-run budget guard, the execution deadline and the `AI.*` audit trail.
 *
 * The planner is deterministic: a goal is classified against a fixed playbook
 * table, exactly as the Copilot's `EVENT_ROUTING` maps events to agents. An LLM
 * never chooses the routing, so the coordination cannot be hijacked and is fully
 * auditable.
 */

/** A single coordinated unit of work inside a playbook. */
export interface GmStepSpec {
  /** Stable id, unique within the playbook (referenced by `dependsOn`). */
  id: string;
  agentKey: string;
  taskType: string;
  /** English intent shown in the management report. */
  intent: string;
  /** Arabic intent shown in the management report. */
  intentAr: string;
  /** Step ids that must complete first (dependency edges). */
  dependsOn: string[];
  input?: Record<string, unknown>;
}

/** A deterministic follow-up action a playbook may recommend (never auto-run). */
export interface GmFollowUp {
  action: string;
  description: string;
  descriptionAr: string;
  agentKey: string | null;
  requiresApproval: boolean;
}

/** A named, deterministic coordination playbook. */
export interface GmPlaybook {
  id: string;
  label: string;
  labelAr: string;
  /** Lower-cased keywords used to classify a free-text goal (no LLM). */
  keywords: string[];
  steps: GmStepSpec[];
  followUps: GmFollowUp[];
}

// ---------------------------------------------------------------------------
// Playbooks — the deterministic goal → agents map.
// ---------------------------------------------------------------------------

export const GM_PLAYBOOKS: GmPlaybook[] = [
  {
    id: 'platform.health_review',
    label: 'Platform health review',
    labelAr: 'مراجعة صحة المنصة',
    keywords: ['health', 'status', 'operations', 'platform', 'monitor', 'overview', 'صحة', 'حالة', 'تشغيل', 'مراقبة', 'المنصة'],
    steps: [
      { id: 'ops', agentKey: 'operations-agent', taskType: 'operations.health_check', intent: 'Operations health snapshot', intentAr: 'لقطة صحة العمليات', dependsOn: [] },
      { id: 'analytics', agentKey: 'analytics-agent', taskType: 'analytics.report', intent: 'Platform KPI report', intentAr: 'تقرير مؤشرات الأداء', dependsOn: [] },
    ],
    followUps: [],
  },
  {
    id: 'revenue.growth',
    label: 'Revenue growth plan',
    labelAr: 'خطة نمو الإيرادات',
    keywords: ['revenue', 'growth', 'sales', 'marketing', 'campaign', 'ads', 'promotion', 'إيراد', 'نمو', 'مبيعات', 'تسويق', 'حملة', 'إعلان', 'ترويج'],
    steps: [
      { id: 'research', agentKey: 'market-research-agent', taskType: 'research.scan_market', intent: 'Scan the market for demand signals', intentAr: 'مسح السوق لإشارات الطلب', dependsOn: [] },
      { id: 'marketing', agentKey: 'marketing-agent', taskType: 'marketing.plan_campaign', intent: 'Draft a campaign from the market scan', intentAr: 'صياغة حملة بناءً على مسح السوق', dependsOn: ['research'] },
      { id: 'ads', agentKey: 'ads-agent', taskType: 'ads.propose_budget', intent: 'Propose an ad budget for the campaign', intentAr: 'اقتراح ميزانية إعلانية للحملة', dependsOn: ['marketing'] },
    ],
    followUps: [
      { action: 'ads.spend_increase', description: 'Increase ad spend once the budget is approved', descriptionAr: 'زيادة الإنفاق الإعلاني بعد اعتماد الميزانية', agentKey: 'ads-agent', requiresApproval: true },
    ],
  },
  {
    id: 'catalog.quality',
    label: 'Catalogue quality audit',
    labelAr: 'تدقيق جودة الكتالوج',
    keywords: ['catalog', 'catalogue', 'product', 'listing', 'quality', 'كتالوج', 'منتج', 'منتجات', 'إدراج', 'جودة'],
    steps: [
      { id: 'product', agentKey: 'product-agent', taskType: 'product.audit_catalog', intent: 'Audit catalogue quality', intentAr: 'تدقيق جودة الكتالوج', dependsOn: [] },
    ],
    followUps: [
      { action: 'catalog.publish_batch', description: 'Publish the corrected listings (human-approved)', descriptionAr: 'نشر الإدراجات المصحّحة (بموافقة بشرية)', agentKey: 'product-agent', requiresApproval: true },
    ],
  },
  {
    id: 'risk.compliance_review',
    label: 'Risk & compliance review',
    labelAr: 'مراجعة المخاطر والامتثال',
    keywords: ['risk', 'compliance', 'fraud', 'dispute', 'trust', 'مخاطر', 'امتثال', 'احتيال', 'نزاع', 'ثقة'],
    steps: [
      { id: 'risk', agentKey: 'risk-agent', taskType: 'risk.scan', intent: 'Assess the platform risk posture', intentAr: 'تقييم الوضع الأمني للمنصة', dependsOn: [] },
      { id: 'compliance', agentKey: 'compliance-agent', taskType: 'compliance.check', intent: 'Run a compliance check', intentAr: 'إجراء فحص الامتثال', dependsOn: [] },
    ],
    followUps: [
      { action: 'risk.block_account', description: 'Block an account flagged as high risk', descriptionAr: 'حظر حساب مصنّف عالي الخطورة', agentKey: 'risk-agent', requiresApproval: true },
      { action: 'compliance.final_ruling', description: 'Issue a final compliance ruling', descriptionAr: 'إصدار قرار امتثال نهائي', agentKey: 'compliance-agent', requiresApproval: true },
    ],
  },
  {
    id: 'support.service_review',
    label: 'Customer service review',
    labelAr: 'مراجعة خدمة العملاء',
    keywords: ['support', 'service', 'ticket', 'customer', 'دعم', 'خدمة', 'تذكرة', 'عملاء'],
    steps: [
      { id: 'support', agentKey: 'support-agent', taskType: 'support.triage_ticket', intent: 'Triage open support work', intentAr: 'فرز أعمال الدعم المفتوحة', dependsOn: [] },
    ],
    followUps: [],
  },
  {
    id: 'network.expansion',
    label: 'Network expansion',
    labelAr: 'توسيع الشبكة',
    keywords: ['supplier', 'merchant', 'network', 'onboard', 'partner', 'b2b', 'مورد', 'موردين', 'تاجر', 'تجار', 'شبكة', 'شراكة', 'توسيع'],
    steps: [
      { id: 'supplier', agentKey: 'supplier-agent', taskType: 'supplier.onboard', intent: 'Assess supplier onboarding', intentAr: 'تقييم انضمام الموردين', dependsOn: [] },
      { id: 'merchant', agentKey: 'merchant-agent', taskType: 'merchant.onboard', intent: 'Assess merchant onboarding', intentAr: 'تقييم انضمام التجار', dependsOn: [] },
      { id: 'b2b', agentKey: 'b2b-agent', taskType: 'b2b.manage_partner', intent: 'Review B2B partnerships', intentAr: 'مراجعة شراكات الأعمال', dependsOn: [] },
    ],
    followUps: [
      { action: 'outreach.send', description: 'Send outreach to vetted prospects', descriptionAr: 'إرسال تواصل مع العملاء المحتملين المعتمدين', agentKey: 'outreach-acquisition-agent', requiresApproval: true },
    ],
  },
];

/** Fallback playbook when a goal matches no keyword. */
export const DEFAULT_PLAYBOOK: GmPlaybook = GM_PLAYBOOKS[0]!;

/** Hard cap on steps per run (loop / blast-radius guard). */
export const MAX_STEPS_PER_RUN = 8;
/** Hard cap on dependency waves per run (defensive). */
export const MAX_WAVES_PER_RUN = 5;

// ---------------------------------------------------------------------------
// Phase 2 — analysis: deterministic goal classification.
// ---------------------------------------------------------------------------

export interface GmClassification {
  playbook: GmPlaybook;
  matched: string[];
  score: number;
}

/**
 * Classifies a free-text goal against the playbook keyword table.
 *
 * Deterministic and LLM-free: the playbook with the most keyword hits wins, ties
 * resolve to the earlier playbook, and no match falls back to
 * {@link DEFAULT_PLAYBOOK}. This is what makes the coordination auditable and
 * impossible to steer with a crafted prompt.
 */
export function classifyGoal(goal: string): GmClassification {
  const text = goal.toLowerCase();
  let best = DEFAULT_PLAYBOOK;
  let bestScore = 0;
  let bestMatched: string[] = [];
  for (const pb of GM_PLAYBOOKS) {
    const matched = pb.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (matched.length > bestScore) {
      best = pb;
      bestScore = matched.length;
      bestMatched = matched;
    }
  }
  return { playbook: best, matched: bestMatched, score: bestScore };
}

// ---------------------------------------------------------------------------
// Phase 2 — coordination: dependency-aware wave planning.
// ---------------------------------------------------------------------------

export interface GmPlan {
  waves: GmStepSpec[][];
  dropped: string[];
}

/**
 * Orders steps into dependency waves with a Kahn-style topological sort.
 *
 * Steps whose declared dependency is missing (e.g. removed by the step cap) or
 * that form a cycle are dropped rather than executed — so the orchestrator can
 * never start a step whose prerequisite did not run, and a malformed playbook
 * degrades safely instead of looping.
 */
export function planWaves(steps: GmStepSpec[]): GmPlan {
  const byId = new Map(steps.map((s) => [s.id, s]));

  const invalid = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of steps) {
      if (invalid.has(s.id)) continue;
      if (s.dependsOn.some((d) => !byId.has(d) || invalid.has(d))) {
        invalid.add(s.id);
        changed = true;
      }
    }
  }

  const active = steps.filter((s) => !invalid.has(s.id));
  const remaining = new Set(active.map((s) => s.id));
  const done = new Set<string>();
  const waves: GmStepSpec[][] = [];

  while (remaining.size > 0 && waves.length < MAX_WAVES_PER_RUN) {
    const wave = active.filter((s) => remaining.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (wave.length === 0) break; // residual cycle
    waves.push(wave);
    for (const s of wave) {
      remaining.delete(s.id);
      done.add(s.id);
    }
  }

  const dropped = [...invalid, ...remaining];
  return { waves, dropped };
}

// ---------------------------------------------------------------------------
// Phase 2 — results, review and report.
// ---------------------------------------------------------------------------

export type GmStepOutcome = 'succeeded' | 'failed' | 'awaiting_approval' | 'blocked' | 'skipped' | 'not_run';

export interface GmStepResult {
  stepId: string;
  agentKey: string;
  taskType: string;
  intent: string;
  intentAr: string;
  outcome: GmStepOutcome;
  taskId: string | null;
  requiresApproval: boolean;
  approvalAction: string | null;
  /** Substantive (non-bookkeeping) keys of the deterministic evidence payload. */
  evidenceKeys: string[];
  /** Scalar evidence values, used to detect cross-agent conflicts. */
  evidence: Record<string, string>;
  error: string | null;
  skippedReason: string | null;
}

export interface GmConflict {
  key: string;
  values: { stepId: string; value: string }[];
}

export interface GmReview {
  failed: string[];
  blocked: string[];
  /** Steps whose dispatch failed or was rescheduled for retry — never a success. */
  notRun: string[];
  pendingApproval: string[];
  skipped: { stepId: string; reason: string }[];
  /** Succeeded steps that produced no substantive evidence (a proposal is not proof). */
  insufficientEvidence: string[];
  conflicts: GmConflict[];
  evidenceCount: number;
  hasBlockingIssues: boolean;
}

/** Payload keys that are bookkeeping, not evidence of live data. */
const BOOKKEEPING_KEYS = new Set([
  'agentKey',
  'action',
  'generatedAt',
  'readOnly',
  'proposal',
  'proposalModel',
  'reasoningUnavailable',
]);

/** Extracts substantive evidence keys/values from an executor's JSON payload. */
function extractEvidence(advice: string): { keys: string[]; values: Record<string, string> } {
  try {
    const obj = JSON.parse(advice) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return { keys: [], values: {} };
    const keys: string[] = [];
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (BOOKKEEPING_KEYS.has(k)) continue;
      keys.push(k);
      if (v === null || typeof v !== 'object') values[k] = String(v);
    }
    return { keys, values };
  } catch {
    return { keys: [], values: {} };
  }
}

/**
 * Reviews aggregated step results. Pure and deterministic — no DB, no clock — so
 * it is unit-testable in isolation.
 *
 * It is deliberately sceptical: an LLM proposal alone is NOT success. A step is
 * only counted as evidence when it succeeded AND produced substantive live-data
 * keys; a succeeded step with no such keys is flagged `insufficientEvidence`.
 * Cross-agent disagreements on the same key are surfaced as `conflicts`.
 */
export function reviewResults(results: GmStepResult[]): GmReview {
  const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.stepId);
  const blocked = results.filter((r) => r.outcome === 'blocked').map((r) => r.stepId);
  // A `not_run` step (dispatch failed or rescheduled for retry) is a problem the
  // manager must see, grouped with failures for the blocking-issue decision.
  const notRun = results.filter((r) => r.outcome === 'not_run').map((r) => r.stepId);
  const pendingApproval = results.filter((r) => r.outcome === 'awaiting_approval').map((r) => r.stepId);
  const skipped = results
    .filter((r) => r.outcome === 'skipped')
    .map((r) => ({ stepId: r.stepId, reason: r.skippedReason ?? 'skipped' }));
  const insufficientEvidence = results
    .filter((r) => r.outcome === 'succeeded' && r.evidenceKeys.length === 0)
    .map((r) => r.stepId);

  const byKey = new Map<string, { stepId: string; value: string }[]>();
  for (const r of results) {
    if (r.outcome !== 'succeeded') continue;
    for (const [k, v] of Object.entries(r.evidence)) {
      const arr = byKey.get(k) ?? [];
      arr.push({ stepId: r.stepId, value: v });
      byKey.set(k, arr);
    }
  }
  const conflicts: GmConflict[] = [];
  for (const [key, values] of byKey) {
    if (values.length < 2) continue;
    if (new Set(values.map((v) => v.value)).size > 1) conflicts.push({ key, values });
  }

  const evidenceCount = results.reduce((n, r) => n + r.evidenceKeys.length, 0);
  const hasBlockingIssues =
    failed.length > 0 || blocked.length > 0 || notRun.length > 0 || conflicts.length > 0 || insufficientEvidence.length > 0;
  return { failed, blocked, notRun, pendingApproval, skipped, insufficientEvidence, conflicts, evidenceCount, hasBlockingIssues };
}

export interface GmProposedAction {
  action: string;
  description: string;
  descriptionAr: string;
  agentKey: string | null;
  requiresApproval: boolean;
  /** Always false: the orchestrator never executes a proposed action. */
  executed: false;
}

export interface GmReport {
  goal: string;
  playbookId: string;
  playbookLabel: string;
  playbookLabelAr: string;
  summaryAr: string;
  summaryEn: string;
  steps: GmStepResult[];
  risks: string[];
  priorities: string[];
  recommendations: string[];
}

export interface GmOrchestrationResult {
  runId: string;
  correlationId: string;
  requestedBy: string;
  role: UserRole[];
  playbookId: string;
  matchedKeywords: string[];
  plan: { waves: string[][]; dropped: string[] };
  results: GmStepResult[];
  review: GmReview;
  report: GmReport;
  proposedActions: GmProposedAction[];
}

/**
 * Snapshot format version.
 *
 * The snapshot is written to `audit_logs.after` under the `AI.GM_ORCHESTRATED`
 * entry for a run. Bumping the version is the only way the shape may change;
 * `getGmRun` refuses to reinterpret a snapshot it does not understand rather
 * than returning a half-decoded report. Version 1 is the original AI-07.0a
 * shape (goal, role, plan, results, review, report, proposedActions).
 */
export const GM_SNAPSHOT_VERSION = 1 as const;

/**
 * The immutable record of a completed GM orchestration.
 *
 * It captures the run's ENTIRE result as it was at execution time — including
 * `skipped`, `failed` and `awaiting_approval` steps with their reasons — plus the
 * review, report and proposed actions. `getGmRun` replays it verbatim; it never
 * recomputes anything from current system state, so a later approval, kill
 * switch change or role change cannot rewrite history.
 *
 * Deliberately NOT stored: `ipAddress`/`userAgent` (request metadata, already on
 * the audit row), tool payloads or any payment/credential material. Only the
 * requester id and their resolved roles at run time are kept, so the run stays
 * attributable without copying sensitive data.
 */
export interface GmRunSnapshot {
  version: typeof GM_SNAPSHOT_VERSION;
  goal: string;
  requestedBy: string;
  role: UserRole[];
  playbookId: string;
  matchedKeywords: string[];
  plan: { waves: string[][]; dropped: string[] };
  results: GmStepResult[];
  review: GmReview;
  report: GmReport;
  proposedActions: GmProposedAction[];
  capturedAt: string;
}

/** The stored snapshot plus the audit provenance `getGmRun` returns with it. */
export interface GmRunRecord extends GmOrchestrationResult {
  /** When the orchestration completed (the audit row's timestamp). */
  createdAt: string;
  /** When the snapshot itself was captured (equal to `createdAt` in practice). */
  capturedAt: string;
}

/** Builds the deterministic management report from the reviewed results. */
export function buildReport(args: {
  goal: string;
  playbook: GmPlaybook;
  matched: string[];
  results: GmStepResult[];
  review: GmReview;
}): GmReport {
  const { goal, playbook, results, review } = args;
  const succeeded = results.filter((r) => r.outcome === 'succeeded');
  const pending = results.filter((r) => r.outcome === 'awaiting_approval');
  const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'blocked');
  const notRun = results.filter((r) => r.outcome === 'not_run');
  const skipped = results.filter((r) => r.outcome === 'skipped');

  const risks: string[] = [];
  if (failed.length > 0) risks.push(`${failed.length} مهمة فشلت: ${failed.map((r) => r.agentKey).join(', ')}`);
  if (notRun.length > 0) risks.push(`${notRun.length} مهمة لم تُنفّذ (فشل إرسال/إعادة جدولة): ${notRun.map((r) => r.agentKey).join(', ')}`);
  if (review.conflicts.length > 0) risks.push(`${review.conflicts.length} تعارض في النتائج بين الوكلاء (${review.conflicts.map((c) => c.key).join(', ')})`);
  if (review.insufficientEvidence.length > 0) risks.push(`${review.insufficientEvidence.length} مهمة نجحت دون أدلة كافية (${review.insufficientEvidence.join(', ')})`);
  if (skipped.length > 0) risks.push(`${skipped.length} خطوة متخطّاة (صلاحيات/إيقاف/اعتماديات)`);

  const priorities: string[] = [];
  if (pending.length > 0) priorities.push(`اعتماد ${pending.length} مهمة حساسة بانتظار الموافقة`);
  if (failed.length + notRun.length > 0) priorities.push('معالجة المهام الفاشلة أو غير المنفّذة');
  if (review.conflicts.length > 0) priorities.push('حلّ تعارض النتائج قبل أي قرار');
  if (priorities.length === 0) priorities.push('لا أولويات حرجة — النتائج متسقة');

  const recommendations: string[] = [];
  if (succeeded.length > 0) recommendations.push(`الاعتماد على نتائج ${succeeded.length} وكيل مع تحقّق بشري قبل أي إجراء`);
  if (pending.length > 0) recommendations.push('مراجعة طلبات الاعتماد عبر بوابة الموافقات قبل التنفيذ');
  if (failed.length + notRun.length > 0) recommendations.push('إعادة تشغيل المهام الفاشلة/غير المنفّذة عبر نفس البوابات (RBAC/الميزانية/الموافقة)');
  if (skipped.length > 0) recommendations.push('مراجعة الخطوات المتخطّاة: قد تحتاج صلاحية أعلى أو وكيلًا مُفعّلًا');

  const summaryAr =
    `المهمة: ${goal}\n` +
    `الخطة: ${playbook.labelAr} (${results.length} خطوة)\n` +
    `النتائج: ${succeeded.length} ناجحة، ${pending.length} بانتظار موافقة، ${failed.length} فاشلة، ${notRun.length} غير منفّذة، ${skipped.length} متخطّاة.\n` +
    `عدد الأدلة الفعلية: ${review.evidenceCount}${review.hasBlockingIssues ? ' — توجد مشكلات تستدعي المراجعة.' : ' — لا مشكلات حاجزة.'}`;
  const summaryEn =
    `Goal: ${goal}\n` +
    `Plan: ${playbook.label} (${results.length} steps)\n` +
    `Outcome: ${succeeded.length} succeeded, ${pending.length} awaiting approval, ${failed.length} failed, ${notRun.length} not run, ${skipped.length} skipped.\n` +
    `Evidence items: ${review.evidenceCount}${review.hasBlockingIssues ? ' — review required.' : ' — no blocking issues.'}`;

  return {
    goal,
    playbookId: playbook.id,
    playbookLabel: playbook.label,
    playbookLabelAr: playbook.labelAr,
    summaryAr,
    summaryEn,
    steps: results,
    risks,
    priorities,
    recommendations,
  };
}

/**
 * Derives the proposed (never executed) follow-up actions.
 *
 * Playbook follow-ups are the sensitive operations the GM may want next; each is
 * marked with whether it needs approval and is returned with `executed: false`.
 * Execution stays entirely behind the existing approval/RBAC gates — the
 * orchestrator only *suggests*.
 */
export function proposeActions(
  playbook: GmPlaybook,
  results: GmStepResult[],
  review: GmReview,
): GmProposedAction[] {
  const actions: GmProposedAction[] = playbook.followUps.map((f) => ({ ...f, executed: false }));

  if (review.failed.length > 0 || review.blocked.length > 0 || review.notRun.length > 0) {
    actions.push({
      action: 'gm.retry_failed',
      description: 'Re-run the failed steps through the same gates',
      descriptionAr: 'إعادة تشغيل الخطوات الفاشلة عبر نفس البوابات',
      agentKey: null,
      requiresApproval: false,
      executed: false,
    });
  }
  if (review.pendingApproval.length > 0) {
    actions.push({
      action: 'gm.await_approvals',
      description: 'Review and decide the tasks awaiting human approval',
      descriptionAr: 'مراجعة واعتماد المهام المنتظرة للموافقة البشرية',
      agentKey: null,
      requiresApproval: false,
      executed: false,
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Phase 2 — intake, selection and execution.
// ---------------------------------------------------------------------------

export interface GmOrchestrateOptions {
  maxSteps?: number;
}

export interface GmOrchestrateParams {
  goal: string;
  requestedBy: string;
  /** The caller's REAL roles (from the session) — never fabricated. */
  role: UserRole[];
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null };
  options?: GmOrchestrateOptions;
}

function holdsAdmin(role: UserRole[]): boolean {
  return role.includes('ADMIN') || role.includes('SUPER_ADMIN');
}

/**
 * Maps a task's terminal status onto a step outcome.
 *
 * A task that is still `queued`/`running` after its dispatch attempt did not
 * produce a result for this run: the runner only ever returns those when it
 * rescheduled a failed attempt (retry backoff), so the step is reported as
 * `not_run` — never as a success — and the error is carried through.
 */
function mapStatus(status: ResolvedAgentTask['status']): GmStepOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'awaiting_approval':
      return 'awaiting_approval';
    default:
      return 'not_run';
  }
}

function isProblemOutcome(outcome: GmStepOutcome): boolean {
  return outcome === 'failed' || outcome === 'blocked' || outcome === 'not_run';
}

function errMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown error';
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : 'unknown error';
}

/** Delegates one step to a specialised agent through the single execution gate. */
async function runStep(
  db: DB,
  runId: string,
  step: GmStepSpec,
  requestedBy: string,
  role: UserRole[],
  audit: GmOrchestrateParams['audit'],
): Promise<GmStepResult> {
  const base = {
    stepId: step.id,
    agentKey: step.agentKey,
    taskType: step.taskType,
    intent: step.intent,
    intentAr: step.intentAr,
  };
  try {
    const task = await createAgentTask(
      db,
      role,
      requestedBy,
      {
        agentKey: step.agentKey,
        taskType: step.taskType,
        input: { gmGoal: step.intent, gmStepId: step.id, ...(step.input ?? {}) },
        correlationId: runId,
        triggeredBy: `gm:${runId}`,
        // Per-(run, step) idempotency: a re-run of the same orchestration cannot
        // create a duplicate open task for the same step.
        dedupeKey: `gm:${runId}:${step.id}`,
        priority: 50,
      },
      audit,
    );
    const outcome = mapStatus(task.status);
    const advice = outcome === 'succeeded' ? String((task.result as { advice?: unknown } | null)?.advice ?? '') : '';
    const evidence = outcome === 'succeeded' ? extractEvidence(advice) : { keys: [], values: {} };
    return {
      ...base,
      outcome,
      taskId: task.id,
      requiresApproval: task.requiresApproval,
      approvalAction: task.approvalAction,
      evidenceKeys: evidence.keys,
      evidence: evidence.values,
      error: isProblemOutcome(outcome) ? errMessage(task.error) : null,
      skippedReason: null,
    };
  } catch (err) {
    // A refusal at the gate (RBAC/scope/capability/unknown agent) or a transient
    // failure is recorded safely — never as a success and never fatal to the run.
    logger.warn('gm orchestrator step not dispatched', {
      runId,
      stepId: step.id,
      agentKey: step.agentKey,
      error: errMessage(err),
    });
    return {
      ...base,
      outcome: 'skipped',
      taskId: null,
      requiresApproval: false,
      approvalAction: null,
      evidenceKeys: [],
      evidence: {},
      error: null,
      skippedReason: errMessage(err),
    };
  }
}

/**
 * Runs one management goal end to end: analyse → select → coordinate → aggregate
 * → review → report → propose.
 *
 * The orchestrator holds no execution authority of its own: every step is a
 * `createAgentTask` call made under the caller's real identity, so the existing
 * RBAC, scope, kill switch, approval, budget and audit controls all apply. It
 * performs no financial or commercial mutation, and it never fabricates a
 * `SUPER_ADMIN` principal.
 */
export async function orchestrateGmGoal(db: DB, params: GmOrchestrateParams): Promise<GmOrchestrationResult> {
  const { goal, requestedBy, role, audit } = params;
  const maxSteps = Math.max(1, Math.min(params.options?.maxSteps ?? MAX_STEPS_PER_RUN, MAX_STEPS_PER_RUN));
  const runId = newId();

  const { playbook, matched } = classifyGoal(goal);

  const declared = playbook.steps.slice(0, maxSteps);
  const cappedOut = playbook.steps.slice(maxSteps).map((s) => s.id);

  // --- Selection: fail closed, skip (never widen) anything not permitted. ---
  const selected: GmStepSpec[] = [];
  const skipped: { stepId: string; reason: string }[] = [];
  for (const step of declared) {
    const spec: AgentDefinition | undefined = findAgentSpec(step.agentKey);
    if (!spec) {
      skipped.push({ stepId: step.id, reason: `unknown agent ${step.agentKey}` });
      continue;
    }
    if (spec.isCopilot || spec.isSupervisor) {
      skipped.push({ stepId: step.id, reason: `agent ${spec.key} is not a runnable executor` });
      continue;
    }
    if (!spec.taskTypes.includes(step.taskType)) {
      skipped.push({ stepId: step.id, reason: `agent ${spec.key} does not handle ${step.taskType}` });
      continue;
    }
    const registry = await getRegistryAgent(db, step.agentKey);
    if (registry.status !== 'ACTIVE') {
      skipped.push({ stepId: step.id, reason: `agent ${step.agentKey} is ${registry.status}` });
      continue;
    }
    if (!callerMayUseAgent(role, spec)) {
      skipped.push({ stepId: step.id, reason: `your role may not invoke ${spec.key}` });
      continue;
    }
    if (spec.requiresPlatformScope && !holdsAdmin(role)) {
      skipped.push({ stepId: step.id, reason: `${spec.key} requires an admin role for platform-wide data` });
      continue;
    }
    selected.push(step);
  }
  for (const id of cappedOut) skipped.push({ stepId: id, reason: `run step cap (${maxSteps}) reached` });

  const { waves, dropped } = planWaves(selected);
  for (const id of dropped) skipped.push({ stepId: id, reason: 'dependency missing or cyclic' });

  // --- Coordination: execute wave by wave, respecting dependencies. ---
  const stepById = new Map(playbook.steps.map((s) => [s.id, s]));
  const results: GmStepResult[] = skipped.map((s) => {
    const spec = stepById.get(s.stepId);
    return {
      stepId: s.stepId,
      agentKey: spec?.agentKey ?? 'unknown',
      taskType: spec?.taskType ?? 'unknown',
      intent: spec?.intent ?? '',
      intentAr: spec?.intentAr ?? '',
      outcome: 'skipped' as const,
      taskId: null,
      requiresApproval: false,
      approvalAction: null,
      evidenceKeys: [],
      evidence: {},
      error: null,
      skippedReason: s.reason,
    };
  });

  for (const wave of waves) {
    const waveResults = await Promise.all(
      wave.map((step) => runStep(db, runId, step, requestedBy, role, audit)),
    );
    results.push(...waveResults);
  }

  // --- Aggregation, review and report. ---
  const review = reviewResults(results);
  const report = buildReport({ goal, playbook, matched, results, review });
  const proposedActions = proposeActions(playbook, results, review);

  const capturedAt = new Date().toISOString();
  const snapshot: GmRunSnapshot = {
    version: GM_SNAPSHOT_VERSION,
    goal,
    requestedBy,
    role,
    playbookId: playbook.id,
    matchedKeywords: matched,
    plan: { waves: waves.map((w) => w.map((s) => s.id)), dropped },
    results,
    review,
    report,
    proposedActions,
    capturedAt,
  };

  // The audit row IS the durable record of the run: `after` carries the full
  // snapshot, so the exact result (including skipped/failed/awaiting_approval
  // steps and their reasons) can be replayed later without recomputation. The
  // `metadata` summary is kept for the existing audit views and stays a
  // *derived* count-only view — never the source of truth.
  await writeAudit(db, audit, {
    action: 'AI.GM_ORCHESTRATED',
    entityType: 'AI_ORCHESTRATION',
    entityId: runId,
    after: snapshot as unknown as Record<string, unknown>,
    metadata: {
      goal: goal.slice(0, 200),
      playbookId: playbook.id,
      matchedKeywords: matched,
      snapshotVersion: GM_SNAPSHOT_VERSION,
      executedSteps: results.filter((r) => r.outcome === 'succeeded' || r.outcome === 'failed').length,
      succeeded: results.filter((r) => r.outcome === 'succeeded').length,
      failed: review.failed.length,
      pendingApproval: review.pendingApproval.length,
      skipped: review.skipped.length,
    },
  });

  return {
    runId,
    correlationId: runId,
    requestedBy,
    role,
    playbookId: playbook.id,
    matchedKeywords: matched,
    plan: { waves: waves.map((w) => w.map((s) => s.id)), dropped },
    results,
    review,
    report,
    proposedActions,
  };
}

/**
 * Reads a completed GM orchestration back from its persisted snapshot.
 *
 * The run is looked up by `correlationId` on the `AI.GM_ORCHESTRATED` audit row
 * (the run id and the correlation id are the same value). The result is decoded
 * **verbatim** from `audit_logs.after` — the review, report and proposed actions
 * are never recomputed from current agent/task state, so history cannot be
 * rewritten by a later approval, kill-switch change or role change.
 *
 * Fail-closed on missing/legacy data:
 *   - no such run, or a run whose snapshot predates AI-07.0a (empty/absent
 *     `after`), or a snapshot version this build does not understand →
 *     `ApiError.notFound`. We never fall back to reconstructing from live rows,
 *     which would produce a plausible-but-wrong report.
 *
 * Scope: `ownerId` is compared to the snapshot's `requestedBy`. A caller may
 * read a run only when it is theirs or when they hold platform scope (resolved
 * from the database, never the request). A non-owner, non-platform caller gets
 * the same 404 as a missing run — no existence leak.
 */
export async function getGmRun(db: DB, correlationId: string, ownerId: string): Promise<GmRunRecord> {
  const rows = await db
    .select({ after: auditLogs.after, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'AI.GM_ORCHESTRATED'), eq(auditLogs.entityId, correlationId)))
    .limit(1);

  const row = rows[0];
  const snapshot = row?.after as Partial<GmRunSnapshot> | null | undefined;
  if (!row || !snapshot || typeof snapshot !== 'object' || snapshot.version !== GM_SNAPSHOT_VERSION) {
    // Absent, legacy (no snapshot) or a version this build cannot read: refuse
    // rather than reconstruct from live state.
    throw ApiError.notFound('GM run');
  }

  const isOwner = snapshot.requestedBy === ownerId;
  if (!isOwner && !(await userHasPlatformScope(db, ownerId))) {
    // Indistinguishable from "not found" so a caller cannot probe for the
    // existence of another owner's run.
    throw ApiError.notFound('GM run');
  }

  return {
    runId: correlationId,
    correlationId,
    requestedBy: snapshot.requestedBy!,
    role: snapshot.role!,
    playbookId: snapshot.playbookId!,
    matchedKeywords: snapshot.matchedKeywords ?? [],
    plan: snapshot.plan!,
    results: snapshot.results!,
    review: snapshot.review!,
    report: snapshot.report!,
    proposedActions: snapshot.proposedActions!,
    createdAt: row.createdAt.toISOString(),
    capturedAt: snapshot.capturedAt ?? row.createdAt.toISOString(),
  };
}

/** Lists the playbooks (for the desk UI and documentation). */
export function listGmPlaybooks(): { id: string; label: string; labelAr: string; steps: number; agents: string[] }[] {
  return GM_PLAYBOOKS.map((p) => ({
    id: p.id,
    label: p.label,
    labelAr: p.labelAr,
    steps: p.steps.length,
    agents: [...new Set(p.steps.map((s) => s.agentKey))],
  }));
}

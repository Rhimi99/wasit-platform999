/**
 * Platform Maintenance & Repair — root-cause analysis and patch proposals.
 *
 * The diagnosis executor could say *that* tasks failed, but not *why*: the
 * repair advice on a failure finding was a fixed paragraph telling a human to
 * "group the failures by agent and error code". That grouping is deterministic
 * work on data the agent already reads, so it belongs here rather than in a
 * person's head.
 *
 * Everything in this module is a pure function over rows the caller has already
 * fetched inside the agent's data scope. Nothing reads the database, writes a
 * file, runs a command or calls a model, which is what makes it safe to compute
 * inside a read-only executor.
 *
 * The output is a *proposal*. `likelyFiles` are real repository paths, and a
 * test asserts they exist, so a proposal can never point a reviewer at a file
 * that is not there. Applying a patch, merging, migrating or deploying stay
 * outside this module: those actions have no executor and require GM approval
 * (AD-050).
 */

export const FAILURE_FAMILIES = [
  'INSUFFICIENT_STOCK',
  'RATE_LIMIT',
  'BUDGET',
  'TIMEOUT',
  'SCOPE_VIOLATION',
  'APPROVAL',
  'VALIDATION',
  'AUTH',
  'PROVIDER',
  'NOT_FOUND',
  'CONFLICT',
  'UNKNOWN',
] as const;

export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

export interface FailureSample {
  taskId: string;
  agentKey: string;
  taskType: string | null;
  error: unknown;
  createdAt: Date;
}

export interface ClassifiedFailure {
  taskId: string;
  agentKey: string;
  taskType: string | null;
  createdAt: Date;
  family: FailureFamily;
  /** Message with identifiers and numbers stripped, so equal causes collapse. */
  signature: string;
  message: string;
}

export interface RootCauseCluster {
  signature: string;
  family: FailureFamily;
  occurrences: number;
  share: number;
  agents: string[];
  taskTypes: string[];
  firstSeen: string;
  lastSeen: string;
  confidence: 'high' | 'medium' | 'low';
  hypothesis: string;
  nextDiagnostics: string[];
  samples: Array<{ taskId: string; agentKey: string; message: string; createdAt: string }>;
}

export interface PatchProposal {
  signature: string;
  family: FailureFamily;
  area: string;
  likelyFiles: string[];
  changeType: 'behaviour' | 'configuration' | 'test_only' | 'investigation';
  riskClass: 'low' | 'medium' | 'high';
  testsToAdd: string[];
  verificationSteps: string[];
  rollback: string;
  requiresGmApproval: true;
  status: 'PROPOSED';
}

interface FamilySpec {
  family: FailureFamily;
  patterns: RegExp[];
  hypothesis: string;
  nextDiagnostics: string[];
  patch: Omit<PatchProposal, 'signature' | 'family' | 'requiresGmApproval' | 'status'>;
}

/**
 * Order matters: the first matching family wins, so the narrowest patterns come
 * first. `UNKNOWN` is the last entry and is never reached by a pattern.
 */
const FAMILY_SPECS: FamilySpec[] = [
  {
    family: 'INSUFFICIENT_STOCK',
    patterns: [/insufficient[_\s-]?stock/i, /not enough stock/i, /\bstock\b.*\b(short|insufficient)\b/i],
    hypothesis:
      'Reservations are losing the race against available quantity: a concurrent sale or adjustment consumed the stock between the read and the guarded decrement.',
    nextDiagnostics: [
      'Compare the reservation timestamps with the sale timestamps for the affected products.',
      'Confirm the guarded decrement returned zero rows (the 409 path) rather than a negative quantity being written.',
      'Check whether the caller retries the reservation or surfaces the conflict to the buyer.',
    ],
    patch: {
      area: 'inventory',
      likelyFiles: ['src/lib/inventory-engine.ts'],
      changeType: 'behaviour',
      riskClass: 'medium',
      testsToAdd: [
        'Two concurrent reservations on a one-unit item: exactly one succeeds, the other gets INSUFFICIENT_STOCK.',
        'A cancelled order releases its reservation once, not twice.',
      ],
      verificationSteps: [
        'Run the inventory suite against a disposable database.',
        'Re-run the diagnosis and confirm the cluster disappears or stops growing.',
      ],
      rollback: 'Revert the commit; no schema or data migration is involved.',
    },
  },
  {
    family: 'RATE_LIMIT',
    patterns: [/rate[_\s-]?limit/i, /too many requests/i, /\b429\b/],
    hypothesis:
      'The caller retries faster than the limiter window, or one principal drives a burst the configured ceiling does not allow.',
    nextDiagnostics: [
      'Identify the principal (user or IP) behind the rejected calls.',
      'Compare the burst size with the configured window and maximum.',
      'Confirm the client backs off instead of retrying immediately.',
    ],
    patch: {
      area: 'rate limiting',
      likelyFiles: ['src/middleware/rate-limit.ts'],
      changeType: 'configuration',
      riskClass: 'low',
      testsToAdd: ['A burst above the ceiling returns 429 with Retry-After, and the counter resets after the window.'],
      verificationSteps: ['Replay the burst against a disposable environment and confirm the ceiling holds.'],
      rollback: 'Restore the previous limits; no data is touched.',
    },
  },
  {
    family: 'BUDGET',
    patterns: [/budget/i, /quota/i, /cost ceiling/i, /spend limit/i],
    hypothesis:
      'The run reached its cost ceiling before finishing, so the remaining work was refused rather than truncated silently.',
    nextDiagnostics: [
      'Read the recorded cost for the task and compare it with the configured ceiling.',
      'Check whether a retry re-counted already-spent cost (it must not).',
      'Decide whether the ceiling or the request size is wrong — this is a policy call, not a bug.',
    ],
    patch: {
      area: 'ai cost control',
      likelyFiles: ['src/lib/ai/cost-control.ts', 'src/lib/ai/agent-run-context.ts'],
      changeType: 'investigation',
      riskClass: 'medium',
      testsToAdd: ['A retry continues from the recorded cost instead of resetting the ceiling.'],
      verificationSteps: ['Confirm the budget refusal is reported as a budget error, not a generic failure.'],
      rollback: 'No change to apply without a decision on the ceiling itself.',
    },
  },
  {
    family: 'TIMEOUT',
    patterns: [/timeout/i, /timed out/i, /etimedout/i, /\b504\b/i, /deadline exceeded/i],
    hypothesis:
      'An upstream call exceeded its deadline; either the provider is slow or the request is unbounded and retries stack latency.',
    nextDiagnostics: [
      'Compare the recorded latency with the provider baseline for the same model.',
      'Check whether the step retried before failing (attempt count).',
      'Confirm the timeout is bounded per call, not per run.',
    ],
    patch: {
      area: 'ai runtime',
      likelyFiles: ['src/lib/ai/provider.ts', 'src/lib/ai/runtime.ts'],
      changeType: 'behaviour',
      riskClass: 'low',
      testsToAdd: ['A slow provider is cut at the configured deadline and surfaces a timeout error, not a hang.'],
      verificationSteps: ['Run the runtime suite with a deliberately slow stub and confirm the deadline holds.'],
      rollback: 'Revert the commit; provider settings are environment-driven.',
    },
  },
  {
    family: 'SCOPE_VIOLATION',
    patterns: [/scope/i, /not allowed to (read|access|write)/i, /prohibited/i, /table .* (is )?(not|denied)/i],
    hypothesis:
      'An executor asked for a table or column outside its A2 contract, so the scoped handle refused it. The contract is right; the executor is reaching too far.',
    nextDiagnostics: [
      'Read the denied table name from the error and compare it with the agent contract.',
      'Decide which side is wrong: the contract (needs a decision) or the executor (a bug).',
      'Never widen a contract to make a failing executor pass without an explicit approval.',
    ],
    patch: {
      area: 'agent data scope',
      likelyFiles: ['src/modules/ai/agent-scope.ts', 'src/modules/ai/executors.ts'],
      changeType: 'behaviour',
      riskClass: 'high',
      testsToAdd: ['The executor succeeds with only its contract tables and fails closed on any other table.'],
      verificationSteps: ['Run the scope suite; confirm no other agent contract changed.'],
      rollback: 'Revert the executor change. A contract change is never part of an automatic patch.',
    },
  },
  {
    family: 'APPROVAL',
    patterns: [/approval/i, /not approved/i, /rejected by/i, /awaiting_approval/i],
    hypothesis:
      'The task was gated on a human decision that did not arrive, or was rejected. This is the approval gate working, not a defect.',
    nextDiagnostics: [
      'Check who the approver is and whether the request was surfaced to them.',
      'Read the rejection reason when present.',
    ],
    patch: {
      area: 'agent approvals',
      likelyFiles: ['src/modules/ai/agents.ts'],
      changeType: 'investigation',
      riskClass: 'low',
      testsToAdd: ['A gated task stays awaiting_approval until a different principal decides.'],
      verificationSteps: ['Confirm the approval notification was delivered.'],
      rollback: 'No change: the gate is the intended behaviour.',
    },
  },
  {
    family: 'VALIDATION',
    patterns: [/validation/i, /invalid/i, /\bzod\b/i, /must be/i, /required/i, /\b422\b/],
    hypothesis:
      'The request did not satisfy the schema. Either the caller sends the wrong shape or the contract changed under it.',
    nextDiagnostics: [
      'Read the field path from the error and compare it with the request that produced it.',
      'Check whether the caller was updated when the schema changed.',
    ],
    patch: {
      area: 'request validation',
      likelyFiles: ['src/modules/ai/routes.ts'],
      changeType: 'behaviour',
      riskClass: 'low',
      testsToAdd: ['The rejected payload returns 422 with the field path, and a valid payload still succeeds.'],
      verificationSteps: ['Run the route suite.'],
      rollback: 'Revert the commit; no data is affected.',
    },
  },
  {
    family: 'AUTH',
    patterns: [/unauthor/i, /forbidden/i, /\b401\b/, /\b403\b/, /invalid token/i, /session expired/i],
    hypothesis:
      'The caller was not authenticated, or lacked the role the route requires. Expected for a wrong-role caller; a defect when a correct caller is refused.',
    nextDiagnostics: [
      'Identify the principal and the roles it held at the time.',
      'Compare them with the permission the route requires.',
    ],
    patch: {
      area: 'access control',
      likelyFiles: ['src/middleware/auth.ts'],
      changeType: 'investigation',
      riskClass: 'high',
      testsToAdd: ['The refused principal stays refused; the intended principal succeeds.'],
      verificationSteps: ['Run the RBAC suites. A permission change is never an automatic patch.'],
      rollback: 'No change without an explicit approval.',
    },
  },
  {
    family: 'PROVIDER',
    patterns: [/provider/i, /upstream/i, /model .* (unavailable|not found)/i, /anthropic/i, /openai/i, /\bllm\b/i],
    hypothesis:
      'The AI provider call failed or the configured model was not usable, so the feature degraded instead of answering.',
    nextDiagnostics: [
      'Check which provider and model the run resolved.',
      'Confirm the fallback path exists and is reachable.',
    ],
    patch: {
      area: 'ai provider',
      likelyFiles: ['src/lib/ai/provider.ts'],
      changeType: 'configuration',
      riskClass: 'low',
      testsToAdd: ['An unavailable provider falls back to the deterministic engine instead of failing the task.'],
      verificationSteps: ['Run the AI core suite with the provider disabled.'],
      rollback: 'Restore the previous provider configuration.',
    },
  },
  {
    family: 'NOT_FOUND',
    patterns: [/not found/i, /\b404\b/, /does not exist/i, /missing/i],
    hypothesis:
      'The target row was gone by the time the task ran — deleted, or referenced by a stale identifier.',
    nextDiagnostics: [
      'Check whether the row still exists and who deleted it.',
      'Confirm the caller re-reads the identifier instead of caching it.',
    ],
    patch: {
      area: 'entity lookup',
      likelyFiles: ['src/modules/ai/executors.ts'],
      changeType: 'behaviour',
      riskClass: 'low',
      testsToAdd: ['A stale identifier returns a 404-shaped error instead of an unhandled exception.'],
      verificationSteps: ['Run the affected executor suite.'],
      rollback: 'Revert the commit.',
    },
  },
  {
    family: 'CONFLICT',
    patterns: [/conflict/i, /duplicate/i, /already exists/i, /unique/i, /\b409\b/],
    hypothesis:
      'A uniqueness constraint rejected a second write of the same logical row — an idempotency key that was not honoured, or a genuine double submit.',
    nextDiagnostics: [
      'Identify the constraint and the two rows that collided.',
      'Check whether the caller sends a stable idempotency key.',
    ],
    patch: {
      area: 'idempotency',
      likelyFiles: ['src/modules/ai/agents.ts'],
      changeType: 'behaviour',
      riskClass: 'low',
      testsToAdd: ['Re-submitting the same request returns the first task instead of a conflict.'],
      verificationSteps: ['Run the dedupe suite.'],
      rollback: 'Revert the commit; the constraint stays.',
    },
  },
];

const UNKNOWN_SPEC: FamilySpec = {
  family: 'UNKNOWN',
  patterns: [],
  hypothesis:
    'The stored error does not match a known family, so no cause is asserted. More samples or a wider window are needed before proposing a change.',
  nextDiagnostics: [
    'Read the raw error for one of the samples.',
    'Widen the window or reproduce the failure to get a second occurrence.',
  ],
  patch: {
    area: 'undetermined',
    likelyFiles: [],
    changeType: 'investigation',
    riskClass: 'low',
    testsToAdd: [],
    verificationSteps: ['Reproduce the failure before proposing any change.'],
    rollback: 'Nothing to roll back: no change is proposed.',
  },
};

const SPEC_BY_FAMILY = new Map<FailureFamily, FamilySpec>(
  [...FAMILY_SPECS, UNKNOWN_SPEC].map((spec) => [spec.family, spec]),
);

/** Reads the message out of the shapes `agent_tasks.error` is actually written in. */
export function errorMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'reason']) {
      const value = record[key];
      const nested = errorMessage(value);
      if (nested) return nested;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return '';
    }
  }
  return String(error);
}

export function classifyFamily(message: string): FailureFamily {
  for (const spec of FAMILY_SPECS) {
    if (spec.patterns.some((pattern) => pattern.test(message))) return spec.family;
  }
  return 'UNKNOWN';
}

/**
 * Collapses the volatile parts of a message — ids, emails, numbers, quoted
 * values — so two occurrences of the same cause produce the same signature.
 */
export function failureSignature(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>')
    .replace(/"[^"]*"|'[^']*'/g, '<value>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return '(empty error)';
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized;
}

export function classifyFailure(row: FailureSample): ClassifiedFailure {
  const message = errorMessage(row.error);
  return {
    taskId: row.taskId,
    agentKey: row.agentKey,
    taskType: row.taskType,
    createdAt: row.createdAt,
    family: classifyFamily(message),
    signature: failureSignature(message),
    message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
  };
}

function confidenceOf(family: FailureFamily, occurrences: number): 'high' | 'medium' | 'low' {
  if (family === 'UNKNOWN') return 'low';
  if (occurrences >= 3) return 'high';
  if (occurrences >= 2) return 'medium';
  return 'low';
}

/** Groups classified failures by signature, most frequent first. */
export function clusterFailures(classified: ClassifiedFailure[]): RootCauseCluster[] {
  const bySignature = new Map<string, ClassifiedFailure[]>();
  for (const failure of classified) {
    const bucket = bySignature.get(failure.signature);
    if (bucket) bucket.push(failure);
    else bySignature.set(failure.signature, [failure]);
  }

  const total = classified.length;
  const clusters = [...bySignature.entries()].map(([signature, rows]) => {
    const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const family = sorted[0]!.family;
    const spec = SPEC_BY_FAMILY.get(family) ?? UNKNOWN_SPEC;
    const occurrences = sorted.length;
    return {
      signature,
      family,
      occurrences,
      share: total === 0 ? 0 : Number((occurrences / total).toFixed(4)),
      agents: [...new Set(sorted.map((r) => r.agentKey))].sort(),
      taskTypes: [...new Set(sorted.map((r) => r.taskType).filter((v): v is string => Boolean(v)))].sort(),
      firstSeen: sorted[0]!.createdAt.toISOString(),
      lastSeen: sorted[occurrences - 1]!.createdAt.toISOString(),
      confidence: confidenceOf(family, occurrences),
      hypothesis: spec.hypothesis,
      nextDiagnostics: [...spec.nextDiagnostics],
      samples: sorted.slice(0, 5).map((r) => ({
        taskId: r.taskId,
        agentKey: r.agentKey,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
      })),
    } satisfies RootCauseCluster;
  });

  return clusters.sort(
    (a, b) => b.occurrences - a.occurrences || Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
  );
}

export function proposePatch(cluster: RootCauseCluster): PatchProposal {
  const spec = SPEC_BY_FAMILY.get(cluster.family) ?? UNKNOWN_SPEC;
  return {
    signature: cluster.signature,
    family: cluster.family,
    ...spec.patch,
    likelyFiles: [...spec.patch.likelyFiles],
    testsToAdd: [...spec.patch.testsToAdd],
    verificationSteps: [...spec.patch.verificationSteps],
    requiresGmApproval: true,
    status: 'PROPOSED',
  };
}

export interface RootCauseAnalysis {
  sampleSize: number;
  clusters: RootCauseCluster[];
  dominant: RootCauseCluster | null;
  unknownSamples: number;
  window: { days: number; from: string; to: string };
}

export function analyseFailures(
  rows: FailureSample[],
  window: { days: number; from: string; to: string },
): RootCauseAnalysis {
  const classified = rows.map(classifyFailure);
  const clusters = clusterFailures(classified);
  return {
    sampleSize: classified.length,
    clusters,
    dominant: clusters[0] ?? null,
    unknownSamples: classified.filter((f) => f.family === 'UNKNOWN').length,
    window,
  };
}

export interface ReviewReport {
  summary: string;
  checklist: Array<{ step: string; state: 'done' | 'blocked' | 'pending_approval'; detail: string }>;
  approvalsRequired: string[];
  appliesChanges: false;
}

/**
 * The six steps the GM asked for, with the state of each stated honestly. A step
 * this process cannot perform says so instead of being quietly dropped.
 */
export function buildReviewReport(analysis: RootCauseAnalysis, proposals: PatchProposal[]): ReviewReport {
  const dominant = analysis.dominant;
  const summary =
    analysis.sampleSize === 0
      ? 'No failures in the window; there is nothing to repair.'
      : dominant
        ? `${dominant.occurrences} of ${analysis.sampleSize} failure(s) share one signature (${dominant.family}) across ${dominant.agents.length} agent(s); that is the dominant cause.`
        : 'Failures were found but could not be grouped.';

  const blockedTests =
    proposals.length === 0
      ? 'No proposal to test.'
      : `Isolated test execution is not available to an agent: it needs a disposable database and a command runner, neither of which the read-only runtime has. The proposed tests are listed per proposal.`;

  return {
    summary,
    checklist: [
      { step: 'diagnose', state: 'done', detail: `${analysis.sampleSize} failure sample(s) read in the window.` },
      {
        step: 'root_cause',
        state: dominant ? 'done' : 'blocked',
        detail: dominant ? dominant.hypothesis : 'No groupable failure; nothing is asserted.',
      },
      {
        step: 'patch_proposal',
        state: proposals.length > 0 ? 'done' : 'blocked',
        detail:
          proposals.length > 0
            ? `${proposals.length} proposal(s) with files, tests and rollback.`
            : 'No proposal: a cause must be established first.',
      },
      { step: 'isolated_tests', state: 'blocked', detail: blockedTests },
      {
        step: 'review_report',
        state: 'done',
        detail: 'This report: severity, evidence, blast radius, approvals and rollback per proposal.',
      },
      {
        step: 'apply_patch',
        state: 'pending_approval',
        detail:
          'code.apply_patch and code.merge are approval actions with no executor (AD-050); the patch is delivered as a proposal for the GM.',
      },
    ],
    approvalsRequired: ['code.apply_patch', 'code.merge'],
    appliesChanges: false,
  };
}

export interface RepairPackage {
  signature: string;
  family: FailureFamily;
  /** Suggested branch, derived from the family so it is stable across runs. */
  branch: string;
  baseBranch: string;
  prTitle: string;
  prBody: string;
  approvalsRequired: string[];
  /**
   * Where the GM decision lives. The agent cannot record it: `audit_logs` is
   * hard-denied to every agent run (A2), so an approval must be recorded by a
   * human before anything is applied.
   */
  approvalStatus: 'NOT_RECORDED';
  delivery: { appliedBy: 'human', mergeBlockedUntilApproval: true };
  rollback: string;
  verification: string[];
  blocked: Array<{ step: string; reason: string }>;
  generatedAt: string;
}

function slug(family: FailureFamily): string {
  return family.toLowerCase().replace(/_/g, '-');
}

/**
 * Turns one cluster into the deliverable the GM asked for: an independent
 * branch, a pull request body, the tests, the verification steps and the
 * rollback — everything needed to review a repair, and nothing that applies it.
 *
 * The package deliberately carries no diff. Producing a correct patch needs the
 * failing path to be read and changed by someone accountable for it; inventing
 * one here would be a guess dressed as a fix.
 */
export function buildRepairPackage(
  cluster: RootCauseCluster,
  proposal: PatchProposal,
  now: Date = new Date(),
): RepairPackage {
  const occurrences = `${cluster.occurrences} occurrence(s)`;
  const agents = cluster.agents.join(', ') || '(unknown)';
  const tests = proposal.testsToAdd.length > 0 ? proposal.testsToAdd.map((t) => `- [ ] ${t}`).join('\n') : '- [ ] (no test proposed — investigation only)';
  const files = proposal.likelyFiles.length > 0 ? proposal.likelyFiles.map((f) => `- \`${f}\``).join('\n') : '- (no file identified)';

  const prBody = [
    `## ${proposal.family} — ${proposal.area}`,
    '',
    '### What',
    cluster.hypothesis,
    '',
    '### Evidence',
    `- Signature: \`${cluster.signature}\``,
    `- Occurrences: ${occurrences} (${(cluster.share * 100).toFixed(1)}% of failures in the window)`,
    `- Agents affected: ${agents}`,
    `- First seen: ${cluster.firstSeen} · Last seen: ${cluster.lastSeen}`,
    `- Confidence: ${cluster.confidence}`,
    '',
    '### Blast radius',
    `- Risk class: ${proposal.riskClass}`,
    `- Change type: ${proposal.changeType}`,
    files,
    '',
    '### Tests to add',
    tests,
    '',
    '### Verification',
    ...proposal.verificationSteps.map((s) => `- [ ] ${s}`),
    '- [ ] `npx tsc --noEmit` in `packages/server`',
    '- [ ] Full server suite green against a disposable database',
    '',
    '### Rollback',
    proposal.rollback,
    '',
    '### Approval',
    'This package was generated by the Platform Maintenance agent, which cannot write',
    'to the repository (`code.apply_patch` / `code.merge` have no executor). A General',
    'Manager must approve before the branch is opened and again before it is merged.',
    '',
    `_Generated ${now.toISOString()} — proposal status ${proposal.status}._`,
  ].join('\n');

  return {
    signature: cluster.signature,
    family: proposal.family,
    branch: `ai-repair/${slug(proposal.family)}`,
    baseBranch: 'master',
    prTitle: `fix(ai-repair): ${proposal.family} — ${proposal.area}`,
    prBody,
    approvalsRequired: ['code.apply_patch', 'code.merge'],
    approvalStatus: 'NOT_RECORDED',
    delivery: { appliedBy: 'human', mergeBlockedUntilApproval: true },
    rollback: proposal.rollback,
    verification: [...proposal.verificationSteps],
    blocked: [
      {
        step: 'isolated_tests',
        reason: 'No command runner or disposable database is available inside an agent run.',
      },
      {
        step: 'apply_patch',
        reason: 'Approval action with no executor (AD-050); a human applies it on the branch.',
      },
    ],
    generatedAt: now.toISOString(),
  };
}

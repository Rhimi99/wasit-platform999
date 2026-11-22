import type { AgentDefinition } from '../../lib/ai/types.js';

/**
 * WASIT specialised agent catalogue — 21 agents plus the Copilot coordinator.
 *
 * This file is the ORGANISATIONAL source of truth: identity, department, tier,
 * mission, declared capabilities, intended data sources, approval actions,
 * limits, task types and objectives. It is restored from the historical
 * reference (commit `0c3d239`) so no planned agent is lost.
 *
 * Structure (AI-ARCH-ALIGN-01): every entry carries a `tier`.
 *  - 12 `CORE_SPECIALIST` — the official agents, listed in `CORE_SPECIALIST_KEYS`.
 *  -  8 `SUPPORTING`     — internal function agents, never presented as official.
 *  -  1 `GOVERNANCE`     — the Agent Supervisor. The Copilot is the same tier but
 *                          lives outside `AGENT_CATALOGUE` (it is never a task agent).
 *
 * R1 boundary — this file is DATA, not behaviour:
 *  - It declares nothing executable. An entry with `executable: false` has no
 *    executor on this branch and cannot run; asking for it fails closed.
 *  - `allowedTools` is DECLARATIVE. No Tool Gateway is bound here, so listing a
 *    tool grants no access and invokes nothing.
 *  - Approval actions and limits are recorded for the future gate; the live
 *    gate remains the existing `requiresHumanApproval` + A2 scope + A1 context.
 *
 * The eleven agents that already execute keep their existing definitions in
 * `agents.ts`. Their entries here carry the organisational metadata only, so
 * runtime behaviour is unchanged.
 */

/** Shared tool groups (declarative only in R1). */
const READ_TOOLS = ['platform.metrics', 'platform.read_orders', 'report.generate'];
const CATALOG_TOOLS = ['platform.read_catalog', 'platform.metrics', 'report.generate'];
const COMPLIANCE_TOOLS = ['compliance.read_platform'];
const OUTREACH_TOOLS = [
  'outreach.discover_entities',
  'outreach.verify_entity',
  'outreach.classify_fit',
  'outreach.persist_prospects',
  'messaging.draft_outreach',
  'outreach.persist_drafts',
  'outreach.record_outcome',
  'outreach.refer',
  'report.generate',
];

/** The Copilot key — deliberately outside the 20 specialised agents. */
export const COPILOT_KEY = 'wasit-copilot';

/** The oversight agent key — agent #20. */
export const SUPERVISOR_KEY = 'agent-supervisor';

/**
 * The official twelve Core Specialist Agents, in the approved order.
 *
 * This list is the identity contract of the WASIT AI structure: every key must
 * resolve to a catalogue entry with `tier: 'CORE_SPECIALIST'`, and no other
 * entry may carry that tier. Tests enforce both directions, so the official
 * structure cannot drift from the code by editing one side only.
 */
export const CORE_SPECIALIST_KEYS = [
  'sales-agent',
  'marketing-agent',
  'ads-agent',
  'product-agent',
  'support-agent',
  'analytics-agent',
  'market-research-agent',
  'b2b-agent',
  'risk-agent',
  'dispute-assistant',
  'development-agent',
  'marketing-video-agent',
] as const;

export type CoreSpecialistKey = (typeof CORE_SPECIALIST_KEYS)[number];

/**
 * Roles that may run an agent whose data is platform-wide.
 *
 * `requiresPlatformScope` has been declared on eight agents since the catalogue
 * existed, but nothing enforced it: A2 bounds an agent to *tables*, not rows, so
 * a platform-wide agent reads every tenant's rows. A caller holding only
 * `ai:use` could therefore run the maintenance agent and read other principals'
 * stored task errors, or run the growth agent and enumerate every supplier,
 * merchant and company. Enforcing the declared flag closes that; it grants
 * nothing new and removes no permission from any role.
 */
export const PLATFORM_SCOPE_ROLES: readonly string[] = ['ADMIN', 'SUPER_ADMIN'];

/**
 * Actions that always require an explicit human approval, regardless of which
 * agent performs them. Declarative in R1: the live approval gate is still
 * `requiresHumanApproval` on the executable catalogue plus the A1/A2 boundary.
 */
export const SENSITIVE_ACTIONS: ReadonlySet<string> = new Set([
  'outreach.send',
  'finance.payout',
  'finance.refund',
  'payment.settle',
  'commission.change',
  'prod.deploy',
  'prod.migrate',
  'code.apply_patch',
  'code.merge',
  'growth.paid_campaign',
  'risk.block_account',
  'dispute.final_decision',
  'compliance.final_ruling',
  'ads.spend_increase',
  'video.publish',
  'video.render_paid',
]);

/**
 * The Copilot — a coordination layer, NOT one of the 20 specialised agents.
 * It has no executor on this branch and is never counted by `agentCount()`.
 */
export const COPILOT_CATALOGUE: AgentDefinition = {
  key: COPILOT_KEY,
  tier: 'GOVERNANCE',
  name: 'WASIT AI Copilot',
  nameAr: 'مساعد الوسيط الذكي',
  mission:
    'Central coordination layer: receives events, delegates tasks to the specialised agents, aggregates results and reports to humans.',
  category: 'coordination',
  description:
    'Central coordinator that delegates events to specialised agents and aggregates results.',
  capabilities: [
    { action: 'delegate', description: 'Route an event to one or more specialised agents' },
    { action: 'summarize', description: 'Aggregate results into a human report' },
  ],
  allowedTools: ['platform.metrics', 'report.generate'],
  approvalActions: [],
  limits: { maxFanout: 10, maxCostUsdPerRun: 2 },
  taskTypes: ['copilot.route_event', 'copilot.summarize'],
  objectives: [
    {
      id: 'copilot.routing_success',
      statement: 'Route every recognised event to its owning agent',
      metric: 'routing_success_rate',
      target: 0.99,
      unit: 'ratio',
      direction: 'increase',
      window: 'daily',
    },
    {
      id: 'copilot.dedup_guard',
      statement: 'Never dispatch a duplicate event within one run',
      metric: 'duplicate_dispatches',
      target: 0,
      unit: 'count',
      direction: 'decrease',
      window: 'per_task',
    },
  ],

  permissionsRequired: ['ai:manage'],
  requiresHumanApproval: false,
  isCopilot: true,
  executable: false,
};

/**
 * The 20 specialised agents, in the approved organisational order.
 *
 * Entries 1–11 are the agents that already execute on this branch
 * (`executable: true`). Entries 12–20 are restored organisational definitions
 * with no executor yet (`executable: false`) — they are catalogued, described
 * and bounded, and they cannot run until their executors and A2 contracts are
 * delivered in a later phase.
 */
export const AGENT_CATALOGUE: AgentDefinition[] = [
  // --------------------------------------------------- 1–11: executable today
  {
    key: 'sales-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Sales Agent',
    nameAr: 'وكيل المبيعات',
    mission: 'Convert qualified prospects and leads into active merchants.',
    category: 'growth',
    description: 'Identifies prospective buyers/leads and recommends sales priorities.',
    capabilities: [{ action: 'identify_leads', description: 'Find prospective buyers for a seller' }],
    allowedTools: [
      ...READ_TOOLS,
      'sales.read_orders_owned',
      'sales.read_orders_platform',
      'sales.read_market_totals',
    ],
    approvalActions: ['finance.refund', 'commission.change'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['sales.qualify_lead', 'sales.update_pipeline'],
    objectives: [
      {
        id: 'sales.qualified_leads',
        statement: 'Qualify inbound leads into the pipeline',
        metric: 'qualified_leads',
        target: 10,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'sales.pipeline_updates',
        statement: 'Keep the sales pipeline current',
        metric: 'pipeline_updates',
        target: 5,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
    ],

    // AI-REG-01: executable entries mirror the ENFORCED runtime contract (see
    // `agents.ts`). The catalogue must never widen or narrow what the live agent
    // requires, otherwise making it the single source would change RBAC for real
    // callers.
    permissionsRequired: ['ai:use'],
    scope: 'own',
    requiresHumanApproval: true,
    executable: true,
  },
  {
    key: 'marketing-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Marketing Agent',
    nameAr: 'وكيل التسويق',
    mission:
      'Plan marketplace campaigns and marketing content. Video production is owned by the Marketing Video Agent.',
    category: 'growth',
    description: 'Recommends marketing content angles and channel mix for campaigns.',
    capabilities: [
      { action: 'recommend_campaign', description: 'Draft a marketing campaign proposal' },
    ],
    allowedTools: [
      ...CATALOG_TOOLS,
      'marketing.read_catalogue_owned',
      'marketing.read_catalogue_platform',
      'marketing.read_videos_owned',
    ],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1.5 },
    taskTypes: ['marketing.plan_campaign'],
    objectives: [
      {
        id: 'marketing.campaigns_planned',
        statement: 'Plan marketplace campaigns',
        metric: 'campaigns_planned',
        target: 2,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'marketing.previewable_videos',
        statement: 'Deliver previewable marketing video assets',
        metric: 'previewable_videos',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'ads-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Ads Agent',
    nameAr: 'وكيل الإعلانات',
    mission: 'Propose and monitor paid ad placements and budgets.',
    category: 'growth',
    description: 'Suggests ad budget allocation and placement strategies.',
    capabilities: [{ action: 'recommend_ads', description: 'Draft an advertising plan' }],
    allowedTools: [...READ_TOOLS, 'ads.read_campaigns'],
    approvalActions: ['ads.spend_increase'],
    limits: { maxCostUsdPerRun: 1, maxDailyBudgetUsd: 200 },
    taskTypes: ['ads.propose_budget'],
    objectives: [
      {
        id: 'ads.budget_proposals',
        statement: 'Propose ad budget allocations',
        metric: 'budget_proposals',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'ads.no_overspend',
        statement: 'Never exceed the approved ad budget',
        metric: 'overspend_events',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'daily',
      },
    ],

    permissionsRequired: ['ai:use', 'ad:create'],
    requiresPlatformScope: true,
    requiresHumanApproval: true,
    executable: true,
  },
  {
    key: 'product-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Product Agent',
    nameAr: 'وكيل المنتجات',
    mission: 'Maintain catalogue quality and product taxonomy.',
    category: 'operations',
    description: 'Analyzes a product listing, pricing, category fit and completeness.',
    capabilities: [{ action: 'analyze_product', description: 'Analyze a product listing' }],
    allowedTools: [
      ...CATALOG_TOOLS,
      'product.read_public',
      'product.read_owned',
      'product.read_platform',
    ],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['product.audit_catalog'],
    objectives: [
      {
        id: 'product.catalog_audits',
        statement: 'Audit catalogue listings for quality',
        metric: 'catalog_audits',
        target: 20,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'product.completeness',
        statement: 'Raise average listing completeness',
        metric: 'avg_completeness_ratio',
        target: 0.8,
        unit: 'ratio',
        direction: 'increase',
        window: 'weekly',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'support-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Support Agent',
    nameAr: 'وكيل الدعم',
    mission: 'Triage customer issues and route them to the right resolver.',
    category: 'operations',
    description: 'Drafts a support reply given customer conversation context.',
    capabilities: [{ action: 'draft_reply', description: 'Draft a support response' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['support.triage_ticket'],
    objectives: [
      {
        id: 'support.tickets_triaged',
        statement: 'Triage customer issues to the right resolver',
        metric: 'tickets_triaged',
        target: 30,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'support.draft_replies',
        statement: 'Draft support replies',
        metric: 'draft_replies',
        target: 20,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
    ],

    permissionsRequired: ['ai:use'],
    scope: 'own',
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'analytics-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Analytics Agent',
    nameAr: 'وكيل التحليلات',
    mission: 'Produce analytics on orders, growth and costs.',
    category: 'insight',
    description: 'Computes business KPIs from live platform data.',
    capabilities: [{ action: 'generate_report', description: 'Generate a KPI report' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['analytics.report'],
    objectives: [
      {
        id: 'analytics.kpi_reports',
        statement: 'Produce KPI reports from live data',
        metric: 'kpi_reports',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'analytics.report_latency',
        statement: 'Keep report generation fast',
        metric: 'report_latency_ms',
        target: 5000,
        unit: 'ms',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use', 'analytics:read:own'],
    scope: 'platform',
    requiresPlatformScope: true,
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'market-research-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Market Research Agent',
    nameAr: 'وكيل أبحاث السوق',
    mission: 'Research markets, competitors and demand signals for WASIT.',
    category: 'insight',
    description: 'Provides market overview, category trends and competitive notes.',
    capabilities: [{ action: 'market_overview', description: 'Summarize a market/category' }],
    allowedTools: [
      'outreach.discover_entities',
      'platform.metrics',
      'market.read_overview',
      'market.read_own',
      'report.generate',
    ],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1.5, discoveryLimit: 100 },
    taskTypes: ['research.scan_market'],
    objectives: [
      {
        id: 'research.market_scans',
        statement: 'Scan target markets and categories',
        metric: 'market_scans',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'research.discovery_cap',
        statement: 'Respect the discovery limit per run',
        metric: 'discovery_overruns',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'daily',
      },
    ],

    permissionsRequired: ['ai:use'],
    scope: 'platform',
    // It reads every seller, product and order on the platform, so it is a
    // platform tool: only roles with platform authority may run it (AI-07).
    requiresPlatformScope: true,
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'b2b-agent',
    tier: 'CORE_SPECIALIST',
    name: 'B2B Agent',
    nameAr: 'وكيل الأعمال B2B',
    mission: 'Develop B2B partnerships with suppliers and large merchants.',
    category: 'growth',
    description: 'Matches buyers to suppliers and merchants to fulfil B2B needs.',
    capabilities: [{ action: 'match_b2b', description: 'Find B2B partners' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['b2b.manage_partner'],
    objectives: [
      {
        id: 'b2b.partner_matches',
        statement: 'Match buyers to suppliers and merchants',
        metric: 'partner_matches',
        target: 5,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
    ],

    permissionsRequired: ['ai:use'],
    // Partner matching names other suppliers/merchants/companies, so no row
    // filter can hide them without emptying the answer. Platform roles only
    // (AI-FIRST-COMPLETION-03); the executor refuses independently.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
    executable: true,
  },
  {
    key: 'risk-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Risk Agent',
    nameAr: 'وكيل المخاطر',
    mission: 'Detect fraud, anomalies and risky counterparties.',
    category: 'trust',
    description: 'Assesses risk indicators for an entity or transaction.',
    capabilities: [{ action: 'assess_risk', description: 'Evaluate risk indicators' }],
    allowedTools: [...READ_TOOLS, 'risk.read_overview'],
    approvalActions: ['risk.block_account'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['risk.scan'],
    objectives: [
      {
        id: 'risk.scans',
        statement: 'Scan entities and transactions for risk',
        metric: 'risk_scans',
        target: 50,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'risk.high_risk_flags',
        statement: 'Surface high-risk indicators',
        metric: 'high_risk_flags',
        target: 5,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
    ],

    permissionsRequired: ['risk:read'],
    requiresPlatformScope: true,
    requiresHumanApproval: true,
    executable: true,
  },
  {
    key: 'dispute-assistant',
    tier: 'CORE_SPECIALIST',
    name: 'Dispute Assistant',
    nameAr: 'مساعد النزاعات',
    mission: 'Assist dispute resolution with evidence summaries.',
    category: 'trust',
    description: 'Summarizes dispute context and recommends possible resolution paths.',
    capabilities: [{ action: 'summarize_dispute', description: 'Summarize dispute context' }],
    allowedTools: [...READ_TOOLS, 'disputes.read_summary'],
    approvalActions: ['dispute.final_decision'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['dispute.summarize'],
    objectives: [
      {
        id: 'dispute.summaries',
        statement: 'Summarize dispute context',
        metric: 'dispute_summaries',
        target: 10,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'dispute.recommendations',
        statement: 'Recommend resolution paths',
        metric: 'recommendations',
        target: 10,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
    ],

    permissionsRequired: ['dispute:read'],
    requiresPlatformScope: true,
    requiresHumanApproval: true,
    executable: true,
  },
  {
    key: 'development-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Platform Maintenance & Repair Agent',
    nameAr: 'وكيل صيانة المنصة وإصلاحها',
    mission:
      'Keep the platform healthy: watch failures, analyse run/task signals, name the probable cause and prepare a reviewable repair (patch, tests, report) for the General Manager to approve.',
    category: 'platform',
    description:
      'Diagnoses the platform from real run and task data and drafts repairs. Diagnosis runs automatically; any change to project files, any migration and any deployment stays behind an explicit General Manager approval, and the agent can never approve its own work.',
    capabilities: [
      { action: 'diagnose_platform', description: 'Diagnose failures, stuck work and error trends' },
      { action: 'propose_patch', description: 'Propose a patch/diff with the tests that cover it' },
      { action: 'write_tests', description: 'Write the regression tests a repair requires' },
      { action: 'dev_plan', description: 'Produce a technical plan' },
      {
        action: 'apply_patch',
        description: 'Apply a patch to project files (requires General Manager approval)',
        requiresApproval: true,
      },
      {
        action: 'merge_change',
        description: 'Merge a change (requires General Manager approval)',
        requiresApproval: true,
      },
    ],
    allowedTools: ['platform.metrics', 'report.generate', 'development.read_platform'],
    approvalActions: ['code.apply_patch', 'code.merge', 'prod.deploy', 'prod.migrate'],
    limits: { maxCostUsdPerRun: 2, maxFindingsPerRun: 25, diagnosisWindowDays: 7 },
    taskTypes: ['dev.diagnose', 'dev.plan_change', 'dev.repair'],
    objectives: [
      {
        id: 'dev.diagnoses',
        statement: 'Diagnose platform failures from real run data',
        metric: 'diagnoses',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'dev.technical_plans',
        statement: 'Produce technical plans',
        metric: 'technical_plans',
        target: 5,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'dev.no_ungated_prod',
        statement: 'Never perform an ungated production action',
        metric: 'ungated_prod_actions',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresPlatformScope: true,
    // Diagnosis is read-only and runs on request; every mutating action stays in
    // `approvalActions` and has no executor at all (fail-closed).
    requiresHumanApproval: false,
    executable: true,
  },

  {
    key: 'marketing-video-agent',
    tier: 'CORE_SPECIALIST',
    name: 'Marketing Video Agent',
    nameAr: 'وكيل الفيديو التسويقي',
    mission:
      'Plan marketing videos end to end — brief, script, storyboard, assets and delivery — without publishing them.',
    category: 'growth',
    description:
      'Turns a marketing goal into a video plan: audience, script, storyboard, asset list and platform variants. Production and publishing are separate, human-gated steps.',
    capabilities: [
      { action: 'plan_video', description: 'Plan a marketing video from a goal and audience' },
      { action: 'write_script', description: 'Write the script and on-screen copy' },
      { action: 'build_storyboard', description: 'Lay out scenes, visuals and audio cues' },
      { action: 'prepare_delivery', description: 'Prepare variants and metadata for hand-off' },
      {
        action: 'render_video',
        description: 'Render the video with an approved production tool',
        requiresApproval: true,
      },
      {
        action: 'publish_video',
        description: 'Publish the video on an external platform',
        requiresApproval: true,
      },
    ],
    // Declarative data sources only: no media or publishing tool is bound on
    // this branch, so none of these grants access or performs an effect.
    allowedTools: [
      'marketing.read_catalogue_owned',
      'marketing.read_brand_assets',
      'video.read_assets_owned',
      'video.plan_storyboard',
      'video.render_approved',
      'video.publish_approved',
    ],
    approvalActions: ['video.render_paid', 'video.publish'],
    limits: { maxCostUsdPerRun: 2, maxScenesPerVideo: 12, maxDurationSeconds: 120 },
    taskTypes: ['marketing.plan_video', 'marketing.produce_video'],
    objectives: [
      {
        id: 'video.plans_delivered',
        statement: 'Deliver a complete video plan (script + storyboard + assets)',
        metric: 'video_plans',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'per_task',
      },
      {
        id: 'video.ungated_publishes',
        statement: 'Never publish a video without a human approval',
        metric: 'ungated_publishes',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],
    scope: 'own',
    permissionsRequired: ['ai:use'],
    // Production (render) and publication are distinct approvals; publishing is
    // always external and therefore always human.
    requiresHumanApproval: true,
    // Planning, readiness and the render request run here. The render itself is
    // executed by the media module: it writes a media_assets row and an audit
    // entry, and agents may not write audit_logs (A2). Publishing still has no
    // executor at all.
    executable: true,
  },

  // ------------------------------- 12–20: restored organisational definitions
  {
    key: 'finance-agent',
    tier: 'SUPPORTING',
    name: 'Finance & Cost Accounting Agent',
    nameAr: 'وكيل المحاسبة المالية وتحليل التكاليف',
    mission:
      'Account for the platform in read-only terms: order volume and value, WASIT commission and payment fees (accrued versus realised), AI cost per request type and advertising spend, and the resulting contribution — with the source, currency and period of every figure.',
    category: 'finance',
    description:
      'Read-only accountant. Reads orders, campaigns and AI usage aggregates; it never touches the transaction ledger, never moves funds and never edits a financial record.',
    capabilities: [
      { action: 'report_pnl', description: 'Report revenue, cost and contribution for a window' },
      { action: 'report_revenue', description: 'Report order volume, GMV, commission and fees' },
      { action: 'report_costs', description: 'Report AI cost per request type and advertising spend' },
      { action: 'report_forecast', description: 'Project the next window from the same figures' },
    ],
    // `finance.read_ledger` was declared but can never be served: the ledger and
    // the commission policies are hard-denied to every agent. Accounting is done
    // from order-level aggregates (which already carry the recorded commission),
    // so the declared tool list no longer promises an impossible read.
    allowedTools: READ_TOOLS,
    approvalActions: ['finance.payout', 'finance.refund', 'commission.change'],
    limits: { maxCostUsdPerRun: 1, defaultWindowDays: 30, maxWindowDays: 365 },
    taskTypes: ['finance.report_pnl', 'finance.reconcile'],
    objectives: [
      {
        id: 'finance.pnl_reports',
        statement: 'Report revenue, cost and contribution from real figures',
        metric: 'pnl_reports',
        target: 1,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'finance.no_fabricated_figures',
        statement: 'Never report a figure without a source and period',
        metric: 'unsourced_figures',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
      {
        id: 'finance.no_fund_movement',
        statement: 'Never move, hold or settle funds',
        metric: 'fund_movements',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use', 'revenue:read'],
    requiresPlatformScope: true,
    // Every capability is a read; the money-moving actions are declared in
    // `approvalActions` and have no executor.
    requiresHumanApproval: false,
    executable: true,
  },
  {
    key: 'payment-settlement-agent',
    tier: 'SUPPORTING',
    name: 'Payment & Settlement Agent',
    nameAr: 'وكيل المدفوعات والتسويات',
    mission: 'Monitor payments and settlement flows; never move funds autonomously.',
    category: 'finance',
    description:
      'Reports payment intents, webhook health and settlement/payout status; read-only.',
    capabilities: [
      { action: 'monitor_settlement', description: 'Report settlement anomalies' },
    ],
    allowedTools: [...READ_TOOLS, 'payments.read_settlements'],
    approvalActions: ['payment.settle', 'finance.payout'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['payment.monitor_settlement'],
    objectives: [
      {
        id: 'payment.settlement_monitors',
        statement: 'Monitor settlement flows',
        metric: 'settlement_monitors',
        target: 24,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'payment.webhook_health',
        statement: 'Keep webhook failures at zero',
        metric: 'failed_webhooks',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'daily',
      },
    ],

    permissionsRequired: ['ai:use', 'order:read'],
    requiresHumanApproval: true,
    executable: false,
  },
  {
    key: 'compliance-agent',
    tier: 'SUPPORTING',
    name: 'Compliance Agent',
    nameAr: 'وكيل الامتثال',
    mission: 'Check adherence to platform policy and regulations.',
    category: 'trust',
    description:
      'Surfaces policy/verification gaps for entities and orders; produces findings only.',
    capabilities: [{ action: 'check', description: 'Produce compliance findings' }],
    allowedTools: COMPLIANCE_TOOLS,
    approvalActions: ['compliance.final_ruling'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['compliance.check'],
    objectives: [
      {
        id: 'compliance.checks',
        statement: 'Check policy and verification adherence',
        metric: 'compliance_checks',
        target: 20,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'compliance.open_findings',
        statement: 'Drive open compliance findings to zero',
        metric: 'open_findings',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'weekly',
      },
    ],

    permissionsRequired: ['ai:use', 'order:read'],
    requiresPlatformScope: true,
    requiresHumanApproval: true,
    executable: false,
  },
  {
    key: 'supplier-agent',
    tier: 'SUPPORTING',
    name: 'Supplier Agent',
    nameAr: 'وكيل الموردين',
    mission: 'Onboard and manage suppliers.',
    category: 'network',
    description:
      "Reviews supplier records for completeness; scoped to the caller's own entity.",
    capabilities: [{ action: 'onboard', description: 'Validate a supplier record' }],
    allowedTools: [...CATALOG_TOOLS, 'supplier.read_owned'],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['supplier.onboard'],
    objectives: [
      {
        id: 'supplier.reviews',
        statement: 'Review supplier records',
        metric: 'supplier_reviews',
        target: 10,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'supplier.record_completeness',
        statement: 'Raise supplier record completeness',
        metric: 'avg_record_completeness',
        target: 0.85,
        unit: 'ratio',
        direction: 'increase',
        window: 'weekly',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
    executable: false,
  },
  {
    key: 'merchant-agent',
    tier: 'SUPPORTING',
    name: 'Merchant Agent',
    nameAr: 'وكيل التجار',
    mission: 'Onboard and manage merchants.',
    category: 'network',
    description:
      "Reviews merchant records for completeness; scoped to the caller's own entity.",
    capabilities: [{ action: 'onboard', description: 'Validate a merchant record' }],
    allowedTools: [...CATALOG_TOOLS, 'merchant.read_owned'],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['merchant.onboard'],
    objectives: [
      {
        id: 'merchant.reviews',
        statement: 'Review merchant records',
        metric: 'merchant_reviews',
        target: 10,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'merchant.record_completeness',
        statement: 'Raise merchant record completeness',
        metric: 'avg_record_completeness',
        target: 0.85,
        unit: 'ratio',
        direction: 'increase',
        window: 'weekly',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
    executable: false,
  },
  {
    key: 'customer-intelligence-agent',
    tier: 'SUPPORTING',
    name: 'Customer Intelligence Agent',
    nameAr: 'وكيل ذكاء العملاء',
    mission: 'Build customer insight and segmentation.',
    category: 'insight',
    description: "Segments customers from order data; scoped to the caller's own sales.",
    capabilities: [{ action: 'segment', description: 'Produce customer segments' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['customer.segment'],
    objectives: [
      {
        id: 'customer.segments',
        statement: 'Produce customer segments',
        metric: 'segments_produced',
        target: 5,
        unit: 'count',
        direction: 'increase',
        window: 'weekly',
      },
      {
        id: 'customer.scope_isolation',
        statement: "Never leak another tenant's customer data",
        metric: 'cross_tenant_leaks',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use', 'analytics:read:own'],
    scope: 'own',
    requiresHumanApproval: false,
    executable: false,
  },
  {
    key: 'operations-agent',
    tier: 'SUPPORTING',
    name: 'Operations Agent',
    nameAr: 'وكيل العمليات',
    mission: 'Keep day-to-day operations healthy and flag blockers.',
    category: 'operations',
    description:
      'Reports operational health (open orders, failed tasks, inventory alerts) from typed queries only — no raw SQL.',
    capabilities: [{ action: 'health_check', description: 'Produce an ops health report' }],
    allowedTools: [...READ_TOOLS, 'operations.read_health'],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['operations.health_check'],
    objectives: [
      {
        id: 'operations.health_checks',
        statement: 'Run operational health checks',
        metric: 'health_checks',
        target: 24,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'operations.blockers',
        statement: 'Keep open operational blockers at zero',
        metric: 'open_blockers',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'daily',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresPlatformScope: true,
    requiresHumanApproval: false,
    executable: false,
  },
  {
    key: 'outreach-acquisition-agent',
    tier: 'SUPPORTING',
    name: 'Global Growth & Acquisition Agent',
    nameAr: 'وكيل النمو والتوسع العالمي',
    mission:
      'Grow WASIT BUSINESS GLOBAL across markets: rank markets and segments from platform supply and demand, build qualified opportunity lists, prepare market-specific acquisition strategies and multilingual outreach drafts, and track acquisition indicators when the data exists.',
    category: 'growth',
    description:
      'Runs a market-discovery/qualification/draft cycle over platform data. Nothing leaves the platform: sending, paid campaigns and purchases are declared as approval actions with no executor, and every draft waits for the General Manager.',
    capabilities: [
      { action: 'discover_markets', description: 'Rank markets and segments from platform data' },
      { action: 'qualify_opportunities', description: 'Build a qualified opportunity list' },
      { action: 'discover', description: 'Discover candidate entities' },
      { action: 'verify', description: 'Verify and de-duplicate candidates' },
      { action: 'classify_fit', description: 'Classify fit' },
      { action: 'draft', description: 'Draft market-specific outreach messages' },
      { action: 'send', description: 'Send outreach (requires approval)', requiresApproval: true },
      {
        action: 'launch_paid_campaign',
        description: 'Launch a paid acquisition campaign (requires approval)',
        requiresApproval: true,
      },
    ],
    allowedTools: OUTREACH_TOOLS,
    approvalActions: ['outreach.send', 'growth.paid_campaign'],
    limits: {
      maxCostUsdPerRun: 2,
      dailyDiscoveryLimit: 200,
      dailySendLimit: 50,
      intervalSeconds: 86400,
      maxMarketsPerRun: 12,
    },
    taskTypes: ['growth.discover_markets', 'growth.build_target_list', 'outreach.run_cycle'],
    objectives: [
      {
        id: 'outreach.discoveries',
        statement: 'Discover candidate entities',
        metric: 'discovered_entities',
        target: 200,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'outreach.drafts',
        statement: 'Draft personalised outreach',
        metric: 'outreach_drafts',
        target: 50,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'outreach.send_gate',
        statement: 'Never send without an approval',
        metric: 'unapproved_sends',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
      {
        id: 'growth.markets_ranked',
        statement: 'Rank the expansion markets from platform data',
        metric: 'markets_ranked',
        target: 12,
        unit: 'count',
        direction: 'increase',
        window: 'per_task',
      },
      {
        id: 'growth.qualified_opportunities',
        statement: 'Produce qualified opportunities, each with its evidence',
        metric: 'qualified_opportunities',
        target: 50,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'growth.no_external_spend',
        statement: 'Never spend or message outside the platform without approval',
        metric: 'unapproved_external_actions',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:use'],
    requiresPlatformScope: true,
    // Discovery, qualification and drafting are read-only and produce nothing
    // that leaves the platform. Sending and paid campaigns are declared approval
    // actions with no executor, so the approval gate stays intact.
    requiresHumanApproval: true,
    executable: true,
  },

  // ------------------------------------------------ agent #20: Agent Supervisor
  {
    key: SUPERVISOR_KEY,
    tier: 'GOVERNANCE',
    name: 'Agent Supervisor',
    nameAr: 'وكيل الإشراف',
    mission:
      'Oversee the agent layer: monitor task/agent health, contain retry loops, stuck and over-budget tasks, enforce capability boundaries, escalate to the SUPER_ADMIN and let operators pause/disable an agent.',
    category: 'oversight',
    description:
      'Deterministic oversight agent: observes tasks, contains breaches (loop/stuck/budget/overreach) and escalates. It cannot approve actions, lift an approval gate, change the catalogue or grant permissions.',
    capabilities: [
      { action: 'observe', description: 'Recompute task and agent health' },
      { action: 'contain', description: 'Fail/block a task that breached a limit' },
      { action: 'escalate', description: 'Raise an alert for the SUPER_ADMIN' },
    ],
    allowedTools: ['platform.read_orders', 'platform.metrics', 'report.generate'],
    approvalActions: [],
    limits: {
      maxCostUsdPerRun: 1,
      maxAttempts: 3,
      stuckRuntimeSeconds: 300,
      staleQueueSeconds: 3600,
      failureRateThreshold: 0.5,
    },
    taskTypes: ['supervisor.observe'],
    objectives: [
      {
        id: 'supervisor.observations',
        statement: 'Observe agent/task health',
        metric: 'supervisor_observations',
        target: 48,
        unit: 'count',
        direction: 'increase',
        window: 'daily',
      },
      {
        id: 'supervisor.containment',
        statement: 'Contain breaches (loop/stuck/budget)',
        metric: 'contained_tasks',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'daily',
      },
      {
        id: 'supervisor.escalation_delivery',
        statement: 'Deliver every escalation to a Super Admin',
        metric: 'undelivered_escalations',
        target: 0,
        unit: 'count',
        direction: 'decrease',
        window: 'per_task',
      },
    ],

    permissionsRequired: ['ai:manage'],
    requiresHumanApproval: false,
    isSupervisor: true,
    executable: false,
  },
];

/** All specs including the Copilot (Copilot first). */
export function allAgentSpecs(): AgentDefinition[] {
  return [COPILOT_CATALOGUE, ...AGENT_CATALOGUE];
}

/** Number of specialised agents — excludes the Copilot. */
export function agentCount(): number {
  return AGENT_CATALOGUE.length;
}

/** The twelve official Core Specialist Agents, in the approved order. */
export function coreSpecialistAgents(): AgentDefinition[] {
  const byKey = new Map(AGENT_CATALOGUE.map((a) => [a.key, a]));
  return CORE_SPECIALIST_KEYS.map((key) => {
    const spec = byKey.get(key);
    if (!spec) throw new Error(`Core specialist "${key}" is missing from the agent catalogue`);
    return spec;
  });
}

/** Internal function agents — not part of the official twelve. */
export function supportingAgents(): AgentDefinition[] {
  return AGENT_CATALOGUE.filter((a) => a.tier === 'SUPPORTING');
}

/** Oversight/coordination layers (Supervisor + Copilot). Never specialists. */
export function governanceAgents(): AgentDefinition[] {
  return [COPILOT_CATALOGUE, ...AGENT_CATALOGUE.filter((a) => a.tier === 'GOVERNANCE')];
}

export interface CatalogueIntegrity {
  ok: boolean;
  problems: string[];
}

/**
 * Structural check of the official structure. Pure and side-effect free: used by
 * tests and by any future startup check. It never mutates the catalogue.
 */
export function catalogueIntegrity(): CatalogueIntegrity {
  const problems: string[] = [];
  const keys = AGENT_CATALOGUE.map((a) => a.key);
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicates.length > 0) problems.push(`duplicate agent keys: ${[...new Set(duplicates)].join(', ')}`);

  const core = AGENT_CATALOGUE.filter((a) => a.tier === 'CORE_SPECIALIST').map((a) => a.key);
  const missing = CORE_SPECIALIST_KEYS.filter((k) => !core.includes(k));
  const extra = core.filter((k) => !(CORE_SPECIALIST_KEYS as readonly string[]).includes(k));
  if (missing.length > 0) problems.push(`core specialists missing from the catalogue: ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`agents marked CORE_SPECIALIST outside the official list: ${extra.join(', ')}`);
  if (core.length !== CORE_SPECIALIST_KEYS.length) {
    problems.push(`expected ${CORE_SPECIALIST_KEYS.length} core specialists, found ${core.length}`);
  }

  for (const spec of AGENT_CATALOGUE) {
    if (spec.tier === undefined) problems.push(`agent "${spec.key}" has no tier`);
    if (spec.isCopilot === true) problems.push(`the Copilot must not appear in the agent catalogue ("${spec.key}")`);
  }
  if (COPILOT_CATALOGUE.tier !== 'GOVERNANCE') problems.push('the Copilot must be tier GOVERNANCE');
  return { ok: problems.length === 0, problems };
}

/** Looks up a spec by key, including the Copilot. */
export function findAgentSpec(key: string): AgentDefinition | undefined {
  if (key === COPILOT_KEY) return COPILOT_CATALOGUE;
  return AGENT_CATALOGUE.find((a) => a.key === key);
}

/**
 * The trusted, server-derived set of action ids an agent run is authorised to
 * perform. Derived from `capabilities` only — never from `allowedTools` (which
 * names data sources, not effects) and never from task input.
 */
export function authorizedActionsForAgent(agent: AgentDefinition): string[] {
  return agent.capabilities.map((c) => c.action);
}

/** True when an action always requires a human approval, regardless of agent. */
export function isSensitiveAction(action: string): boolean {
  return SENSITIVE_ACTIONS.has(action);
}

/** The agents that have a real executor wired into `executeAgentTask`. */
export function executableAgents(): AgentDefinition[] {
  return AGENT_CATALOGUE.filter((a) => a.executable === true);
}

/** Specialised agents that exist as identity/metadata only — no executor. */
export function declaredOnlyAgents(): AgentDefinition[] {
  return AGENT_CATALOGUE.filter((a) => a.executable !== true && a.isSupervisor !== true);
}

export interface AgentRunRefusal {
  code: 'UNKNOWN_AGENT' | 'COPILOT_NOT_RUNNABLE' | 'SUPERVISOR_NOT_RUNNABLE' | 'AGENT_NOT_EXECUTABLE';
  message: string;
}

/**
 * Why an agent may not be run as a task, or `null` when it may.
 *
 * Pure, and shared by every run path (user task creation, scheduling, dispatch)
 * so a declared-but-unimplemented agent, the Copilot and the oversight supervisor
 * fail the same way everywhere — before any task row is written.
 */
export function agentRunRefusal(agent: AgentDefinition | undefined): AgentRunRefusal | null {
  if (!agent) return { code: 'UNKNOWN_AGENT', message: 'Unknown agent' };
  if (agent.isCopilot === true) {
    return {
      code: 'COPILOT_NOT_RUNNABLE',
      message: `"${agent.key}" is the coordinating Copilot, not a specialised agent: it cannot be dispatched as a task`,
    };
  }
  if (agent.isSupervisor === true) {
    return {
      code: 'SUPERVISOR_NOT_RUNNABLE',
      message: `"${agent.key}" is the oversight supervisor: it runs its own cycle and cannot be dispatched as a task`,
    };
  }
  if (agent.executable !== true) {
    return {
      code: 'AGENT_NOT_EXECUTABLE',
      message: `"${agent.key}" is declared in the agent catalogue but has no executor, so it cannot run tasks`,
    };
  }
  return null;
}

/** Composition of the agent layer: 20 specialised + 1 supervisor, Copilot apart. */
export interface AgentLayerCounts {
  total: number;
  specialised: number;
  supervisor: number;
  executable: number;
  declared: number;
  copilot: number;
}

export function agentLayerCounts(): AgentLayerCounts {
  const supervisor = AGENT_CATALOGUE.filter((a) => a.isSupervisor === true).length;
  const executable = AGENT_CATALOGUE.filter((a) => a.executable === true).length;
  return {
    total: AGENT_CATALOGUE.length,
    specialised: AGENT_CATALOGUE.length - supervisor,
    supervisor,
    executable,
    declared: AGENT_CATALOGUE.length - executable - supervisor,
    copilot: 1,
  };
}

import type { AgentDefinition } from '../../lib/ai/types.js';

/**
 * WASIT specialised agent catalogue — 20 agents plus the Copilot coordinator.
 *
 * This is the single source of truth for what each agent may do. Every agent is
 * bounded: it declares a tool allow-list, the actions that need a human approval,
 * deterministic limits, and the task types it owns. The Copilot is the central
 * coordinator and is deliberately NOT counted among the 20.
 *
 * Nothing here computes money or mutates state — executors only read live data
 * and produce advisory output; sensitive actions are gated by approval.
 */

// Shared tool groups keep the specs readable and consistent.
const READ_TOOLS = ['platform.metrics', 'platform.read_orders', 'report.generate'];
const CATALOG_TOOLS = ['platform.read_catalog', 'platform.metrics', 'report.generate'];
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

export const COPILOT_KEY = 'wasit-copilot';

/**
 * Actions that always require an explicit human approval before an agent may
 * perform them. The list is the single authority the runner consults; an agent
 * that declares one of these in `approvalActions` is queued, not run.
 */
export const SENSITIVE_ACTIONS: ReadonlySet<string> = new Set([
  'outreach.send',
  'finance.payout',
  'finance.refund',
  'payment.settle',
  'commission.change',
  'prod.deploy',
  'prod.migrate',
  'risk.block_account',
  'dispute.final_decision',
  'compliance.final_ruling',
  'ads.spend_increase',
]);

export const COPILOT_CATALOGUE: AgentDefinition = {
  key: COPILOT_KEY,
  name: 'WASIT AI Copilot',
  nameAr: 'مساعد الوسيط الذكي',
  mission:
    'Central coordination layer: receives events, delegates tasks to the specialised agents, aggregates results and reports to humans.',
  category: 'coordination',
  description: 'Central coordinator that delegates events to specialised agents and aggregates results.',
  capabilities: [
    { action: 'delegate', description: 'Route an event to one or more specialised agents' },
    { action: 'summarize', description: 'Aggregate results into a human report' },
  ],
  allowedTools: ['platform.metrics', 'report.generate'],
  approvalActions: [],
  limits: { maxFanout: 10, maxCostUsdPerRun: 2 },
  taskTypes: ['copilot.route_event', 'copilot.summarize'],
  objectives: [
    { id: 'copilot.routing_success', statement: 'Route every recognised event to its owning agent', metric: 'routing_success_rate', target: 0.99, unit: 'ratio', direction: 'increase', window: 'daily' },
    { id: 'copilot.dedup_guard', statement: 'Never dispatch a duplicate event within one run', metric: 'duplicate_dispatches', target: 0, unit: 'count', direction: 'decrease', window: 'per_task' },
  ],

  permissionsRequired: ['ai:manage'],
  requiresHumanApproval: false,
  isCopilot: true,
};

export const AGENT_CATALOGUE: AgentDefinition[] = [
  // ---------------------------------------------------------------- existing 11
  {
    key: 'sales-agent',
    name: 'Sales Agent',
    nameAr: 'وكيل المبيعات',
    mission: 'Convert qualified prospects and leads into active merchants.',
    category: 'growth',
    description: 'Identifies prospective buyers/leads and recommends sales priorities.',
    capabilities: [{ action: 'identify_leads', description: 'Find prospective buyers for a seller' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['finance.refund', 'commission.change'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['sales.qualify_lead', 'sales.update_pipeline'],
    objectives: [
      { id: 'sales.qualified_leads', statement: 'Qualify inbound leads into the pipeline', metric: 'qualified_leads', target: 10, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'sales.pipeline_updates', statement: 'Keep the sales pipeline current', metric: 'pipeline_updates', target: 5, unit: 'count', direction: 'increase', window: 'daily' },
    ],

    permissionsRequired: ['ai:use', 'order:read:own'],
    // Scoped to the caller's own sales; a platform-wide pipeline aggregate
    // additionally needs `analytics:read:all`.
    scope: 'own',
    requiresHumanApproval: true,
  },
  {
    key: 'marketing-agent',
    name: 'Marketing Agent',
    nameAr: 'وكيل التسويق',
    mission: 'Plan and produce marketplace marketing content and campaigns.',
    category: 'growth',
    description: 'Recommends marketing content angles and channel mix for campaigns.',
    capabilities: [{ action: 'recommend_campaign', description: 'Draft a marketing campaign proposal' }],
    allowedTools: CATALOG_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1.5 },
    taskTypes: ['marketing.plan_campaign'],
    objectives: [
      { id: 'marketing.campaigns_planned', statement: 'Plan marketplace campaigns', metric: 'campaigns_planned', target: 2, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'marketing.previewable_videos', statement: 'Deliver previewable marketing video assets', metric: 'previewable_videos', target: 1, unit: 'count', direction: 'increase', window: 'per_task' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'ads-agent',
    name: 'Ads Agent',
    nameAr: 'وكيل الإعلانات',
    mission: 'Propose and monitor paid ad placements and budgets.',
    category: 'growth',
    description: 'Suggests ad budget allocation and placement strategies.',
    capabilities: [{ action: 'recommend_ads', description: 'Draft an advertising plan' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['ads.spend_increase'],
    limits: { maxCostUsdPerRun: 1, maxDailyBudgetUsd: 200 },
    taskTypes: ['ads.propose_budget'],
    objectives: [
      { id: 'ads.budget_proposals', statement: 'Propose ad budget allocations', metric: 'budget_proposals', target: 1, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'ads.no_overspend', statement: 'Never exceed the approved ad budget', metric: 'overspend_events', target: 0, unit: 'count', direction: 'decrease', window: 'daily' },
    ],

    permissionsRequired: ['ai:use', 'ad:create'],
    // Every campaign (advertiser, budget, spend) is platform data: admin-only.
    // A non-admin is refused rather than shown the whole ad book.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
  },
  {
    key: 'product-agent',
    name: 'Product Agent',
    nameAr: 'وكيل المنتجات',
    mission: 'Maintain catalogue quality and product taxonomy.',
    category: 'operations',
    description: 'Analyzes a product listing, pricing, category fit and completeness.',
    capabilities: [{ action: 'analyze_product', description: 'Analyze a product listing' }],
    allowedTools: CATALOG_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['product.audit_catalog'],
    objectives: [
      { id: 'product.catalog_audits', statement: 'Audit catalogue listings for quality', metric: 'catalog_audits', target: 20, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'product.completeness', statement: 'Raise average listing completeness', metric: 'avg_completeness_ratio', target: 0.8, unit: 'ratio', direction: 'increase', window: 'weekly' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'support-agent',
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
      { id: 'support.tickets_triaged', statement: 'Triage customer issues to the right resolver', metric: 'tickets_triaged', target: 30, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'support.draft_replies', statement: 'Draft support replies', metric: 'draft_replies', target: 20, unit: 'count', direction: 'increase', window: 'daily' },
    ],

    permissionsRequired: ['ai:use', 'message:read:own'],
    // Customer conversations are private data: own scope only.
    scope: 'own',
    requiresHumanApproval: false,
  },
  {
    key: 'analytics-agent',
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
      { id: 'analytics.kpi_reports', statement: 'Produce KPI reports from live data', metric: 'kpi_reports', target: 1, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'analytics.report_latency', statement: 'Keep report generation fast', metric: 'report_latency_ms', target: 5000, unit: 'ms', direction: 'decrease', window: 'per_task' },
    ],

    permissionsRequired: ['ai:use', 'analytics:read:all'],
    // Platform-wide aggregates: only roles with analytics:read:all; a caller
    // without it is refused rather than shown another tenant's data.
    scope: 'platform',
    requiresPlatformScope: true,
    requiresHumanApproval: false,
  },
  {
    key: 'market-research-agent',
    name: 'Market Research Agent',
    nameAr: 'وكيل أبحاث السوق',
    mission: 'Research markets, competitors and demand signals for WASIT.',
    category: 'insight',
    description: 'Provides market overview, category trends and competitive notes.',
    capabilities: [{ action: 'market_overview', description: 'Summarize a market/category' }],
    allowedTools: ['outreach.discover_entities', 'platform.metrics', 'report.generate'],
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1.5, discoveryLimit: 100 },
    taskTypes: ['research.scan_market'],
    objectives: [
      { id: 'research.market_scans', statement: 'Scan target markets and categories', metric: 'market_scans', target: 1, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'research.discovery_cap', statement: 'Respect the discovery limit per run', metric: 'discovery_overruns', target: 0, unit: 'count', direction: 'decrease', window: 'daily' },
    ],

    permissionsRequired: ['ai:use'],
    // Platform-wide *aggregates* only; raw records stay scoped to the caller.
    scope: 'platform',
    requiresHumanApproval: false,
  },
  {
    key: 'b2b-agent',
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
      { id: 'b2b.partner_matches', statement: 'Match buyers to suppliers and merchants', metric: 'partner_matches', target: 5, unit: 'count', direction: 'increase', window: 'weekly' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: true,
  },
  {
    key: 'risk-agent',
    name: 'Risk Agent',
    nameAr: 'وكيل المخاطر',
    mission: 'Detect fraud, anomalies and risky counterparties.',
    category: 'trust',
    description: 'Assesses risk indicators for an entity or transaction.',
    capabilities: [{ action: 'assess_risk', description: 'Evaluate risk indicators' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['risk.block_account'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['risk.scan'],
    objectives: [
      { id: 'risk.scans', statement: 'Scan entities and transactions for risk', metric: 'risk_scans', target: 50, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'risk.high_risk_flags', statement: 'Surface high-risk indicators', metric: 'high_risk_flags', target: 5, unit: 'count', direction: 'increase', window: 'daily' },
    ],

    permissionsRequired: ['risk:read'],
    // `risk:read` alone must not expose every user's risk profile/events. The
    // cross-user risk picture is platform data: admin-only.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
  },
  {
    key: 'dispute-assistant',
    name: 'Dispute Assistant',
    nameAr: 'مساعد النزاعات',
    mission: 'Assist dispute resolution with evidence summaries.',
    category: 'trust',
    description: 'Summarizes dispute context and recommends possible resolution paths.',
    capabilities: [{ action: 'summarize_dispute', description: 'Summarize dispute context' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['dispute.final_decision'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['dispute.summarize'],
    objectives: [
      { id: 'dispute.summaries', statement: 'Summarize dispute context', metric: 'dispute_summaries', target: 10, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'dispute.recommendations', statement: 'Recommend resolution paths', metric: 'recommendations', target: 10, unit: 'count', direction: 'increase', window: 'daily' },
    ],

    permissionsRequired: ['dispute:read'],
    // Every dispute and its messages is cross-user platform data: admin-only.
    // `dispute:read` alone must not enumerate all disputes/participants.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
  },
  {
    key: 'development-agent',
    name: 'Development Agent',
    nameAr: 'وكيل التطوير',
    mission: 'Support engineering work: specs, checks and safe changes.',
    category: 'platform',
    description: 'Summarizes technical context and recommends implementation steps.',
    capabilities: [{ action: 'dev_plan', description: 'Produce a technical plan' }],
    allowedTools: ['platform.metrics', 'report.generate'],
    approvalActions: ['prod.deploy', 'prod.migrate'],
    limits: { maxCostUsdPerRun: 2 },
    taskTypes: ['dev.plan_change'],
    objectives: [
      { id: 'dev.technical_plans', statement: 'Produce technical plans', metric: 'technical_plans', target: 5, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'dev.no_ungated_prod', statement: 'Never perform an ungated production action', metric: 'ungated_prod_actions', target: 0, unit: 'count', direction: 'decrease', window: 'per_task' },
    ],

    permissionsRequired: ['ai:use'],
    // The report counts users/orders/campaigns across the whole platform and
    // reads the platform KPI table: admin-only.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
  },

  // ------------------------------------------------------------- new 8 agents
  {
    key: 'finance-agent',
    name: 'Finance Agent',
    nameAr: 'وكيل المالية',
    mission: 'Produce financial summaries and reconcile commissions from the ledger.',
    category: 'finance',
    description: 'Summarizes commission, payment-fee and refund flows from the ledger; never moves funds.',
    capabilities: [{ action: 'reconcile', description: 'Produce a financial reconciliation summary' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['finance.payout', 'finance.refund', 'commission.change'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['finance.reconcile'],
    objectives: [
      { id: 'finance.reconciliations', statement: 'Reconcile commissions and fees from the ledger', metric: 'reconciliations', target: 1, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'finance.no_unexplained_variance', statement: 'Leave no unexplained ledger variance', metric: 'unexplained_variance', target: 0, unit: 'TND', direction: 'decrease', window: 'monthly' },
    ],

    permissionsRequired: ['ai:use', 'revenue:read'],
    // The ledger, commission policies and transaction flows are platform-wide
    // financial data: admin-only. `revenue:read` alone must not expose them.
    requiresPlatformScope: true,
    requiresHumanApproval: true,
  },
  {
    key: 'payment-settlement-agent',
    name: 'Payment & Settlement Agent',
    nameAr: 'وكيل المدفوعات والتسويات',
    mission: 'Monitor payments and settlement flows; never move funds autonomously.',
    category: 'finance',
    description: 'Reports payment intents, webhook health and settlement/payout status; read-only.',
    capabilities: [{ action: 'monitor_settlement', description: 'Report settlement anomalies' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['payment.settle', 'finance.payout'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['payment.monitor_settlement'],
    objectives: [
      { id: 'payment.settlement_monitors', statement: 'Monitor settlement flows', metric: 'settlement_monitors', target: 24, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'payment.webhook_health', statement: 'Keep webhook failures at zero', metric: 'failed_webhooks', target: 0, unit: 'count', direction: 'decrease', window: 'daily' },
    ],

    permissionsRequired: ['ai:use', 'order:read'],
    requiresHumanApproval: true,
  },
  {
    key: 'compliance-agent',
    name: 'Compliance Agent',
    nameAr: 'وكيل الامتثال',
    mission: 'Check adherence to platform policy and regulations.',
    category: 'trust',
    description: 'Surfaces policy/verification gaps for entities and orders; produces findings only.',
    capabilities: [{ action: 'check', description: 'Produce compliance findings' }],
    allowedTools: READ_TOOLS,
    approvalActions: ['compliance.final_ruling'],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['compliance.check'],
    objectives: [
      { id: 'compliance.checks', statement: 'Check policy and verification adherence', metric: 'compliance_checks', target: 20, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'compliance.open_findings', statement: 'Drive open compliance findings to zero', metric: 'open_findings', target: 0, unit: 'count', direction: 'decrease', window: 'weekly' },
    ],

    permissionsRequired: ['ai:use', 'order:read'],
    requiresHumanApproval: true,
  },
  {
    key: 'supplier-agent',
    name: 'Supplier Agent',
    nameAr: 'وكيل الموردين',
    mission: 'Onboard and manage suppliers.',
    category: 'network',
    description: 'Reviews supplier records for completeness; scoped to the caller\'s own entity.',
    capabilities: [{ action: 'onboard', description: 'Validate a supplier record' }],
    allowedTools: CATALOG_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['supplier.onboard'],
    objectives: [
      { id: 'supplier.reviews', statement: 'Review supplier records', metric: 'supplier_reviews', target: 10, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'supplier.record_completeness', statement: 'Raise supplier record completeness', metric: 'avg_record_completeness', target: 0.85, unit: 'ratio', direction: 'increase', window: 'weekly' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'merchant-agent',
    name: 'Merchant Agent',
    nameAr: 'وكيل التجار',
    mission: 'Onboard and manage merchants.',
    category: 'network',
    description: 'Reviews merchant records for completeness; scoped to the caller\'s own entity.',
    capabilities: [{ action: 'onboard', description: 'Validate a merchant record' }],
    allowedTools: CATALOG_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['merchant.onboard'],
    objectives: [
      { id: 'merchant.reviews', statement: 'Review merchant records', metric: 'merchant_reviews', target: 10, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'merchant.record_completeness', statement: 'Raise merchant record completeness', metric: 'avg_record_completeness', target: 0.85, unit: 'ratio', direction: 'increase', window: 'weekly' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'customer-intelligence-agent',
    name: 'Customer Intelligence Agent',
    nameAr: 'وكيل ذكاء العملاء',
    mission: 'Build customer insight and segmentation.',
    category: 'insight',
    description: 'Segments customers from order data; scoped to the caller\'s own sales.',
    capabilities: [{ action: 'segment', description: 'Produce customer segments' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['customer.segment'],
    objectives: [
      { id: 'customer.segments', statement: 'Produce customer segments', metric: 'segments_produced', target: 5, unit: 'count', direction: 'increase', window: 'weekly' },
      { id: 'customer.scope_isolation', statement: 'Never leak another tenant\'s customer data', metric: 'cross_tenant_leaks', target: 0, unit: 'count', direction: 'decrease', window: 'per_task' },
    ],

    permissionsRequired: ['ai:use', 'analytics:read:own'],
    // Buyer data is scoped to the caller's own sales; never platform-wide.
    scope: 'own',
    requiresHumanApproval: false,
  },
  {
    key: 'operations-agent',
    name: 'Operations Agent',
    nameAr: 'وكيل العمليات',
    mission: 'Keep day-to-day operations healthy and flag blockers.',
    category: 'operations',
    description: 'Reports operational health (open orders, failed tasks, inventory alerts).',
    capabilities: [{ action: 'health_check', description: 'Produce an ops health report' }],
    allowedTools: READ_TOOLS,
    approvalActions: [],
    limits: { maxCostUsdPerRun: 1 },
    taskTypes: ['operations.health_check'],
    objectives: [
      { id: 'operations.health_checks', statement: 'Run operational health checks', metric: 'health_checks', target: 24, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'operations.blockers', statement: 'Keep open operational blockers at zero', metric: 'open_blockers', target: 0, unit: 'count', direction: 'decrease', window: 'daily' },
    ],

    permissionsRequired: ['ai:use'],
    // The ops health report spans every order, dispute and inventory row on the
    // platform: admin-only. The scheduled/system run is unaffected (it carries
    // the trusted scheduler principal and admin roles).
    requiresPlatformScope: true,
    requiresHumanApproval: false,
  },
  {
    key: 'outreach-acquisition-agent',
    name: 'Outreach & Acquisition Agent',
    nameAr: 'وكيل الاستقطاب والتوسع التجاري',
    mission:
      'Discover companies/merchants/suppliers, verify and de-duplicate them, classify fit, draft personalised WASIT introductions and refer interested entities to Sales/B2B.',
    category: 'growth',
    description:
      'Runs a discovery/verification/draft cycle. External sending stays disabled by default and always requires approval.',
    capabilities: [
      { action: 'discover', description: 'Discover candidate entities' },
      { action: 'verify', description: 'Verify and de-duplicate candidates' },
      { action: 'classify_fit', description: 'Classify fit' },
      { action: 'draft', description: 'Draft outreach messages' },
      { action: 'send', description: 'Send outreach (requires approval)', requiresApproval: true },
    ],
    allowedTools: OUTREACH_TOOLS,
    approvalActions: ['outreach.send'],
    limits: { maxCostUsdPerRun: 2, dailyDiscoveryLimit: 200, dailySendLimit: 50, intervalSeconds: 86400 },
    taskTypes: ['outreach.run_cycle'],
    objectives: [
      { id: 'outreach.discoveries', statement: 'Discover candidate entities', metric: 'discovered_entities', target: 200, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'outreach.drafts', statement: 'Draft personalised outreach', metric: 'outreach_drafts', target: 50, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'outreach.send_gate', statement: 'Never send without an approval', metric: 'unapproved_sends', target: 0, unit: 'count', direction: 'decrease', window: 'per_task' },
    ],

    permissionsRequired: ['ai:use'],
    requiresHumanApproval: true,
  },

  // --------------------------------------------------- agent #20: Supervisor
  {
    key: 'agent-supervisor',
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
      { id: 'supervisor.observations', statement: 'Observe agent/task health', metric: 'supervisor_observations', target: 48, unit: 'count', direction: 'increase', window: 'daily' },
      { id: 'supervisor.containment', statement: 'Contain breaches (loop/stuck/budget)', metric: 'contained_tasks', target: 0, unit: 'count', direction: 'decrease', window: 'daily' },
      { id: 'supervisor.escalation_delivery', statement: 'Deliver every escalation to a Super Admin', metric: 'undelivered_escalations', target: 0, unit: 'count', direction: 'decrease', window: 'per_task' },
    ],

    permissionsRequired: ['ai:manage'],
    requiresHumanApproval: false,
    isSupervisor: true,
  },
];

/** All specs including the Copilot (Copilot first). */
export function allAgentSpecs(): AgentDefinition[] {
  return [COPILOT_CATALOGUE, ...AGENT_CATALOGUE];
}

/** Number of specialised agents (excludes the Copilot). */
export function agentCount(): number {
  return AGENT_CATALOGUE.length;
}

export function findAgentSpec(key: string): AgentDefinition | undefined {
  if (key === COPILOT_KEY) return COPILOT_CATALOGUE;
  return AGENT_CATALOGUE.find((a) => a.key === key);
}

/** True when an action always requires a human approval, regardless of agent. */
export function isSensitiveAction(action: string): boolean {
  return SENSITIVE_ACTIONS.has(action);
}

/**
 * Resolves whether a task must be queued for explicit human approval, and under
 * which action label.
 *
 * The task type names *what* is being done (e.g. `finance.reconcile`); an
 * approval action names the *sensitive effect* it may produce (e.g.
 * `finance.payout`). The two are deliberately different strings, so the gate
 * must not compare them. We consult both authorities the catalogue defines:
 *
 *  1. `approvalActions` — an agent whose task may produce any sensitive effect
 *     is always gated (a financial agent cannot be asked to reconcile, then
 *     approve its own payout, without a human in the loop).
 *  2. `isSensitiveAction(taskType)` — a task whose own type is globally
 *     sensitive (e.g. `outreach.send`) is gated even if the agent left it out
 *     of `approvalActions`.
 *
 * `requiresHumanApproval` remains the coarse fallback for agents that declare
 * no explicit approval actions.
 */
export function resolveApproval(
  agent: AgentDefinition,
  taskType: string | undefined,
): { requiresApproval: boolean; approvalAction: string | null } {
  if (taskType && agent.approvalActions.includes(taskType)) {
    return { requiresApproval: true, approvalAction: taskType };
  }
  if (taskType && isSensitiveAction(taskType)) {
    return { requiresApproval: true, approvalAction: taskType };
  }
  if (agent.approvalActions.length > 0) {
    return { requiresApproval: true, approvalAction: agent.approvalActions[0]! };
  }
  if (agent.requiresHumanApproval) {
    return { requiresApproval: true, approvalAction: taskType ?? null };
  }
  return { requiresApproval: false, approvalAction: null };
}


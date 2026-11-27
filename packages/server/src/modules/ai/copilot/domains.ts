/**
 * The coordinator's view of the 20 agents: what each one is for, and the exact
 * input the coordinator may hand it.
 *
 * Two rules make this table safe:
 *  - an agent that needs a concrete entity the request cannot supply (onboarding a
 *    named supplier or merchant) is NOT plannable, so the coordinator cannot
 *    invent one;
 *  - every input here is a fixed, server-owned shape. The model chooses WHICH
 *    agent and WHY; it never writes the payload.
 */

export interface CopilotDomainRule {
  agentKey: string;
  /** Short domain label used in the report and in tests. */
  signal: string;
  /** Keywords per language. Matched case-insensitively as substrings. */
  keywords: { ar: string[]; fr: string[]; en: string[] };
  /** The input the coordinator sends. Never derived from model output. */
  defaultInput: Record<string, unknown>;
}

/** Agents whose executor needs an entity id the request cannot provide. */
export const NON_PLANNABLE_AGENTS: ReadonlySet<string> = new Set([
  'supplier-agent',
  'merchant-agent',
]);

export const COPILOT_DOMAIN_RULES: readonly CopilotDomainRule[] = [
  {
    agentKey: 'sales-agent',
    signal: 'sales',
    keywords: {
      ar: ['مبيعات', 'بيع', 'إيراد', 'ايراد', 'عملاء محتملين', 'طلبات'],
      fr: ['vente', 'ventes', "chiffre d'affaires", 'revenu', 'commandes'],
      en: ['sales', 'sell', 'revenue', 'leads', 'orders'],
    },
    defaultInput: { periodDays: 30 },
  },
  {
    agentKey: 'marketing-agent',
    signal: 'marketing',
    keywords: {
      ar: ['تسويق', 'حملة', 'حملات', 'ترويج'],
      fr: ['marketing', 'campagne', 'promotion'],
      en: ['marketing', 'campaign', 'promotion'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'marketing-video-agent',
    signal: 'video',
    keywords: {
      ar: ['فيديو', 'فيديوهات'],
      fr: ['vidéo', 'video'],
      en: ['video'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'ads-agent',
    signal: 'ads',
    keywords: {
      ar: ['إعلان', 'اعلان', 'إعلانات', 'اعلانات', 'ميزانية إعلانية'],
      fr: ['publicité', 'publicite', 'annonce', 'budget pub'],
      en: ['ads', 'advertising', 'ad spend', 'campaign budget'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'product-agent',
    signal: 'catalogue',
    keywords: {
      ar: ['منتج', 'منتجات', 'كتالوج', 'وصف المنتج'],
      fr: ['produit', 'produits', 'catalogue', 'fiche'],
      en: ['product', 'products', 'catalog', 'listing'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'support-agent',
    signal: 'support',
    keywords: {
      ar: ['دعم', 'شكوى', 'شكاوى', 'تذكرة', 'رسائل العملاء'],
      fr: ['support', 'réclamation', 'reclamation', 'ticket', 'messages clients'],
      en: ['support', 'complaint', 'ticket', 'customer messages'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'analytics-agent',
    signal: 'analytics',
    keywords: {
      ar: ['تحليل', 'تقرير', 'تقارير', 'أداء', 'اداء', 'مؤشرات', 'لوحة'],
      fr: ['analyse', 'rapport', 'performance', 'indicateurs', 'tableau'],
      en: ['analytics', 'report', 'performance', 'kpi', 'dashboard'],
    },
    defaultInput: { periodDays: 30 },
  },
  {
    agentKey: 'market-research-agent',
    signal: 'market',
    keywords: {
      ar: ['سوق', 'منافس', 'منافسين', 'أسعار السوق'],
      fr: ['marché', 'marche', 'concurrent', 'concurrence'],
      en: ['market', 'competitor', 'competition'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'b2b-agent',
    signal: 'b2b',
    keywords: {
      ar: ['شراكة', 'شركاء', 'موردين', 'تجار', 'تعاون'],
      fr: ['partenaire', 'partenariat', 'fournisseur', 'grossiste'],
      en: ['partner', 'partnership', 'supplier', 'wholesale', 'b2b'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'risk-agent',
    signal: 'risk',
    keywords: {
      ar: ['مخاطر', 'خطر', 'احتيال', 'نصب'],
      fr: ['risque', 'fraude', 'suspicion'],
      en: ['risk', 'fraud', 'abuse'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'dispute-assistant',
    signal: 'dispute',
    keywords: {
      ar: ['نزاع', 'نزاعات', 'خلاف', 'خلافات'],
      fr: ['litige', 'litiges', 'conflit'],
      en: ['dispute', 'disputes', 'conflict'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'development-agent',
    signal: 'platform-dev',
    keywords: {
      ar: ['خطأ', 'أخطاء', 'عطل', 'أعطال', 'تطوير'],
      fr: ['bug', 'erreur', 'panne', 'développement'],
      en: ['bug', 'error', 'failure', 'development'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'finance-agent',
    signal: 'finance',
    keywords: {
      ar: ['مالي', 'مالية', 'أرباح', 'ارباح', 'خسائر', 'تسوية مالية'],
      fr: ['finance', 'bénéfice', 'benefice', 'perte', 'marge'],
      en: ['finance', 'profit', 'loss', 'margin', 'p&l'],
    },
    defaultInput: { periodDays: 30 },
  },
  {
    agentKey: 'payment-settlement-agent',
    signal: 'payments',
    keywords: {
      ar: ['دفع', 'مدفوعات', 'تحصيل', 'تسوية'],
      fr: ['paiement', 'paiements', 'règlement', 'reglement'],
      en: ['payment', 'payments', 'settlement', 'payout'],
    },
    defaultInput: { windowDays: 7 },
  },
  {
    agentKey: 'compliance-agent',
    signal: 'compliance',
    keywords: {
      ar: ['امتثال', 'قانوني', 'سياسات'],
      fr: ['conformité', 'conformite', 'légal', 'legal'],
      en: ['compliance', 'legal', 'policy'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'customer-intelligence-agent',
    signal: 'customers',
    keywords: {
      ar: ['تقسيم العملاء', 'سلوك العملاء', 'شرائح'],
      fr: ['segmentation', 'comportement client', 'cohorte'],
      en: ['customer segment', 'segmentation', 'cohort', 'customer behaviour', 'customer behavior'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'operations-agent',
    signal: 'operations',
    keywords: {
      ar: ['تشغيل', 'صحة النظام', 'استقرار', 'أداء المنصة'],
      fr: ['opérations', 'operations', 'système', 'stabilite'],
      en: ['operations', 'health', 'uptime', 'stability'],
    },
    defaultInput: {},
  },
  {
    agentKey: 'outreach-acquisition-agent',
    signal: 'growth',
    keywords: {
      ar: ['توسع', 'أسواق جديدة', 'استقطاب', 'عملاء جدد'],
      fr: ['expansion', 'prospection', 'acquisition', 'nouveaux marchés'],
      en: ['expansion', 'outreach', 'acquisition', 'new markets'],
    },
    defaultInput: {},
  },
];

/** Rules the coordinator is allowed to plan, in catalogue order. */
export function plannableRules(): CopilotDomainRule[] {
  return COPILOT_DOMAIN_RULES.filter((r) => !NON_PLANNABLE_AGENTS.has(r.agentKey));
}

export function ruleFor(agentKey: string): CopilotDomainRule | undefined {
  return COPILOT_DOMAIN_RULES.find((r) => r.agentKey === agentKey);
}

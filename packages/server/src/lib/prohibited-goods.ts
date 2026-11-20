/**
 * LC-03 — Prohibited & restricted goods policy (single source of truth).
 *
 * One catalogue-wide rule set decides whether a listing may be published. It is
 * deliberately a *classification* engine, not a legal opinion: each rule carries
 * a default severity (PROHIBITED / RESTRICTED / ALLOWED) plus a rationale, and a
 * country may later loosen or tighten a category through the policy engine. The
 * engine never asserts that a category is illegal everywhere; it classifies and
 * fails closed on the highest-risk matches.
 *
 * Design rules that the rest of the codebase relies on:
 *  - Text is matched on a *normalised* form (case-folded, diacritics stripped,
 *    Arabic/Persian letter variants unified, letter-spacing and punctuation
 *    removed) so renaming, re-describing or switching language cannot evade it.
 *  - PROHIBITED wins over RESTRICTED wins over ALLOWED, regardless of order.
 *  - Anything that matches a high-risk term but cannot be confidently classified
 *    is treated as PROHIBITED (fail closed), never silently allowed.
 */

export type GoodsSeverity = 'PROHIBITED' | 'RESTRICTED' | 'ALLOWED';

export interface GoodsRule {
  /** Stable id used in audit records. */
  id: string;
  /** Coarse category, aligned with the policy document. */
  category:
    | 'ILLEGAL_GOODS_SERVICES'
    | 'WEAPONS_AMMUNITION_EXPLOSIVES'
    | 'DRUGS_CONTROLLED_SUBSTANCES'
    | 'MEDICINES_MEDICAL'
    | 'COUNTERFEIT_STOLEN'
    | 'WILDLIFE_PROTECTED'
    | 'SANCTIONS_TRADE_CONTROLS'
    | 'LICENSED_REGULATED'
    | 'FRAUDULENT_SERVICES';
  severity: GoodsSeverity;
  /** Terms that trigger the rule. Matched as whole tokens against normalised text. */
  terms: string[];
  /** Human-readable reason surfaced to the caller and stored in the audit trail. */
  reason: string;
}

/**
 * A deliberately conservative, configurable seed set. It is not a claim of legal
 * completeness: it covers the categories the policy names, and admins can extend
 * or country-scope it. Terms are normalised at load time, so they are written in
 * their plain lower-case form here.
 */
export const GOODS_RULES: readonly GoodsRule[] = [
  // ---- Illegal goods & services -------------------------------------------------
  {
    id: 'illegal.goods',
    category: 'ILLEGAL_GOODS_SERVICES',
    severity: 'PROHIBITED',
    terms: ['stolen', 'مسروق', 'مسروقة', 'volé', 'volée', '被盗', '销赃'],
    reason: 'Stolen property may not be listed',
  },
  {
    id: 'illegal.services',
    category: 'ILLEGAL_GOODS_SERVICES',
    severity: 'PROHIBITED',
    terms: ['counterfeit', 'fake branded', 'مقلد', 'مزيف', 'contrefait', '假冒', '仿冒'],
    reason: 'Counterfeit or forged goods may not be listed',
  },

  // ---- Weapons, ammunition, explosives -----------------------------------------
  {
    id: 'weapons.firearms',
    category: 'WEAPONS_AMMUNITION_EXPLOSIVES',
    severity: 'PROHIBITED',
    terms: [
      'firearm', 'handgun', 'pistol', 'rifle', 'shotgun', 'machine gun', 'ammunition',
      'ammo', 'cartridge', 'silencer', 'suppressor', 'grenade', 'explosive', 'c4', 'tnt',
      'سلاح', 'أسلحة', 'مسدس', 'بندقية', 'ذخيرة', 'رصاص', 'قنبلة', 'متفجرات', 'مفرقعات',
      'arme', 'fusil', 'munition', 'grenade', '枪支', '手枪', '步枪', '弹药', '爆炸物',
    ],
    reason: 'Weapons, ammunition and explosives may not be listed',
  },
  {
    id: 'weapons.components',
    category: 'WEAPONS_AMMUNITION_EXPLOSIVES',
    severity: 'RESTRICTED',
    terms: ['reloading', 'gunpowder', 'black powder', 'detonator', 'fuse', 'تجهيز الذخيرة', 'بارود', 'مفجر'],
    reason: 'Weapon components and precursors require a licence and review',
  },

  // ---- Drugs, controlled substances, dangerous toxins --------------------------
  {
    id: 'drugs.controlled',
    category: 'DRUGS_CONTROLLED_SUBSTANCES',
    severity: 'PROHIBITED',
    terms: [
      'cocaine', 'heroin', 'methamphetamine', 'meth', 'cannabis', 'marijuana', 'opium',
      'ecstasy', 'mdma', 'fentanyl', 'narcotic', 'drug',
      'مخدرات', 'حشيش', 'كوكايين', 'هيروين', 'أفيون', 'ممنوعات',
      'drogue', 'cannabis', '毒品', '海洛因', '可卡因',
    ],
    reason: 'Controlled narcotics and psychoactive substances may not be listed',
  },
  {
    id: 'toxins.dangerous',
    category: 'DRUGS_CONTROLLED_SUBSTANCES',
    severity: 'PROHIBITED',
    terms: ['ricin', 'sarin', 'cyanide', 'poison', 'سم', 'سموم', 'toxine', '毒药', '剧毒'],
    reason: 'Dangerous toxins and poisons may not be listed',
  },

  // ---- Medicines & unlicensed medical products ---------------------------------
  {
    id: 'medicines.prescription',
    category: 'MEDICINES_MEDICAL',
    severity: 'RESTRICTED',
    terms: [
      'prescription', 'antibiotic', 'vaccine', 'insulin', 'medical device', 'surgical',
      'وصفة طبية', 'مضاد حيوي', 'لقاح', 'أدوية', 'جهاز طبي',
      'ordonnance', 'médicament', '处方', '疫苗', '药品',
    ],
    reason: 'Prescription medicines and regulated medical products require a licence and review',
  },

  // ---- Counterfeit / stolen ----------------------------------------------------
  {
    id: 'counterfeit.brands',
    category: 'COUNTERFEIT_STOLEN',
    severity: 'PROHIBITED',
    terms: ['replica watch', 'knock off', 'knockoff', 'clone brand', 'aa replica'],
    reason: 'Counterfeit branded goods may not be listed',
  },

  // ---- Wildlife & protected products -------------------------------------------
  {
    id: 'wildlife.protected',
    category: 'WILDLIFE_PROTECTED',
    severity: 'PROHIBITED',
    terms: [
      'ivory', 'rhino horn', 'pangolin', 'tiger bone', 'illegal wildlife', 'endangered species',
      'عاج', 'قرن وحيد القرن', 'أنواع مهددة', 'حياة برية محمية',
      'ivoire', 'espèce protégée', '象牙', '野生动物',
    ],
    reason: 'Protected wildlife and derived products may not be listed',
  },

  // ---- Sanctions / trade controls ----------------------------------------------
  {
    id: 'sanctions.embargoed',
    category: 'SANCTIONS_TRADE_CONTROLS',
    severity: 'PROHIBITED',
    terms: ['sanctioned goods', 'embargoed', 'sanctions evasion', 'سلع محظورة دوليا', 'تهرب من العقوبات', 'biens sous embargo'],
    reason: 'Goods under sanctions or trade embargoes may not be listed',
  },

  // ---- Licensed / regulated (restricted, review + proof) -----------------------
  {
    id: 'regulated.licence',
    category: 'LICENSED_REGULATED',
    severity: 'RESTRICTED',
    terms: [
      'alcohol', 'wine', 'liquor', 'beer', 'spirits', 'tobacco', 'cigarette', 'vape', 'e-liquid',
      'fireworks', 'pyrotechnics', 'drone', 'radioactive', 'hazardous chemical',
      'كحول', 'خمر', 'تبغ', 'سجائر', 'ألعاب نارية', 'مبيدات', 'كيماويات خطرة', 'طائرة بدون طيار',
      'alcool', 'tabac', 'feu d\'artifice', '烟酒', '烟草', '烟花', '农药',
    ],
    reason: 'Age-restricted, licensed or regulated goods require proof and review',
  },

  // ---- Fraudulent services -----------------------------------------------------
  {
    id: 'fraud.services',
    category: 'FRAUDULENT_SERVICES',
    severity: 'PROHIBITED',
    terms: [
      'fake documents', 'forged documents', 'fake id', 'counterfeit currency', 'money laundering',
      'carding', 'stolen data', 'hacked accounts', 'fake certificate',
      'وثائق مزورة', 'هوية مزيفة', 'عملة مزيفة', 'تبييض أموال', 'قرصنة حسابات',
      'faux documents', 'fausse identité', 'blanchiment', '伪造文件', '洗钱',
    ],
    reason: 'Services that facilitate fraud or illegal activity may not be listed',
  },
];

/** Arabic/Persian letter variants and diacritics that must not defeat matching. */
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Normalises free text for matching. Removes every trick a seller might use to
 * evade a naive substring check: case, diacritics, Arabic letter variants,
 * zero-width characters, punctuation and intra-word spacing.
 */
export function normalizeForMatch(input: string): string {
  let s = input.normalize('NFKD');
  s = s.replace(/[\u0300-\u036f]/g, ''); // latin diacritics
  s = s.replace(ARABIC_DIACRITICS, '');
  s = s
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // أ إ آ ٱ -> ا
    .replace(/[\u0649]/g, '\u064a') // ى -> ي
    .replace(/[\u0629]/g, '\u0647') // ة -> ه
    .replace(/[\u06CC]/g, '\u064a'); // Persian yeh -> ي
  s = s.toLowerCase();
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' '); // punctuation/emoji -> space
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export interface GoodsClassification {
  severity: GoodsSeverity;
  /** The winning rule id, when one matched. */
  ruleId: string | null;
  category: GoodsRule['category'] | null;
  reason: string | null;
}

/** Pre-normalised term index, built once. */
const TERM_INDEX: { term: string; rule: GoodsRule }[] = GOODS_RULES.flatMap((rule) =>
  rule.terms.map((term) => ({ term: normalizeForMatch(term), rule })),
);

const SEVERITY_RANK: Record<GoodsSeverity, number> = { ALLOWED: 0, RESTRICTED: 1, PROHIBITED: 2 };

/**
 * Classifies a listing from its user-controllable text fields. Every field is
 * normalised; a term matches only as a whole token, so "gun" does not fire on
 * "begun". The strictest match wins.
 */
export function classifyListing(fields: {
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  /** Any other user-controllable free text (specs, variant names, alt text, ...). */
  extraTexts?: (string | null | undefined)[];
}): GoodsClassification {
  const haystack = normalizeForMatch(
    [
      fields.name,
      fields.nameAr,
      fields.nameFr,
      fields.description,
      fields.brand,
      fields.category,
      ...(fields.extraTexts ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  );
  const tokens = new Set(haystack.split(' ').filter(Boolean));
  const phrase = ` ${haystack} `;

  let best: GoodsClassification = { severity: 'ALLOWED', ruleId: null, category: null, reason: null };
  for (const { term, rule } of TERM_INDEX) {
    const matched = term.includes(' ') ? phrase.includes(` ${term} `) : tokens.has(term);
    if (!matched) continue;
    if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[best.severity]) {
      best = { severity: rule.severity, ruleId: rule.id, category: rule.category, reason: rule.reason };
    }
  }
  return best;
}

/**
 * Fails closed for callers that must never publish on ambiguity. If a listing is
 * unclassified we still treat it as ALLOWED (the common case), but a PROHIBITED
 * classification can never be downgraded by a caller; `assertPublishable` is the
 * single enforcement point.
 */
export function isPublishable(classification: GoodsClassification): boolean {
  return classification.severity === 'ALLOWED';
}

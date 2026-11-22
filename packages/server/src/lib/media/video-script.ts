import type { VideoLanguage } from './tts.js';

/**
 * Marketing copy for a video, derived only from what the listing actually says.
 *
 * The planner is deliberately dumb about persuasion and strict about facts: it
 * may quote the product name, brand, price, currency, seller and the seller's
 * own description, and it may state what the platform visibly does (show the
 * price and seller before ordering, keep the order in the buyer's account).
 * It may not invent a benefit, a discount, a rating or a delivery promise —
 * those would be claims the platform cannot back, and the quality gate fails a
 * script that carries a number it cannot trace to product data.
 */

export type MarketingObjective = 'SALES' | 'AWARENESS' | 'LAUNCH' | 'RETENTION';

export const MARKETING_OBJECTIVES: readonly MarketingObjective[] = ['SALES', 'AWARENESS', 'LAUNCH', 'RETENTION'];

export function isMarketingObjective(value: unknown): value is MarketingObjective {
  return typeof value === 'string' && (MARKETING_OBJECTIVES as readonly string[]).includes(value);
}

export type SceneKind = 'hook' | 'value' | 'detail' | 'trust' | 'cta';

export interface ProductFacts {
  name: string;
  brand?: string | null;
  description?: string | null;
  price?: string | null;
  currencyCode: string;
  sellerName?: string | null;
}

export interface ScriptScene {
  index: number;
  kind: SceneKind;
  headline: string;
  bullets: string[];
  /** Exactly what the voice reads; also the subtitle source. */
  voiceover: string;
  /** Floor for this scene, before the real audio length is known. */
  minSeconds: number;
}

export type FactKind = 'product' | 'brand' | 'price' | 'currency' | 'seller';

export interface ScriptFact {
  kind: FactKind;
  value: string;
}

export interface VideoScript {
  language: VideoLanguage;
  /** `TUNISIAN` only when the copy was written in the dialect itself. */
  dialect: 'MSA' | 'TUNISIAN' | 'NONE';
  objective: MarketingObjective;
  audience: 'B2B' | 'B2C';
  scenes: ScriptScene[];
  cta: string;
  facts: ScriptFact[];
  wordCount: number;
  /** Rough read time at ~2.6 words/second, used before audio exists. */
  estimatedSpeechSeconds: number;
}

type Copy = {
  dialect: VideoScript['dialect'];
  hook: (facts: ProductFacts, objective: MarketingObjective) => { headline: string; voiceover: string };
  value: (facts: ProductFacts, audience: 'B2B' | 'B2C') => { headline: string; bullets: string[]; voiceover: string };
  detail: (facts: ProductFacts) => { headline: string; bullets: string[]; voiceover: string };
  trust: (facts: ProductFacts) => { headline: string; bullets: string[]; voiceover: string };
  cta: (facts: ProductFacts, audience: 'B2B' | 'B2C') => { headline: string; voiceover: string };
};

const CTA_PHRASE: Record<VideoLanguage, string> = {
  ar: 'اطلب الآن من وسيط',
  'ar-TN': 'إلّي يعجبك، اطلب توّا من وسيط',
  fr: 'Commandez maintenant sur WASIT',
  en: 'Order now on WASIT',
  zh: '立即在 WASIT 下单',
};

/** The line the gate looks for to prove the video closes with a call to action. */
export function ctaFor(language: VideoLanguage): string {
  return CTA_PHRASE[language];
}

function priceLine(facts: ProductFacts): string | null {
  if (!facts.price) return null;
  return `${facts.price} ${facts.currencyCode}`;
}

/** First sentence of the seller's description, trimmed — never reworded. */
function descriptionExcerpt(facts: ProductFacts, maxChars = 120): string | null {
  const text = (facts.description ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === facts.name) return null;
  const first = text.split(/(?<=[.!?؟。])\s/)[0] ?? text;
  const excerpt = first.length > maxChars ? `${first.slice(0, maxChars).replace(/[,،;؛\s]+\S*$/, '')}…` : first;
  return excerpt.length >= 12 ? excerpt : null;
}

const COPY: Record<VideoLanguage, Copy> = {
  ar: {
    dialect: 'MSA',
    hook: (f, objective) => ({
      headline: f.name,
      voiceover:
        objective === 'LAUNCH'
          ? `وصل جديد إلى وسيط: ${f.name}.`
          : objective === 'AWARENESS'
            ? `هل تعرفه؟ ${f.name}، متوفر الآن على وسيط.`
            : `تعرّف على ${f.name}، المعروض الآن على وسيط.`,
    }),
    value: (f, audience) => ({
      headline: 'ما يميّزه',
      bullets: [f.brand ? `العلامة: ${f.brand}` : '', priceLine(f) ? `السعر: ${priceLine(f)}` : ''].filter(Boolean),
      voiceover:
        audience === 'B2B'
          ? `مناسب للشركات والمتاجر التي تبحث عن توريد واضح: كل التفاصيل والسعر أمامك قبل الطلب.`
          : `كل التفاصيل التي تحتاجها قبل الشراء ظاهرة في صفحة المنتج، بلا مفاجآت.`,
    }),
    detail: (f) => {
      const excerpt = descriptionExcerpt(f);
      return {
        headline: 'تفاصيل المنتج',
        bullets: excerpt ? [excerpt] : [],
        voiceover: excerpt
          ? `يقول البائع: ${excerpt}`
          : `تجد في صفحة المنتج وصفًا كاملًا، والسعر، وبيانات البائع.`,
      };
    },
    trust: (f) => ({
      headline: 'لماذا وسيط',
      bullets: ['السعر وبيانات البائع قبل الطلب', 'الطلب وحالته في حسابك'],
      voiceover: f.sellerName
        ? `البيع من ${f.sellerName} عبر وسيط، والسعر وبيانات البائع واضحة قبل أن تطلب.`
        : `البيع عبر وسيط، والسعر وبيانات البائع واضحة قبل أن تطلب.`,
    }),
    cta: (f) => ({
      headline: CTA_PHRASE.ar,
      voiceover: `اطلب الآن من وسيط${f.sellerName ? ` من ${f.sellerName}` : ''}.`,
    }),
  },
  'ar-TN': {
    dialect: 'TUNISIAN',
    hook: (f) => ({
      headline: f.name,
      voiceover: `شنيّة هذا؟ هذا ${f.name}، وموجود توّا في وسيط.`,
    }),
    value: (f, audience) => ({
      headline: 'شنوّة يزيد',
      bullets: [f.brand ? `العلامة: ${f.brand}` : '', priceLine(f) ? `السوم: ${priceLine(f)}` : ''].filter(Boolean),
      voiceover:
        audience === 'B2B'
          ? `يصلح للتجّار والمحلّات إلّي يحبّو يشرو بالجملة: تنجّم تشوف السوم والتفاصيل الكل قبل ما تكمّن.`
          : `تنجّم تشوف التفاصيل الكل والسوم قبل ما تشري، بلا ما تتقلّق.`,
    }),
    detail: (f) => {
      const excerpt = descriptionExcerpt(f);
      return {
        headline: 'التفاصيل',
        bullets: excerpt ? [excerpt] : [],
        voiceover: excerpt
          ? `البايع يقول: ${excerpt}`
          : `في صفحة المنتج تلقى الوصف الكل، والسوم، ومعطيات البايع.`,
      };
    },
    trust: (f) => ({
      headline: 'علاش وسيط',
      bullets: ['السوم ومعطيات البايع قبل ما تكمّن', 'الطلبية وحالتها في حسابك'],
      voiceover: f.sellerName
        ? `البيع من ${f.sellerName} عبر وسيط، والسوم واضح قبل ما تكمّن.`
        : `البيع عبر وسيط، والسوم واضح قبل ما تكمّن.`,
    }),
    cta: (f) => ({
      headline: CTA_PHRASE['ar-TN'],
      voiceover: `إلّي يعجبك، اطلب توّا من وسيط${f.sellerName ? ` من ${f.sellerName}` : ''}.`,
    }),
  },
  fr: {
    dialect: 'NONE',
    hook: (f, objective) => ({
      headline: f.name,
      voiceover:
        objective === 'LAUNCH'
          ? `Nouveau sur WASIT : ${f.name}.`
          : objective === 'AWARENESS'
            ? `Vous le connaissez ? ${f.name}, disponible sur WASIT.`
            : `Découvrez ${f.name}, proposé sur WASIT.`,
    }),
    value: (f, audience) => ({
      headline: 'Ce qui le distingue',
      bullets: [f.brand ? `Marque : ${f.brand}` : '', priceLine(f) ? `Prix : ${priceLine(f)}` : ''].filter(Boolean),
      voiceover:
        audience === 'B2B'
          ? `Pensé pour les entreprises et les commerces qui veulent un approvisionnement clair : prix et détails affichés avant la commande.`
          : `Tous les détails utiles sont affichés sur la fiche produit, avant votre achat.`,
    }),
    detail: (f) => {
      const excerpt = descriptionExcerpt(f);
      return {
        headline: 'Détails du produit',
        bullets: excerpt ? [excerpt] : [],
        voiceover: excerpt
          ? `Le vendeur précise : ${excerpt}`
          : `La fiche produit contient la description complète, le prix et les informations du vendeur.`,
      };
    },
    trust: (f) => ({
      headline: 'Pourquoi WASIT',
      bullets: ['Prix et vendeur affichés avant la commande', 'Votre commande suivie dans votre compte'],
      voiceover: f.sellerName
        ? `Vendu par ${f.sellerName} via WASIT, avec le prix et le vendeur affichés avant la commande.`
        : `Vendu via WASIT, avec le prix et le vendeur affichés avant la commande.`,
    }),
    cta: (f) => ({
      headline: CTA_PHRASE.fr,
      voiceover: `Commandez maintenant sur WASIT${f.sellerName ? `, chez ${f.sellerName}` : ''}.`,
    }),
  },
  en: {
    dialect: 'NONE',
    hook: (f, objective) => ({
      headline: f.name,
      voiceover:
        objective === 'LAUNCH'
          ? `New on WASIT: ${f.name}.`
          : objective === 'AWARENESS'
            ? `Have you seen it? ${f.name}, now listed on WASIT.`
            : `Meet ${f.name}, listed on WASIT.`,
    }),
    value: (f, audience) => ({
      headline: 'What stands out',
      bullets: [f.brand ? `Brand: ${f.brand}` : '', priceLine(f) ? `Price: ${priceLine(f)}` : ''].filter(Boolean),
      voiceover:
        audience === 'B2B'
          ? `Built for businesses and stores that want clear sourcing: price and details are shown before you order.`
          : `Every detail you need is shown on the product page, before you buy.`,
    }),
    detail: (f) => {
      const excerpt = descriptionExcerpt(f);
      return {
        headline: 'Product details',
        bullets: excerpt ? [excerpt] : [],
        voiceover: excerpt
          ? `The seller says: ${excerpt}`
          : `The product page carries the full description, the price and the seller details.`,
      };
    },
    trust: (f) => ({
      headline: 'Why WASIT',
      bullets: ['Price and seller shown before ordering', 'Your order tracked in your account'],
      voiceover: f.sellerName
        ? `Sold by ${f.sellerName} through WASIT, with price and seller shown before you order.`
        : `Sold through WASIT, with price and seller shown before you order.`,
    }),
    cta: (f) => ({
      headline: CTA_PHRASE.en,
      voiceover: `Order now on WASIT${f.sellerName ? ` from ${f.sellerName}` : ''}.`,
    }),
  },
  zh: {
    dialect: 'NONE',
    hook: (f, objective) => ({
      headline: f.name,
      voiceover:
        objective === 'LAUNCH'
          ? `WASIT 新品上架：${f.name}。`
          : objective === 'AWARENESS'
            ? `认识一下：${f.name}，已在 WASIT 上架。`
            : `了解 ${f.name}，现已在 WASIT 上架。`,
    }),
    value: (f, audience) => ({
      headline: '产品亮点',
      bullets: [f.brand ? `品牌：${f.brand}` : '', priceLine(f) ? `价格：${priceLine(f)}` : ''].filter(Boolean),
      voiceover:
        audience === 'B2B'
          ? `适合需要清晰采购信息的企业和商家：下单前即可看到价格和详细信息。`
          : `购买前即可在产品页面看到所有需要的详细信息。`,
    }),
    detail: (f) => {
      const excerpt = descriptionExcerpt(f, 70);
      return {
        headline: '产品详情',
        bullets: excerpt ? [excerpt] : [],
        voiceover: excerpt
          ? `卖家说明：${excerpt}`
          : `产品页面包含完整描述、价格和卖家信息。`,
      };
    },
    trust: (f) => ({
      headline: '为什么选择 WASIT',
      bullets: ['下单前显示价格和卖家', '在账户中跟踪订单'],
      voiceover: f.sellerName
        ? `由 ${f.sellerName} 通过 WASIT 销售，下单前即可看到价格和卖家信息。`
        : `通过 WASIT 销售，下单前即可看到价格和卖家信息。`,
    }),
    cta: (f) => ({
      headline: CTA_PHRASE.zh,
      voiceover: `立即在 WASIT 下单${f.sellerName ? `，卖家 ${f.sellerName}` : ''}。`,
    }),
  },
};

export interface BuildScriptInput {
  language: VideoLanguage;
  objective: MarketingObjective;
  audience: 'B2B' | 'B2C';
  facts: ProductFacts;
}

export function buildVideoScript(input: BuildScriptInput): VideoScript {
  const copy = COPY[input.language];
  const { facts } = input;

  const hook = copy.hook(facts, input.objective);
  const value = copy.value(facts, input.audience);
  const detail = copy.detail(facts);
  const trust = copy.trust(facts);
  const cta = copy.cta(facts, input.audience);

  const scenes: ScriptScene[] = [
    { index: 1, kind: 'hook', headline: hook.headline, bullets: [], voiceover: hook.voiceover, minSeconds: 4.5 },
    {
      index: 2,
      kind: 'value',
      headline: value.headline,
      bullets: value.bullets,
      voiceover: value.voiceover,
      minSeconds: 6.5,
    },
    {
      index: 3,
      kind: 'detail',
      headline: detail.headline,
      bullets: detail.bullets,
      voiceover: detail.voiceover,
      minSeconds: 6.5,
    },
    {
      index: 4,
      kind: 'trust',
      headline: trust.headline,
      bullets: trust.bullets,
      voiceover: trust.voiceover,
      minSeconds: 6,
    },
    { index: 5, kind: 'cta', headline: cta.headline, bullets: [], voiceover: cta.voiceover, minSeconds: 5 },
  ];

  const allText = scenes.map((s) => s.voiceover).join(' ');
  const words = allText.split(/\s+/).filter(Boolean).length;
  const cjkChars = (allText.match(/[\u4E00-\u9FFF]/g) ?? []).length;

  const factsUsed: ScriptFact[] = [{ kind: 'product', value: facts.name }];
  if (facts.brand) factsUsed.push({ kind: 'brand', value: facts.brand });
  if (facts.price) factsUsed.push({ kind: 'price', value: facts.price });
  factsUsed.push({ kind: 'currency', value: facts.currencyCode });
  if (facts.sellerName) factsUsed.push({ kind: 'seller', value: facts.sellerName });

  return {
    language: input.language,
    dialect: copy.dialect,
    objective: input.objective,
    audience: input.audience,
    scenes,
    cta: CTA_PHRASE[input.language],
    facts: factsUsed,
    wordCount: input.language === 'zh' ? cjkChars : words,
    // Chinese packs more meaning per glyph; the rest read at ~2.6 words/second.
    estimatedSpeechSeconds: input.language === 'zh' ? cjkChars / 5.2 : words / 2.6,
  };
}

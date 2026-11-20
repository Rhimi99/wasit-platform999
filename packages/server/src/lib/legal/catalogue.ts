/**
 * LC-01 — Legal document catalogue (pure, database-free).
 *
 * This is the single registry of the platform's public legal artefacts: their
 * identity, the version currently in force, its effective date, and whether the
 * text has been approved for publication. It is deliberately code-defined rather
 * than runtime-editable, because publishing a legal document is a deliberate,
 * reviewable act — never a runtime toggle. Shipping a change to a version here
 * goes through the same review as any other code change.
 *
 * Nothing in this file is a legal text. The texts are drafted separately
 * (`docs/legal/`) and require external legal review; every entry therefore
 * starts as `LEGAL_REVIEW_REQUIRED` with no effective date, and the public
 * surface shows nothing until an entry is explicitly `PUBLISHED`. The platform
 * must never present an unapproved draft as a binding document.
 */

import { USER_ROLES } from '@wasit/shared';

/** Where a document sits in its review/publication lifecycle. */
export type LegalDocumentStatus =
  | 'DRAFT' // being written; not reviewable
  | 'LEGAL_REVIEW_REQUIRED' // awaiting external counsel sign-off
  | 'APPROVED' // signed off; not yet in force
  | 'PUBLISHED' // in force and publicly disclosed
  | 'SUPERSEDED'; // replaced by a newer version

/** The audience a document governs. */
export type LegalDocumentAudience =
  | 'ALL'
  | 'VISITOR'
  | 'BUYER'
  | 'SELLER'
  | 'SUPPLIER'
  | 'MERCHANT'
  | 'COMPANY';

/**
 * The system roles each audience maps to (LC-01.1, H1).
 *
 * This is the single source of truth for "who must accept this document". It
 * exists so the acceptance gate, the pending-list surface and the service layer
 * all answer the audience question the same way, instead of each inventing its
 * own rule.
 *
 * Rules, in order:
 *  - A specific audience maps only to the system role that names it. There is no
 *    `SELLER` role in `USER_ROLES`: selling is expressed through the
 *    `MERCHANT`/`SUPPLIER`/`COMPANY` roles. The `SELLER` audience therefore
 *    resolves to `MERCHANT` — the merchant-terms document is the one tagged
 *    `SELLER` today — and never to `SUPPLIER` or `COMPANY`, which carry their
 *    own audiences.
 *  - Roles with no matching audience (`MARKETER`, and the staff roles `SUPPORT`,
 *    `RISK`, `DISPUTE`, `ADMIN`, `SUPER_ADMIN`) receive only `ALL` documents.
 *    They are never implicitly treated as a buyer, seller, supplier or company.
 *  - `ALL` is handled by {@link appliesToRoles} as "every account": it is
 *    returned here only as the full role list, for documentation and tests.
 *  - `VISITOR` targets anonymous use, which a signed-in account — the only thing
 *    this gate inspects — is not, so it matches no role.
 */
export function rolesForAudience(audience: LegalDocumentAudience): readonly string[] {
  switch (audience) {
    case 'ALL':
      return [...USER_ROLES];
    case 'BUYER':
      return ['CUSTOMER'];
    case 'MERCHANT':
      return ['MERCHANT'];
    case 'SUPPLIER':
      return ['SUPPLIER'];
    case 'COMPANY':
      return ['COMPANY'];
    // No standalone `SELLER` role exists; the seller-facing document tagged with
    // this audience is the merchant-terms one, so it binds `MERCHANT` only. It is
    // deliberately *not* spread to SUPPLIER/COMPANY, which have their own terms.
    case 'SELLER':
      return ['MERCHANT'];
    // A visitor document governs anonymous use, which a signed-in account
    // (the only thing this gate inspects) is not.
    case 'VISITOR':
      return [];
  }
}

/** True when a document's audience covers at least one of the caller's roles. */
export function appliesToRoles(
  entry: LegalDocumentEntry,
  roles: readonly string[] | undefined | null,
): boolean {
  // No user context at all: nothing applies. The gate checks `user` before it
  // ever calls this, so this guard only keeps the helper total for other callers.
  if (!roles) return false;
  // An `ALL` document governs every signed-in account — including one that holds
  // no roles. An empty role set is "an authenticated account with no role", not
  // "anonymous" (anonymous never reaches this helper), so it must still be bound
  // by the documents that apply to everyone.
  if (entry.audience === 'ALL') return true;
  // A role-specific audience needs at least one matching role; an empty set
  // matches nothing (`.some` on an empty array is already false).
  const matched = rolesForAudience(entry.audience);
  return roles.some((r) => matched.includes(r));
}

/**
 * Consent type a document maps to when accepted. Mirrors the privacy module's
 * `CONSENT_TYPES`; a document that requires no separate consent uses `null`
 * (e.g. a policy disclosed for transparency only).
 */
export type LegalConsentType =
  | 'TERMS'
  | 'PRIVACY_POLICY'
  | 'DATA_PROCESSING'
  | 'COOKIE_POLICY'
  | null;

export interface LegalDocumentEntry {
  /** Stable machine code; never reused, never renumbered. */
  code: string;
  audience: LegalDocumentAudience;
  /** Title shown to users (Arabic is the launch locale). */
  title: { ar: string; en: string };
  /** One-line summary of scope, for the index page. */
  summary: { ar: string; en: string };
  /** Version identifier in force (semantic-ish; bump on material change). */
  version: string;
  /** ISO date the version takes effect; null while not in force. */
  effectiveDate: string | null;
  status: LegalDocumentStatus;
  /** Consent captured on acceptance, or null when none is required. */
  consentType: LegalConsentType;
  /** Whether accepting this document is mandatory to use the platform. */
  acceptanceRequired: boolean;
}

/**
 * The catalogue. Every entry starts unpublished: the platform is a commercial
 * intermediary whose texts must be reviewed by qualified counsel in each market
 * before they bind anyone. Flipping an entry to `PUBLISHED` is a reviewed change
 * that also sets `effectiveDate`; it is not done at runtime.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocumentEntry[] = [
  {
    code: 'TERMS_OF_SERVICE',
    audience: 'ALL',
    title: { ar: 'شروط الخدمة', en: 'Terms of Service' },
    summary: {
      ar: 'الشروط العامة لاستخدام منصة WASIT BUSINESS GLOBAL كوسيط تجاري.',
      en: 'General terms for using the WASIT BUSINESS GLOBAL platform as a commercial intermediary.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'TERMS',
    acceptanceRequired: true,
  },
  {
    code: 'PRIVACY_POLICY',
    audience: 'ALL',
    title: { ar: 'سياسة الخصوصية', en: 'Privacy Policy' },
    summary: {
      ar: 'كيف نجمع البيانات الشخصية ونستخدمها ونحميها، وأغراض المعالجة.',
      en: 'How personal data is collected, used and protected, and the purposes of processing.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'PRIVACY_POLICY',
    acceptanceRequired: true,
  },
  {
    code: 'COOKIE_POLICY',
    audience: 'VISITOR',
    title: { ar: 'سياسة ملفات تعريف الارتباط', en: 'Cookie Policy' },
    summary: {
      ar: 'فئات ملفات تعريف الارتباط وأغراضها وكيفية إدارة الموافقة عليها.',
      en: 'Cookie categories, their purposes, and how consent is managed.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'COOKIE_POLICY',
    acceptanceRequired: false,
  },
  {
    code: 'REFUND_DISPUTE_POLICY',
    audience: 'ALL',
    title: { ar: 'سياسة الاسترجاع والنزاعات', en: 'Refund & Dispute Policy' },
    summary: {
      ar: 'النوافذ التشغيلية لفتح النزاع وتقديم الأدلة والبتّ والاستئناف، ودور WASIT كوسيط.',
      en: 'Operational windows for opening a dispute, submitting evidence, decisions and appeals, and WASIT\u2019s role as intermediary.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: null,
    acceptanceRequired: false,
  },
  {
    code: 'BUYER_TERMS',
    audience: 'BUYER',
    title: { ar: 'شروط المشتري', en: 'Buyer Terms' },
    summary: {
      ar: 'حقوق المشتري والتزاماته عند الشراء عبر المنصة.',
      en: 'The buyer\u2019s rights and obligations when purchasing through the platform.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'TERMS',
    acceptanceRequired: true,
  },
  {
    code: 'SELLER_MERCHANT_TERMS',
    audience: 'SELLER',
    title: { ar: 'شروط البائع/التاجر', en: 'Seller / Merchant Terms' },
    summary: {
      ar: 'التزامات البائع والتاجر، والعمولة 4% (2% بائع + 2% مشتري)، ورسوم مزوّد الدفع المنفصلة.',
      en: 'Seller and merchant obligations, the 4% commission (2% seller + 2% buyer), and separate payment-provider fees.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'TERMS',
    acceptanceRequired: true,
  },
  {
    code: 'SUPPLIER_TERMS',
    audience: 'SUPPLIER',
    title: { ar: 'شروط المورد', en: 'Supplier Terms' },
    summary: {
      ar: 'شروط انطباقية على الموردين الذين يعرضون منتجاتهم عبر المنصة.',
      en: 'Terms applicable to suppliers listing their products on the platform.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'TERMS',
    acceptanceRequired: true,
  },
  {
    code: 'DATA_PROCESSING_AGREEMENT',
    audience: 'SELLER',
    title: { ar: 'اتفاقية معالجة البيانات', en: 'Data Processing Agreement' },
    summary: {
      ar: 'اتفاقية معالجة البيانات بين WASIT والكيانات التجارية، عند انطباقها.',
      en: 'Data processing agreement between WASIT and business entities, where applicable.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: 'DATA_PROCESSING',
    acceptanceRequired: false,
  },
  {
    code: 'PROHIBITED_GOODS_POLICY',
    audience: 'SELLER',
    title: { ar: 'سياسة السلع المحظورة', en: 'Prohibited Goods Policy' },
    summary: {
      ar: 'السلع المحظورة والمقيّدة، وآلية المراجعة البشرية قبل النشر.',
      en: 'Prohibited and restricted goods, and the human-review gate before listing.',
    },
    version: '0.0.0-draft',
    effectiveDate: null,
    status: 'LEGAL_REVIEW_REQUIRED',
    consentType: null,
    acceptanceRequired: false,
  },
];

export function findLegalDocument(
  code: string,
  catalogue: readonly LegalDocumentEntry[] = LEGAL_DOCUMENTS,
): LegalDocumentEntry | null {
  return catalogue.find((d) => d.code === code) ?? null;
}

/** Documents the public may read: in force and approved for publication. */
export function publishedDocuments(
  catalogue: readonly LegalDocumentEntry[] = LEGAL_DOCUMENTS,
): LegalDocumentEntry[] {
  return catalogue.filter((d) => d.status === 'PUBLISHED' && d.effectiveDate !== null);
}

/**
 * A document that requires acceptance must be published before anyone can
 * accept it: accepting an unapproved draft would record a binding consent to a
 * text that is not in force.
 */
export function isAcceptable(
  entry: LegalDocumentEntry | null,
  now: Date = new Date(),
): entry is LegalDocumentEntry {
  if (!entry) return false;
  if (!entry.acceptanceRequired) return false;
  if (entry.status !== 'PUBLISHED') return false;
  if (!entry.effectiveDate) return false;
  return Date.parse(entry.effectiveDate) <= now.getTime();
}

/** True when an accepted version is missing or older than the version in force. */
export function needsReacceptance(
  entry: LegalDocumentEntry,
  acceptedVersion: string | null | undefined,
): boolean {
  if (!entry.acceptanceRequired) return false;
  if (entry.status !== 'PUBLISHED') return false;
  return acceptedVersion !== entry.version;
}

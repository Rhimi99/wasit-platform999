/**
 * WASIT BUSINESS GLOBAL — generator for the Arabic administrative-permissions guide.
 *
 * Renders two documents (a full-bleed cover and the numbered body) with headless
 * Chromium through the DevTools Protocol, then merges them into one PDF.
 *
 * Read-only with respect to the platform: it only reads nothing from the app and
 * writes the PDF plus the intermediate HTML under docs/management/.
 *
 *   node docs/management/build-pdf.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PDF = join(HERE, 'WASIT-Admin-Permissions-Guide-AR.pdf');
const BODY_HTML = join(HERE, 'guide.html');
const COVER_HTML = join(HERE, 'cover.html');
const FONT_DIR = join(HERE, 'assets', 'fonts');

const META = {
  title: 'WASIT BUSINESS GLOBAL — الدليل الإداري لمهام وصلاحيات المدير العام والمدير',
  version: '1.0',
  date: '2026-11-03',
  branch: 'master',
  commit: 'e43dee4017d2848e37d03d13025a33890adb483f',
  classification: 'وثيقة إدارية رسمية — للاستخدام الداخلي',
};

// ---------------------------------------------------------------------------
// Data — every row was taken from the code on the commit above. Statuses:
//   yes      implemented and reachable
//   read     read-only access
//   partial  permission exists but the feature is incomplete
//   backend  server route exists, no admin-dashboard surface
//   no       does not exist
//   denied   the role is blocked from it
// ---------------------------------------------------------------------------
const ST = {
  yes: { c: 'ok', t: 'منفَّذ' },
  read: { c: 'ro', t: 'قراءة فقط' },
  partial: { c: 'part', t: 'ناقص' },
  backend: { c: 'be', t: 'Backend فقط' },
  no: { c: 'none', t: 'غير موجود' },
  denied: { c: 'deny', t: 'محظور' },
};

const DOMAINS = [
  {
    id: 'users', num: '5.1', title: 'إدارة المستخدمين والحسابات والأدوار',
    rows: [
      ['عرض قائمة المستخدمين', 'yes', 'yes', 'لوحة /admin/users · GET /api/admin/users', 'admin/routes.ts:163 (سقف 100 صف)'],
      ['إيقاف / إعادة تنشيط حساب', 'yes', 'yes', 'لوحة /admin/users · PATCH /api/admin/users/:id/status', 'admin/routes.ts:179 · Audit ADMIN.USER_STATUS'],
      ['إنشاء مستخدم من اللوحة', 'no', 'no', '—', 'USER_CREATE غير مُنفَّذة في أي route'],
      ['تعديل بيانات مستخدم', 'no', 'no', '—', 'USER_UPDATE غير مُنفَّذة'],
      ['حذف مستخدم', 'no', 'no', '—', 'USER_DELETE غير مُنفَّذة'],
      ['منح / سحب الأدوار', 'no', 'no', '—', 'لا مسار؛ الأدوار عبر seeder / CLI فقط'],
      ['إعادة تعيين كلمة مرور لمستخدم آخر', 'no', 'no', '—', 'المسارات ذاتية فقط (auth/routes.ts)'],
      ['إدارة الجلسات (ذاتية)', 'yes', 'yes', 'لوحة /dashboard/security · GET /api/auth/sessions, POST /sessions/revoke', 'auth/routes.ts:352,359'],
      ['إدارة MFA (ذاتية)', 'yes', 'yes', 'لوحة /dashboard/security · /api/auth/mfa/*', 'auth/routes.ts:380+'],
      ['إنشاء أول SUPER_ADMIN (خارج اللوحة)', 'no', 'yes', 'CLI: npm run bootstrap:super-admin', 'lib/super-admin-bootstrap.ts · docs/SUPER_ADMIN_BOOTSTRAP.md'],
    ],
  },
  {
    id: 'entities', num: '5.2', title: 'التجار والموردون والشركات',
    rows: [
      ['عرض التجار / الموردين / الشركات', 'read', 'read', 'صفحات عامة · GET /api/{merchants,suppliers,companies}', 'merchants|suppliers|companies/routes.ts'],
      ['تعديل كيان أي بائع', 'no', 'no', '—', 'PATCH /api/{merchants,companies}/:id تشترط المالك (service.ts:79,85)'],
      ['إنشاء كيان تجاري إدارياً', 'no', 'no', '—', 'لا مسار إداري؛ POST يشترط requireRole(MERCHANT|SUPPLIER|COMPANY)'],
      ['حذف كيان تجاري', 'no', 'no', '—', 'لا مسار'],
      ['إنشاء كيان بصفتك مالكاً', 'no', 'no', '—', 'الدوران لا يحملان MERCHANT/SUPPLIER/COMPANY'],
    ],
  },
  {
    id: 'products', num: '5.3', title: 'المنتجات والكتالوج',
    rows: [
      ['عرض كل المنتجات', 'yes', 'yes', 'لوحة /admin/products · GET /api/admin/products', 'admin/routes.ts:264'],
      ['إيقاف منتج (تجاوز الملكية)', 'yes', 'yes', 'لوحة /admin/products · PATCH /api/products/:id/suspend', 'products/routes.ts:167 · PRODUCT_MANAGE'],
      ['تغيير حالة منتج أي بائع', 'yes', 'yes', 'لوحة /admin/products · PATCH /api/products/:id/status', 'products/routes.ts:131,153 · isAdmin'],
      ['تعديل بيانات منتج أي بائع', 'backend', 'backend', 'Backend فقط · PATCH /api/products/:id', 'products/routes.ts:147 · isAdmin · بلا زر في اللوحة'],
      ['نشر منتج باسم أي بائع', 'denied', 'backend', 'Backend فقط · POST /api/products', 'products/routes.ts:108-124 · product:create لـSUPER فقط'],
      ['حذف منتج', 'no', 'no', '—', 'لا route للحذف'],
      ['إدارة التصنيفات', 'backend', 'backend', 'Backend فقط · POST /api/categories', 'categories/routes.ts:51 · PRODUCT_MANAGE'],
      ['تعديل المخزون', 'denied', 'backend', 'Backend فقط · /api/inventory/*', 'inventory:* محصورة بـSUPER_ADMIN (rbac.ts)'],
    ],
  },
  {
    id: 'orders', num: '5.4', title: 'الطلبات',
    rows: [
      ['عرض كل الطلبات', 'yes', 'yes', 'لوحة /admin/orders · GET /api/admin/orders', 'admin/routes.ts:207'],
      ['تفاصيل طلب إداري', 'no', 'no', '—', 'لا adminOrders/:id؛ اللوحة تعرض قائمة فقط'],
      ['تعديل حالة طلب', 'denied', 'denied', '—', 'orders/service.ts:372-375 تقصرها على المشتري/البائع'],
      ['إنشاء طلب بصفتك المالك', 'denied', 'backend', 'Backend فقط · POST /api/orders', 'order:create لـSUPER فقط (rbac.ts)'],
    ],
  },
  {
    id: 'finance', num: '5.5', title: 'المدفوعات والعمولات والسجلات المالية',
    rows: [
      ['عرض المعاملات', 'yes', 'yes', 'لوحة /admin/transactions · GET /api/admin/transactions', 'admin/routes.ts:234'],
      ['عرض دفتر الأستاذ', 'yes', 'yes', 'لوحة /admin/ledger · GET /api/admin/ledger', 'admin/routes.ts:253'],
      ['إصدار استرداد لأي طلب', 'yes', 'yes', 'لوحة /admin/orders · POST /api/payments/orders/:id/refunds', 'payments/routes.ts:93 · refund:manage'],
      ['قراءة مدفوعات أي طلب', 'yes', 'yes', 'لوحة /admin/orders · GET /api/payments/orders/:id', 'payments/routes.ts:76 · isOperator'],
      ['تأكيد تسوية', 'backend', 'backend', 'Backend فقط · POST /api/admin/finance/settlements/confirm', 'finance/routes.ts:117'],
      ['دفعات البائعين (Payout)', 'backend', 'backend', 'Backend فقط · POST/GET /api/admin/finance/payouts', 'finance/routes.ts:139-212 · db/schema/payouts.ts:27'],
      ['مواءمة بنكية / إيصالات', 'backend', 'backend', 'Backend فقط · POST /api/admin/finance/reconciliation/import', 'finance/routes.ts:197,235'],
      ['تقرير الربحية', 'denied', 'backend', 'Backend فقط · GET /api/revenue/report', 'revenue/routes.ts:33-35 · REVENUE_READ لـSUPER فقط · تحقق حيّ: ADMIN 403'],
      ['محاكاة سيناريو الإيراد', 'denied', 'backend', 'Backend فقط · POST /api/revenue/scenario', 'revenue/routes.ts:54-56 · REVENUE_SIMULATE لـSUPER فقط'],
      ['قراءة السيناريوهات المحفوظة', 'denied', 'backend', 'Backend فقط · GET /api/revenue/scenarios', 'revenue/routes.ts:76-78'],
      ['تعديل سياسة العمولة', 'no', 'no', '—', 'الكتابة في scripts/seed.ts:226 فقط؛ لا مسار إداري'],
      ['عرض تكلفة / حدود AI', 'yes', 'yes', 'لوحة /admin/ai · GET /api/admin/ai/usage|budgets', 'admin/ai-routes.ts:56-88'],
    ],
  },
  {
    id: 'subscriptions', num: '5.6', title: 'الاشتراكات والفواتير',
    rows: [
      ['خطط الاشتراك (عرض / تفعيل)', 'yes', 'yes', 'لوحة /admin/subscriptions · GET /admin/plans, PATCH /admin/plans/:id/active', 'subscriptions/routes.ts:160,138 · SUBSCRIPTION_MANAGE'],
      ['اشتراكات العملاء', 'yes', 'yes', 'لوحة /admin/subscriptions · GET /admin/subscriptions', 'subscriptions/routes.ts:171'],
      ['الفواتير (عرض / معلّقة)', 'yes', 'yes', 'لوحة /admin/subscriptions · GET /admin/invoices[/pending]', 'subscriptions/routes.ts:182,218'],
      ['تحصيل فاتورة', 'yes', 'yes', 'لوحة /admin/subscriptions · POST /admin/invoices/:id/collect', 'subscriptions/routes.ts:260'],
      ['rollover / إقفال المتقادم', 'yes', 'yes', 'لوحة /admin/subscriptions · POST /admin/rollover, /admin/expire-lapsed', 'subscriptions/routes.ts:198,281'],
      ['اشتراك بصفتك المالك', 'denied', 'backend', 'Backend فقط · POST /api/subscriptions/subscribe', 'subscription:create لـSUPER فقط'],
    ],
  },
  {
    id: 'disputes', num: '5.7', title: 'النزاعات والشكاوى والاستئنافات',
    rows: [
      ['عرض النزاعات / تفاصيلها', 'yes', 'yes', 'لوحة /admin/disputes · GET /api/admin/disputes[/:id]', 'engines-routes.ts:140,153'],
      ['إسناد نزاع لمراجع', 'yes', 'yes', 'لوحة /admin/disputes · POST /admin/disputes/:id/assign', 'engines-routes.ts:159 · DISPUTE_ASSIGN'],
      ['تغيير حالة النزاع', 'yes', 'yes', 'لوحة /admin/disputes · POST /admin/disputes/:id/status', 'engines-routes.ts:166'],
      ['إصدار قرار', 'yes', 'yes', 'لوحة /admin/disputes · POST /admin/disputes/:id/decide', 'engines-routes.ts:173 · DISPUTE_DECIDE'],
      ['عرض / مراجعة الاستئنافات', 'yes', 'yes', 'لوحة /admin/disputes · GET .../appeals, POST .../appeals/:id/review', 'engines-routes.ts:180,186 · DISPUTE_MANAGE'],
      ['رفع نزاع بصفتك طرفاً', 'denied', 'backend', 'Backend فقط · POST /api/disputes', 'dispute:create لـSUPER فقط'],
      ['تنحّي صاحب القرار عن مراجعة استئنافه', 'yes', 'yes', 'قاعدة عمل مطبَّقة', 'docs/UI_SCREEN_MAP.md:50'],
    ],
  },
  {
    id: 'ads', num: '5.8', title: 'الإعلانات والتسويق',
    rows: [
      ['مؤشرات الإعلانات (KPIs)', 'yes', 'yes', 'لوحة /admin/ads · GET /api/admin/ads/summary', 'admin/routes.ts:69'],
      ['حملات المعلنين', 'yes', 'yes', 'لوحة /admin/ads · GET /api/admin/ads/campaigns', 'admin/routes.ts:107'],
      ['إشراف على حملة (تفعيل / إيقاف / إنهاء)', 'yes', 'yes', 'لوحة /admin/ads · PATCH /api/ads/campaigns/:id', 'ads/routes.ts:88,145 · CAMPAIGN_MANAGE'],
      ['إنشاء حملة إعلانية', 'denied', 'backend', 'Backend فقط · POST /api/ads/campaigns', 'campaign:create لـSUPER فقط'],
    ],
  },
  {
    id: 'analytics', num: '5.9', title: 'التحليلات والتقارير',
    rows: [
      ['إحصاءات لوحة القيادة', 'yes', 'yes', 'لوحة /admin · GET /api/admin/stats', 'admin/routes.ts:28'],
      ['التحليلات (overview / retention / conversion / revenue / unit-economics / cohorts / daily-kpis)', 'yes', 'yes', 'لوحة /admin/analytics · GET /api/admin/analytics/*', 'analytics-routes.ts:69-171 · ADMIN_ANALYTICS'],
      ['rollup يومي', 'yes', 'yes', 'لوحة /admin/analytics · POST /admin/analytics/daily-kpis/rollup', 'analytics-routes.ts:153'],
      ['التقارير المحفوظة (إنشاء / عرض)', 'yes', 'yes', 'لوحة /admin/reports · GET/POST /api/admin/analytics/reports', 'analytics-routes.ts:189,195'],
      ['تحليلات مستخدم محدّد', 'backend', 'backend', 'Backend فقط · GET /api/admin/analytics/users/:userId/overview', 'analytics-routes.ts:213'],
      ['تسجيل حدث تحليلي', 'backend', 'backend', 'Backend فقط · POST /api/admin/analytics/events', 'analytics-routes.ts:171'],
      ['تقرير الربحية / السيناريو', 'denied', 'backend', 'Backend فقط · /api/revenue/*', 'revenue/routes.ts · REVENUE_* لـSUPER فقط'],
    ],
  },
  {
    id: 'ai', num: '5.10', title: 'الذكاء الاصطناعي والوكلاء',
    rows: [
      ['استخدام AI (تشغيل / تحليل / توصيات)', 'yes', 'yes', 'صفحات الداشبورد · POST /api/ai/*', 'ai/routes.ts · AI_USE'],
      ['حوكمة AI (usage / requests / budgets)', 'yes', 'yes', 'لوحة /admin/ai · GET /api/admin/ai/*', 'admin/ai-routes.ts:56-88 · AI_MANAGE, ADMIN_AI'],
      ['إنشاء / تحديث ميزانية AI', 'yes', 'yes', 'لوحة /admin/ai · POST /api/admin/ai/budgets', 'admin/ai-routes.ts:88'],
      ['إنشاء / تحديث نموذج AI', 'yes', 'yes', 'لوحة /admin/ai · GET/POST /api/admin/ai/models', 'admin/ai-routes.ts:142,148'],
      ['سجل الوكلاء (11 وكيل)', 'yes', 'yes', 'لوحة /admin/ai · GET /api/admin/ai/agents', 'admin/ai-routes.ts:191 · ai/agents.ts:21-101'],
      ['مهام الوكلاء', 'yes', 'yes', 'لوحة /admin/ai · GET /api/admin/ai/tasks', 'admin/ai-routes.ts:197'],
      ['الموافقة / الرفض على مهمة وكيل', 'yes', 'yes', 'لوحة /admin/ai · POST /api/ai/tasks/:id/{approve,reject}', 'ai/routes.ts:261,275 · AI_MANAGE'],
    ],
  },
  {
    id: 'observability', num: '5.11', title: 'المراقبة والتنبيهات',
    rows: [
      ['مقاييس / لوجات / تنبيهات المنصة', 'yes', 'yes', 'لوحة /admin/observability · GET /api/admin/observability/*', 'observability/routes.ts:62-88 · ADMIN_SYSTEM'],
      ['تقييم التنبيهات يدوياً', 'yes', 'yes', 'لوحة /admin/observability · POST .../alerts/evaluate', 'observability/routes.ts:108'],
      ['حالة القنوات (بريد / SMS / rate-limit)', 'yes', 'yes', 'GET /api/health/channels', 'health/routes.ts:57'],
      ['نقطة scrape لـPrometheus', 'yes', 'yes', 'GET /metrics', 'app.ts:128'],
      ['تنقية حدود المعدّل', 'backend', 'backend', 'Backend فقط · POST /api/admin/rate-limits/purge', 'engines-routes.ts:196 · ADMIN_SYSTEM'],
    ],
  },
  {
    id: 'audit', num: '5.12', title: 'التدقيق والسجلات',
    rows: [
      ['عرض سجل التدقيق', 'yes', 'yes', 'لوحة /admin/audit · GET /api/admin/audit-logs', 'admin/routes.ts:282 (سقف 100 صف)'],
      ['تصدير سجل التدقيق', 'no', 'no', '—', 'AUDIT_LOG_EXPORT موجودة لـADMIN لكن بلا route'],
      ['كتابة تدقيق تلقائية', 'yes', 'yes', 'writeAudit في كل عملية حساسة', 'lib/audit.ts:12'],
    ],
  },
  {
    id: 'policy', num: '5.13', title: 'السياسات والخصوصية والامتثال',
    rows: [
      ['سياسة النزاع (قراءة / تعديل)', 'yes', 'yes', 'لوحة /admin/policies · GET/PUT /api/admin/policies/dispute', 'policy-routes.ts:74,119 · ADMIN_POLICIES'],
      ['سياسة الاحتفاظ (قراءة / تعديل)', 'yes', 'yes', 'لوحة /admin/policies · GET/PUT /api/admin/policies/retention', 'policy-routes.ts:213,255'],
      ['السياسة المحلولة (دولة → عام)', 'yes', 'yes', 'لوحة /admin/policies · GET .../{dispute,retention}/resolved', 'policy-routes.ts:197,332'],
      ['الدول وتفعيلها', 'yes', 'yes', 'لوحة /admin/policies · GET /api/admin/countries, PUT /:id/activation', 'country-routes.ts:28,49'],
      ['قواعد الضريبة', 'backend', 'backend', 'Backend فقط · GET /api/admin/tax/*', 'tax/routes.ts:62-103'],
      ['طلبات حذف البيانات (PII)', 'yes', 'yes', 'لوحة /admin/privacy · GET/PATCH /api/admin/privacy/deletions', 'privacy/routes.ts:120-151'],
      ['تنفيذ الاحتفاظ (retention sweep)', 'yes', 'yes', 'لوحة /admin/privacy · POST .../deletions/retention-sweep', 'privacy/routes.ts:141'],
    ],
  },
  {
    id: 'platform', num: '5.14', title: 'إعدادات المنصة والتكاملات',
    rows: [
      ['إعدادات عامة / أعلام ميزات', 'no', 'no', '—', 'لا مسار admin/settings|config|flags'],
      ['ضبط مزوّد الدفع', 'no', 'no', 'بيئة: PAYMENT_PROVIDER', 'docs/DEPLOYMENT.md:43,141'],
      ['ضبط البريد / SMS', 'no', 'no', 'بيئة: MAIL_TRANSPORT, SMS_*', 'docs/DEPLOYMENT.md:49-67'],
      ['ضبط قناة التنبيه', 'no', 'no', 'بيئة: OBS_ALERT_NOTIFY', 'docs/DEPLOYMENT.md:99'],
      ['مراقبة صحة القنوات', 'yes', 'yes', 'GET /api/health/channels', 'health/routes.ts:57'],
      ['Webhooks الدفع (HMAC)', 'yes', 'yes', 'POST /api/payment-webhooks', 'app.ts:114'],
      ['إشعاراتي الشخصية', 'denied', 'yes', 'لوحة /dashboard/notifications · GET /api/notifications', 'notifications/routes.ts:22 · MESSAGE_READ_OWN · تحقق حيّ: ADMIN 403'],
      ['بث إشعار جماعي', 'no', 'no', '—', 'لا مسار إداري'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
const ALIAS = { ok: 'yes', be: 'backend', deny: 'denied' };
const badge = (s) => {
  const k = ALIAS[s] || s;
  return ST[k]
    ? '<span class="badge b-' + ST[k].c + '">' + ST[k].t + '</span>'
    : '<span class="plain-val">' + s + '</span>';
};

function domainTable(d) {
  const head = '<tr><th style="width:26%">العملية</th><th style="width:9%">المدير ADMIN</th>'
    + '<th style="width:11%">المدير العام SUPER_ADMIN</th><th style="width:28%">مكان التنفيذ (لوحة / API)</th>'
    + '<th style="width:26%">الدليل في الكود</th></tr>';
  const body = d.rows.map((r) =>
    '<tr><td>' + r[0] + '</td><td class="ctr">' + badge(r[1]) + '</td><td class="ctr">' + badge(r[2])
    + '</td><td class="loc">' + r[3] + '</td><td class="ev">' + r[4] + '</td></tr>').join('\n');
  return '<h3 id="' + d.id + '">' + d.num + ' ' + d.title + '</h3>'
    + '<table class="grid"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

const TOC = [
  ['0', 'الملخص التنفيذي'],
  ['1', 'مقدمة: الهيكل الإداري للمنصة'],
  ['2', 'مهام ومسؤوليات المدير العام (SUPER_ADMIN)'],
  ['3', 'مهام ومسؤوليات المدير (ADMIN)'],
  ['4', 'جدول مقارنة مباشر بين المنصبين'],
  ['5', 'الصلاحيات الفعلية في لوحة الإدارة والـBackend حسب المجالات'],
  ['6', 'ما يمكن تنفيذه، وما يمكن قراءته فقط، وما لا يمكن تنفيذه'],
  ['7', 'الوظائف في الواجهة، والوظائف في الـBackend فقط، والوظائف غير الموجودة'],
  ['8', 'الفروق الحقيقية بين المنصبين والحارس العام لمسارات /api/admin/*'],
  ['9', 'جدول المهام التي تحتاج تطويراً مستقبلياً'],
  ['10', 'التوزيع الإداري المقترح'],
  ['—', 'الخاتمة'],
  ['—', 'الملحق: المنهجية، الأدلة، والملفات المفحوصة'],
];

function renderBody() {
  const tocRows = TOC.map((t) =>
    '<li><span class="toc-num">' + t[0] + '</span><span class="toc-t">' + t[1] + '</span></li>').join('\n');

  const legend = Object.keys(ST).map((k) => badge(k) + ' <span class="lg">' + ({
    yes: 'العملية مُنفَّذة ومتاحة',
    read: 'قراءة فقط بلا كتابة',
    partial: 'الصلاحية موجودة والوظيفة ناقصة',
    backend: 'مسار خادمي موجود دون واجهة إدارية',
    no: 'غير موجودة أصلاً',
    denied: 'الدور محظور منها',
  })[k] + '</span>').join('<br>');

  const compare = [
    ['كل مسارات /api/admin/* (سياسات، دول، خصوصية، مستخدمون، منتجات، طلبات، معاملات، دفتر، محاسبة، ضرائب، تحليلات، إعلانات، اشتراكات، AI، مراقبة، سجلات)', 'ok:متاحة', 'ok:متاحة', 'الحارس الشامل requireRole(ADMIN,SUPER_ADMIN) — admin/routes.ts:20 — لا فرق اليوم'],
    ['السياسات (نزاع / احتفاظ) وتفعيل الدول', 'ok:متاح', 'ok:متاح', 'admin:policies لكلَيهما'],
    ['حذف البيانات والاحتفاظ (PII)', 'ok:متاح', 'ok:متاح', 'privacy/routes.ts:120'],
    ['عرض / إيقاف-تنشيط المستخدمين', 'ok:متاح', 'ok:متاح', 'admin/routes.ts:163,179'],
    ['إنشاء / تعديل / حذف مستخدم', 'no:غير موجود', 'no:غير موجود', 'لا route لكلَيهما'],
    ['منح / سحب الأدوار', 'no:غير موجود', 'no:غير موجود', 'seeder / CLI فقط'],
    ['إيقاف / إعادة تنشيط منتج أي بائع', 'ok:متاح', 'ok:متاح', 'isAdmin في products/routes.ts:131,153'],
    ['نشر منتج باسم أي بائع', 'deny:محظور', 'be:Backend فقط', 'product:create لـSUPER فقط (rbac.ts)'],
    ['إصدار استرداد', 'ok:متاح', 'ok:متاح', 'refund:manage لكلَيهما'],
    ['عرض المعاملات / دفتر الأستاذ', 'ok:متاح', 'ok:متاح', 'adminRoutes'],
    ['محاسبة Finance (تسويات / دفعات / مواءمة)', 'be:Backend فقط', 'be:Backend فقط', 'finance/routes.ts بلا واجهة'],
    ['تقرير الربحية GET /api/revenue/report', 'deny:محظور 403', 'be:Backend فقط', 'REVENUE_READ لـSUPER فقط — تحقق حيّ'],
    ['محاكاة سيناريو الإيراد', 'deny:محظور 403', 'be:Backend فقط', 'REVENUE_SIMULATE لـSUPER فقط'],
    ['تعديل سياسة العمولة', 'no:غير موجود', 'no:غير موجود', 'seed فقط'],
    ['الاشتراكات (خطط / فواتير / rollover / تحصيل)', 'ok:متاح', 'ok:متاح', 'subscription:manage لكلَيهما'],
    ['النزاعات (إسناد / قرار / استئناف)', 'ok:متاح', 'ok:متاح', 'حرّاس engines-routes'],
    ['الإعلانات (إشراف على الحملات)', 'ok:متاح', 'ok:متاح', 'campaign:manage لكلَيهما'],
    ['التحليلات / التقارير المحفوظة', 'ok:متاح', 'ok:متاح', 'admin:analytics لكلَيهما'],
    ['إشعاراتي الشخصية', 'deny:محظور 403', 'ok:متاح', 'message:read:own — ADMIN لا يملكها'],
    ['بث إشعار جماعي', 'no:غير موجود', 'no:غير موجود', 'لا route'],
    ['حوكمة AI (نماذج / ميزانيات / وكلاء / مهام)', 'ok:متاح', 'ok:متاح', 'ai:manage + admin:ai لكلَيهما'],
    ['مراقبة الأداء والتنبيهات', 'ok:متاح', 'ok:متاح', 'admin:system لكلَيهما'],
    ['السجلات (عرض)', 'ok:متاح', 'ok:متاح', 'adminRoutes'],
    ['تصدير السجلات', 'no:غير موجود', 'no:غير موجود', 'لا route'],
    ['إنشاء طلب / دفعة / اشتراك بصفتك المالك', 'deny:محظور', 'be:Backend فقط', 'order:create / payment:create / subscription:create لـSUPER فقط'],
    ['إدارة المخزون', 'deny:محظور', 'be:Backend فقط', 'inventory:* لـSUPER فقط'],
    ['إنشاء أول SUPER_ADMIN', 'no:غير موجود', 'ok:متاح', 'CLI bootstrap:super-admin'],
    ['عدد الصلاحيات في RBAC', '79 صلاحية', '110 صلاحيات', 'rbac.ts:169-203 — العدد لا يعني اكتمال الوظائف'],
  ].map((r) => {
    const a = r[1].split(':'), s = r[2].split(':');
    return '<tr><td>' + r[0] + '</td><td class="ctr">' + badge(a[0]) + '<div class="hint">' + a[1] + '</div></td>'
      + '<td class="ctr">' + badge(s[0]) + '<div class="hint">' + s[1] + '</div></td><td class="ev">' + r[3] + '</td></tr>';
  }).join('\n');

  const future = [
    ['ت-01', 'منح / سحب الأدوار من اللوحة', 'أساسي', 'حرجة', 'لا يوجد أي مسار؛ الأدوار تُدار بـseeder / CLI — أول ما يلزم لهيكل إداري حقيقي'],
    ['ت-02', 'إنشاء / تعديل / حذف المستخدمين إدارياً', 'أساسي', 'حرجة', 'USER_CREATE / USER_UPDATE / USER_DELETE غير مُنفَّذة'],
    ['ت-03', 'واجهة إدارية لمسارات المحاسبة (تسويات / دفعات / مواءمة)', 'تشغيلي', 'عالية', 'finance/routes.ts موجودة بلا أي صفحة'],
    ['ت-04', 'واجهة لتقرير الربحية ومحاكاة السيناريو (SUPER فقط)', 'مالي', 'عالية', 'revenue/routes.ts موجودة؛ ADMIN محظور منها بحكم الصلاحية'],
    ['ت-05', 'إصلاح ظلّ حرّاس /api/admin الدقيقة', 'أمني', 'عالية', 'الحارس الشامل يُخفي فروق ADMIN_* — إعادة ترتيب التركيب أو دمج الحرّاس'],
    ['ت-06', 'واجهة إدارة قواعد الضريبة', 'امتثال', 'عالية', 'tax/routes.ts بلا صفحة'],
    ['ت-07', 'فكّ ظلّ ADMIN عن إشعاراته الشخصية', 'تصحيحي', 'متوسطة', 'ADMIN لا يملك MESSAGE_READ_OWN فيردّ 403 على /api/notifications'],
    ['ت-08', 'تصدير سجل التدقيق', 'تدقيق', 'متوسطة', 'AUDIT_LOG_EXPORT معرّفة بلا route'],
    ['ت-09', 'إعدادات المنصة وأعلام الميزات من اللوحة', 'تشغيلي', 'متوسطة', 'لا مسار admin/settings|config|flags'],
    ['ت-10', 'واجهة لإدارة التكاملات (بريد / SMS / دفع / تنبيه)', 'تكامل', 'متوسطة', 'الضبط حالياً عبر متغيرات البيئة فقط'],
    ['ت-11', 'بث إشعارات إدارية', 'تواصل', 'منخفضة', 'لا مسار إداري للإشعار الجماعي'],
    ['ت-12', 'تفاصيل طلب إداري', 'تشغيلي', 'منخفضة', 'لا adminOrders/:id'],
    ['ت-13', 'واجهة لتعديل بيانات منتج أي بائع', 'كتالوج', 'منخفضة', 'PATCH /api/products/:id متاح للمشرف بلا زر في اللوحة'],
  ].map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td class="ctr">' + r[2] + '</td><td class="ctr">' + r[3] + '</td><td class="ev">' + r[4] + '</td></tr>').join('\n');

  const domainsHtml = DOMAINS.map(domainTable).join('\n');

  return '<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">'
  + '<title>' + META.title + '</title><style>' + CSS() + '</style></head><body class="body">'

  + '<section class="page-break">'
  + '<h1 class="doc-h1">الفهرس</h1><ul class="toc">' + tocRows + '</ul>'
  + '<div class="note"><b>كيف يُقرأ هذا الدليل:</b> كل صف مبني على الكود الفعلي في الإصدار '
  + '<span class="mono">' + META.commit.slice(0, 12) + '</span>، لا على الوثائق وحدها. '
  + 'وجود صلاحية في RBAC لا يعني وجود واجهة أو وظيفة مكتملة؛ ولذلك يُميَّز في كل صف بين الحالة الفعلية ومكان التنفيذ والدليل.</div>'
  + '</section>'

  + '<h1 id="s0">0. الملخص التنفيذي</h1>'
  + '<p>يقدّم هذا الدليل صورة أمينة عن سلطات كلٍّ من <b>المدير العام (SUPER_ADMIN)</b> و<b>المدير (ADMIN)</b> في منصة '
  + 'WASIT BUSINESS GLOBAL، مستخرجةً من الكود والمسارات والواجهات والاختبارات في الفرع <span class="mono">' + META.branch
  + '</span> عند الإصدار <span class="mono">' + META.commit.slice(0, 12) + '</span>.</p>'
  + '<p>الخلاصة الجوهرية: يوجد حارس شامل على مسار <span class="mono">/api/admin/*</span> نصّه '
  + '<span class="mono">requireRole(ADMIN, SUPER_ADMIN)</span>، وهو مُثبَّت قبل بقية الموجّهات الإدارية في '
  + '<span class="mono">app.ts</span>. نتيجته العملية أن <b>سلطة المنصبين متطابقة فعلياً على كل الواجهات الإدارية</b>، '
  + 'ولا تظهر فروق حقيقية بينهما إلا في مسارات تقع <b>خارج</b> <span class="mono">/api/admin</span>: تقارير ومحاكاة الإيراد، '
  + 'والعمليات بصفة المالك (إنشاء منتجات / طلبات / مدفوعات / اشتراكات)، وإشعارات المستخدم الشخصية، وإنشاء أول SUPER_ADMIN.</p>'
  + '<div class="callout warn"><b>تحذير منهجي:</b> SUPER_ADMIN يملك 110 صلاحيات وADMIN يملك 79، لكن هذا الفارق '
  + '<b>لا يعني</b> أن مهام SUPER_ADMIN مكتملة. صلاحيات كثيرة (مثل <span class="mono">product:create</span> و'
  + '<span class="mono">merchant:delete</span>) معرّفة نظرياً دون واجهة أو وظيفة مكتملة، وبعض المسارات الخادمية (المحاسبة، الضريبة، الربحية) '
  + 'بلا أي سطح في لوحة الإدارة.</div>'
  + '<div class="callout ok"><b>الجاهزية التشغيلية:</b> الإدارة التشغيلية اليومية (المستخدمون، المنتجات، الطلبات، المدفوعات، الاشتراكات، '
  + 'النزاعات، الإعلانات، التحليلات، AI، المراقبة، السياسات، الخصوصية، السجلات) مغطّاة بالكامل في اللوحة لكلا المنصبين. '
  + 'النقص الحقيقي يتركّز في <b>إدارة الأدوار والمستخدمين</b> و<b>المحاسبة والربحية</b> و<b>إعدادات المنصة والتكاملات</b>.</div>'

  + '<h1 id="s1">1. مقدمة: الهيكل الإداري للمنصة</h1>'
  + '<p>تعتمد المنصة نموذج <b>الأقل صلاحية</b>: لا وراثة تلقائية بين الأدوار، بل تُمنح الصلاحيات صراحةً لكل دور في '
  + '<span class="mono">packages/shared/src/constants/rbac.ts</span>. الإنفاذ حصراً في الخادم عبر '
  + '<span class="mono">requirePermission(...)</span> و<span class="mono">requireRole(...)</span> في '
  + '<span class="mono">packages/server/src/middleware/auth.ts</span>؛ والواجهة ليست حماية.</p>'
  + '<p>الأدوار المعرّفة في <span class="mono">roles.ts</span> هي: CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER, SUPPORT, RISK, DISPUTE, '
  + 'ADMIN, SUPER_ADMIN. ويقف SUPER_ADMIN على قمة الهرم (قيمة 100)، وADMIN تحته (قيمة 90)، ولا يوجد دور أعلى من SUPER_ADMIN.</p>'
  + '<p>لا يمكن الحصول على أيٍّ من الدورين عبر التسجيل العام: التسجيل يقبل فقط '
  + '<span class="mono">SELF_SELECTABLE_ROLES</span> (CUSTOMER, MERCHANT, SUPPLIER, COMPANY, MARKETER) ويرفض الباقي بـ422. '
  + 'ويُنشأ أول SUPER_ADMIN خارج المسار العام عبر الأمر <span class="mono">npm run bootstrap:super-admin</span>.</p>'
  + '<p class="legend-title"><b>مفتاح الحالات المستخدم في الجداول:</b></p><div class="legend">' + legend + '</div>'

  + '<h1 id="s2">2. مهام ومسؤوليات المدير العام (SUPER_ADMIN)</h1>'
  + '<p><b>الموقع:</b> أعلى سلطة في المنصة؛ يملك كل الصلاحيات (110) عبر <span class="mono">SUPER_ADMIN: new Set(Object.values(P))</span> '
  + 'في <span class="mono">rbac.ts:201-203</span>. لا يُنشَأ عبر واجهة عامة إطلاقاً.</p>'
  + '<p><b>المهمة الأساسية:</b> القيادة والرقابة واتخاذ القرارات العليا، وحيازة الصلاحيات التي لا تُفوَّض: '
  + 'قراءة الربحية ومحاكاتها، والعمليات بصفة المالك، وتهيئة المالك الأول.</p>'
  + '<p><b>المسؤوليات التشغيلية:</b></p>'
  + '<ul>'
  + '<li>الإشراف الكامل على الواجهات الإدارية: المستخدمون، المنتجات، الطلبات، المعاملات، دفتر الأستاذ، الاشتراكات، النزاعات، الإعلانات، التحليلات، AI، المراقبة، السجلات، السياسات، الخصوصية.</li>'
  + '<li>قراءة تقرير الربحية (<span class="mono">GET /api/revenue/report</span>) وتشغيل محاكاة السيناريو (<span class="mono">POST /api/revenue/scenario</span>) — وهذان محظوران على المدير.</li>'
  + '<li>العمليات بصفة المالك: إنشاء منتج (<span class="mono">product:create</span>)، إنشاء طلب (<span class="mono">order:create</span>)، '
  + 'إنشاء دفعة (<span class="mono">payment:create</span>)، إنشاء / تعديل / إلغاء اشتراك، إدارة المخزون، رفع نزاع، رفع طلب تحقق.</li>'
  + '<li>قراءة إشعاراته الشخصية عبر <span class="mono">MESSAGE_READ_OWN</span> — وهي صلاحية يفتقدها المدير.</li>'
  + '<li>تهيئة أول SUPER_ADMIN ومنح الأدوار خارج اللوحة (CLI / seeder).</li>'
  + '</ul>'
  + '<p><b>حدود فعلية يجب الانتباه إليها:</b> حتى مع امتلاكه كل الصلاحيات، لا توجد واجهة أو مسار لإنشاء/تعديل/حذف المستخدمين، '
  + 'ولا لمنح الأدوار، ولا لتعديل سياسة العمولة، ولا لتصدير سجل التدقيق، ولا لإعدادات المنصة العامة. أي أن سعة المنصب العليا '
  + 'محصورة اليوم بما هو منفَّذ فعلاً.</p>'

  + '<h1 id="s3">3. مهام ومسؤوليات المدير (ADMIN)</h1>'
  + '<p><b>الموقع:</b> قمة الهرم التنفيذي تحت المدير العام؛ يملك 79 صلاحية صريحة في <span class="mono">rbac.ts:169-199</span>، '
  + 'ولا يرث تلقائياً من SUPER_ADMIN.</p>'
  + '<p><b>المهمة الأساسية:</b> الإدارة التشغيلية اليومية للمنصة ضمن التفويض المعتمد، بما يشمل ضبط السياسات، '
  + 'وإدارة المحتوى والطلبات والمستخدمين، ومعالجة النزاعات، والإشراف على الإعلانات، ومتابعة التحليلات والمراقبة.</p>'
  + '<p><b>المسؤوليات التشغيلية:</b></p>'
  + '<ul>'
  + '<li>إدارة المستخدمين عملياً: العرض وإيقاف/إعادة تنشيط الحسابات (Audit <span class="mono">ADMIN.USER_STATUS</span>).</li>'
  + '<li>إدارة الكتالوج: عرض كل المنتجات، إيقاف/إعادة تنشيط منتج أي بائع، تغيير حالته.</li>'
  + '<li>متابعة الطلبات والمعاملات ودفتر الأستاذ، وإصدار الاستردادات عند الحاجة.</li>'
  + '<li>إدارة الاشتراكات والفواتير: الخطط، الفواتير المعلّقة، التحصيل، rollover، وإقفال المتقادم.</li>'
  + '<li>معالجة النزاعات: الإسناد، تغيير الحالة، إصدار القرار، ومراجعة الاستئنافات (مع قاعدة تنحّي صاحب القرار).</li>'
  + '<li>الإشراف على الإعلانات، ومتابعة التحليلات والتقارير المحفوظة، وحوكمة AI، والمراقبة والتنبيهات.</li>'
  + '<li>ضبط السياسات (النزاع والاحتفاظ)، وتفعيل الدول، ومعالجة طلبات حذف البيانات.</li>'
  + '</ul>'
  + '<div class="callout warn"><b>قيود فعلية على المدير:</b> لا يقرأ تقرير الربحية ولا يشغّل محاكاة السيناريو (تحقق حيّ: 403)، '
  + 'ولا ينشئ منتجات أو طلبات أو مدفوعات أو اشتراكات بصفة المالك، ولا يقرأ إشعاراته الشخصية عبر الـAPI '
  + '(<span class="mono">MESSAGE_READ_OWN</span> غير ممنوحة له، فتأتي 403) — وهي فجوة RBAC غير مقصودة.</div>'

  + '<h1 id="s4">4. جدول مقارنة مباشر بين المنصبين</h1>'
  + '<table class="grid"><thead><tr><th style="width:30%">المجال / العملية</th><th style="width:13%">المدير ADMIN</th>'
  + '<th style="width:15%">المدير العام SUPER_ADMIN</th><th style="width:42%">الأساس والدليل</th></tr></thead><tbody>'
  + compare + '</tbody></table>'

  + '<h1 id="s5">5. الصلاحيات الفعلية في لوحة الإدارة والـBackend حسب المجالات</h1>'
  + '<div class="note">الحالة المذكورة في كل صف تعبّر عن <b>القدرة الفعلية</b> لا عن مجرد وجود الصلاحية. '
  + 'عمود «مكان التنفيذ» يفصل بوضوح بين ما يُنفَّذ من لوحة الإدارة وما هو مسار خادمي فقط.</div>'
  + domainsHtml

  + '<h1 id="s6">6. ما يمكن تنفيذه، وما يمكن قراءته فقط، وما لا يمكن تنفيذه</h1>'
  + '<h2>6.1 المدير العام (SUPER_ADMIN)</h2>'
  + '<p><b>يستطيع تنفيذه:</b> كل ما في القسم 5 بحالة «منفَّذ»، إضافةً إلى تقارير الربحية ومحاكاتها، والعمليات بصفة المالك، وتهيئة المالك الأول.</p>'
  + '<p><b>يستطيع قراءته فقط:</b> التجار والموردون والشركات (عرض عام)، وسجل التدقيق (عرض بلا تصدير)، وحالة القنوات، ومؤشرات المراقبة.</p>'
  + '<p><b>لا يستطيع تنفيذه حالياً:</b> إنشاء/تعديل/حذف المستخدمين، منح الأدوار، تصدير سجل التدقيق، بث إشعار جماعي، إعدادات المنصة وأعلام الميزات، '
  + 'إدارة التكاملات من الواجهة، تعديل سياسة العمولة، حذف منتج، تعديل حالة طلب.</p>'
  + '<h2>6.2 المدير (ADMIN)</h2>'
  + '<p><b>يستطيع تنفيذه:</b> كل الواجهات الإدارية التشغيلية: المستخدمون (عرض وإيقاف/تنشيط)، المنتجات (عرض وإيقاف/تنشيط)، الطلبات والمعاملات ودفتر الأستاذ، '
  + 'الاستردادات، الاشتراكات والفواتير، النزاعات والاستئنافات، الإعلانات، التحليلات والتقارير، AI، المراقبة، السجلات (عرض)، السياسات، الخصوصية.</p>'
  + '<p><b>يستطيع قراءته فقط:</b> التجار والموردون والشركات، وسجل التدقيق، وحالة القنوات.</p>'
  + '<p><b>لا يستطيع تنفيذه حالياً:</b> تقرير الربحية ومحاكاة السيناريو (محظور بالصلاحية)، والعمليات بصفة المالك '
  + '(منتجات/طلبات/مدفوعات/اشتراكات/مخزون)، وقراءة إشعاراته الشخصية، وتهيئة المالك الأول، إضافةً إلى كل ما لا يمكن للمدير العام فعله أصلاً.</p>'

  + '<h1 id="s7">7. الوظائف في الواجهة، وفي الـBackend فقط، وغير الموجودة</h1>'
  + '<h2>7.1 متاح في لوحة الإدارة (UI + API)</h2>'
  + '<p>لوحة القيادة <span class="mono">/admin</span>، التحليلات <span class="mono">/admin/analytics</span>، التقارير <span class="mono">/admin/reports</span>، '
  + 'المستخدمون <span class="mono">/admin/users</span>، المنتجات <span class="mono">/admin/products</span>، الطلبات <span class="mono">/admin/orders</span>، '
  + 'المعاملات <span class="mono">/admin/transactions</span>، دفتر الأستاذ <span class="mono">/admin/ledger</span>، '
  + 'التحقق <span class="mono">/admin/verification</span>، الثقة <span class="mono">/admin/trust</span>، المخاطر <span class="mono">/admin/risk</span>، '
  + 'النزاعات <span class="mono">/admin/disputes</span>، السياسات <span class="mono">/admin/policies</span>، الإعلانات <span class="mono">/admin/ads</span>، '
  + 'الاشتراكات <span class="mono">/admin/subscriptions</span>، AI <span class="mono">/admin/ai</span>، '
  + 'المراقبة <span class="mono">/admin/observability</span>، الخصوصية <span class="mono">/admin/privacy</span>، السجلات <span class="mono">/admin/audit</span>.</p>'
  + '<h2>7.2 موجود في الـBackend فقط (بلا واجهة إدارية)</h2>'
  + '<ul>'
  + '<li>المحاسبة: <span class="mono">POST /api/admin/finance/settlements/confirm</span>، '
  + '<span class="mono">POST/GET /api/admin/finance/payouts</span>، <span class="mono">/reconciliation/import</span>، <span class="mono">/receipts</span>.</li>'
  + '<li>الربحية: <span class="mono">GET /api/revenue/report</span>، <span class="mono">POST /api/revenue/scenario</span>، <span class="mono">GET /api/revenue/scenarios</span>.</li>'
  + '<li>الضريبة: <span class="mono">GET /api/admin/tax/jurisdictions</span>، <span class="mono">/countries/:id/rules</span>، <span class="mono">POST /resolve</span>.</li>'
  + '<li>التحليلات: <span class="mono">GET /api/admin/analytics/users/:userId/overview</span>، <span class="mono">POST /api/admin/analytics/events</span>.</li>'
  + '<li>الصيانة: <span class="mono">POST /api/admin/rate-limits/purge</span>.</li>'
  + '<li>المنتجات: <span class="mono">PATCH /api/products/:id</span> (تعديل بيانات أي بائع) و<span class="mono">POST /api/products</span> (نشر باسم أي بائع).</li>'
  + '</ul>'
  + '<h2>7.3 غير موجود أصلاً</h2>'
  + '<ul>'
  + '<li>إنشاء/تعديل/حذف المستخدمين، ومنح/سحب الأدوار.</li>'
  + '<li>تصدير سجل التدقيق.</li>'
  + '<li>إعدادات المنصة وأعلام الميزات، وإدارة التكاملات من الواجهة.</li>'
  + '<li>بث إشعار جماعي، وتفاصيل طلب إداري، وحذف منتج، وتعديل حالة طلب.</li>'
  + '<li>تعديل سياسة العمولة.</li>'
  + '</ul>'

  + '<h1 id="s8">8. الفروق الحقيقية بين المنصبين والحارس العام لمسارات /api/admin/*</h1>'
  + '<p>المفتاح لفهم الفرق الفعلي هو سطر واحد في <span class="mono">packages/server/src/modules/admin/routes.ts:20</span>:</p>'
  + '<pre class="code">adminRoutes.use("*", requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));</pre>'
  + '<p>وهو مُثبَّت في <span class="mono">app.ts:118</span> <b>قبل</b> بقية موجّهات <span class="mono">/api/admin</span> '
  + '(<span class="mono">engines</span> في 119، <span class="mono">ai</span> في 120، <span class="mono">analytics</span> في 121، '
  + '<span class="mono">observability</span> في 122، <span class="mono">tax</span> في 123، <span class="mono">finance</span> في 124). '
  + 'لذلك يمرّ أي طلب إلى <span class="mono">/api/admin/*</span> أولاً على حارس يسمح للمنصبين معاً، '
  + 'فتصبح الحرّاس الدقيقة (مثل <span class="mono">ADMIN_SYSTEM</span> و<span class="mono">ADMIN_ANALYTICS</span> و<span class="mono">ADMIN_POLICIES</span>) '
  + '<b>مظلَّلة</b>، ولا تُنتج فرقاً بين ADMIN وSUPER_ADMIN.</p>'
  + '<p>وعليه فإن الفروق الحقيقية بين المنصبين محصورة في المسارات <b>خارج</b> <span class="mono">/api/admin</span>:</p>'
  + '<ol>'
  + '<li><b>تقارير ومحاكاة الإيراد</b> (<span class="mono">/api/revenue/*</span>): SUPER_ADMIN يمرّ، وADMIN يُردّ بـ403.</li>'
  + '<li><b>العمليات بصفة المالك</b>: إنشاء منتج/طلب/دفعة/اشتراك، وإدارة المخزون، ورفع نزاع أو طلب تحقق — SUPER_ADMIN يملكها وADMIN لا.</li>'
  + '<li><b>إشعارات المستخدم الشخصية</b> (<span class="mono">/api/notifications</span>): SUPER_ADMIN يمرّ وADMIN يُردّ بـ403.</li>'
  + '<li><b>تهيئة أول SUPER_ADMIN</b> عبر الـCLI.</li>'
  + '</ol>'
  + '<p class="legend-title"><b>نتائج التحقق الحيّ (تشغيل الحرّاس الحقيقيين بستَب قاعدة بيانات معزول):</b></p>'
  + '<table class="grid"><thead><tr><th style="width:46%">الحارس المُختبر</th><th style="width:27%">SUPER_ADMIN</th><th style="width:27%">ADMIN</th></tr></thead><tbody>'
  + '<tr><td><span class="mono">/api/admin/stats</span> — requireRole(ADMIN,SUPER_ADMIN)</td><td class="ctr"><span class="badge b-ok">200</span></td><td class="ctr"><span class="badge b-ok">200</span></td></tr>'
  + '<tr><td><span class="mono">/api/revenue/report</span> — requirePermission(REVENUE_READ)</td><td class="ctr"><span class="badge b-ok">200</span></td><td class="ctr"><span class="badge b-deny">403</span></td></tr>'
  + '<tr><td><span class="mono">/api/revenue/scenario</span> — requirePermission(REVENUE_SIMULATE)</td><td class="ctr"><span class="badge b-ok">200</span></td><td class="ctr"><span class="badge b-deny">403</span></td></tr>'
  + '<tr><td><span class="mono">/api/notifications</span> — requirePermission(MESSAGE_READ_OWN)</td><td class="ctr"><span class="badge b-ok">200</span></td><td class="ctr"><span class="badge b-deny">403</span></td></tr>'
  + '<tr><td><span class="mono">POST /api/products</span> — requirePermission(PRODUCT_CREATE)</td><td class="ctr"><span class="badge b-ok">200</span></td><td class="ctr"><span class="badge b-deny">403</span></td></tr>'
  + '</tbody></table>'
  + '<div class="callout warn"><b>لا يُعتد بعدد صلاحيات RBAC دليلاً على الاكتمال:</b> الفارق 110 مقابل 79 صلاحية يشمل صلاحيات '
  + 'بلا واجهة أو بلا وظيفة مكتملة، كما يشمل صلاحياتٍ لا معنى لها لمشرف (مثل إدارة المخزون). '
  + 'المعيار الصحيح هو ما ورد في القسم 5: وجود الحارس + وجود المسار + وجود سطح في اللوحة.</div>'

  + '<h1 id="s9">9. جدول المهام التي تحتاج تطويراً مستقبلياً</h1>'
  + '<table class="grid"><thead><tr><th style="width:8%">المرجع</th><th style="width:30%">المهمة</th><th style="width:11%">المجال</th>'
  + '<th style="width:11%">الأولوية</th><th style="width:40%">الوضع الحالي / سبب الحاجة</th></tr></thead><tbody>'
  + future + '</tbody></table>'

  + '<h1 id="s10">10. التوزيع الإداري المقترح</h1>'
  + '<p>التوزيع التالي مبني على الفرق الحقيقي الموثَّق في هذا الدليل، ويهدف إلى فصل القيادة والرقابة عن الإدارة التشغيلية:</p>'
  + '<table class="grid"><thead><tr><th style="width:22%">المستوى</th><th style="width:39%">المدير العام SUPER_ADMIN</th>'
  + '<th style="width:39%">المدير ADMIN</th></tr></thead><tbody>'
  + '<tr><td><b>الطبيعة</b></td><td>قيادة ورقابة واتخاذ قرارات عليا</td><td>إدارة تشغيلية يومية ضمن التفويض</td></tr>'
  + '<tr><td><b>المالية</b></td><td>قراءة الربحية ومحاكاتها؛ الإشراف على المحاسبة والدفعات</td><td>المعاملات ودفتر الأستاذ والاستردادات واشتراكات العملاء؛ بلا وصول للربحية</td></tr>'
  + '<tr><td><b>الحسابات والأدوار</b></td><td>يملك الصلاحية النظرية لإدارة الأدوار وتهيئة المالك الأول (عبر CLI)</td><td>إيقاف/إعادة تنشيط الحسابات فقط</td></tr>'
  + '<tr><td><b>الكتالوج والطلبات</b></td><td>العمليات بصفة المالك عند الحاجة</td><td>الإشراف التشغيلي: الإيقاف/إعادة التنشيط ومتابعة الطلبات</td></tr>'
  + '<tr><td><b>النزاعات والامتثال</b></td><td>الرقابة العليا والقرارات الحسّاسة</td><td>الإسناد والقرار والاستئنافات وضبط السياسات وحذف البيانات</td></tr>'
  + '<tr><td><b>الإعلانات والتحليلات وAI والمراقبة</b></td><td>إشراف أعلى وقراءة الربحية</td><td>التشغيل الكامل اليومي</td></tr>'
  + '<tr><td><b>المحاسبة (تسويات/دفعات)</b></td><td>مراجعة واعتماد (يتطلب بناء واجهة)</td><td>لا وصول</td></tr>'
  + '</tbody></table>'
  + '<div class="callout ok"><b>مبدأ التوزيع:</b> يُقاد المدير العام عبر الرقابة والقرارات العليا والوصول المالي الكامل، '
  + 'ويتولّى المدير التنفيذ التشغيلي اليومي. وبما أن الحارس الشامل يجعل الواجهات الإدارية متطابقة اليوم، '
  + 'فإن أي فصل فعلي للسلطات يتطلّب إصلاح ظلّ الحرّاس (المهمة ت-05) قبل الاعتماد على RBAC كأداة فصل حقيقية.</div>'

  + '<h1>الخاتمة</h1>'
  + '<p>الإدارة في WASIT BUSINESS GLOBAL ناضجة تشغيلياً: الواجهات اليومية كاملة لكلا المنصبين، والسياسات والخصوصية والتدقيق '
  + 'والمحاسبة موجودة في الـBackend. لكن الهيكل الإداري لا يزال <b>غير متكامل</b> من ثلاث جهات:</p>'
  + '<ol>'
  + '<li><b>غياب إدارة الهوية والأدوار:</b> لا يمكن إنشاء مستخدم أو منح دور من اللوحة إطلاقاً — وهي أهم فجوة في أي هيكل إداري.</li>'
  + '<li><b>ظلّ الحرّاس:</b> الحارس الشامل على <span class="mono">/api/admin</span> يلغي الفصل الفعلي بين المدير والمدير العام، '
  + 'فيصبح RBAC غير معبِّر عن السلطة الحقيقية.</li>'
  + '<li><b>وظائف خادمية بلا سطح إداري:</b> المحاسبة (تسويات/دفعات/مواءمة)، والضريبة، والربحية — كلها موجودة في الكود وغير قابلة للاستخدام من اللوحة.</li>'
  + '</ol>'
  + '<p>لذلك فإن الطريق إلى هيكل إداري متكامل يبدأ بترتيب المهام في القسم 9: منح الأدوار وإدارة المستخدمين، ثم إصلاح ظلّ الحرّاس، '
  + 'ثم إظهار وظائف المحاسبة والربحية في اللوحة، ثم إعدادات المنصة والتكاملات. حتى ذلك الحين، يبقى التوزيع المقترح في القسم 10 '
  + 'إطاراً عملياً آمناً: المدير العام يقود ويراقب ويتخذ القرارات العليا، والمدير يتولّى الإدارة التشغيلية ضمن التفويض.</p>'

  + '<h1>الملحق: المنهجية، الأدلة، والملفات المفحوصة</h1>'
  + '<p><b>المنهجية:</b> قُرئ الكود الفعلي على الإصدار <span class="mono">' + META.commit + '</span>، '
  + 'ولكل عملية تحقّقنا من ثلاثة مستويات: (أ) الحارس في الـroute، (ب) وجود المسار في <span class="mono">app.ts</span>، '
  + '(ج) وجود صفحة/زر في <span class="mono">packages/web/src</span>. ثم شُغّلت حرّاس <span class="mono">middleware/auth.ts</span> '
  + 'الحقيقيون بستَب قاعدة بيانات معزول لقياس السلوك الفعلي لكل دور.</p>'
  + '<p><b>لم تُجرَ أي تعديلات</b> على الكود أو قاعدة البيانات أو الحسابات، ولم يُنفَّذ أي commit أو push.</p>'
  + '<p class="legend-title"><b>أبرز الملفات المفحوصة:</b></p>'
  + '<table class="grid"><thead><tr><th style="width:52%">الملف</th><th style="width:48%">ما أُخذ منه</th></tr></thead><tbody>'
  + '<tr><td class="mono">packages/shared/src/constants/{permissions,roles,rbac}.ts</td><td>الصلاحيات، الأدوار، مصفوفة ROLE_PERMISSIONS ومقارنتها</td></tr>'
  + '<tr><td class="mono">packages/server/src/middleware/auth.ts</td><td>requireAuth / requirePermission / requireRole</td></tr>'
  + '<tr><td class="mono">packages/server/src/app.ts</td><td>ترتيب تركيب الموجّهات (سبب ظلّ الحارس الشامل)</td></tr>'
  + '<tr><td class="mono">packages/server/src/modules/admin/{routes,engines-routes,ai-routes,analytics-routes,policy-routes,country-routes}.ts</td><td>مسارات /api/admin وحرّاسها</td></tr>'
  + '<tr><td class="mono">packages/server/src/modules/{finance,revenue,tax,privacy,observability,subscriptions,notifications,ads,payments,products,orders}/*</td><td>المسارات الخادمية وحالات الظهور في اللوحة</td></tr>'
  + '<tr><td class="mono">packages/web/src/{App.tsx,lib/api.ts,pages/Admin*.tsx}</td><td>صفحات الإدارة وربطها بالـAPI</td></tr>'
  + '<tr><td class="mono">packages/server/src/scripts/seed.ts, lib/super-admin-bootstrap.ts</td><td>مصدر الأدوار وسياسة العمولة وتهيئة المالك الأول</td></tr>'
  + '<tr><td class="mono">packages/server/tests/*</td><td>اختبارات admin-access, admin-ai, finance-routes, revenue, tax-engine, observability, privacy, subscriptions</td></tr>'
  + '<tr><td class="mono">docs/{PERMISSIONS_MATRIX,SUPER_ADMIN_BOOTSTRAP,UI_SCREEN_MAP,PRODUCTION_GAP_LIST,MASTER_GAP_AUDIT}.md</td><td>مرجعية تقاطعية للتحقق من عدم التخمين</td></tr>'
  + '</tbody></table>'
  + '<p class="closing">إعداد: فريق منصة WASIT BUSINESS GLOBAL · الإصدار ' + META.version + ' · ' + META.date + '</p>'

  + '</body></html>';
}

function renderCover() {
  return '<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>' + CSS() + '</style></head>'
  + '<body class="cover"><div class="cover-inner">'
  + '<div class="cover-top"><div class="brand">WASIT BUSINESS GLOBAL</div><div class="brand-line"></div></div>'
  + '<div class="cover-mid">'
  + '<div class="cover-kicker">وثيقة إدارية رسمية</div>'
  + '<h1 class="cover-title">الدليل الإداري لمهام وصلاحيات<br>المدير العام والمدير</h1>'
  + '<div class="cover-sub">WASIT BUSINESS GLOBAL — Administrative Permissions Guide</div>'
  + '<div class="cover-rule"></div>'
  + '<table class="cover-meta">'
  + '<tr><td>الوثيقة</td><td>دليل الصلاحيات الإدارية</td></tr>'
  + '<tr><td>الإصدار</td><td>' + META.version + '</td></tr>'
  + '<tr><td>التاريخ</td><td>' + META.date + '</td></tr>'
  + '<tr><td>الفرع</td><td class="mono">' + META.branch + '</td></tr>'
  + '<tr><td>الإصدار (commit)</td><td class="mono">' + META.commit + '</td></tr>'
  + '<tr><td>التصنيف</td><td>' + META.classification + '</td></tr>'
  + '</table>'
  + '</div>'
  + '<div class="cover-bottom">مصدر المحتوى: الكود الفعلي للمنصة — دون أي تخمين. '
  + 'وجود صلاحية في RBAC لا يعني وجود وظيفة مكتملة.</div>'
  + '</div></body></html>';
}

function CSS() {
  const fontFace = (family, weight, file) =>
    "@font-face{font-family:'" + family + "';font-style:normal;font-weight:" + weight
    + ";src:url('assets/fonts/" + file + "') format('truetype');}";
  const SANS = 'IBM Plex Sans Arabic';
  return fontFace(SANS, 400, 'IBMPlexSansArabic-Regular.ttf')
    + fontFace(SANS, 600, 'IBMPlexSansArabic-SemiBold.ttf')
    + fontFace(SANS, 700, 'IBMPlexSansArabic-Bold.ttf')
    + fontFace('Amiri', 400, 'Amiri-Regular.ttf') + fontFace('Amiri', 700, 'Amiri-Bold.ttf')
    + `
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: 'IBM Plex Sans Arabic', sans-serif; color: #16232f; font-size: 10.4pt; line-height: 1.85; margin: 0; }
    .mono { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.6pt; direction: ltr; unicode-bidi: embed;
            background: #eef3f8; padding: 0.5px 4px; border-radius: 3px; color: #123;
            overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
    h1 { font-size: 15.5pt; color: #0f2f4f; margin: 20px 0 8px; padding-bottom: 6px; border-bottom: 2.5px solid #c9a227; }
    h1.doc-h1 { margin-top: 0; }
    h2 { font-size: 12.4pt; color: #12405f; margin: 14px 0 6px; }
    h3 { font-size: 11.4pt; color: #0f2f4f; margin: 16px 0 6px; padding-right: 9px; border-right: 4px solid #c9a227; }
    p { margin: 6px 0; text-align: justify; }
    ul, ol { margin: 6px 0; padding-right: 20px; }
    li { margin: 3px 0; }
    .page-break { break-after: page; }
    table.grid { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 8.7pt; }
    table.grid th { background: #0f2f4f; color: #fff; padding: 6px 6px; text-align: right; font-weight: 700;
                    border: 1px solid #0f2f4f; font-size: 8.6pt; }
    table.grid td { border: 1px solid #d6dee7; padding: 5px 6px; vertical-align: top; }
    table.grid td, table.grid th { overflow-wrap: anywhere; word-break: break-word; }
    table.grid tbody tr:nth-child(even) { background: #f5f9fc; }
    table.grid thead { display: table-header-group; }
    table.grid tr { break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; }
    .callout, .note { break-inside: avoid; }
    table.grid td.ctr { text-align: center; }
    table.grid td.ev { color: #3d4b59; font-size: 8.1pt; }
    table.grid td.loc { font-size: 8.3pt; }
    .plain-val { font-weight: 700; color: #0f2f4f; white-space: nowrap; }
    .hint { font-size: 7.6pt; color: #55636f; margin-top: 2px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 7.9pt; font-weight: 700;
             color: #fff; white-space: nowrap; }
    .b-ok { background: #1e7d4f; } .b-ro { background: #1f6fb2; } .b-part { background: #b8860b; }
    .b-be { background: #6b4fa1; } .b-none { background: #7b8794; } .b-deny { background: #b3261e; }
    .legend { background: #f5f9fc; border: 1px solid #d6dee7; border-radius: 6px; padding: 8px 12px; margin: 6px 0 14px; font-size: 8.6pt; }
    .legend .lg { color: #3d4b59; }
    .legend-title { margin-top: 10px; }
    .callout { border-radius: 6px; padding: 8px 12px; margin: 10px 0; font-size: 9.4pt; }
    .callout.warn { background: #fdf6e3; border: 1px solid #e3c56a; border-right: 5px solid #b8860b; }
    .callout.ok { background: #eef8f2; border: 1px solid #a9d6bf; border-right: 5px solid #1e7d4f; }
    .note { background: #eef4fa; border: 1px solid #bcd3e8; border-right: 5px solid #1f6fb2; border-radius: 6px;
            padding: 8px 12px; margin: 10px 0; font-size: 9.4pt; }
    pre.code { direction: ltr; text-align: left; background: #0f2436; color: #e6eef6; padding: 9px 12px;
               border-radius: 6px; font-family: 'DejaVu Sans Mono', monospace; font-size: 8.6pt; overflow-wrap: anywhere; }
    ul.toc { list-style: none; padding: 0; margin: 10px 0; }
    ul.toc li { display: flex; gap: 10px; padding: 7px 10px; border-bottom: 1px dashed #cfd9e3; font-size: 10.4pt; }
    ul.toc li:nth-child(odd) { background: #f7fafc; }
    .toc-num { min-width: 26px; color: #b8860b; font-weight: 700; }
    .toc-t { flex: 1; }
    .closing { margin-top: 16px; color: #55636f; font-size: 9pt; text-align: center; }

    /* Cover */
    body.cover { margin: 0; padding: 0; }
    .cover { height: 297mm; width: 210mm; background: linear-gradient(160deg, #0b2137 0%, #0f2f4f 45%, #16436b 100%);
             color: #fff; display: flex; }
    .cover-inner { display: flex; flex-direction: column; justify-content: space-between; width: 100%;
                   padding: 26mm 20mm 18mm; }
    .brand { font-family: 'IBM Plex Sans Arabic', sans-serif; font-weight: 700; letter-spacing: 3px; font-size: 15pt; color: #fff; }
    .brand-line { width: 62mm; height: 3px; background: #c9a227; margin-top: 6px; }
    .cover-kicker { display: inline-block; border: 1px solid #c9a227; color: #e9d18a; border-radius: 999px;
                    padding: 3px 14px; font-size: 10pt; margin-bottom: 16px; }
    .cover-title { font-family: 'Amiri', 'IBM Plex Sans Arabic', serif; font-weight: 700; font-size: 31pt; line-height: 1.5;
                   margin: 0 0 12px; color: #fff; }
    .cover-sub { font-size: 11pt; color: #b9cde0; letter-spacing: 0.6px; }
    .cover-rule { width: 40mm; height: 2px; background: #c9a227; margin: 18px 0; }
    table.cover-meta { border-collapse: collapse; font-size: 9.8pt; }
    table.cover-meta td { padding: 4px 10px 4px 0; color: #d7e3ee; border-bottom: 1px solid rgba(255,255,255,0.14); }
    table.cover-meta td:first-child { color: #e9d18a; font-weight: 700; min-width: 40mm; }
    table.cover-meta .mono { background: rgba(255,255,255,0.10); color: #fff; }
    .cover-bottom { font-size: 9pt; color: #9fb6c9; border-top: 1px solid rgba(255,255,255,0.18); padding-top: 8px; }
    `;
}

// ---------------------------------------------------------------------------
// Chromium via the DevTools Protocol
// ---------------------------------------------------------------------------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        const key = m.method + (m.sessionId ? '@' + m.sessionId : '');
        (this.listeners.get(key) || []).forEach((fn) => fn(m.params));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, sessionId) {
    const key = method + (sessionId ? '@' + sessionId : '');
    return new Promise((resolve) => {
      const fn = (p) => { const arr = this.listeners.get(key) || []; this.listeners.set(key, arr.filter((x) => x !== fn)); resolve(p); };
      this.listeners.set(key, [...(this.listeners.get(key) || []), fn]);
    });
  }
}

async function withChromium(fn) {
  const profile = mkdtempSync(join(tmpdir(), 'wasit-cr-'));
  const proc = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none',
    '--allow-file-access-from-files', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('chromium did not report a DevTools endpoint')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (c) => reject(new Error('chromium exited early: ' + c)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  try { return await fn(cdp); }
  finally { try { ws.close(); } catch {} proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); }
}

async function renderPdf(cdp, htmlPath, { footer }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url: 'file://' + htmlPath }, sessionId);
  await loaded;

  for (let i = 0; i < 60; i++) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: "document.readyState === 'complete' && document.fonts.status === 'loaded'",
      returnByValue: true,
    }, sessionId);
    if (result.value === true) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const opts = footer
    ? {
        printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
        marginTop: 0.55, marginBottom: 0.62, marginLeft: 0.45, marginRight: 0.45,
        headerTemplate: '<div></div>',
        footerTemplate: '<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7.5px;'
          + 'color:#5b6b7c;padding:0 12mm;display:flex;justify-content:space-between;">'
          + '<span>WASIT BUSINESS GLOBAL &mdash; Administrative Permissions Guide</span>'
          + '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      }
    : { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 };

  const { data } = await cdp.send('Page.printToPDF', opts, sessionId);
  await cdp.send('Target.closeTarget', { targetId });
  return Buffer.from(data, 'base64');
}

// ---------------------------------------------------------------------------
async function main() {
  writeFileSync(COVER_HTML, renderCover(), 'utf8');
  writeFileSync(BODY_HTML, renderBody(), 'utf8');
  console.log('HTML written: cover.html, guide.html');

  const { cover, body } = await withChromium(async (cdp) => ({
    cover: await renderPdf(cdp, COVER_HTML, { footer: false }),
    body: await renderPdf(cdp, BODY_HTML, { footer: true }),
  }));

  const coverPdf = join(HERE, '.cover.pdf');
  const bodyPdf = join(HERE, '.body.pdf');
  writeFileSync(coverPdf, cover);
  writeFileSync(bodyPdf, body);

  const merge = `
import sys
from pypdf import PdfWriter, PdfReader
w = PdfWriter()
for p in (sys.argv[1], sys.argv[2]):
    for page in PdfReader(p).pages:
        w.add_page(page)
w.add_metadata({'/Title': ${JSON.stringify(META.title)}, '/Author': 'WASIT BUSINESS GLOBAL',
                '/Subject': 'Administrative permissions guide (SUPER_ADMIN vs ADMIN)',
                '/Creator': 'docs/management/build-pdf.mjs', '/Producer': 'Chromium printToPDF'})
with open(sys.argv[3], 'wb') as f:
    w.write(f)
`;
  execFileSync('python3', ['-c', merge, coverPdf, bodyPdf, OUT_PDF], { stdio: 'inherit' });
  rmSync(coverPdf, { force: true }); rmSync(bodyPdf, { force: true });
  console.log('PDF written:', OUT_PDF);
}

main().catch((e) => { console.error(e); process.exit(1); });

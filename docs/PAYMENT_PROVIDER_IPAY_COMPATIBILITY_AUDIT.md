# WASIT BUSINESS GLOBAL — تقرير: توافق مزوّد الدفع iPay by Audasoft

**النطاق:** مراجعة قراءة فقط (Read-only audit) — لا تعديل على كود الإنتاج، لا migrations، لا DB reset/drop/push، ولا إضافة أي credentials.
**تاريخ الفحص:** 2026-09-23.
**المزوّد المستهدف (مُعرَّف بدقة):** **iPay by Audasoft Technology** — `ipay.tn` / `dashboard.ipay.tn`، صادر عن **AUDASOFT SARL**، تونس. (ليس iPay Ghana، ولا iPay.ua، ولا i-pay.io — فتلك منتجات مختلفة تمامًا؛ انظر §B).

> **قاعدة التقرير:** لا معلومة هنا إلا وهي إما (1) مقتبسة من صفحة رسمية على `ipay.tn` مع رابطها، أو (2) مقتبسة من كود WASIT الحالي، أو (3) موسومة صراحةً `PROVIDER CONFIRMATION REQUIRED`. **لم يُختَرع أي endpoint أو حقل أو رقم.**

---

## A. Executive Summary

**الحكم النهائي: `NEEDS PROVIDER CONFIRMATION` (ليس `GO` وليس `BLOCKED` نهائيًا).**

النموذج المطلوب (المشتري يدفع 1,020 والمورّد يستلم 980 وWASIT تحتفظ بـ40) هو نموذج **marketplace split بأربع جهات دفع عددها ثلاثة** (WASIT + المورّد + مزوّد الدفع). ما هو **مثبت رسميًا** من iPay:

1. **كصفحة تسويقية/تصنيف حلول**: iPay تُعلن صراحةً على `/solutions` قسم **Marketplace** فيه حرفيًا: `Split des paiements`، `Multi-vendeurs`، `Commissions configurables`، `Paiements différés ou instantanés`. أي أنهم **يدّعون** دعم النموذج على مستوى المنتج.
2. **كدليل API منشور**: التوثيق العام المنشور على `ipay.tn/developpeurs` **لا يعرض أي endpoint** للـsplit، ولا للـpartners/sub-merchants، ولا للـpayout، ولا للـsettlement، ولا للـrefund، ولا للـdispute. المعروض فقط: `customers` / `plans` / `subscriptions` / `transactions` / `stats`، مع JWT + `X-Org-Id`، وwebhooks بـ`transaction.completed|created|failed` **فقط**.
3. **كفجوة فنية حاسمة**: iPay هي **مُجمِّع (aggregator)** يوجّه إلى ClicToPay/Flouci/D17/Konnect/virement/mandat/SMS. ومعظم هذه القنوات تُسوّي **عملية واحدة نحو حساب واحد**. لذلك **القدرة التصنيعية على توزيع مال واحد على ثلاثة أطراف غير مثبتة**، بل مشكوك فيها على مستوى التنفيذ الفعلي.

**النتيجة العملية:** يمكن لـWASIT ربط iPay كـ**قناة تحصيل (collection) فقط** بتغيير مُحدَّد صغير جدًا (محوّل واحد + enum + 3 متغيرات بيئة) **دون إعادة بناء النظام** (§L / §O). لكن **توزيع الـ40 TND، ووصولها إلى الحساب البنكي لـWASIT، ووصول الـ980 للمورّد، وحالة الـrefund/chargeback — كل ذلك يحتاج تأكيدًا مباشرًا من iPay بعقد/إعداد خاص** قبل أي ادعاء بأن الـintegration "100% ممكن".

**توصية:** لا تُوقَّع أي التزامات على أساس الصفحة التسويقية وحدها. اطرح §M على iPay كتابيًا واطلب مواصفات API للـsplit/settlement، ثم أعد التصنيف.

---

## B. Official Evidence

كل ما يلي مأخوذ من `ipay.tn` (مُلك AUDASOFT SARL) وقت الفحص. الصفحات تحمل «Dernière mise à jour : 16/07/2026».

| # | الحقيقة | المصدر الرسمي (URL) | الاقتباس الحرفي |
|---|---|---|---|
| E1 | هوية المزوّد وطبيعته | `https://www.ipay.tn/a-propos` | «L'agrégateur de paiements tunisien qui connecte les SaaS… nous offrons une seule API qui agrège toutes ces solutions» |
| E2 | يخدم صراحةً الـmarketplaces | `https://www.ipay.tn/a-propos` | «iPay s'adresse aux SaaS, sites e-commerce, **marketplaces**…» |
| E3 | ادعاء Marketplace/Split (تسويقي) | `https://www.ipay.tn/solutions` | «Marketplace … Répartition des flux, commissions par vendeur, paiements différés ou instantanés. **Split des paiements**, **Multi-vendeurs**, **Commissions configurables**, Webhooks par transaction» |
| E4 | القنوات المُجمَّعة (9) | `https://www.ipay.tn/produits/agregateur-paiements` | Virement bancaire، Mandat postal، **ClicToPay**، **Flouci**، **D17**، **Konnect**، SMS Ooredoo، SMS Tunisie Telecom، WinSMS |
| E5 | التسعير: 1% بحد 5 TND | `https://www.ipay.tn/pricing` | «Commission par transaction **1 %** — **Plafonné à 5 TND** par transaction»؛ ومن 500 TND فما فوق = 5 TND كحد أقصى |
| E6 | رسوم القنوات منفصلة عن iPay | `https://www.ipay.tn/pricing` | «Les frais des prestataires externes (ClicToPay, Flouci, Ooredoo, Tunisie Telecom, etc.) sont facturés **en sus** du 1 % iPay par les émetteurs respectifs. Ces frais ne sont **pas inclus** dans la commission iPay» |
| E7 | المصادقة | `https://www.ipay.tn/developpeurs` | «Utilisez l'en-tête `X-Org-Id` et un token **JWT** généré depuis l'interface admin. Le token est valide **1 an**» + `Authorization: Bearer` |
| E8 | Endpoints المنشورة | `https://www.ipay.tn/developpeurs` | `POST /api/admin/customers`، `POST /api/admin/plans`، `POST /api/admin/subscriptions`، `GET /api/admin/transactions`، `GET /api/admin/stats` |
| E9 | endpoint الدفع الفردي | `https://www.ipay.tn/produits/paiement-oneshot` | «Endpoint API dédié : **`POST /api/admin/transactions/create-oneshot`** — Retourne un lien de paiement prêt à rediriger» |
| E10 | أحداث الـwebhook (3 فقط) | `https://www.ipay.tn/produits/webhooks-integrations` | `transaction.completed`، `transaction.created`، `transaction.failed`؛ «**Retry automatique**»، «Historique des appels et payloads» |
| E11 | حقول الـwebhook | `https://www.ipay.tn/produits/webhooks-integrations` | Payload : `id, status, product_id, customer_id, month, amount, currency, invoice_reference` |
| E12 | الفواتير (API) | `https://www.ipay.tn/produits/gestion-factures` | `GET /api/admin/invoices`، `GET /api/admin/invoices/:id`، `GET /api/admin/invoices/:id/pdf` |
| E13 | نموذج الحساب = Organization | `https://www.ipay.tn/produits/interface-administration` | «Mon compte & **Organisation** … token JWT API, **données de test**» — لا ذكر لأي مفهوم sous-marchand/partner |
| E14 | إدارة الاشتراكات المفوترة شهريًا | `https://www.ipay.tn/cgu` | «La facturation s'effectue **mensuellement** selon le volume de transactions» |
| E15 | الشركة المالكة | `https://www.ipay.tn/mentions-legales` | «édité par **AUDASOFT SARL**… Siège social : Tunis, Tunisie» |

**تمييز مهم (لمنع الالتباس):** نتائج البحث تُرجع منتجات بنفس الاسم ولا علاقة لها بالمزوّد:
- `docs.ipaygh.com` / `ipaygh.com/terms` → **iPay Ghana** (مرخّص بغانا، عملة GHS).
- `docs.i-pay.io` → بوابة **كريبتو**.
- `ipay.ua` → **أوكرانيا**.
- `ipayafrica.com`، `ipay.com.bd`، `i-payout.com` → جهات أخرى.
**لا يُستشهد بأي منها هنا**؛ فهي لا تمثّل iPay by Audasoft، واستخدام وثائقها في تقرير توافق تونسي سيكون خطأً منهجيًا.

---

## C. Exact WASIT 1,020 → 980 + 40 Flow

نموذج WASIT المطلوب (كما هو مُنفَّذ فعليًا في الكود — مُتحقَّق منه):

| الخطوة | المبلغ | الأدلة في كود WASIT |
|---|---|---|
| قيمة العملية (Items Total) | **1,000.0000 TND** | `orders.itemsTotal` — `packages/server/src/modules/orders/service.ts` |
| عمولة المشتري (2%) | +20.0000 | قيد `COMMISSION/DEBIT` بـ`payerId = buyerId`, `beneficiaryId = 'wasit'`, `metadata.share = 'BUYER'` |
| **المشتري يدفع** | **1,020.0000 TND** | `orders.grandTotal = itemsTotal + buyerCommission` (السطر المعلَّق: «The buyer pays the items total plus their share of the commission») |
| عمولة البائع (2%) | −20.0000 | قيد `COMMISSION/DEBIT` بـ`payerId = sellerId`, `beneficiaryId = 'wasit'`, `metadata.share = 'SELLER'` |
| **البائع يستلم** | **980.0000 TND** | `itemsTotal − sellerCommission` (يُخصم عند التسوية) |
| **إجمالي عمولة WASIT** | **40.0000 TND** | مجموع قيدَي COMMISSION (2% + 2%) |
| رسم الدفع (منفصل) | منفصل تمامًا | قيد `PAYMENT_FEE/DEBIT` بـ`beneficiaryId = 'payment-provider'` — أي **ليس إيراد WASIT** بل مرور لمزوّد الدفع |

**الترجمة الدقيقة إلى دفعة واحدة عبر iPay:** المشتري يدفع مبلغًا واحدًا = **1,020 TND**، ويجب أن يخرج منه:
- **980 TND → البائع (المورّد)**  
- **40 TND → WASIT**  
- **رسم iPay (5 TND لكون 1,020 > 500، بسبب سقف 5 TND) + رسوم القناة → جهة ثالثة**

> هذه **ثلاثة beneficiaries** يجب أن تقبلهم iPay من دفعة واحدة. وهذا بالضبط ما لم تُثبته وثائقهم (§D/E).

**ملاحظة على سقف iPay:** عند 1,020 TND (وهذا فوق 500 TND) تكون عمولة iPay = **5.000 TND** بالسقف، وليس 1% (=10.20). هذا **أرخص** من رسوم WASIT الحالية إن كانت أكبر من 5 TND، لكنه لا يحلّ مشكلة الـsplit.

---

## D. iPay API capabilities

### D.1 ما هو موثَّق رسميًا (GO للتحصيل)

| القدرة | الحالة | الدليل |
|---|---|---|
| إنشاء عملية دفع فردية + رابط دفع | ✅ موثَّق | E9 — `POST /api/admin/transactions/create-oneshot` |
| قائمة العمليات + إحصاءات | ✅ موثَّق | E8 — `GET /api/admin/transactions`, `GET /api/admin/stats` |
| إدارة العملاء | ✅ موثَّق | E8 — `POST /api/admin/customers` |
| مصادقة Bearer JWT + `X-Org-Id` | ✅ موثَّق | E7 |
| Webhooks بثلاثة أحداث + retry | ✅ موثَّق | E10 |
| الفواتير (list/detail/pdf) | ✅ موثَّق | E12 |
| الاشتراكات/الخطط | ✅ موثَّق | E8 |

### D.2 ما هو **غير** موثَّق علنًا (يحتاج تأكيدًا)

| القدرة المطلوبة لـWASIT | الحالة | المرجع |
|---|---|---|
| **Split payment** عبر API (حقول `splits`/`sub_accounts`) | ❌ غير منشور | لا شيء في `/developpeurs` |
| **Partners / Sub-merchants** (تسجيل مورّد ككيان دفع) | ❌ غير منشور | E13 يذكر «Organisation» فقط |
| **Payout / Settlement** إلى حساب بنكي | ❌ غير منشور | لا endpoint ولا حقل |
| **Refund** (كامل/جزئي) عبر API | ❌ غير منشور | §I |
| **Dispute / Chargeback** عبر API | ❌ غير منشور | §I |
| **حالة التسوية (settlement_status)** لكل عملية | ❌ غير منشور | لا حقل في E11 |
| **حقول الـwebhook غنية** (المبالغ المفصولة، هوية المورّد) | ❌ غير منشورة | E11: `amount` إجمالي واحد فقط |
| **توقيع (signature) للـwebhook** | ❌ غير منشور | §J |

> **تنبيه:** التوثيق الكامل «avec tous les champs, exemples curl» موجود **فقط داخل الـdashboard بعد تسجيل الدخول** (E8: «disponible dans l'interface d'administration une fois connecté»). لذلك قد توجد قدرات split غير مُعلَنة على الموقع العام — لكن **لا يجوز افتراضها**. هذا هو جوهر وسم `PROVIDER CONFIRMATION REQUIRED`.

---

## E. Marketplace/Split architecture

**التحليل الفني (قراءة بين السطور + بنية القنوات):**

1. **إعلان مقابل تنفيذ:** الصفحة `/solutions` تقول `Split des paiements` و`Multi-vendeurs` (E3). لكن لا صفحة، ولا endpoint، ولا حقل، ولا حدث webhook واحد يشرح **كيف** يتم ذلك. عند مزوّدين آخرين (مثال Telr) يوجد API منشور فيه مصفوفة `splits` بـ`type`/`value` ومفهوم `sub-merchant id`؛ **هذا النمط غائب تمامًا** من وثائق iPay العامة.
2. **iPay مُجمِّع لا مُصدِر:** قدرة الـsplit تعتمد على القناة النهائية. Virement/Mandat = تحويل لعملية واحدة نحو IBAN/CCP غالبًا. ClicToPay = بوابة monétique وطنية (تحصيل واحد). Flouci = محفظة. **القناة الواحدة ≈ مستفيد واحد.** لذا حتى لو دعمت iPay التوزيع في نموذجها الداخلي، فالأرجح أنها **تسوّي للأورغانيزيشن (WASIT) ثم يُطلب من WASIT توزيعها** (§F/G) — وهذا يعني أن WASIT تتحول إلى **حامل الأموال** (money transmitter)، وهي مسؤولية بنكية/تنظيمية مختلفة.
3. **نموذج الحساب:** كل شيء يدور حول **Organization** واحدة + `X-Org-Id` (E7/E13). لا وجود لكائن «sous-marchand» ولا «partner». هذا يؤكد أن الاندماج المطلوب لتسجيل **كل مورّد ككيان دفع** (sub-merchant/partner) غير قائم في النموذج العام.

**الخلاصة:** الادعاء التسويقي موجود؛ لكن **الدليل على قدرة API فعلية = صفر**. تصنيف النقطة: **`NEEDS PROVIDER CONFIRMATION`**.

---

## F. Settlement to WASIT bank

- **ما هو موثَّق:** لا شيء. لا توجد صفحة، ولا endpoint، ولا حقل `bank_account`/`settlement`/`payout`، ولا حدث webhook للتسوية. الفواتير (E12) عربية-فواتير ضريبية، وليست تسوية.
- **ما هو مُستنتج بحذر:** التسعير «facturation **mensuelle** sur le volume réel» (E5/E14) يوحي بأن iPay تُصدر فاتورة شهرية برسمها (1% بحد 5 TND)، وليس أن توزّع أموالًا لكل طرف. هذا يرجّح أن iPay **تحصّل لصالح الأورغانيزيشن** ثم تُصفّي لاحقًا — لكن **طريقة وتوقيت وصول المال لحساب WASIT البنكي غير موثّقة**.
- **التضارب المفتوح مع تقريرنا السابق:** `docs/PAYMENT_SETTLEMENT_AUDIT.md` أثبت أن **WASIT نفسها لا تملك حاليًا أي مسار يحرّك مالًا فعليًا إلى البنك** (لا كود payout/IBAN/settlement). حتى لو وفّرت iPay settlement، سيحتاج WASIT إلى إضافة مسار تسوية محاسبي — وهو **خارج نطاق هذه المهمة** وممنوع صراحةً.
- **تصنيف:** **`NEEDS PROVIDER CONFIRMATION`** — السؤال الحاسم: *هل تودع iPay الـ40 TND (عمولة WASIT) في الحساب البنكي لـWASIT مباشرة، أم تُصفّي المبلغ الإجمالي وتُصدر فاتورة بالعمولة؟ ومتى؟*

---

## G. Seller payout

- لا يوجد أي endpoint payout/transfer/Beneficiary موثَّق.
- لكي يستلم المورّد الـ980، يوجد سيناريوهان:
  1. **iPay split مباشر إلى المورّد** (sub-merchant/partner account، مع KYC لكل مورّد) — غير موثَّق إطلاقًا.
  2. **iPay تسوّي الإجمالي إلى WASIT** ثم **WASIT تدفع للمورّد** — وهذا يتطلب من WASIT بناء طبقة payout، وهي **ممنوعة في المهمة الحالية** وخارج نطاق الـintegration النقي.
- **تصنيف:** **`BLOCKED` (حتى التأكيد)** — لا يمكن للمورّد أن يستلم 980 عبر iPay بمعزل عن WASIT دون آلية موثَّقة.

---

## H. Fees

| الرسم | المبلغ على 1,020 TND | الدليل | كيف يُخصم؟ |
|---|---|---|---|
| عمولة iPay | **5.000 TND** (سقف؛ 1% = 10.20 مُقيَّد بـ5) | E5 | موثَّق أن الرسم 1% بحد 5 — لكن **آلية الخصم غير موثَّقة** |
| رسوم القنوات (ClicToPay/Flouci/SMS…) | متغيّرة | E6 | «facturés en sus… par les émetteurs respectifs» |
| رسوم Virement/Mandat | 0 إضافي من iPay | E5 | «ne génèrent pas de frais supplémentaires côté iPay» |
| عمولة WASIT | 40 TND | نموذج WASIT | منفصلة تمامًا عن رسوم iPay |

**الأسئلة غير المحسومة (كلها `PROVIDER CONFIRMATION REQUIRED`):**
1. هل تُخصم عمولة iPay **من مبلغ العملية** (فيصبح الصافي 1,015 → 980 + 35؟) أم **تُفوتر شهريًا على WASIT** (فيبقى التوزيع 980 + 40 كاملًا)؟
   - هذا **جوهري**: الخصم من العملية **يكسر** النموذج (40→35)، بينما الفوترة الشهرية تُبقيه سليمًا (980 + 40 + فاتورة 5 لاحقة).
2. من يتحمّل رسوم القناة (ClicToPay/Flouci)؟ المشتري؟ WASIT؟ تُخصم من الإجمالي؟
3. هل للعمولة سقف/حد أدنى/ضريبة (TVA) على 5 TND؟

**تصنيف نقطة الأرقام:** **`GO`** — الأرقام الرسمية (1% / سقف 5) واضحة ومنشورة.  
**تصنيف آلية الخصم وموقع الرسم من الـsplit:** **`NEEDS PROVIDER CONFIRMATION`**.

---

## I. Refund/Dispute behavior

- **الاسترداد (Refund):** لا يوجد endpoint refund منشور. أحداث الـwebhook الثلاثة (E10) **لا تشمل** أي حدث refund. لذلك:
  - ماذا يحدث للـ**20 buyer fee** والـ**20 seller fee** عند الاسترداد؟
  - في نظام WASIT الحالي (بعد إصلاح RC-5) الاسترداد **يعكس** عمولة البائع والمشتري ورسم الدفع تناسبيًا عبر قيود CREDIT (انظر `reverseCommissionAndFee` في `packages/server/src/modules/payments/service.ts`). لكن **هل تعكس iPay بدورها الـ40 ورسومها؟** غير موثَّق.
  - **تصنيف: `NEEDS PROVIDER CONFIRMATION` + يتطلب تنفيذ refund adapter إذا وُجد API.**
- **النزاع/الـChargeback:** لا ذكر إطلاقًا لـdispute/chargeback في أي صفحة iPay عامة. لا حقل حالة، ولا endpoint، ولا سياسة منشورة.
  - **تصنيف: `NEEDS PROVIDER CONFIRMATION`.** (يُستحسن طلب: دورة حياة النزاع، الأطراف، مهل الرد، من يتحمّل الخسارة، وأثرها على عمولة WASIT.)

---

## J. Webhook lifecycle

**الموثَّق:**
- ثلاث أحداث: `transaction.completed` / `transaction.created` / `transaction.failed` (E10).
- **Retry تلقائي** + سجل بالـcalls والـpayloads (E10).
- حقول payload: `id, status, product_id, customer_id, month, amount, currency, invoice_reference` (E11).
- Callback URLs تُضبط **per produit** (نجاح/فشل) (E10/E12).

**غير الموثَّق / المخاطر:**
1. **لا توقيع (signature) للـwebhook** → لا يوجد `X-Signature`/HMAC. هذا مطابق لوضع Flouci/ClicToPay، ولهذا يمتلك WASIT آلية `requiresStatusRecheck` + `getStatus()` (انظر `port.ts`). **مطلوب نفس النمط لـiPay.**
2. **لا معرّف حدث للـidempotency** (لا `event_id`). الحقل `id` = معرّف العملية لا الحدث → إعادة الإرسال (retry) قد تُنشئ نفس الحدث مرتين بلا تمييز.
3. **لا حدث refund** → الاسترداد لا يمكن متابعته عبر webhook.
4. **الـpayload لا يحمل split breakdown** (مستفيدون/مبالغ) ولا هوية المورّد.
5. **التوقيت/عدد المحاولات/backoff** للـretry غير موثَّق.

**تصنيف:** **`GO` بشرط** — يمكن استقبال الأحداث الثلاثة مع **إعادة تحقق عبر `GET /api/admin/transactions`** قبل تطبيق أي أثر (نفس نمط Flouci). أما clave idempotency وحدث الـrefund فيحتاجان **`PROVIDER CONFIRMATION`**.

---

## K. KYC/KYB and onboarding

**الموثَّق رسميًا (بسيط جدًا):**
- التسجيل: `https://www.ipay.tn/signup` + `https://dashboard.ipay.tn/signup` (حقول: Email, Nom complet, **Nom de l'organisation**, Mot de passe). الأساس: «Inscription en quelques étapes».
- «Compte administrateur (propriétaire)» = كيان واحد للأورغانيزيشن.
- «données de test» متاحة في إعدادات الأورغانيزيشن (E13).

**غير الموثَّق:**
- **KYC/KYB**: لا صفحة، ولا قائمة مستندات، ولا ذكر لـRNE/مستندات شركة، ولا مالكين نافعين (UBO)، ولا التحقق البنكي (IBAN/RIB)، ولا مدة الموافقة.
- **التوافق التنظيمي**: لا ذكر لـBCT (البنك المركزي التونسي) ولا ترخيص دفع، ولا PCI-DSS، ولا AML/CTF.
- **للمورّدين**: لا آلية للتحقق من كل مورّد (sub-merchant KYC) — وهذا شرط أساسي لو أراد WASIT تسجيل كل مورّد كطرف دفع.

**سياق السوق (ليس دليلًا على iPay):** التوثيق القطاعي يشير إلى أن KYC/KYB في تونس قد يتطلب مستندات موثّقة/تحققًا فعليًا ومدة أسابيع. لذا يجب افتراض أن onboarding قد يكون طويلًا.

**تصنيف:** **`NEEDS PROVIDER CONFIRMATION`** — بما فيه سؤال «هل تُقدّم iPay قناة onboarding للمورّدين (sub-merchants) أم أنّ الأورغانيزيشن فقط هو الطرف المُتحقَّق منه؟».

---

## L. WASIT integration mapping

**بنية الـPayment Kernel الحالية (مُتحقَّق منها من الكود — لا تغيير مطلوب في الجوهر):**

```
packages/server/src/modules/payments/service.ts   ← المنطق (createIntent, createRefund, handlePaymentWebhook)
packages/server/src/modules/payments/routes.ts    ← HTTP + webhook بلا session
packages/server/src/lib/payments/port.ts          ← العقد PaymentProvider (النقطة الوحيدة التي تلمس المزوّد)
packages/server/src/lib/payments/providers.ts     ← الـNoop / Manual / OpenCheckout + HMAC
packages/server/src/lib/payments/flouci.ts        ← محوّل Flouci (نموذج مرجعي)
packages/server/src/lib/payments/clictopay.ts     ← محوّل ClicToPay (نموذج مرجعي)
packages/server/src/lib/payments/resolve.ts       ← resolvePaymentProvider() + describePaymentProviders()
packages/server/src/lib/env.ts                    ← PAYMENT_PROVIDER enum + مفاتيح المزوّد
```

**نقاط الإضافة الدقيقة (دون إعادة بناء):**

| # | الملف | التغيير المطلوب |
|---|---|---|
| 1 | `lib/payments/ipay.ts` (جديد) | `class IpayPaymentProvider implements PaymentProvider` بنفس نمط `flouci.ts`/`clictopay.ts` |
| 2 | `lib/payments/resolve.ts` | `case 'ipay': return resolveIpay();` + إضافته إلى `describePaymentProviders()` |
| 3 | `lib/env.ts` | إضافة `'ipay'` إلى `PAYMENT_PROVIDER` enum + 3 متغيرات: `IPAY_BASE_URL`, `IPAY_ORG_ID`, `IPAY_JWT_TOKEN` |
| 4 | `port.ts` | **لا تغيير** (العقد يحمل `requiresStatusRecheck` و`getStatus` سلفًا) |
| 5 | خريطة الأساليب | القنوات المتعددة (virement/carte/Flouci/SMS) تُمثَّل عبر `ProviderCapability[]` — لكن **قد تحتاج توسيع `PaymentScheme`** ليشمل `VIREMENT`/`POSTE`/`SMS` (تغيير محدود في enum فقط) |

**ملاءمة المحوّل:** الـ`PaymentProvider` port مُصمَّم لـ«اقتطاع + استرداد + webhook»، ولا يحمل أي مفهوم **split/payout**. لذا:
- **التحصيل (1,020 من المشتري):** يُمثَّل مباشرة عبر `createIntent` باستخدام `POST /api/admin/transactions/create-oneshot` → **يُرجع checkoutUrl** (متوافق تمامًا).
- **الاسترداد:** يُمثَّل عبر `refund()` **إن وُجد endpoint**.
- **توزيع 980/40:** **لا مكان له في العقد الحالي** — لأن النظام كله مبني على أن WASIT تستلم الإجمالي ثم تُسوّي محاسبيًا (انظر `PAYMENT_SETTLEMENT_AUDIT.md`: لا payout، لا settlement). لذا أي `splits` من iPay سيتطلب **توسيع العقد** (`CreateIntentInput` + بنية `splits`) إن أراد WASIT تفويض التوزيع للمزوّد.

**تصنيف الـmapping:**
- ربط التحصيل: **`GO`** (تغيير صغير محدود، لا إعادة بناء).
- ربط الـsplit: **`NEEDS PROVIDER CONFIRMATION`** (يعتمد على وجود API غير منشور).
- ربط الـpayout للمورّد: **`BLOCKED`** (لا آلية موثَّقة + التزام معماري بتسوية WASIT).

---

## M. Missing information requiring direct confirmation from iPay

الأسئلة التالية **يجب** توجيهها كتابيًا إلى iPay (Contact/Audasoft)، لأن الإجابة عليها غير منشورة:

**الـSplit والتوزيع**
1. هل يوجد API split في **مستوى الإنتاج** (وليس إعلانًا تسويقيًا)؟ ما الحقول بالضبط (endpoint + payload schema)؟
2. هل تُسجَّل الأطراف كـ**sub-merchants/partners**؟ ما آلية التسجيل وKYC لكل مورّد؟ هل لكل مورّد IBAN/RIP مستقل؟
3. هل يدعم الـsplit **ثلاثة مستفيدين في عملية واحدة** (WASIT + morّد + مزوّد)؟ أم مستفيد واحد فقط؟
4. هل الـsplit يُحدَّد **وقت إنشاء العملية (at charge time)** أم لاحقًا (post-settlement) عبر Transfer API؟
5. ماذا يحدث للـsplit عند **استرداد جزئي/كامل**؟

**التسوية والأموال**
6. كيف تُوصَل الـ40 TND إلى **الحساب البنكي لـWASIT**؟ (تحويل دوري؟ صافي بعد الرسوم؟ متى T+?؟)
7. هل تُخصم عمولة iPay (5 TND) **من العملية** أم **تُفوتر شهريًا على WASIT** (وهذا يحدد هل التوزيع 980+40 أم 980+35)؟
8. من يتحمّل رسوم ClicToPay/Flouci، وكيف تُخصم؟
9. هل توجد تقارير/API للتسوية (settlement reports) ومطابقتها (reconciliation)؟

**الاسترداد والنزاع**
10. هل يوجد Refund API (كامل/جزئي)؟ ما أثره على عمولة WASIT ورسوم iPay؟
11. هل يوجد Dispute/Chargeback API وسياسة مكتوبة؟ من يتحمّل الخسارة؟

**التقنية والتوافق**
12. هل يوجد **webhook signature**؟ ما اسم الهيدر والدالة؟
13. هل يوجد **معرّف حدث فريد** للـidempotency؟ سياسة الـretry (عدد المحاولات/backoff)؟
14. هل يوجد **Sandbox/Test** منفصل وما شروطه؟ (E13 يذكر «données de test» فقط)
15. ما متطلبات **KYC/KYB** بالضبط؟ هل iPay مرخّصة/مرتبطة بـBCT؟ ما الوضع مع PCI-DSS؟
16. ما **العملات المدعومة**؟ (كل الصفحات TND فقط — هل توجد عملات أخرى؟)
17. ما **حدود المبالغ** (min/max) للمورّدين والعمليات؟
18. هل توفّر iPay توثيق API كاملًا بصيغة PDF/Markdown يمكن مشاركته قبل فتح حساب؟

---

## N. Required credentials/configuration for Sandbox

**غير مؤكد (يحتاج تأكيدًا):** لا نشر لبيئة sandbox مستقلة أو مفاتيح اختبار عامة. ما هو معروف:
- إنشاء حساب على `https://dashboard.ipay.tn/signup` (Email + Nom complet + Nom de l'organisation + Mot de passe) — E13/§K.
- بعد الدخول: `Mon compte & Organisation` → **«données de test»** + **token JWT API** (صلاحية سنة).
- `X-Org-Id` = معرّف الأورغانيزيشن (E7).
- الـbase URL للمصادقة/Docs: `https://dashboard.ipay.tn` (نطاق البوابة)؛ الـAPI تحت `…/api/admin/…`.

**الشكل المقترح لملف البيئة (لا يُضاف إلى المستودع — يُملأ لاحقًا على السيرفر فقط):**
```
PAYMENT_PROVIDER=ipay
IPAY_BASE_URL=<يُحدَّد من iPay>          # PROVIDER CONFIRMATION REQUIRED (sandbox host?)
IPAY_ORG_ID=<X-Org-Id من الـdashboard>
IPAY_JWT_TOKEN=<JWT من الـdashboard>
```
> **لا تُضاف أي credentials إلى المستودع** (التزامًا بالقيود). المطلوب من iPay: تأكيد وجود **sandbox host منفصل** + بيانات اختبار + مفتاح/سرّ لتوقيع الـwebhook (إن وُجد).

---

## O. Recommended technical integration architecture

**المرحلة 1 — تحصيل فقط (قابل للتنفيذ فورًا، تغيير محدود، لا إعادة بناء):**
1. إضافة `lib/payments/ipay.ts` بنمط `flouci.ts`:
   - `id = 'ipay'`, `isFunctional = true`
   - `requiresStatusRecheck = true` (لغياب توقيع الـwebhook) + `getStatus()` عبر `GET /api/admin/transactions` (مطابقة بـ`invoice_reference` = `orderId`).
   - `createIntent()` → `POST /api/admin/transactions/create-oneshot`، مع تمرير `amount = grandTotal (1,020)`، و`currency = TND`، و`invoice_reference = orderId`، واستخدام `Idempotency-Key` المحلي.
   - `verifyAndNormalizeWebhook()`: يفكّ `transaction.completed|failed` ثم **يفوّض التحقق إلى `getStatus`** (نمط Flouci).
2. إضافة `case 'ipay'` في `resolve.ts` + `describePaymentProviders()`.
3. إضافة `'ipay'` + 3 متغيرات في `env.ts`.
4. **WASIT تبقى المسؤول عن التوزيع المحاسبي**: تستلم 1,020 (مطابقة `payment.status=PAID`)، ثم تُثبِّت عمولة 4% (40) ورسوم القناة في الـledger كما هو الآن. **لا تفويض split للمزوّد في هذه المرحلة.**

**المرحلة 2 — split مفوَّض (فقط بعد تأكيد §M):**
- توسيع `CreateIntentInput` بحقل اختياري `splits?: { beneficiaryRef, amount }[]`.
- إن أكّدت iPay دعم sub-merchants: تسجيل كل مورّد كـsub-merchant، وتمرير `splits` وقت الـcharge.
- **تنبيه:** هذا يتقاطع مع `PAYMENT_SETTLEMENT_AUDIT.md` الذي يمنع بناء Settlement/Payout؛ لذا يحتاج قرارًا معماريًا مستقلًا (لا يُنفَّذ الآن).

**المرحلة 3 — الاسترداد والنزاع:** تُبنى فقط إن وُجد Refund/Dispute API. حتى ذلك الحين، الاسترداد يعمل داخليًا (RC-5) مع بقاء المال عند iPay غير مُعاد — وهي **فجوة يجب تسجيلها بوضوح**.

---

## P. GO / BLOCKED / NEEDS PROVIDER CONFIRMATION — لكل نقطة

| # | النقطة | التصنيف | السبب المختصر |
|---|---|---|---|
| P1 | القنوات المُجمَّعة (virement, carte, wallets, mandat, SMS) | **GO** | موثَّقة رسميًا (E4) |
| P2 | تحصيل دفعة واحدة من المشتري (1,020) | **GO** | `create-oneshot` موثَّق (E9) |
| P3 | مصادقة API (JWT + `X-Org-Id`) | **GO** | موثَّثة (E7) |
| P4 | Webhooks (3 أحداث + retry) | **GO** | موثَّقة (E10) — مع إعادة تحقق إلزامية |
| P5 | الفواتير عبر API | **GO** | موثَّقة (E12) |
| P6 | رسوم iPay (1% / سقف 5 TND) | **GO** | منشورة (E5) |
| P7 | Endpoint الاسترداد (Refund) | **NEEDS PROVIDER CONFIRMATION** | غير منشور (لا حدث refund) |
| P8 | **Split payment عبر API** | **NEEDS PROVIDER CONFIRMATION** | ادعاء تسويقي فقط (E3) بلا API (E8) |
| P9 | Partners / Sub-merchants (+ KYC لكل مورّد) | **NEEDS PROVIDER CONFIRMATION** | النموذج «Organization» فقط (E13) |
| P10 | آلية خصم رسوم iPay (من العملية أم فاتورة شهرية) | **NEEDS PROVIDER CONFIRMATION** | غير منشورة — تؤثر مباشرة على 980/40 |
| P11 | Settlement إلى بنك WASIT | **NEEDS PROVIDER CONFIRMATION** | لا endpoint ولا سياسة منشورة |
| P12 | Seller payout (وصول 980 للمورّد) | **BLOCKED (حتى التأكيد)** | لا آلية موثَّقة + التزام تسوية WASIT |
| P13 | Refund behavior للـ20+20 | **NEEDS PROVIDER CONFIRMATION** | لا API ولا حدث |
| P14 | Dispute / Chargeback | **NEEDS PROVIDER CONFIRMATION** | لا ذكر إطلاقًا |
| P15 | توقيع الـwebhook | **NEEDS PROVIDER CONFIRMATION** | غير منشور (يُعالج بـ`getStatus`) |
| P16 | Idempotency (`event_id`) للـwebhook | **NEEDS PROVIDER CONFIRMATION** | حقول الـpayload لا تحمله (E11) |
| P17 | Sandbox منفصل | **NEEDS PROVIDER CONFIRMATION** | «données de test» فقط (E13) |
| P18 | KYC/KYB + ترخيص BCT + PCI | **NEEDS PROVIDER CONFIRMATION** | غير منشور |
| P19 | العملات المدعومة | **NEEDS PROVIDER CONFIRMATION** | TND فقط ظاهريًا |
| P20 | حدود المبالغ | **NEEDS PROVIDER CONFIRMATION** | غير منشورة |
| P21 | ربط iPay كقناة تحصيل في WASIT (محوّل واحد + enum + env) | **GO** (قابل للتنفيذ) | بنية `port.ts` جاهزة؛ تغيير محدود |
| P22 | تفويض التوزيع (980/40) للمزوّد | **NEEDS PROVIDER CONFIRMATION** | يعتمد على P8/P9 |
| P23 | استلام WASIT لعمولة 40 في بنكها | **NEEDS PROVIDER CONFIRMATION** | يعتمد على P11 + غياب مسار settlement في WASIT |

---

## ملاحظات نزاهة (Integrity Notes)

1. **لم يُعدَّل أي كود إنتاج**، ولم تُنشأ migrations، ولم يُعمَل أي DB reset/drop/push، ولم تُضَف أي credentials.
2. **لا اختراع**: كل endpoint مذكور أعلاه مأخوذ حرفيًا من صفحة رسمية (المصادر في §B) أو من كود WASIT (المسارات في §C/§L). كل ما هو غير منشور موسوم `NEEDS PROVIDER CONFIRMATION`.
3. **لم يُدَّعَ إمكان integration 100%** — الحكم النهائي `NEEDS PROVIDER CONFIRMATION` مقيَّد بنداء §M.
4. **حفظ نموذج WASIT**: العمولة 4% = 2%+2% لم تُمس، وسياسة Marketing Video (35–120ث) وAgent 89e68d7 لم تُمس.
5. **الحدود الزمنية**: معلومات iPay مأخوذة وقت الفحص (2026-09-23)؛ صفحاتهم تحمل «Dernière mise à jour : 16/07/2026» وقد تتغيّر.
6. **لم يُنفَّذ أي integration** — هذا تقرير فقط، والتوقّف هنا مقصود بناءً على طلب المهمة.

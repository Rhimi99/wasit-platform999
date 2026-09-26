/**
 * WASIT BUSINESS GLOBAL — Dev/Test Demo Seeder.
 *
 * ملاحظة: هذه بيانات تطوير/اختبار واضحة ("Seed/Dev Data") تُنشئ المستخدمين والكيانات
 * التجارية والمنتجات والطلبات عبر الـ Services الحقيقية (registerUser, createSupplier,
 * createProduct, createOrder) ليمرّ كل شيء بنفس اصطلاحات التحقق/العمولة/الدفتر.
 * لا علاقة لها ببيانات الإنتاج.
 */
import { db, closeDb } from '../db/client';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { registerUser } from '../modules/auth/service';
import { hashPassword } from '../lib/security';
import { env } from '../lib/env';
import { createSupplier } from '../modules/suppliers/service';
import { createMerchant } from '../modules/merchants/service';
import { createCompany } from '../modules/companies/service';
import { createProduct } from '../modules/products/service';
import { createOrder } from '../modules/orders/service';
import { openDirectThread, sendMessage } from '../modules/messaging/service';
import { DEMO_PUBLISHED_PASSWORD, DEMO_TEST_ACCOUNT_EMAIL, resolveStaffPassword } from '../lib/demo-account';
import { users, userRoles, roles } from '../db/schema/auth';
import { suppliers, merchants, companies } from '../db/schema/trade';
import { categories, products } from '../db/schema/products';
import { countries } from '../db/schema/geo';
import { orders } from '../db/schema/commerce';
import { threads, threadParticipants } from '../db/schema/messaging';
import { inventoryItems } from '../db/schema/commerce_extras';
import { ensureInventoryItem } from '../lib/inventory-engine';

/**
 * When set, restores each demo product's declared stock instead of preserving
 * what earlier runs consumed. Used by the E2E global setup for a deterministic
 * fixture; never set in production.
 */
const RESET_STOCK = process.env.SEED_RESET_STOCK === '1';

/**
 * Official PUBLIC-DEMO test account, provisioned by this seeder (not by any
 * login special-case). It is an ordinary CUSTOMER — active, email-verified in
 * the demo only, with no staff role and no password bypass. The address lives in
 * `lib/demo-account.ts` so the `/api/auth/demo-session` route opens a session for
 * exactly this account; the password never is committed: it comes from
 * `DEMO_TEST_ACCOUNT_PASSWORD` in the environment, so the credential stays in
 * the git-ignored demo env (`.env.demo`) exactly like every other demo secret.
 */
const DEMO_TEST_ACCOUNT_PASSWORD = process.env.DEMO_TEST_ACCOUNT_PASSWORD?.trim();

/**
 * Password for the two staff fixtures below. Delegates the policy to
 * {@link resolveStaffPassword}: an explicit `DEMO_STAFF_PASSWORD` wins, the public
 * demo generates a random one, and dev/test keeps the known password for E2E.
 */
function staffPassword(): string {
  const pw = resolveStaffPassword({
    nodeEnv: env.NODE_ENV,
    configuredPassword: process.env.DEMO_STAFF_PASSWORD,
    generate: () => randomBytes(32).toString('base64url'),
  });
  if (!process.env.DEMO_STAFF_PASSWORD?.trim() && env.NODE_ENV === 'staging') {
    console.warn(
      '[seed-demo] DEMO_STAFF_PASSWORD not set; generated a random staff password ' +
        'for this run (not committed):',
      pw,
    );
  }
  return pw;
}

// تونس — الثابتة تُستخرج من قاعدة البيانات (وليست Hardcoded في Core):
let TUNISIA_ID = '';
let FOOD_CAT = '';
let TEXTILE_CAT = '';
let ELECTRONICS_CAT = '';

async function loadRefs(): Promise<void> {
  const cRows = await db.select({ id: categories.id }).from(categories);
  FOOD_CAT = cRows[0]?.id ?? '';
  TEXTILE_CAT = cRows[1]?.id ?? '';
  ELECTRONICS_CAT = cRows[2]?.id ?? '';

  const tn = await db.select({ id: countries.id }).from(countries).limit(1);
  TUNISIA_ID = tn[0]?.id ?? '';
}

interface CreatedUser {
  userId: string;
  email: string;
}

async function ensureDevUser(
  emailBase: string,
  password: string,
  role: 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY' | 'ADMIN' | 'SUPER_ADMIN',
  options: { enforcePassword?: boolean } = {},
): Promise<CreatedUser> {
  const email = emailBase.toLowerCase();
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    // Dev shortcut: اجعل مستخدمي الديمو موثقي البريد تلقائيًا (بيئة تطوير فقط).
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, existing[0].id));
    // Staff fixtures must never keep a stale password across runs — otherwise a
    // demo rebuilt from an earlier seeder run would still answer to the published
    // password. Re-hash so the stored credential always matches `password`.
    if (options.enforcePassword) {
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.id, existing[0].id));
    }
    return { userId: existing[0].id, email };
  }
  const { userId } = await registerUser(db, {
    email,
    password,
    firstName: role,
    lastName: 'Demo',
    locale: 'ar',
    role,
  }, { ipAddress: '127.0.0.1', userAgent: 'dev-seeder' });
  // Dev shortcut (تطوير فقط): نغيّر حالة التحقق مباشرة لأن لا SMTP حقيقي في بيئة التطوير.
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
  return { userId, email };
}

async function assignRoleDirect(userId: string, roleName: 'ADMIN' | 'SUPER_ADMIN'): Promise<void> {
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role.length === 0) return;
  const existing = await db
    .select()
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  if (existing.some((ur) => ur.roleId === role[0].id)) return;
  await db.insert(userRoles).values({ id: randomUUID(), userId, roleId: role[0].id });
}

async function seedDirectoryRelationships(ctx: {
  customerUserId: string;
  supplierUserId: string;
  merchantUserId: string;
  companyUserId: string;
  supplierId: string;
  merchantId: string;
  companyId: string;
}): Promise<void> {
  // Products created inside this helper are marked so the seeder stays idempotent
  // and re-runnable: a second run reuses the same rows instead of duplicating them.
  const DIRECTORY_SKU_PREFIX = 'DIR-REL-';

  async function ensureRelationshipProduct(opts: {
    skuSuffix: number;
    sellerId: string;
    sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY';
    name: string;
    price: string;
    actorId: string;
  }): Promise<string> {
    const sku = `${DIRECTORY_SKU_PREFIX}${opts.skuSuffix}`;
    const existing = await db.select({ id: products.id }).from(products).where(eq(products.sku, sku)).limit(1);
    if (existing.length > 0) return existing[0].id;
    const created = await createProduct(db, {
      sellerId: opts.sellerId,
      sellerType: opts.sellerType,
      categoryId: FOOD_CAT || TEXTILE_CAT || ELECTRONICS_CAT,
      name: opts.name,
      sku,
      currencyCode: 'TND',
      basePrice: opts.price,
      moq: 1,
      purchaseIntent: 'B2B',
      initialQuantity: 500,
      lowStockThreshold: 20,
    }, { ipAddress: '127.0.0.1', actorId: opts.actorId });
    return created.id;
  }

  async function ensureRelationshipOrder(opts: {
    buyerId: string;
    buyerType: 'CUSTOMER' | 'MERCHANT' | 'COMPANY';
    productId: string;
    notes: string;
  }): Promise<void> {
    const existing = await db.select({ id: orders.id }).from(orders).where(eq(orders.notes, opts.notes)).limit(1);
    if (existing.length > 0) return;
    await createOrder(db, {
      buyerId: opts.buyerId,
      buyerType: opts.buyerType,
      items: [{ productId: opts.productId, quantity: 1 }],
      currencyCode: 'TND',
      notes: opts.notes,
    }, { actorId: opts.buyerId, ipAddress: '127.0.0.1' });
  }

  // Merchant sells → Customer buys, and Company (as buyer) buys.
  const merchantProduct = await ensureRelationshipProduct({
    skuSuffix: 1, sellerId: ctx.merchantId, sellerType: 'MERCHANT',
    name: 'Demo relationship product — Merchant', price: '75.0000', actorId: ctx.merchantUserId,
  });
  await ensureRelationshipOrder({
    buyerId: ctx.customerUserId, buyerType: 'CUSTOMER', productId: merchantProduct,
    notes: 'DEMO-DIR merchant->customer',
  });
  await ensureRelationshipOrder({
    buyerId: ctx.companyUserId, buyerType: 'COMPANY', productId: merchantProduct,
    notes: 'DEMO-DIR merchant->company',
  });

  // Supplier sells → Customer buys, Merchant (as buyer) buys, and Company buys.
  const supplierProduct = await ensureRelationshipProduct({
    skuSuffix: 2, sellerId: ctx.supplierId, sellerType: 'SUPPLIER',
    name: 'Demo relationship product — Supplier', price: '120.0000', actorId: ctx.supplierUserId,
  });
  await ensureRelationshipOrder({
    buyerId: ctx.customerUserId, buyerType: 'CUSTOMER', productId: supplierProduct,
    notes: 'DEMO-DIR supplier->customer',
  });
  await ensureRelationshipOrder({
    buyerId: ctx.merchantUserId, buyerType: 'MERCHANT', productId: supplierProduct,
    notes: 'DEMO-DIR supplier->merchant',
  });
  await ensureRelationshipOrder({
    buyerId: ctx.companyUserId, buyerType: 'COMPANY', productId: supplierProduct,
    notes: 'DEMO-DIR supplier->company',
  });

  // Supplier (as buyer) buys from the Merchant → also gives Merchant a real buyer.
  await ensureRelationshipOrder({
    buyerId: ctx.supplierUserId, buyerType: 'MERCHANT', productId: merchantProduct,
    notes: 'DEMO-DIR merchant->supplier-org',
  });

  // Company sells → Customer and Merchant buy → Company→Buyers surface.
  const companyProduct = await ensureRelationshipProduct({
    skuSuffix: 3, sellerId: ctx.companyId, sellerType: 'COMPANY',
    name: 'Demo relationship product — Company', price: '210.0000', actorId: ctx.companyUserId,
  });
  await ensureRelationshipOrder({
    buyerId: ctx.customerUserId, buyerType: 'CUSTOMER', productId: companyProduct,
    notes: 'DEMO-DIR company->customer',
  });
  await ensureRelationshipOrder({
    buyerId: ctx.merchantUserId, buyerType: 'MERCHANT', productId: companyProduct,
    notes: 'DEMO-DIR company->merchant',
  });

  console.log('Directory relationships seeded ✓');
}

async function main(): Promise<void> {
  console.log('Demo Seeder — seeding dev/test environment...');
  await loadRefs();

  const pw = DEMO_PUBLISHED_PASSWORD;
  const staffPw = staffPassword();

  // المستخدمون التجريبيون
  const customer = await ensureDevUser('customer1@wasit.tn', pw, 'CUSTOMER');
  const supplierUser = await ensureDevUser('supplierA@wasit.tn', pw, 'SUPPLIER');
  const merchantUser = await ensureDevUser('merchantA@wasit.tn', pw, 'MERCHANT');
  const companyUser = await ensureDevUser('companyA@wasit.tn', pw, 'COMPANY');
  const adminUser = await ensureDevUser('admin@wasit.tn', staffPw, 'SUPER_ADMIN', {
    enforcePassword: true,
  });
  await assignRoleDirect(adminUser.userId, 'SUPER_ADMIN');
  await assignRoleDirect(adminUser.userId, 'ADMIN');

  // A second permitted reviewer. The appeal policy recuses the admin who decided
  // a dispute from reviewing the appeal of that decision, so proving the positive
  // review path (from the UI) requires a distinct staff actor. There is no
  // product endpoint that grants a staff role, so this fixture is seeded here.
  const reviewerUser = await ensureDevUser('admin2@wasit.tn', staffPw, 'ADMIN', {
    enforcePassword: true,
  });
  await assignRoleDirect(reviewerUser.userId, 'ADMIN');

  // Official PUBLIC-DEMO test account (ordinary CUSTOMER). Idempotent: an
  // existing row is kept as-is and only (re-)marked verified in the demo, so
  // re-running the seeder never duplicates or resets the account. Re-provisioned
  // automatically whenever the demo database is rebuilt from scratch.
  //
  // `enforcePassword` repairs a row whose stored hash no longer matches the
  // published demo credential — the failure mode a stray registration (or an
  // integration run that minted the account with its own literal) leaves behind,
  // where the account exists but the documented password is refused.
  const demoTestUser = await ensureDevUser(
    DEMO_TEST_ACCOUNT_EMAIL,
    DEMO_TEST_ACCOUNT_PASSWORD ?? pw,
    'CUSTOMER',
    { enforcePassword: true },
  );
  if (!DEMO_TEST_ACCOUNT_PASSWORD) {
    console.warn(
      `[seed-demo] DEMO_TEST_ACCOUNT_PASSWORD not set; ${DEMO_TEST_ACCOUNT_EMAIL} uses the published demo password.`,
    );
  }

  console.log('Users ready:', [customer, supplierUser, merchantUser, companyUser, demoTestUser].map((u) => u.email).join(', '));

  // إنشاء الكيانات التجارية إن لم تكن موجودة
  const supExisting = await db.select().from(suppliers).where(eq(suppliers.userId, supplierUser.userId)).limit(1);
  let supplierId = supExisting[0]?.id ?? '';
  if (!supplierId) {
    const sup = await createSupplier(db, {
      companyName: 'Tunisian Harvest Exports SARL',
      countryId: TUNISIA_ID,
      description: 'Exporter of olive oil, dates and agricultural products from Tunisia.',
      userId: supplierUser.userId,
    }, { actorId: supplierUser.userId });
    supplierId = sup.id;
  }

  const merExisting = await db.select().from(merchants).where(eq(merchants.userId, merchantUser.userId)).limit(1);
  let merchantId = merExisting[0]?.id ?? '';
  if (!merchantId) {
    const mer = await createMerchant(db, {
      storeName: 'Médina Modern Store',
      countryId: TUNISIA_ID,
      description: 'Retail & wholesale store in Tunis.',
      userId: merchantUser.userId,
    }, { actorId: merchantUser.userId });
    merchantId = mer.id;
  }

  const comExisting = await db.select().from(companies).where(eq(companies.userId, companyUser.userId)).limit(1);
  let companyId = comExisting[0]?.id ?? '';
  if (!companyId) {
    const com = await createCompany(db, {
      legalName: 'Global Tunisian Industries Co.',
      registrationNumber: 'TN-88231-B',
      taxId: '00088231/A/B/000',
      countryId: TUNISIA_ID,
      industry: 'Food processing & packaging',
      description: 'B2B food processing and packaging company.',
      userId: companyUser.userId,
    }, { actorId: companyUser.userId });
    companyId = com.id;
  }

  console.log('Entities ready:', { supplierId, merchantId, companyId });

  // المنتجات — عبر createProduct (نفس صلاحيات/تحقق الـ API الحقيقي)
  const productDefinitions = [
    {
      sellerId: supplierId, sellerType: 'SUPPLIER' as const, categoryId: FOOD_CAT, name: 'Premium Organic Olive Oil 5L',
      nameAr: 'زيت زيتون عضوي فاخر 5 لتر', sku: 'SUP-OO-5L-001', basePrice: '145.0000', moq: 50, unit: 'can',
      brand: 'Tunisian Harvest', purchaseIntent: 'B2B' as const,
      description: 'Cold-pressed extra virgin olive oil, export quality, 5L cans.',
      initialQuantity: 400, lowStockThreshold: 40,
    },
    {
      sellerId: supplierId, sellerType: 'SUPPLIER' as const, categoryId: FOOD_CAT, name: 'Deglet Nour Dates 10kg Box',
      nameAr: 'تمر دقلة نور صندوق 10 كغ', sku: 'SUP-DT-10K-002', basePrice: '89.0000', moq: 100, unit: 'box',
      brand: 'Tunisian Harvest', purchaseIntent: 'B2B' as const,
      description: 'Premium Deglet Nour dates, hand-sorted, 10kg export boxes.',
      initialQuantity: 120, lowStockThreshold: 20,
    },
    {
      sellerId: merchantId, sellerType: 'MERCHANT' as const, categoryId: TEXTILE_CAT, name: 'Tunisian Handwoven Rugs (Set of 3)',
      nameAr: 'زرابي تونسية منسوجة يدويًا (طقم 3)', sku: 'MER-RUG-001', basePrice: '320.0000', moq: 1, unit: 'set',
      brand: 'Médina Modern', purchaseIntent: 'B2C' as const,
      description: 'Authentic handwoven Tunisian rugs made from natural wool.',
      initialQuantity: 8, lowStockThreshold: 3,
    },
    {
      sellerId: merchantId, sellerType: 'MERCHANT' as const, categoryId: ELECTRONICS_CAT, name: 'Smart Home Hub WS-200',
      nameAr: 'مركز المنزل الذكي WS-200', sku: 'MER-HUB-002', basePrice: '59.5000', moq: 5, unit: 'unit',
      brand: 'Médina Modern', purchaseIntent: 'B2C' as const,
      description: 'Wi-Fi smart home hub with mobile app.',
      initialQuantity: 30, lowStockThreshold: 5,
    },
    {
      sellerId: companyId, sellerType: 'COMPANY' as const, categoryId: FOOD_CAT, name: 'Industrial Tomato Paste 3kg Tins (Pallet 48)',
      nameAr: 'معجون طماطم صناعي 3 كغ (بالتة 48)', sku: 'COM-TP-3K-001', basePrice: '420.0000', moq: 10, unit: 'pallet',
      brand: 'GTI Co.', purchaseIntent: 'B2B' as const,
      description: 'Industrial double-concentrated tomato paste for food manufacturers.',
      initialQuantity: 60, lowStockThreshold: 10,
    },
    {
      sellerId: companyId, sellerType: 'COMPANY' as const, categoryId: ELECTRONICS_CAT, name: 'POS Terminal Bundle (10 units)',
      nameAr: 'طقم أجهزة نقاط بيع (10 وحدات)', sku: 'COM-POS-010', basePrice: '4500.0000', moq: 1, unit: 'bundle',
      brand: 'GTI Co.', purchaseIntent: 'B2B' as const,
      description: 'Retail POS terminal bundle with printers and software license.',
      initialQuantity: 15, lowStockThreshold: 2,
    },
    // عروض قابلة للمقارنة — نفس المنتج بباركود مشترك من بائعين مختلفين بأسعار مختلفة،
    // كي تظهر محرك مقارنة الأسعار ببيانات حقيقية (لا Mock).
    {
      sellerId: supplierId, sellerType: 'SUPPLIER' as const, categoryId: FOOD_CAT,
      name: 'Extra Virgin Olive Oil 1L Bottle', nameAr: 'زيت زيتون بكر ممتاز زجاجة 1 لتر',
      sku: 'SUP-OO-1L-003', barcode: '6191234500011', basePrice: '28.5000', moq: 12, unit: 'bottle',
      brand: 'Tunisian Harvest', purchaseIntent: 'B2B' as const,
      description: 'Cold-pressed extra virgin olive oil in 1L retail bottles.',
      initialQuantity: 300, lowStockThreshold: 30,
    },
    {
      sellerId: merchantId, sellerType: 'MERCHANT' as const, categoryId: FOOD_CAT,
      name: 'Extra Virgin Olive Oil 1L Bottle', nameAr: 'زيت زيتون بكر ممتاز زجاجة 1 لتر',
      sku: 'MER-OO-1L-004', barcode: '6191234500011', basePrice: '32.0000', moq: 1, unit: 'bottle',
      brand: 'Tunisian Harvest', purchaseIntent: 'B2C' as const,
      description: 'Cold-pressed extra virgin olive oil, 1L retail bottle.',
      initialQuantity: 40, lowStockThreshold: 5,
    },
    {
      sellerId: companyId, sellerType: 'COMPANY' as const, categoryId: FOOD_CAT,
      name: 'Deglet Nour Dates 5kg Box', nameAr: 'تمر دقلة نور صندوق 5 كغ',
      sku: 'COM-DT-5K-003', barcode: '6191234500028', basePrice: '52.0000', moq: 20, unit: 'box',
      brand: 'GTI Co.', purchaseIntent: 'B2B' as const,
      description: 'Export-grade Deglet Nour dates, 5kg boxes.',
      initialQuantity: 80, lowStockThreshold: 10,
    },
    {
      sellerId: supplierId, sellerType: 'SUPPLIER' as const, categoryId: FOOD_CAT,
      name: 'Deglet Nour Dates 5kg Box', nameAr: 'تمر دقلة نور صندوق 5 كغ',
      sku: 'SUP-DT-5K-004', barcode: '6191234500028', basePrice: '47.5000', moq: 50, unit: 'box',
      brand: 'Tunisian Harvest', purchaseIntent: 'B2B' as const,
      description: 'Hand-sorted Deglet Nour dates packed in 5kg boxes.',
      initialQuantity: 150, lowStockThreshold: 20,
    },
  ];

  for (const p of productDefinitions) {
    const existing = await db.select().from(products).where(eq(products.sku, p.sku)).limit(1);
    if (existing.length > 0) continue;
    const ownerId = p.sellerType === 'SUPPLIER' ? supplierUser.userId : p.sellerType === 'MERCHANT' ? merchantUser.userId : companyUser.userId;
    await createProduct(db, {
      sellerId: p.sellerId,
      sellerType: p.sellerType,
      categoryId: p.categoryId,
      name: p.name,
      nameAr: p.nameAr,
      description: p.description,
      brand: p.brand,
      sku: p.sku,
      barcode: 'barcode' in p ? p.barcode : undefined,
      currencyCode: 'TND',
      basePrice: p.basePrice,
      moq: p.moq,
      unit: p.unit,
      purchaseIntent: p.purchaseIntent,
      initialQuantity: p.initialQuantity ?? 0,
      lowStockThreshold: p.lowStockThreshold ?? p.moq,
      images: [
        { url: `https://picsum.photos/seed/${encodeURIComponent(p.sku)}/600/600`, altText: p.name, isPrimary: true, sortOrder: 0 },
      ],
    }, { actorId: ownerId });
  }

  console.log('Products seeded via createProduct ✓');

  // Backfill inventory rows for any existing active products (e.g. created before
  // the inventory engine existed) so every catalog item has a stock record.
  // Uses each product's defined initial stock when available, otherwise a 0 baseline.
  const stockBySku = new Map(productDefinitions.map((p) => [
    p.sku,
    { quantity: p.initialQuantity ?? 0, threshold: p.lowStockThreshold ?? p.moq ?? 5 },
  ]));
  const activeProducts = await db.select().from(products).where(eq(products.status, 'ACTIVE'));
  let backfilled = 0;
  let reset = 0;
  for (const p of activeProducts) {
    const hasRow = await db.select({ id: inventoryItems.id }).from(inventoryItems)
      .where(sql`${inventoryItems.productId} = ${p.id} and ${inventoryItems.productVariantId} is null`)
      .limit(1);
    if (hasRow.length === 0) {
      const def = stockBySku.get(p.sku) ?? { quantity: 0, threshold: 5 };
      await ensureInventoryItem(db, p.id, p.sellerId, null, def.threshold);
      if (def.quantity > 0) {
        await db.update(inventoryItems)
          .set({ quantity: def.quantity })
          .where(sql`${inventoryItems.productId} = ${p.id} and ${inventoryItems.productVariantId} is null`);
      }
      backfilled += 1;
    } else if (RESET_STOCK && stockBySku.has(p.sku)) {
      // E2E/CI only: restore demo stock that prior test runs consumed, so the
      // fixture starts from a known quantity instead of drifting downward.
      const def = stockBySku.get(p.sku)!;
      await db.update(inventoryItems)
        .set({ quantity: def.quantity })
        .where(sql`${inventoryItems.productId} = ${p.id} and ${inventoryItems.productVariantId} is null`);
      await db.execute(sql`
        update inventory_items set reserved_quantity = 0
        where product_id = ${p.id} and product_variant_id is null and reserved_quantity <> 0
      `);
      reset += 1;
    }
  }
  if (backfilled > 0) console.log(`Inventory backfilled: ${backfilled} product(s) ✓`);
  if (reset > 0) console.log(`Inventory restocked for demo products: ${reset} ✓`);

  // طلب تجريبي (يُنشئ Transaction + Ledger + Commission عبر Policy Engine الحقيقي)
  const existingOrders = await db.select().from(orders).limit(1);
  if (existingOrders.length === 0) {
    // Select a product that actually has enough stock to satisfy its MOQ, so the
    // seeder is re-runnable and never aborts on an unrelated zero-stock catalog row.
    const productRows = await db
      .select({ id: products.id, moq: products.moq })
      .from(products)
      .innerJoin(inventoryItems, sql`${inventoryItems.productId} = ${products.id}`)
      .where(sql`${products.status} = 'ACTIVE' and ${inventoryItems.quantity} >= coalesce(${products.moq}, 1)`)
      .limit(2);
    if (productRows.length > 0) {
      const buyer = customer.userId;
      await createOrder(db, {
        buyerId: buyer,
        buyerType: 'CUSTOMER',
        items: productRows.map((pr) => ({ productId: pr.id, quantity: Math.max(pr.moq ?? 1, 1) })),
        currencyCode: 'TND',
        notes: 'Demo order — created through real order service (commission + ledger + audit).',
      }, { actorId: buyer, ipAddress: '127.0.0.1' });
      console.log('Demo order created ✓');
    }
  }

  // محادثة تجريبية — تُنشأ عبر openDirectThread/sendMessage الحقيقيين كي تظهر
  // لوحة الرسائل بمحتوى فعلي لكل مستخدم تجريبي بدلًا من قائمة فارغة.
  const customerThreads = await db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(threadParticipants, eq(threadParticipants.threadId, threads.id))
    .where(eq(threadParticipants.userId, customer.userId))
    .limit(1);

  if (customerThreads.length === 0) {
    const { threadId } = await openDirectThread(
      db,
      customer.userId,
      {
        participantUserId: supplierUser.userId,
        subject: 'استفسار عن زيت الزيتون العضوي',
        body: 'مرحبًا، ما هي الكمية المتاحة للتصدير من زيت الزيتون العضوي 5 لتر؟',
      },
      { ipAddress: '127.0.0.1' },
    );
    // A reply from the counterparty so the thread shows a real back-and-forth.
    await sendMessage(
      db,
      supplierUser.userId,
      threadId,
      { body: 'أهلًا بك، لدينا 400 علبة جاهزة للتصدير حاليًا ويمكن زيادة الكمية عند الطلب.' },
      { ipAddress: '127.0.0.1' },
    );
    console.log('Demo conversation created ✓');
  }

  // علاقات دليل الأطراف — طلبات حقيقية عبر createOrder نفسه (بدل بيانات وهمية)
  // كي تظهر كل واجهات الدليل الست بمحتوى فعلي:
  //   Merchant→Customers, Merchant→Suppliers(my), Supplier→Buyers,
  //   Supplier→Merchants(my), Company→Suppliers(my), Company→Buyers.
  await seedDirectoryRelationships({
    customerUserId: customer.userId,
    supplierUserId: supplierUser.userId,
    merchantUserId: merchantUser.userId,
    companyUserId: companyUser.userId,
    supplierId,
    merchantId,
    companyId,
  });

  console.log('Demo Seed complete.');
  console.log('Test users (password: ' + pw + '):');
  console.log('  customer1@wasit.tn (CUSTOMER)');
  console.log('  supplierA@wasit.tn (SUPPLIER)');
  console.log('  merchantA@wasit.tn (MERCHANT)');
  console.log('  companyA@wasit.tn  (COMPANY)');
  console.log(
    'Staff fixtures (admin@wasit.tn SUPER_ADMIN, admin2@wasit.tn ADMIN) use a separate ' +
      'credential: DEMO_STAFF_PASSWORD (never the published demo password).',
  );
}

main()
  .catch((err) => {
    console.error('Demo seeder failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());